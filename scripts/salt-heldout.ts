import { randomBytes } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, HeldoutSchema, randomSalt, sha256Hex } from "@tender/shared";

// Gives held-out files a salt drawn for their checks, the files a seed or a sub-task is posted from.
//
//   pnpm exec tsx scripts/salt-heldout.ts <heldout.json | folder>...
//
// A held-out document needs a `salt` of fresh random bytes (`HeldoutSchema`): its commitment is
// public from the moment the task is posted, and without one a short answer is found by hashing
// the likely answers until one gives the commitment. The API and the Judge refuse a document
// without one. A folder stands for the `heldout.json` of each folder in it (a private seed
// directory, `scripts/demo-seeds/`).
//
// A salt is good for one set of checks only. Once a task is judged its scorecard publishes the
// checks and the salt, and new checks under that old salt would be as guessable as checks with no
// salt at all. So a salt this script draws is 48 bytes: 32 random ones, then the first 16 bytes of
// the SHA-256 of the checks it was drawn for (the document without its salt, as canonical JSON).
// A file whose salt ends in the fingerprint of the checks it holds now is left as it is. Any other
// file gets a new salt: one with none, one whose checks changed since its salt was drawn, and one
// whose salt this script did not draw (it cannot tell what that salt was drawn for). The
// fingerprint says nothing before the salt is published, as the salt is secret until then, and
// nothing after, as the checks are published with it.
//
// A file that gets a salt is written back as JSON with two spaces (keys in their order, the salt
// last), through a temporary file and a rename. What is printed is the path and what was done,
// never what a file holds: the files of the real seeds are private. It exits with 1 when a file
// is not a held-out document even with a salt.

/**
 * What was done to one file: `salted`, it had no salt; `resalted`, it had one that was not drawn
 * for the checks it holds now, and got a new one; `kept`, its salt was drawn for these checks.
 */
export type Salted = "salted" | "resalted" | "kept";

/** The hex characters of a salt this script draws that are random: 32 bytes. */
const RANDOM_HEX = 64;
/** The hex characters of the checks' SHA-256 that end a salt this script draws: 16 bytes. */
const FINGERPRINT_HEX = 32;

/** The fingerprint of the checks of `document`: its keys but the salt, as canonical JSON, hashed. */
function fingerprintOf(document: object): string {
  const { salt: _salt, ...checks } = document as Record<string, unknown>;
  return sha256Hex(canonicalJson(checks)).slice(0, FINGERPRINT_HEX);
}

/** A new salt for the checks of `document`: 32 random bytes and their fingerprint. */
export function saltFor(document: object): string {
  return `${randomSalt()}${fingerprintOf(document)}`;
}

/** Whether `salt` is one this script drew for the checks `document` holds now. */
export function drawnFor(salt: unknown, document: object): boolean {
  return (
    typeof salt === "string" &&
    salt.length === RANDOM_HEX + FINGERPRINT_HEX &&
    salt.endsWith(fingerprintOf(document))
  );
}

/** The `heldout.json` files that `paths` stand for: each file, and those of each folder's folders. */
export function heldoutFilesOf(paths: readonly string[]): string[] {
  const files: string[] = [];
  for (const path of paths) {
    if (!statSync(path).isDirectory()) {
      files.push(path);
      continue;
    }
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name, "heldout.json");
      if (entry.isDirectory() && existsSync(file)) files.push(file);
    }
  }
  return files.sort();
}

/**
 * Gives `file` a new salt unless its salt was drawn for the checks it holds (`drawnFor`). Throws,
 * naming the file and nothing it holds, for a file that is not JSON or is no held-out document with
 * its salt; such a file is not written.
 */
export function saltHeldoutFile(file: string): Salted {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not JSON`);
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new Error(`${file} is not a held-out document: it is not an object`);
  }
  const has = Object.hasOwn(document, "salt");
  const kept = has && drawnFor((document as { salt?: unknown }).salt, document);
  // A salt that stays is moved nowhere; a new one goes last, after the checks.
  const { salt: _old, ...checks } = document as Record<string, unknown>;
  const salted = kept ? document : { ...checks, salt: saltFor(document) };
  const parsed = HeldoutSchema.safeParse(salted);
  if (!parsed.success) {
    // The paths of the issues and not their messages: a message can quote a value.
    const where = parsed.error.issues.map((issue) => issue.path.join(".") || "(the document)");
    throw new Error(`${file} is not a held-out document (at ${[...new Set(where)].join(", ")})`);
  }
  if (kept) return "kept";
  const temp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(temp, `${JSON.stringify(salted, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temp, file);
  return has ? "resalted" : "salted";
}

/** What `main` prints for each outcome, padded to one width. */
const SAID: Record<Salted, string> = {
  salted: "SALTED  ",
  resalted: "NEW SALT",
  kept: "KEPT    ",
};

function main(args: readonly string[]): number {
  if (args.length === 0 || args.includes("--help")) {
    console.error("usage: pnpm exec tsx scripts/salt-heldout.ts <heldout.json | folder>...");
    return 2;
  }
  let failed = false;
  for (const file of heldoutFilesOf(args)) {
    try {
      console.log(`${SAID[saltHeldoutFile(file)]} ${file}`);
    } catch (error) {
      failed = true;
      console.error(`ERROR    ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2));
}
