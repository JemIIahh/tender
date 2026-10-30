import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./adapters";

// Found from this file, not from the working directory, so services can start from anywhere.
const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

// Held (until the transaction ends) while migrating, so two services booting at once apply a
// migration once between them. Any number nobody else uses will do; this one spells "TENDER".
const MIGRATE_LOCK = 0x54454e444552;

/**
 * Applies every `*.sql` file in `dir` (default: this package's `migrations/`) that is not yet
 * recorded in `schema_migrations`, in file name order, and returns the names it applied.
 *
 * All of it is one transaction: if a file fails, nothing from this call is applied or recorded,
 * and the error names the file. A recorded file is never run again, or compared with what ran.
 */
export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  const files = await Promise.all(
    names.map(async (name) => ({ name, sql: await readFile(join(dir, name), "utf8") })),
  );

  return db.tx(async (tx) => {
    await tx.exec(`select pg_advisory_xact_lock(${MIGRATE_LOCK})`);
    await tx.exec(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz default now())",
    );
    const done = new Set(
      (await tx.query<{ name: string }>("select name from schema_migrations")).map(
        (row) => row.name,
      ),
    );

    const applied: string[] = [];
    for (const { name, sql } of files) {
      if (done.has(name)) continue;
      try {
        await tx.exec(sql);
      } catch (error) {
        throw new Error(
          `migration ${name} failed: ${error instanceof Error ? error.message : error}`,
          {
            cause: error,
          },
        );
      }
      await tx.query("insert into schema_migrations (name) values ($1)", [name]);
      applied.push(name);
    }
    return applied;
  });
}
