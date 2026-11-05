import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Sandbox } from "near-sandbox";

/** The nearcore that plan 01 tested the contract on, and near-sandbox 0.3.4's default. */
export const NEARCORE_VERSION = "2.13.4";

/**
 * Where near-sandbox keeps the nodes it downloads: `DIR_TO_DOWNLOAD_BINARY`, else `bin` in its own
 * package, which is a directory of `node_modules`. A node is `near-sandbox-<version>/near-sandbox`
 * under it.
 */
function downloadRoot(): string {
  const own = process.env.DIR_TO_DOWNLOAD_BINARY;
  if (own) return resolve(own);
  // The package's entry is `<package>/dist/esm/index.mjs`.
  const entry = fileURLToPath(import.meta.resolve("near-sandbox"));
  return join(dirname(dirname(dirname(entry))), "bin");
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** The download in progress, if there is one. Callers of one process share it. */
let downloading: Promise<void> | undefined;

/**
 * Makes the download of nearcore's sandbox node that near-sandbox would make on the first start of
 * an install, with the OS temp dir pointed at a directory beside where the node goes.
 *
 * near-sandbox unpacks the archive into the OS temp dir and renames the node from there into its
 * package, and the rename fails with EXDEV where the two are on different filesystems: a tmpfs
 * /tmp, or a checkout on a bind mount (a dev container, Codespaces). It also keeps the lock of the
 * download when the download fails, so a process that waits for that lock waits for minutes. A
 * directory beside the destination is on the destination's filesystem, and the temp dir goes back
 * to what it was, so the node's home dir and its port locks land where the caller put them.
 *
 * Resolves with the path of the node: the one `NEAR_SANDBOX_BIN_PATH` names, if it is set (nothing
 * is downloaded then), else the downloaded one. Several callers in one process share one download.
 * The temp dir is the process's, so whatever else makes a temp file in it while the download runs
 * makes it in the scratch directory, which goes when the download ends.
 */
export async function ensureSandboxNode(): Promise<string> {
  const named = process.env.NEAR_SANDBOX_BIN_PATH;
  if (named) return named;
  const root = downloadRoot();
  const node = join(root, `near-sandbox-${NEARCORE_VERSION}`, "near-sandbox");
  if (await isFile(node)) return node;
  downloading ??= download(root).finally(() => {
    downloading = undefined;
  });
  await downloading;
  return node;
}

async function download(root: string): Promise<void> {
  // near-sandbox has no call that downloads and nothing else, so the part of its start that does
  // is called: it makes a home dir, gets the node (downloading it if the node is not there) and
  // has the node write the config into the home dir. The exact version of near-sandbox is pinned.
  const getNode = (
    Sandbox as unknown as {
      initConfigsWithVersion?: (version: string) => Promise<{ cleanup(): Promise<void> }>;
    }
  ).initConfigsWithVersion;
  if (getNode === undefined) {
    throw new Error(
      "near-sandbox no longer has the call that downloads the node: see sandbox-node.ts",
    );
  }
  const scratch = join(root, ".tmp");
  await mkdir(scratch, { recursive: true });
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  try {
    const home = await getNode.call(Sandbox, NEARCORE_VERSION);
    await home.cleanup();
  } finally {
    if (saved === undefined) Reflect.deleteProperty(process.env, "TMPDIR");
    else process.env.TMPDIR = saved;
    // A scratch directory that will not go is no reason to hide why the download failed.
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
