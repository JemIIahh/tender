import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  heldoutFileOf,
  knownWrongFileOf,
  missingPrivateFiles,
  PRIVATE_DIR_VARIABLE,
  privateDirOf,
  solutionFileOf,
  weakFileOf,
} from "../scripts/lib/private-dir";
import {
  answerCandidates,
  CASE_SET_FILES,
  type Candidate,
  caseStrings,
  holdsCaseTable,
  mask,
  occursIn,
  type SeedHeldout,
} from "./answer-scan";

// The answer scan of `no-answers-in-tree.test.ts`, run over git's history instead of the tree:
// every blob that any commit reachable from any ref holds (`git rev-list --all --objects`), with
// the rules of `answer-scan.ts` and the private directory. A seed whose answer is in an older
// commit is answered for anyone who reads the history once the repository is public, so such a
// seed is changed (its data, so that the old answer is wrong) rather than the history rewritten.
//
//   TENDER_SEEDS_PRIVATE_DIR=<dir> pnpm exec tsx seeds/history-scan.ts
//
// One rule more than the tree's: for an `exact` seed, every string literal in a blob is put through
// the seed's own `normalize` steps and compared with its accepted answers, and with all whitespace
// taken out of both, so that a spacing variant of an answer ("7 ,31") is found as well. What is
// printed names the seed, the path, the blob and the kind of value with its length, never the
// value. It exits with 1 when it finds anything, and with 2 when it cannot look.

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SEEDS_DIR = import.meta.dirname;
/** A blob larger than this is no source file; the tree's guard skips the same. */
const MAX_BLOB_BYTES = 3_000_000;

interface Seed {
  slug: string;
  candidates: Candidate[];
  cases: string[];
  /** For an `exact` seed: its accepted answers, each normalised, and each without whitespace. */
  exact: { normalize: string[]; accepted: Set<string>; bare: Set<string> } | null;
}

interface Blob {
  id: string;
  path: string;
  text: string;
}

const NORMALIZE: Record<string, (text: string) => string> = {
  trim: (text) => text.trim(),
  lowercase: (text) => text.toLowerCase(),
  collapse_ws: (text) => text.replace(/\s+/g, " "),
};
const normalized = (text: string, steps: readonly string[]): string =>
  steps.reduce((current, step) => NORMALIZE[step]?.(current) ?? current, text);
const bare = (text: string): string => text.replace(/\s+/g, "").toLowerCase();

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

function seedOf(privateDir: string, slug: string): Seed {
  const publicText = ["task.json", "brief.json", "criteria.json"]
    .map((name) => join(SEEDS_DIR, slug, name))
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const criteria = readJson(join(SEEDS_DIR, slug, "criteria.json")) as {
    kind: string;
    normalize?: string[];
  };
  const heldoutFile = heldoutFileOf(privateDir, slug);
  // Read as JSON and not through `HeldoutSchema`: the scan looks at the checks, whatever else the
  // document holds.
  const heldout = existsSync(heldoutFile) ? (readJson(heldoutFile) as SeedHeldout) : null;
  const knownWrongFile = knownWrongFileOf(privateDir, slug);
  const knownWrong = existsSync(knownWrongFile)
    ? (readJson(knownWrongFile) as { pattern?: string; source?: string }[])
        .map((entry) => entry.pattern ?? entry.source)
        .filter((text): text is string => typeof text === "string")
    : [];
  const candidates = answerCandidates({
    heldout,
    solution: readFileSync(solutionFileOf(privateDir, slug), "utf8"),
    weak: readFileSync(weakFileOf(privateDir, slug), "utf8"),
    knownWrong,
    publicText,
  });
  let exact: Seed["exact"] = null;
  if (heldout !== null && "exact" in heldout && criteria.kind === "exact") {
    const steps = criteria.normalize ?? [];
    exact = {
      normalize: steps,
      accepted: new Set(heldout.exact.expected.map((answer) => normalized(answer, steps))),
      bare: new Set(heldout.exact.expected.map(bare)),
    };
  }
  return { slug, candidates, cases: caseStrings(heldout), exact };
}

/** Every blob that a commit reachable from a ref holds, once, with the first path it was seen at. */
function historyBlobs(): Blob[] {
  const listing = execFileSync("git", ["rev-list", "--all", "--objects"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const pathOf = new Map<string, string>();
  for (const line of listing.split("\n")) {
    const space = line.indexOf(" ");
    // A commit is listed without a path; a tree or a blob with one.
    if (space < 0) continue;
    const id = line.slice(0, space);
    if (!pathOf.has(id)) pathOf.set(id, line.slice(space + 1));
  }
  const ids = [...pathOf.keys()];
  const batch = spawnSync("git", ["cat-file", "--batch"], {
    cwd: ROOT,
    input: `${ids.join("\n")}\n`,
    maxBuffer: 2 * 1024 * 1024 * 1024,
  });
  if (batch.status !== 0) throw new Error("git cat-file --batch failed");
  const out = batch.stdout;
  const blobs: Blob[] = [];
  let at = 0;
  while (at < out.length) {
    const end = out.indexOf(0x0a, at);
    const [id = "", type, size] = out.subarray(at, end).toString("utf8").split(" ");
    const length = Number(size);
    const content = out.subarray(end + 1, end + 1 + length);
    at = end + 1 + length + 1;
    const path = pathOf.get(id) ?? "";
    if (type !== "blob" || length > MAX_BLOB_BYTES || content.includes(0)) continue;
    // The private directory is never tracked; a lockfile is hashes and versions, not prose.
    if (path.startsWith("seeds-private/") || /(?:^|\/)(?:pnpm-lock\.yaml|Cargo\.lock)$/.test(path))
      continue;
    blobs.push({ id, path, text: content.toString("utf8").toLowerCase() });
  }
  return blobs;
}

/** The string literals in `text`: between double quotes, single quotes or backticks, on one line. */
function literalsIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`]*)`/g)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? "";
    let value = raw;
    if (match[1] !== undefined) {
      try {
        value = JSON.parse(`"${raw}"`) as string;
      } catch {
        // Not a JSON string (a JavaScript escape JSON lacks): looked at as written.
      }
    }
    found.push(value);
  }
  return found;
}

/** What `seed` finds in `blob`, one line each, with no value in it. */
function hitsIn(seed: Seed, blob: Blob): string[] {
  const hits: string[] = [];
  for (const candidate of seed.candidates) {
    if (occursIn(blob.text, candidate)) {
      hits.push(`${candidate.what}, ${candidate.how}, ${mask(candidate.value)}`);
    }
  }
  const tableAllowed = new Set(CASE_SET_FILES.get(seed.slug) ?? []);
  if (!tableAllowed.has(blob.path) && holdsCaseTable(blob.text, seed.cases)) {
    hits.push("a table of the seed's cases");
  }
  if (seed.exact !== null) {
    const { normalize, accepted } = seed.exact;
    for (const literal of literalsIn(blob.text)) {
      if (accepted.has(normalized(literal, normalize))) {
        hits.push(`an accepted exact answer as a literal, ${mask(literal)}`);
      } else if (literal.length >= 3 && seed.exact.bare.has(bare(literal))) {
        hits.push(`an exact answer with other spacing, as a literal, ${mask(literal)}`);
      }
    }
  }
  return [...new Set(hits)];
}

/** The commits, short, that add blob `id` at some path or take it away. */
function commitsWith(id: string): string[] {
  const out = execFileSync("git", ["log", "--all", "--format=%h", `--find-object=${id}`], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out.split("\n").filter((line) => line !== "");
}

function main(): number {
  const privateDir = privateDirOf();
  const slugs = readdirSync(SEEDS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const missing = missingPrivateFiles(SEEDS_DIR, privateDir, slugs);
  if (missing.length > 0) {
    console.error(
      `history-scan: private files of ${missing.length} seeds not found in ${privateDir}; set ${PRIVATE_DIR_VARIABLE}`,
    );
    return 2;
  }
  const seeds = slugs.map((slug) => seedOf(privateDir, slug));
  const blobs = historyBlobs();
  console.log(`history-scan: ${blobs.length} blobs, ${seeds.length} seeds`);
  const found = new Set<string>();
  for (const seed of seeds) {
    for (const blob of blobs) {
      const hits = hitsIn(seed, blob);
      if (hits.length === 0) continue;
      found.add(seed.slug);
      const commits = commitsWith(blob.id);
      const span = commits.length === 0 ? "no commit" : `added or removed in ${commits.join(", ")}`;
      for (const hit of hits) {
        console.log(
          `FOUND ${seed.slug}: ${blob.path} (blob ${blob.id.slice(0, 10)}, ${span}): ${hit}`,
        );
      }
    }
  }
  console.log(
    found.size === 0
      ? "history-scan: no seed's answer is in the history"
      : `history-scan: answers of ${found.size} seeds are in the history: ${[...found].join(", ")}`,
  );
  return found.size === 0 ? 0 : 1;
}

process.exitCode = main();
