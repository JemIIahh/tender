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
// - anything under `.submission/` (a submission payload holds the owner's email) or
//   under `seeds-private/` (the real seeds' held-out checks and answers, seeds/README.md);
// - the owner's email address, or any address at its domain;
// - a NEAR ed25519 private key (`ed25519:` and 80 or more base58 characters), a PEM private key
//   and a Telegram bot token;
// - the shapes of common service credentials: an `sk-` API key (a form several providers use), a
//   GitHub token, an AWS access key id, a Slack token, a Google API key and a JWT;
// - an environment-style line (`NAME=value`, at the start of a line, with or without `export`)
//   whose name is in capitals and is, or ends in, API_KEY, APIKEY, SECRET, TOKEN, PASSWORD, JWT or
//   PRIVATE_KEY (so `TOKEN=` and `LLM_API_KEY=` both count) and whose value is 16 or more characters
//   that are no placeholder (`<...>`, `$VAR`, `...`, `xxxx`, `example`). A name in lower case is not
//   looked at.
//
// It does not find a secret of a shape it does not know (a short password, a key in a TypeScript
// object literal such as `FASTNEAR_API_KEY: "..."`, or a credential with no recognisable prefix),
// and it skips a file over 3 MB or with a NUL byte. It is a net for the likely mistakes, and the
// pre-commit hook's gitleaks run (when installed) is a second one; neither proves a tree clean.
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

/** Whether the value of an assignment is a stand-in and no secret: `<...>`, `$VAR`, `...`, `xxxx`. */
function isPlaceholder(value: string): boolean {
  return (
    /^[<$[{(]/.test(value) ||
    /\.\.\.|…/.test(value) ||
    /^(?:x+|\*+|\.+|-+)$/i.test(value) ||
    /example|placeholder|changeme|your[-_]/i.test(value)
  );
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
  {
    // `sk-` and 32 or more more characters: the form several providers use, with or without a
    // longer prefix after the `sk-`. Shorter strings such as `sk-test-0001` are the fakes of tests.
    name: "an sk- API key",
    pattern: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{32,}/,
  },
  {
    name: "a GitHub token",
    pattern: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/,
  },
  {
    name: "an AWS access key id",
    pattern: /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/,
  },
  {
    name: "a Slack token",
    pattern: /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/,
  },
  {
    name: "a Google API key",
    pattern: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/,
  },
  {
    name: "a JWT",
    pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  {
    // The form of an env file, a shell line or a docs snippet: the name at the start of the line.
    // `.env.example` has empty values and docs have placeholders, so neither matches.
    name: "a secret assigned to an environment variable",
    pattern:
      /^\s*(?:export\s+)?(?:[A-Z][A-Z0-9_]*)?(?:API_KEY|APIKEY|SECRET|TOKEN|PASSWORD|JWT|PRIVATE_KEY)=["']?[^\s"'#]{16,}/,
    excused: (match) => isPlaceholder(match.text.replace(/^[^=]*=["']?/, "")),
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
    expect(found).toEqual([
      "a.pem:1: a PEM private key",
      "c.md:1: a Telegram bot token",
      // The same line is also a secret assigned to a variable named for one.
      "c.md:1: a secret assigned to an environment variable",
    ]);
  });

  test("the shapes of common service credentials are found, and the fakes of tests are not", () => {
    // Written in parts, like the address: this file is scanned too.
    const a = (n: number) => "A1b2C3d4E5".repeat(Math.ceil(n / 10)).slice(0, n);
    const found = findProblems(
      new Map([
        ["a.md", `key ${["sk", "-", a(48)].join("")}\n`],
        ["b.md", `key ${["sk", "-ant-api03-", a(40)].join("")}\n`],
        ["c.md", `${["gh", "p_", a(36)].join("")}\n`],
        ["d.md", `${["github", "_pat_", a(60)].join("")}\n`],
        ["e.md", `${["AK", "IA", "ABCDEFGH12345678"].join("")}\n`],
        ["f.md", `${["xo", "xb-", "1234567890-abcdefghij"].join("")}\n`],
        ["g.md", `${["AI", "za", a(35)].join("")}\n`],
        ["h.md", `${["ey", "J", a(20)].join("")}.${["ey", "J", a(20)].join("")}.${a(20)}\n`],
        // What a test or a doc may hold.
        ["ok1.md", "an sk-test-0001 key, a ghp_ prefix, AKIA alone, xoxb-, AIza\n"],
        ["ok2.md", `sk-${a(31)}\n`],
        ["ok3.md", "a token eyJhbGciOi.short\n"],
      ]),
    );
    expect(found).toEqual([
      "a.md:1: an sk- API key",
      "b.md:1: an sk- API key",
      "c.md:1: a GitHub token",
      "d.md:1: a GitHub token",
      "e.md:1: an AWS access key id",
      "f.md:1: a Slack token",
      "g.md:1: a Google API key",
      "h.md:1: a JWT",
    ]);
  });

  test("a value assigned to a variable named for a secret is found, a stand-in is not", () => {
    const value = "q8Zt4rW1xLp9Vb2NcK7mD3";
    const found = findProblems(
      new Map([
        ["a.env.md", `LLM_API_KEY=${value}\n`],
        ["b.md", `  export FASTNEAR_API_KEY="${value}"\n`],
        ["c.md", `TELEGRAM_WEBHOOK_SECRET=${value}  # set this\n`],
        ["d.md", `ONECLICK_JWT=${value}\n`],
        ["e.md", `DEPLOY_PARENT_PRIVATE_KEY=${value}\n`],
        // A name that is only the suffix, and the `export` forms of it.
        ["bare1.md", `API_KEY=${value}\n`],
        ["bare2.md", `TOKEN=${value}\n`],
        ["bare3.md", `PASSWORD=${value}\n`],
        ["bare4.md", `SECRET=${value}\n`],
        ["bare5.md", `JWT=${value}\n`],
        ["bare6.md", `PRIVATE_KEY=${value}\n`],
        ["bare7.md", `APIKEY=${value}\n`],
        ["bare8.md", `export TOKEN=${value}\n`],
        ["bare9.md", `  export  API_KEY='${value}'\n`],
        ["bare10.md", `MYTOKEN=${value}\n`],
        // Empty, short, placeholder, shell and TypeScript forms.
        ["ok1.md", "LLM_API_KEY=\n"],
        ["ok2.md", "LLM_API_KEY=short\n"],
        ["ok3.md", "LLM_API_KEY=<your key from the provider>\n"],
        ["ok4.md", "LLM_API_KEY=$LLM_API_KEY_FROM_VAULT\n"],
        ["ok5.md", "DEPLOY_PARENT_PRIVATE_KEY=<ed25519:...>\n"],
        ["ok6.md", "LLM_API_KEY=xxxxxxxxxxxxxxxxxxxx\n"],
        ["ok7.md", "LLM_API_KEY=your-key-goes-here-123\n"],
        ["ok8.ts", `const env = { LLM_API_KEY: "${value}" };\n`],
        ["ok9.md", `TENDER_SEEDS_PRIVATE_DIR=${value}\n`],
        ["ok10.md", `TOKEN=<${value}>\n`],
        ["ok11.md", `export TOKEN=$TOKEN_FROM_VAULT_ONLY\n`],
        // Not in capitals, so not looked at (the header says so).
        ["ok12.md", `token=${value}\n`],
        ["ok13.md", `NOT_A_TOKEN_NAME=${value}\n`],
      ]),
    );
    expect(found).toEqual([
      "a.env.md:1: a secret assigned to an environment variable",
      "b.md:1: a secret assigned to an environment variable",
      "c.md:1: a secret assigned to an environment variable",
      "d.md:1: a secret assigned to an environment variable",
      "e.md:1: a secret assigned to an environment variable",
      "bare1.md:1: a secret assigned to an environment variable",
      "bare2.md:1: a secret assigned to an environment variable",
      "bare3.md:1: a secret assigned to an environment variable",
      "bare4.md:1: a secret assigned to an environment variable",
      "bare5.md:1: a secret assigned to an environment variable",
      "bare6.md:1: a secret assigned to an environment variable",
      "bare7.md:1: a secret assigned to an environment variable",
      "bare8.md:1: a secret assigned to an environment variable",
      "bare9.md:1: a secret assigned to an environment variable",
      "bare10.md:1: a secret assigned to an environment variable",
    ]);
    expect(found.join("\n")).not.toContain(value);
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
