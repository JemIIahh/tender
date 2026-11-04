import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative as relativePath, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { deploymentsDirOverride, envDir, loadEnv, REPO_ROOT } from "./env";

const dirs: string[] = [];

/** A new directory holding the given files. */
async function dirWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tender-env-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}

afterEach(async () => {
  vi.unstubAllEnvs();
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
      "POSTER_FULL_ACCESS_KEY=ed25519:abc123",
      "",
    ].join("\n"),
  });

  expect(loadEnv("testnet", { dir })).toEqual({
    POSTER_ACCOUNT: "poster.dev.testnet",
    POSTER_FULL_ACCESS_KEY: "ed25519:abc123",
  });
});

test("blank_value_with_trailing_space_does_not_swallow_the_next_line", async () => {
  // Node's parseEnv alone reads "A= \nB=1" as A="B=1" and loses B. A tab does the same.
  const dir = await dirWith({
    ".env": "SPACE= \nTAB=\t\nKEPT=1\nMORE=two words  \n",
    ".env.deploy.testnet": "DEPLOY_PARENT_ACCOUNT= \r\nDEPLOY_PARENT_PRIVATE_KEY=the-key\r\n",
  });

  expect(loadEnv("testnet", { dir })).toEqual({
    SPACE: "",
    TAB: "",
    KEPT: "1",
    MORE: "two words",
    DEPLOY_PARENT_ACCOUNT: "",
    DEPLOY_PARENT_PRIVATE_KEY: "the-key",
  });
  // A blank is still a missing key to anything that requires it, and the key after it is found.
  expect(() => loadEnv("testnet", { dir, required: ["DEPLOY_PARENT_ACCOUNT"] })).toThrow(
    /missing keys for network testnet: DEPLOY_PARENT_ACCOUNT /,
  );
  expect(loadEnv("testnet", { dir, required: ["DEPLOY_PARENT_PRIVATE_KEY"] })).toMatchObject({
    DEPLOY_PARENT_PRIVATE_KEY: "the-key",
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

test("env_dir_is_the_repository_root_unless_tender_env_dir_names_another", async () => {
  for (const unset of [
    {},
    { TENDER_ENV_DIR: undefined },
    { TENDER_ENV_DIR: "" },
    { TENDER_ENV_DIR: " \t" },
  ]) {
    expect(envDir(unset), JSON.stringify(unset)).toBe(REPO_ROOT);
    expect(deploymentsDirOverride(unset), JSON.stringify(unset)).toBeUndefined();
  }
  const dir = await dirWith({});
  expect(envDir({ TENDER_ENV_DIR: dir })).toBe(dir);
  expect(deploymentsDirOverride({ TENDER_ENV_DIR: dir })).toBe(join(dir, "deployments"));
  // A relative name is taken from the working directory, and the spaces around it are not part of it.
  const relative = relativePath(process.cwd(), dir);
  expect(envDir({ TENDER_ENV_DIR: ` ${relative} ` })).toBe(resolve(relative));
  expect(deploymentsDirOverride({ TENDER_ENV_DIR: relative })).toBe(
    join(resolve(relative), "deployments"),
  );
});

test("env_dir_throws_naming_the_variable_for_a_directory_that_does_not_exist", async () => {
  const dir = await dirWith({ "a-file": "x" });
  const refused: Record<string, string> = {
    "a missing directory": join(dir, "missing"),
    // A leading ~ is not the home directory: it is a directory of that name under the working one.
    "a tilde": "~/tender-env-dir-that-is-not-there",
    "a file": join(dir, "a-file"),
    "a path under a file": join(dir, "a-file", "below"),
  };
  for (const [what, value] of Object.entries(refused)) {
    const message = new RegExp(
      `^TENDER_ENV_DIR names .+, which is not an existing directory: create it, and give an ` +
        `absolute path \\(a leading ~ is not expanded\\)$`,
    );
    expect(() => envDir({ TENDER_ENV_DIR: value }), what).toThrow(message);
    expect(() => deploymentsDirOverride({ TENDER_ENV_DIR: value }), what).toThrow(message);
    // The default dir of `loadEnv` is the same check: it is never a silent "no files".
    vi.stubEnv("TENDER_ENV_DIR", value);
    expect(() => loadEnv("testnet"), what).toThrow(message);
    vi.unstubAllEnvs();
  }
});

test("load_env_reads_the_directory_the_process_names_in_tender_env_dir_when_given_no_dir", async () => {
  const named = await dirWith({ ".env.deploy.testnet": "FROM_NAMED=1\n" });
  const empty = await dirWith({});

  vi.stubEnv("TENDER_ENV_DIR", named);
  expect(loadEnv("testnet")).toEqual({ FROM_NAMED: "1" });
  // A `dir` that is passed wins over the variable.
  expect(loadEnv("testnet", { dir: empty })).toEqual({});
  // A directory with no env file is no variables, whatever is in the repository root.
  vi.stubEnv("TENDER_ENV_DIR", empty);
  expect(loadEnv("testnet")).toEqual({});
});
