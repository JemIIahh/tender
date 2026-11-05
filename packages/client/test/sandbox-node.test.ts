import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import fsPromises from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Sandbox } from "near-sandbox";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ensureSandboxNode, NEARCORE_VERSION, sandboxDownloadRoot } from "../src/index";

// `ensureSandboxNode`: the download of nearcore's sandbox node that the first local chain of an
// install makes. near-sandbox unpacks it into the OS temp dir and then renames it into its own
// package, and that rename fails with EXDEV where the two are on different filesystems (a tmpfs
// /tmp, a checkout on a bind mount). Run against the real near-sandbox download code, with a fake
// node served from a local server, and with a `rename` that fails as the kernel does when the two
// paths sit under different "mounts" (directories of the test's own).

/** What the fake node does: `--version` and `init` succeed, the way a node that is there does. */
const FAKE_NODE = `#!/bin/sh
case "$1" in
  --version) echo "fake-neard ${NEARCORE_VERSION}" ;;
  --home) printf '{}' > "$2/config.json"; printf '{}' > "$2/genesis.json" ;;
esac
`;

// Each test makes a download, an archive and a server, and the default of 5 s leaves a busy machine
// too little room.
vi.setConfig({ testTimeout: 30_000 });

const SAVED = {
  TMPDIR: process.env.TMPDIR,
  DIR_TO_DOWNLOAD_BINARY: process.env.DIR_TO_DOWNLOAD_BINARY,
  SANDBOX_ARTIFACT_URL: process.env.SANDBOX_ARTIFACT_URL,
  NEAR_SANDBOX_BIN_PATH: process.env.NEAR_SANDBOX_BIN_PATH,
};

function setEnv(name: keyof typeof SAVED, value: string | undefined) {
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}

interface World {
  /** Where the world lives; two "mounts" under it. */
  dir: string;
  /** The mount near-sandbox downloads to (`DIR_TO_DOWNLOAD_BINARY`). */
  install: string;
  /** The mount of the OS temp dir (`TMPDIR`): another filesystem as far as `rename` goes. */
  tmp: string;
  server: Server;
  /** The archives the server has served. */
  hits: string[];
}

let world: World;

/** The "filesystem" a path is on: the mount of the world that holds it. */
function mountOf(path: string): string {
  const [first] = relative(world.dir, path).split(sep);
  return first ?? "";
}

beforeEach(async () => {
  // The real path: the temp library resolves symlinks, as macOS has on /var.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tender-sandbox-node-")));
  const install = join(dir, "install");
  const tmp = join(dir, "tmp");
  mkdirSync(install);
  mkdirSync(tmp);

  // The archive near-sandbox expects: one top directory, which it strips, holding `near-sandbox`.
  const source = join(dir, "archive", "near-sandbox");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "near-sandbox"), FAKE_NODE);
  chmodSync(join(source, "near-sandbox"), 0o755);
  const archive = join(dir, "near-sandbox.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", join(dir, "archive"), "near-sandbox"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const bytes = readFileSync(archive);

  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/gzip" });
    response.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  world = { dir, install, tmp, server, hits };
  setEnv("DIR_TO_DOWNLOAD_BINARY", install);
  setEnv("SANDBOX_ARTIFACT_URL", `http://127.0.0.1:${port}/near-sandbox.tar.gz`);
  setEnv("TMPDIR", tmp);
  setEnv("NEAR_SANDBOX_BIN_PATH", undefined);

  // The kernel's answer to a rename between two filesystems.
  const rename = fsPromises.rename.bind(fsPromises);
  vi.spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
    if (mountOf(String(from)) !== mountOf(String(to))) {
      throw Object.assign(
        new Error(`EXDEV: cross-device link not permitted, rename '${from}' -> '${to}'`),
        { errno: -18, code: "EXDEV", syscall: "rename", path: String(from), dest: String(to) },
      );
    }
    return rename(from, to);
  });
  // near-sandbox is an ES module: its `import * as fs from "fs/promises"` sees the spy only once
  // the builtin's exports are synced.
  syncBuiltinESMExports();
});

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const [name, value] of Object.entries(SAVED)) {
    setEnv(name as keyof typeof SAVED, value);
  }
  await new Promise((resolve) => world.server.close(resolve));
  rmSync(world.dir, { recursive: true, force: true });
});

const nodePath = () => join(world.install, `near-sandbox-${NEARCORE_VERSION}`, "near-sandbox");

test("the_download_succeeds_when_the_temp_dir_is_on_another_filesystem", async () => {
  expect(existsSync(nodePath())).toBe(false);

  const path = await ensureSandboxNode();

  expect(path).toBe(nodePath());
  expect(existsSync(path)).toBe(true);
  expect(world.hits).toHaveLength(1);
  // The temp dir is the caller's again, and the scratch dir that the download used is gone: only
  // the node is left in the install dir.
  expect(process.env.TMPDIR).toBe(world.tmp);
  expect(readdirSync(world.install).filter((name) => !name.endsWith(".lock"))).toEqual([
    basename(dirname(path)),
  ]);
  expect(readdirSync(world.tmp)).toEqual([]);
});

test("the_download_leaves_no_temp_dir_set_when_there_was_none", async () => {
  // With no TMPDIR the OS temp dir is the system's, which is on none of the test's mounts.
  setEnv("TMPDIR", undefined);

  await ensureSandboxNode();

  expect(existsSync(nodePath())).toBe(true);
  expect("TMPDIR" in process.env).toBe(false);
});

test("callers_at_the_same_time_share_one_download", async () => {
  const [first, second, third] = await Promise.all([
    ensureSandboxNode(),
    ensureSandboxNode(),
    ensureSandboxNode(),
  ]);

  expect([first, second, third]).toEqual([nodePath(), nodePath(), nodePath()]);
  expect(world.hits).toHaveLength(1);
  expect(process.env.TMPDIR).toBe(world.tmp);
});

test("a_node_that_is_on_disk_is_not_downloaded_again", async () => {
  mkdirSync(dirname(nodePath()), { recursive: true });
  writeFileSync(nodePath(), FAKE_NODE);
  chmodSync(nodePath(), 0o755);

  expect(await ensureSandboxNode()).toBe(nodePath());

  expect(world.hits).toEqual([]);
  expect(process.env.TMPDIR).toBe(world.tmp);
  expect(readdirSync(world.install)).toEqual([`near-sandbox-${NEARCORE_VERSION}`]);
});

test("a_node_named_by_NEAR_SANDBOX_BIN_PATH_is_used_as_it_is", async () => {
  setEnv("NEAR_SANDBOX_BIN_PATH", "/somewhere/else/near-sandbox");

  expect(await ensureSandboxNode()).toBe("/somewhere/else/near-sandbox");

  expect(world.hits).toEqual([]);
  expect(readdirSync(world.install)).toEqual([]);
});

test("a_failed_download_gives_the_temp_dir_back_and_leaves_no_scratch_dir", async () => {
  // Stands in for near-sandbox failing mid-download (it keeps its lock when it does, which a real
  // failure would leave in this test's dir for the rest of the process).
  const failure = new Error("the network went away");
  const initNode = vi
    .spyOn(
      Sandbox as unknown as { initConfigsWithVersion: () => Promise<unknown> },
      "initConfigsWithVersion",
    )
    .mockRejectedValueOnce(failure);

  await expect(ensureSandboxNode()).rejects.toBe(failure);

  expect(initNode).toHaveBeenCalledTimes(1);
  expect(process.env.TMPDIR).toBe(world.tmp);
  expect(readdirSync(world.install)).toEqual([]);

  // The next call tries again, and now the download goes through.
  initNode.mockRestore();
  expect(await ensureSandboxNode()).toBe(nodePath());
  expect(world.hits).toHaveLength(1);
});

test("a_download_removes_its_own_scratch_dir_and_no_other", async () => {
  // Another process's download, still going on in the same install: its scratch dir is a sibling.
  const other = join(world.install, ".tmp-other");
  mkdirSync(other);
  writeFileSync(join(other, "home"), "x");

  await ensureSandboxNode();

  expect(readdirSync(world.install).filter((name) => name.startsWith(".tmp-"))).toEqual([
    ".tmp-other",
  ]);
  expect(existsSync(join(other, "home"))).toBe(true);
});

test("each_download_has_a_scratch_dir_of_its_own", async () => {
  // Two processes cannot be made here; two downloads one after the other can: each one's temp dir
  // is a new directory beside the node's place, not the name the last one used.
  const seen: string[] = [];
  const real = (Sandbox as unknown as { initConfigsWithVersion: (v: string) => Promise<unknown> })
    .initConfigsWithVersion;
  vi.spyOn(
    Sandbox as unknown as { initConfigsWithVersion: (v: string) => Promise<unknown> },
    "initConfigsWithVersion",
  ).mockImplementation(async (version) => {
    seen.push(tmpdir());
    return real.call(Sandbox, version);
  });

  await ensureSandboxNode();
  // The node is on disk now, and near-sandbox has pointed NEAR_SANDBOX_BIN_PATH at it: take both
  // away, so that the next call downloads again.
  rmSync(join(world.install, `near-sandbox-${NEARCORE_VERSION}`), { recursive: true });
  setEnv("NEAR_SANDBOX_BIN_PATH", undefined);
  await ensureSandboxNode();

  expect(seen).toHaveLength(2);
  expect(new Set(seen).size).toBe(2);
  for (const dir of seen) expect(dirname(dir)).toBe(world.install);
  expect(readdirSync(world.install).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
});

/** The directory of the near-sandbox package this test resolves, found from the manifest. */
function nearSandboxPackageDir(): string {
  let dir = dirname(fileURLToPath(import.meta.resolve("near-sandbox")));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (
      existsSync(manifest) &&
      JSON.parse(readFileSync(manifest, "utf8")).name === "near-sandbox"
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("the package of near-sandbox was not found");
    dir = parent;
  }
}

test("the_download_root_is_near_sandboxs_own_and_follows_DIR_TO_DOWNLOAD_BINARY", () => {
  // Unset, it is `bin` in near-sandbox's package, which is where near-sandbox 0.3.4 puts a node
  // (`join(__dirname, "..", "..", "bin")` from `dist/esm`). A new version of the package has to be
  // checked against this: the scratch dir must sit beside the node's place to be on its filesystem.
  setEnv("DIR_TO_DOWNLOAD_BINARY", undefined);
  expect(sandboxDownloadRoot()).toBe(join(nearSandboxPackageDir(), "bin"));

  // Set, it is that directory, made absolute as near-sandbox's own `join` leaves it relative to the
  // working directory.
  setEnv("DIR_TO_DOWNLOAD_BINARY", "nodes/here");
  expect(sandboxDownloadRoot()).toBe(resolve("nodes/here"));
  setEnv("DIR_TO_DOWNLOAD_BINARY", world.install);
  expect(sandboxDownloadRoot()).toBe(world.install);
});
