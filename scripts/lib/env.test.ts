import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { loadEnv, REPO_ROOT } from "./env";

const dirs: string[] = [];

/** A new directory holding the given files. */
async function dirWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tender-env-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("load_env_reads_env_and_the_network_file_and_the_network_file_wins", async () => {
  const dir = await dirWith({
    ".env": "A=from-env\nB=from-env\n",
    ".env.deploy.testnet": "B=from-testnet\nC=from-testnet\n",
    // The file of another network is not read.
    ".env.deploy.sandbox": "A=from-sandbox\nD=from-sandbox\n",
  });

  expect(loadEnv("testnet", { dir })).toEqual({
    A: "from-env",
    B: "from-testnet",
    C: "from-testnet",
  });
});

test("load_env_reads_dotenv_syntax", async () => {
  const dir = await dirWith({
    ".env.deploy.testnet": [
      "# written by deploy",
      'POSTER_ACCOUNT="poster.dev.testnet"',
      "POSTER_PRIVATE_KEY=ed25519:abc123",
      "",
    ].join("\n"),
  });

  expect(loadEnv("testnet", { dir })).toEqual({
    POSTER_ACCOUNT: "poster.dev.testnet",
    POSTER_PRIVATE_KEY: "ed25519:abc123",
  });
});

test("load_env_is_empty_when_neither_file_exists", async () => {
  expect(loadEnv("testnet", { dir: await dirWith({}) })).toEqual({});
});

test("load_env_names_every_missing_key_and_only_those", async () => {
  const dir = await dirWith({
    // GONE and ALSO_GONE are not set at all, BLANK and SPACES are set to nothing.
    ".env.deploy.testnet": "KEPT=secret-value\nBLANK=\nSPACES=   \n",
  });

  expect(() =>
    loadEnv("testnet", { dir, required: ["KEPT", "GONE", "BLANK", "SPACES", "ALSO_GONE"] }),
  ).toThrow(
    new Error(
      "missing keys for network testnet: GONE, BLANK, SPACES, ALSO_GONE " +
        "(set them in .env or .env.deploy.testnet)",
    ),
  );
});

test("load_env_returns_the_required_keys_it_checked", async () => {
  const dir = await dirWith({ ".env": "A=1\nB=2\n" });

  const env = loadEnv("sandbox", { dir, required: ["A", "B"] });

  expect([env.A, env.B]).toEqual(["1", "2"]);
});

test("load_env_reads_the_repository_root_by_default", () => {
  expect(existsSync(join(REPO_ROOT, "pnpm-workspace.yaml"))).toBe(true);
});
