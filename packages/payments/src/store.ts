import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

/** Local, single-host state. A crashed owner leaves a lock: inspect it, never auto-reset it. */
export async function lockedState<T>(
  path: string,
  run: (read: () => Promise<T | null>, save: (state: T) => Promise<void>) => Promise<unknown>,
): Promise<unknown> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new Error(
      "Payment state is locked. Another purchase is running, or its outcome needs review.",
    );
  }
  try {
    return await run(
      async () => {
        try {
          return JSON.parse(await readFile(path, "utf8")) as T;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      },
      async (state) => {
        const temporary = `${path}.${randomUUID()}.tmp`;
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(JSON.stringify(state));
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, path);
        const directory = await open(dirname(path), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      },
    );
  } finally {
    await rm(lock, { recursive: true });
  }
}
