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
import { HeldoutSchema, randomSalt } from "@tender/shared";

// Adds a salt to held-out files that have none, the files a seed or a sub-task is posted from.
//
//   pnpm exec tsx scripts/salt-heldout.ts <heldout.json | folder>...
//
// A held-out document needs a `salt` of fresh random bytes (`HeldoutSchema`): its commitment is
// public from the moment the task is posted, and without one a short answer is found by hashing
// the likely answers until one gives the commitment. The API and the Judge refuse a document
// without one. A folder stands for the `heldout.json` of each folder in it (a private seed
// directory, `scripts/demo-seeds/`). A file that has a salt is left as it is; the rest get one, of
// 32 bytes, and are written back as JSON with two spaces (keys in their order, the salt last),
// each through a temporary file and a rename. What is printed is the path and what was done,
// never what a file holds: the files of the real seeds are private. It exits with 1 when a file
// is not a held-out document even with a salt.

/** What was done to one file. */
export type Salted = "salted" | "kept";

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
 * Gives `file` a salt if it has none. Throws, naming the file and nothing it holds, for a file that
 * is not JSON or is no held-out document with its salt.
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
  const salted = has ? document : { ...document, salt: randomSalt() };
  const parsed = HeldoutSchema.safeParse(salted);
  if (!parsed.success) {
    // The paths of the issues and not their messages: a message can quote a value.
    const where = parsed.error.issues.map((issue) => issue.path.join(".") || "(the document)");
    throw new Error(`${file} is not a held-out document (at ${[...new Set(where)].join(", ")})`);
  }
  if (has) return "kept";
  const temp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(temp, `${JSON.stringify(salted, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temp, file);
  return "salted";
}

function main(args: readonly string[]): number {
  if (args.length === 0 || args.includes("--help")) {
    console.error("usage: pnpm exec tsx scripts/salt-heldout.ts <heldout.json | folder>...");
    return 2;
  }
  let failed = false;
  for (const file of heldoutFilesOf(args)) {
    try {
      console.log(`${saltHeldoutFile(file) === "salted" ? "SALTED" : "KEPT  "} ${file}`);
    } catch (error) {
      failed = true;
      console.error(`ERROR  ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2));
}
