import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// The repository is public, so it must hold no secret and no personal data. This is the guard that
// keeps that true for every file git tracks, and for every one it has not yet been told about
// (`git ls-files --cached --others --exclude-standard`, as seeds/no-answers-in-tree.test.ts lists
// them), so that a leak is found before it is committed. It looks for:
//
// - an environment file other than `.env.example`, anywhere in the tree;
// - anything under `.submission/` (the hackathon submission payload holds the owner's email) or
//   under `seeds-private/` (the real seeds' held-out checks and answers, seeds/README.md);
// - the owner's email address, or any address at its domain;
// - a NEAR ed25519 private key (`ed25519:` and 80 or more base58 characters), a PEM private key
//   and a Telegram bot token.
//
// A finding is told by file, line and rule, never by the text it matched: the text is the secret.
//
// The owner's address is not written in this file, or in any other. The patterns below are built
// from parts at run time, so that this test, which the scan reads like any other file, does not
// hold what it looks for.

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The owner's address in two parts, joined only inside the patterns. */
const OWNER_LOCAL_PART = "[redacted]";
const OWNER_DOMAIN = "[redacted]";

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What a rule knows about a match when it is asked whether the match is public data after all. */
interface Match {
  path: string;
  /** The matched text. */
  text: string;
  /** The signatures a JSON fixture holds, which are public; none for any other file. */
  signatures: () => ReadonlySet<string>;
}

/** One thing to look for in the text of a file. */
interface Rule {
  name: string;
  pattern: RegExp;
  excused?: (match: Match) => boolean;
}

/**
 * The keys that hold a signature in a block of the chain: a transaction's or a block header's
 * `signature`, the `signatures` of a transaction and the `approvals` of a block, which are the
 * validators' signatures. All public.
 */
const SIGNATURE_KEYS: ReadonlySet<string> = new Set([
  "signature",
  "signatures",
  "approvals",
  "approvals_after_next",
]);

/**
 * The strings a JSON fixture holds as the value of a signature key, or as an element of an array
 * under one: the shape of a transaction or a block of the chain. Empty for a file that is no JSON,
 * or is not a test fixture.
 */
function fixtureSignatures(path: string, text: string): Set<string> {
  const found = new Set<string>();
  if (!/(?:^|\/)test\/fixtures\/.+\.json$/.test(path)) return found;
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return found;
  }
  const walk = (value: unknown, key: string | null): void => {
    if (typeof value === "string") {
      if (key !== null && SIGNATURE_KEYS.has(key)) found.add(value);
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item, key !== null && SIGNATURE_KEYS.has(key) ? key : null);
    } else if (typeof value === "object" && value !== null) {
      for (const [name, item] of Object.entries(value)) walk(item, name);
    }
  };
  walk(document, null);
  return found;
}

const RULES: readonly Rule[] = [
  {
    name: "the owner's email address",
    pattern: new RegExp(escapeRegExp(`${OWNER_LOCAL_PART}@${OWNER_DOMAIN}`), "i"),
  },
  {
    name: "an address at the owner's email domain",
    pattern: new RegExp(`@${escapeRegExp(OWNER_DOMAIN)}`, "i"),
  },
  {
    // A NEAR secret key is 64 bytes, 87 or 88 base58 characters. So is an ed25519 signature, and a
    // block of the chain that is kept as a test fixture carries many of them, as `signature` values
    // and in `signatures` arrays: those are public data, and the one place a match is excused.
    name: "an ed25519 private key",
    pattern: /ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/,
    excused: (match) => match.signatures().has(match.text),
  },
  {
    name: "a PEM private key",
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/,
  },
  {
    name: "a Telegram bot token",
    pattern: /(?<![0-9A-Za-z_-])[0-9]{8,10}:[A-Za-z0-9_-]{35}(?![0-9A-Za-z_-])/,
  },
];

/** A path that must not be in the repository at all, and why. */
function forbiddenPath(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (/^\.env(?:\..*)?$/.test(name) && name !== ".env.example") {
    return "an environment file other than .env.example";
  }
  if (path === ".submission" || path.startsWith(".submission/") || path.includes("/.submission/")) {
    return "a file under .submission/";
  }
  if (path.startsWith("seeds-private/")) return "a file under seeds-private/";
  return null;
}

/** What is wrong with the files, as lines that name a path (and a line number), never the text. */
function findProblems(files: ReadonlyMap<string, string | null>): string[] {
  const problems: string[] = [];
  for (const [path, text] of files) {
    const why = forbiddenPath(path);
    if (why !== null) problems.push(`${path}: ${why}`);
    if (text === null) continue;
    let signatures: Set<string> | undefined;
    const signaturesOfFile = () => {
      signatures ??= fixtureSignatures(path, text);
      return signatures;
    };
    const lines = text.split("\n");
    for (const rule of RULES) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const global = new RegExp(rule.pattern.source, `${rule.pattern.flags.replace("g", "")}g`);
        for (const match of line.matchAll(global)) {
          const shown: Match = { path, text: match[0], signatures: signaturesOfFile };
          if (rule.excused?.(shown) === true) continue;
          problems.push(`${path}:${i + 1}: ${rule.name}`);
        }
      }
    }
  }
  return problems;
}

/**
 * Every file git tracks or has not been told about (and does not ignore), by path, with its text,
 * or null for a file with no text to scan (binary, too large, gone). Null where there is no git
 * checkout, which has no list of files.
 */
function repositoryFiles(): Map<string, string | null> | null {
  let listing: string;
  try {
    listing = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    return null;
  }
  const files = new Map<string, string | null>();
  for (const path of listing.split("\0")) {
    if (path === "") continue;
    try {
      const file = join(ROOT, path);
      if (statSync(file).size > 3_000_000) {
        files.set(path, null);
        continue;
      }
      const text = readFileSync(file, "utf8");
      files.set(path, text.includes("\0") ? null : text);
    } catch {
      // Listed but not on disk (deleted and not yet committed): nothing to scan.
      files.set(path, null);
    }
  }
  return files;
}

describe("the rules of the scan, on invented files", () => {
  const key = `ed25519:${"3Zq7".repeat(22)}`;
  const otherKey = `ed25519:${"9Zq7".repeat(22)}`;

  test("an environment file is found, and .env.example is not", () => {
    const found = findProblems(
      new Map([
        [".env", "A=1\n"],
        ["apps/web/.env.local", "A=1\n"],
        [".env.deploy.testnet", "A=1\n"],
        [".env.example", "A=\n"],
        ["docs/env.md", "A=1\n"],
      ]),
    );
    expect(found).toEqual([
      ".env: an environment file other than .env.example",
      "apps/web/.env.local: an environment file other than .env.example",
      ".env.deploy.testnet: an environment file other than .env.example",
    ]);
  });

  test("anything under .submission/ or seeds-private/ is found", () => {
    const found = findProblems(
      new Map([
        [".submission/payload.json", "{}"],
        ["seeds-private/some-seed/solution.txt", "x"],
        ["seeds/some-seed/task.json", "{}"],
      ]),
    );
    expect(found).toEqual([
      ".submission/payload.json: a file under .submission/",
      "seeds-private/some-seed/solution.txt: a file under seeds-private/",
    ]);
  });

  test("the owner's address and its domain are found, in any case", () => {
    const address = `${OWNER_LOCAL_PART}@${OWNER_DOMAIN}`;
    const found = findProblems(
      new Map([
        ["a.md", `write to ${address}\n`],
        ["b.md", `${address.toUpperCase()}\n`],
        ["c.md", `team@${OWNER_DOMAIN}\n`],
        ["d.md", "write to someone@example.com\n"],
      ]),
    );
    expect(found).toEqual([
      "a.md:1: the owner's email address",
      "a.md:1: an address at the owner's email domain",
      "b.md:1: the owner's email address",
      "b.md:1: an address at the owner's email domain",
      "c.md:1: an address at the owner's email domain",
    ]);
  });

  test("a private key is found, a signature in a fixture is not, and a finding never shows the text", () => {
    const block = JSON.stringify(
      {
        transaction: { signature: key, public_key: "ed25519:short" },
        receipt: { signatures: [key, key], other: otherKey },
        header: { approvals: [key, null] },
      },
      null,
      2,
    );
    const found = findProblems(
      new Map([
        ["notes.md", `KEY=${key}\n`],
        ["packages/x/test/fixtures/block.json", block],
        ["packages/x/test/fixtures/block.txt", `    "signature": "${key}",\n`],
        ["packages/x/src/block.json", block],
        ["short.md", `a public key ed25519:${"3Zq7".repeat(11)}\n`],
      ]),
    );
    expect(found).toEqual([
      "notes.md:1: an ed25519 private key",
      // `other` is no signature: only the values of the signature keys are public.
      "packages/x/test/fixtures/block.json:11: an ed25519 private key",
      "packages/x/test/fixtures/block.txt:1: an ed25519 private key",
      // The same JSON outside a test fixture is not excused.
      "packages/x/src/block.json:3: an ed25519 private key",
      "packages/x/src/block.json:8: an ed25519 private key",
      "packages/x/src/block.json:9: an ed25519 private key",
      "packages/x/src/block.json:11: an ed25519 private key",
      "packages/x/src/block.json:15: an ed25519 private key",
    ]);
    expect(found.join("\n")).not.toContain(key);
    expect(found.join("\n")).not.toContain(otherKey);
  });

  test("a PEM private key and a Telegram bot token are found", () => {
    // Written in parts, like the address: this file is scanned too.
    const pemHeader = (kind: string) =>
      ["-----BEGIN", kind, "-----"].join(" ").replace(" -----", "-----");
    const token = `${"1234567890".slice(0, 9)}:${"AbC-dEf_".repeat(5).slice(0, 35)}`;
    const found = findProblems(
      new Map([
        ["a.pem", `${pemHeader("OPENSSH PRIVATE KEY")}\nxx\n`],
        ["b.pem", `${pemHeader("PUBLIC KEY")}\nxx\n`],
        ["c.md", `TELEGRAM_BOT_TOKEN=${token}\n`],
        ["d.md", "TELEGRAM_BOT_TOKEN=123456:short\n"],
      ]),
    );
    expect(found).toEqual(["a.pem:1: a PEM private key", "c.md:1: a Telegram bot token"]);
  });

  test("a file with no text is only checked by its path", () => {
    const found = findProblems(
      new Map([
        ["contract/res/tender.wasm", null],
        [".env", null],
      ]),
    );
    expect(found).toEqual([".env: an environment file other than .env.example"]);
  });
});

describe("the repository", () => {
  test("no_personal_data_in_tracked_files", ({ skip }) => {
    const files = repositoryFiles();
    if (files === null) return skip("not a git checkout, so there is no list of files to scan");
    // Not a scan of nothing: a repository this size lists a few hundred files at least.
    expect(files.size).toBeGreaterThan(100);
    expect(files.has(".env.example")).toBe(true);
    expect(findProblems(files)).toEqual([]);
  });
});
