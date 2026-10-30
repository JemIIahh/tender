import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ApiClient, type TenderClient } from "@tender/client";
import { type ConfigView, canonicalBase, computeCommitment, sha256Hex } from "@tender/shared";
import { KeyPair } from "near-api-js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  ConfigError,
  describeFailure,
  expandHome,
  readConfig,
  resolveDefaultToken,
  secretsOf,
} from "../src/config";
import { createStateStore } from "../src/state";

// `lstatSync` and `realpathSync` are wrapped, so that a test can describe a way of directories that a
// disk cannot be made to have (a parent that root owns, one that another user owns). They do the real
// thing until a test says not to.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    realpathSync: vi.fn(actual.realpathSync),
  };
});

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = "packages/mcp/bin/tender-mcp.ts";

const KEY = KeyPair.fromRandom("ed25519");
/** What a TENDER_API_URL that is refused is told it must be. */
const AN_API_URL =
  "an https URL, or an http URL to localhost, 127.0.0.1 or [::1], without a user name, password, " +
  "query or fragment";
/** What the bin needs, and nothing it does not. */
const ENV = {
  TENDER_NETWORK: "testnet",
  TENDER_CONTRACT: "tender.testnet",
  TENDER_API_URL: "https://api.tender.example",
  TENDER_ACCOUNT: "alice.testnet",
  TENDER_PRIVATE_KEY: KEY.toString(),
};

// A home of its own for each test, so that nothing is ever read from or written to the real one.
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "tender-mcp-home-"));
});

afterEach(async () => {
  vi.mocked(lstatSync).mockReset();
  vi.mocked(realpathSync).mockReset();
  await rm(home, { recursive: true, force: true });
});

/** The message `readConfig` fails with, for the home `at` (the test's own, unless another is given). */
function failureOf(env: Record<string, string>, at: string = home): string {
  try {
    readConfig(env, at);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).message;
  }
  throw new Error("readConfig did not fail");
}

test("config_reads_the_environment", () => {
  // Only what is needed: the state goes to the default place, and nothing optional is set.
  expect(readConfig(ENV, home)).toStrictEqual({
    network: "testnet",
    contractId: "tender.testnet",
    apiUrl: "https://api.tender.example",
    signer: { accountId: "alice.testnet", privateKey: KEY.toString() },
    publicKey: KEY.getPublicKey().toString(),
    stateDir: join(home, ".tender", "testnet", "alice.testnet"),
  });

  // Everything, with space around the values as a hand-edited file has.
  const filesDir = join(home, "tender-files");
  mkdirSync(filesDir, { mode: 0o700 });
  const everything = {
    ...ENV,
    TENDER_NETWORK: " mainnet\n",
    NEAR_RPC_URL: "https://rpc.example.com/?key=1",
    TENDER_STATE_DIR: "/srv/tender-state",
    TENDER_FILES_DIR: filesDir,
    TENDER_JUDGE_ACCOUNT: "judge.testnet",
    TENDER_TOKEN: "usdc.testnet",
  };
  expect(readConfig(everything, home)).toMatchObject({
    network: "mainnet",
    rpcUrl: "https://rpc.example.com/?key=1",
    stateDir: "/srv/tender-state",
    filesDir,
    judgeAccount: "judge.testnet",
    token: "usdc.testnet",
  });
});

test("empty_values_count_as_unset", () => {
  // `FOO=` in an env file or a JSON config is what an unfilled template gives.
  const blank = Object.fromEntries(Object.keys(ENV).map((name) => [name, ""]));
  expect(failureOf(blank)).toBe(
    "missing environment variables: TENDER_NETWORK, TENDER_CONTRACT, TENDER_API_URL, " +
      "TENDER_ACCOUNT, TENDER_PRIVATE_KEY",
  );
  expect(failureOf({ ...ENV, TENDER_CONTRACT: "  " })).toBe(
    "missing environment variable: TENDER_CONTRACT",
  );

  // The optional ones set to nothing are not set: the state goes to the default place.
  const config = readConfig(
    {
      ...ENV,
      TENDER_STATE_DIR: "",
      TENDER_FILES_DIR: "",
      TENDER_JUDGE_ACCOUNT: "",
      TENDER_TOKEN: "",
      NEAR_RPC_URL: "",
    },
    home,
  );
  expect(config.stateDir).toBe(join(home, ".tender", "testnet", "alice.testnet"));
  expect(config).not.toHaveProperty("filesDir");
  expect(config).not.toHaveProperty("judgeAccount");
  expect(config).not.toHaveProperty("token");
  expect(config).not.toHaveProperty("rpcUrl");
});

test("wrong_values_are_named_and_never_quoted", () => {
  const message = failureOf({
    TENDER_NETWORK: "devnet",
    TENDER_CONTRACT: "Not An Account",
    TENDER_API_URL: "ftp://files.example/SECRETPATH",
    TENDER_ACCOUNT: "A",
    TENDER_PRIVATE_KEY: "ed25519:SECRETGARBAGE123",
    TENDER_JUDGE_ACCOUNT: "Not An Account Either",
    TENDER_TOKEN: "Nor This",
    NEAR_RPC_URL: "not a url",
  });

  expect(message).toBe(
    "TENDER_NETWORK must be one of sandbox, testnet, mainnet; " +
      "TENDER_CONTRACT must be a NEAR account id; " +
      `TENDER_API_URL must be ${AN_API_URL}; ` +
      "TENDER_ACCOUNT must be a NEAR account id; " +
      "TENDER_PRIVATE_KEY must be an access key, as ed25519:<base58>; " +
      "NEAR_RPC_URL must be an http(s) URL; " +
      "TENDER_JUDGE_ACCOUNT must be a NEAR account id; TENDER_TOKEN must be a NEAR account id",
  );
  for (const value of ["devnet", "SECRETPATH", "SECRETGARBAGE123", "Not An Account", "not a url"]) {
    expect(message).not.toContain(value);
  }

  // What is missing comes first, then what is wrong.
  expect(failureOf({ ...ENV, TENDER_NETWORK: "devnet", TENDER_ACCOUNT: "" })).toBe(
    "missing environment variable: TENDER_ACCOUNT; " +
      "TENDER_NETWORK must be one of sandbox, testnet, mainnet",
  );
});

test("the_api_url_is_https_unless_it_is_on_this_machine", () => {
  // The API takes a bearer token, which plain http would carry across the network in the clear.
  const refusal = `TENDER_API_URL must be ${AN_API_URL}`;
  const apiUrl = (value: string) => readConfig({ ...ENV, TENDER_API_URL: value }, home).apiUrl;

  for (const url of ["https://api.tender.example", "https://api.tender.example:8443"]) {
    expect(apiUrl(url)).toBe(url);
  }
  // A local API for development is plain http, and that stays possible.
  for (const url of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
    expect(apiUrl(url)).toBe(url);
  }

  // Anything else on http is refused, however much of it looks local: a name that starts or ends
  // like one, a loopback name in the path or the user part, and addresses that are not the three.
  for (const url of [
    "http://api.tender.example",
    "http://localhost.evil.example",
    "http://127.0.0.1.evil.example",
    "http://evil.example/localhost",
    "http://localhost@evil.example",
    "http://evil.example#127.0.0.1",
    "http://127.0.0.2:3000",
    "http://0.0.0.0:3000",
    "http://[::2]:3000",
  ]) {
    expect(failureOf({ ...ENV, TENDER_API_URL: url }), url).toBe(refusal);
  }
  // Other schemes, and values that are no URL, are refused as they were.
  for (const url of ["ftp://api.tender.example", "ws://localhost:3000", "api.tender.example"]) {
    expect(failureOf({ ...ENV, TENDER_API_URL: url }), url).toBe(refusal);
  }
  // The refusal does not quote the value, which can hold a key.
  expect(failureOf({ ...ENV, TENDER_API_URL: "http://evil.example/?key=SECRETKEY" })).not.toContain(
    "SECRETKEY",
  );
  // The RPC carries signed transactions and no bearer token, and is not held to this.
  expect(readConfig({ ...ENV, NEAR_RPC_URL: "http://rpc.tender.example:3030" }, home).rpcUrl).toBe(
    "http://rpc.tender.example:3030",
  );
});

test("the_api_url_is_read_as_canonical_base_reads_it", () => {
  // The base is where the client calls and whom its sign-in is signed for, so it is the one spelling
  // that `canonicalBase` writes: the scheme and the host in lower case, the default port left out,
  // and no trailing slash and no final /v1.
  const apiUrl = (value: string) => readConfig({ ...ENV, TENDER_API_URL: value }, home).apiUrl;
  const spellings: Array<[written: string, base: string]> = [
    ["https://api.tender.example/", "https://api.tender.example"],
    ["https://api.tender.example/v1", "https://api.tender.example"],
    ["https://api.tender.example/v1/", "https://api.tender.example"],
    ["https://API.Tender.Example:443/v1/", "https://api.tender.example"],
    ["https://api.tender.example:8443/v1", "https://api.tender.example:8443"],
    ["https://host.example/tender/v1", "https://host.example/tender"],
    ["http://LOCALHOST:3000", "http://localhost:3000"],
    ["http://127.0.0.1:3000/v1", "http://127.0.0.1:3000"],
    ["http://[::1]:3000/", "http://[::1]:3000"],
  ];
  for (const [written, base] of spellings) {
    expect(apiUrl(written), written).toBe(base);
    expect(canonicalBase(apiUrl(written)), written).toBe(apiUrl(written));
  }

  // What `canonicalBase` refuses is refused, with this file's words and not its own.
  const refusal = `TENDER_API_URL must be ${AN_API_URL}`;
  for (const url of [
    "http://user:pass@localhost:3000",
    "https://user:SECRETPASS@api.tender.example",
    "https://user@api.tender.example",
    "https://api.tender.example/?key=SECRETKEY",
    "https://api.tender.example?",
    "https://api.tender.example/#top",
    "https://api.tender.example#",
    "https://api.tender.example./",
    "https://api.tender.example//v1",
    "https://api.tender.example/v1/v1",
    "https://",
  ]) {
    const message = failureOf({ ...ENV, TENDER_API_URL: url });
    expect(message, url).toBe(refusal);
    for (const secret of ["SECRETPASS", "SECRETKEY", "canonical"]) {
      expect(message, url).not.toContain(secret);
    }
  }
});

test("the_config_and_the_api_client_take_the_same_api_urls", () => {
  // The bin builds `new ApiClient({ baseUrl: config.apiUrl, signer: config.signer })` once the
  // config is read. A URL that the config takes and the client refuses would stop the server after
  // its start-up message; one that the client takes and the config refuses is turned back for
  // nothing. So the two give one answer to each URL here, and the client's own loopback list, which
  // this file cannot read, is held to the config's.
  const verdict: Array<[url: string, taken: boolean]> = [
    ["https://api.tender.example", true],
    ["https://api.tender.example/", true],
    ["https://api.tender.example/v1", true],
    ["https://API.tender.example:443/v1/", true],
    ["https://api.tender.example:8443/tender/v1", true],
    ["http://localhost:8787", true],
    ["http://LOCALHOST:8787/v1/", true],
    ["http://127.0.0.1:8787", true],
    ["http://[::1]:8787", true],
    ["http://api.tender.example", false],
    ["http://127.0.0.2:8787", false],
    ["http://0.0.0.0:8787", false],
    ["http://[::2]:8787", false],
    ["http://localhost.evil.example", false],
    ["https://user:pw@api.tender.example", false],
    ["https://user@api.tender.example", false],
    ["https://api.tender.example/?key=1", false],
    ["https://api.tender.example?", false],
    ["https://api.tender.example/#top", false],
    ["https://api.tender.example#", false],
    ["https://api.tender.example./", false],
    ["https://api.tender.example:8443./", false],
    ["https://api.tender.example//v1", false],
    ["https://api.tender.example/v1/v1", false],
    ["ftp://api.tender.example", false],
    ["ws://localhost:8787", false],
    ["https://", false],
    ["api.tender.example", false],
    ["not a url", false],
  ];
  const asksConfig = (url: string) => {
    try {
      return readConfig({ ...ENV, TENDER_API_URL: url }, home);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return undefined;
    }
  };
  for (const [url, taken] of verdict) {
    const config = asksConfig(url);
    let clientTakes = true;
    try {
      new ApiClient({
        baseUrl: url,
        signer: { accountId: "alice.testnet", privateKey: KEY.toString() },
      });
    } catch {
      clientTakes = false;
    }
    expect(config !== undefined, `config: ${url}`).toBe(taken);
    expect(clientTakes, `client: ${url}`).toBe(taken);
    // And what the config hands on is what the bin gives the client, which takes it as it is.
    if (config !== undefined) {
      expect(
        () => new ApiClient({ baseUrl: config.apiUrl, signer: config.signer }),
        url,
      ).not.toThrow();
    }
  }
});

test("the_sandbox_needs_an_rpc_url_and_the_others_do_not", () => {
  const sandbox = { ...ENV, TENDER_NETWORK: "sandbox", TENDER_CONTRACT: "tender.sandbox" };

  expect(failureOf(sandbox)).toBe("missing environment variable: NEAR_RPC_URL");
  expect(readConfig({ ...sandbox, NEAR_RPC_URL: "http://127.0.0.1:3030" }, home)).toMatchObject({
    network: "sandbox",
    rpcUrl: "http://127.0.0.1:3030",
  });
  // The other networks have an RPC of their own.
  expect(readConfig(ENV, home)).not.toHaveProperty("rpcUrl");
});

test("state_dir_tilde_is_expanded", async () => {
  // A config file such as .mcp.json can hold `~/...`, and no shell expands it there.
  const config = readConfig({ ...ENV, TENDER_STATE_DIR: "~/tender-state" }, home);
  expect(config.stateDir).toBe(join(home, "tender-state"));

  // It is the directory the store writes in, and not a directory named `~` in the current one.
  const content = "answer";
  const contentHash = sha256Hex(content);
  const salt = "5a".repeat(32);
  await createStateStore(config.stateDir).saveDraft({
    taskId: "5",
    contentBase64: Buffer.from(content).toString("base64"),
    contentHash,
    salt,
    commitment: computeCommitment(5n, "alice.testnet", contentHash, salt),
  });
  expect(await readFile(join(home, "tender-state", "drafts", "5.json"), "utf8")).toContain(
    contentHash,
  );
  expect(existsSync(join(process.cwd(), "~"))).toBe(false);

  expect(readConfig({ ...ENV, TENDER_STATE_DIR: "~" }, home).stateDir).toBe(home);
  // Any other path is the operator's own.
  expect(readConfig({ ...ENV, TENDER_STATE_DIR: "/srv/state" }, home).stateDir).toBe("/srv/state");
  expect(readConfig({ ...ENV, TENDER_STATE_DIR: "state/here" }, home).stateDir).toBe("state/here");
  expect(readConfig({ ...ENV, TENDER_STATE_DIR: "a~b/~c" }, home).stateDir).toBe("a~b/~c");

  // `~user` is not expanded, and would be taken for a directory of that name.
  expect(failureOf({ ...ENV, TENDER_STATE_DIR: "~bob/state" })).toBe(
    "TENDER_STATE_DIR must not start with ~user: only ~ and ~/ are expanded",
  );
  // With no home to expand to, it says so rather than writing under the current directory.
  expect(() => expandHome("~/state", "")).toThrow(/home directory is not known/);
  expect(expandHome("~/state", homedir())).toBe(join(homedir(), "state"));
});

test("files_dir_is_an_absolute_path_or_nothing", () => {
  // P04-R1: the one directory commit_result may read a file from. Nothing set means no files.
  const filesDir = (value: string) =>
    readConfig({ ...ENV, TENDER_FILES_DIR: value }, home).filesDir;

  expect(readConfig(ENV, home)).not.toHaveProperty("filesDir");
  for (const unset of ["", "   "]) expect(filesDir(unset)).toBeUndefined();

  // (The directory is there, and the user's own: see the tests that follow.)
  const tenderFiles = join(home, "tender-files");
  mkdirSync(tenderFiles, { mode: 0o700 });
  mkdirSync(join(home, "results"), { mode: 0o700 });
  expect(filesDir(tenderFiles)).toBe(tenderFiles);
  // Space around the value is not part of it, and a leading ~ is the home directory, as in
  // TENDER_STATE_DIR: a config file holds `~/...` and no shell expands it there.
  expect(filesDir(` ${tenderFiles} \n`)).toBe(tenderFiles);
  expect(filesDir("~/results")).toBe(join(home, "results"));
  expect(filesDir("~")).toBe(home);

  // A relative path would mean the directory the client happened to start the server in. The
  // message names the variable and does not quote what it was given.
  for (const bad of ["results", "./results", "../results", "a~b/~c"]) {
    expect(failureOf({ ...ENV, TENDER_FILES_DIR: bad }), bad).toBe(
      "TENDER_FILES_DIR must be an absolute path",
    );
  }
  expect(failureOf({ ...ENV, TENDER_FILES_DIR: "~bob/results" })).toBe(
    "TENDER_FILES_DIR must not start with ~user: only ~ and ~/ are expanded",
  );
  expect(() => expandHome("~/results", "", "TENDER_FILES_DIR")).toThrow(
    "TENDER_FILES_DIR starts with ~, but the home directory is not known",
  );
  expect(failureOf({ ...ENV, TENDER_FILES_DIR: "relative/SECRETPATH" })).not.toContain(
    "SECRETPATH",
  );

  // It is reported with the other faults, after the ones that come before it.
  expect(
    failureOf({
      ...ENV,
      TENDER_NETWORK: "devnet",
      TENDER_STATE_DIR: "~bob/state",
      TENDER_FILES_DIR: "results",
    }),
  ).toBe(
    "TENDER_NETWORK must be one of sandbox, testnet, mainnet; " +
      "TENDER_STATE_DIR must not start with ~user: only ~ and ~/ are expanded; " +
      "TENDER_FILES_DIR must be an absolute path",
  );
});

/** A directory `name` under `parent`, with exactly `mode` (a umask does not change what chmod sets). */
function makeDir(parent: string, name: string, mode = 0o700): string {
  const path = join(parent, name);
  mkdirSync(path);
  chmodSync(path, mode);
  return path;
}

/** What `readConfig` says of a TENDER_FILES_DIR that others could write in, or that is not there. */
const SHARED = /^TENDER_FILES_DIR must be a directory that only you can write to: /;
const MISSING = "TENDER_FILES_DIR must be a directory that exists";

test("files_dir_must_be_a_directory_that_only_the_user_can_write_to", () => {
  // P04-R2: whoever can write in the directory can race a file read's checks, so it is the user's
  // alone. First the mode of the directory itself: nothing for a group or for others to write.
  const files = makeDir(home, "files");
  const env = { ...ENV, TENDER_FILES_DIR: files };
  for (const [mode, accepted] of [
    [0o700, true],
    [0o750, true],
    [0o755, true],
    [0o775, false],
    [0o757, false],
    [0o770, false],
    [0o707, false],
    [0o720, false],
    [0o702, false],
    [0o777, false],
  ] as const) {
    chmodSync(files, mode);
    if (accepted) expect(readConfig(env, home).filesDir, mode.toString(8)).toBe(files);
    else expect(failureOf(env), mode.toString(8)).toMatch(SHARED);
  }

  // Then a directory above it, up to the home, and the home itself.
  chmodSync(files, 0o700);
  const inner = makeDir(files, "inner");
  const innerEnv = { ...ENV, TENDER_FILES_DIR: inner };
  expect(readConfig(innerEnv, home).filesDir).toBe(inner);
  chmodSync(files, 0o775);
  expect(failureOf(innerEnv)).toMatch(SHARED);
  chmodSync(files, 0o700);
  chmodSync(home, 0o775);
  expect(failureOf(env)).toMatch(SHARED);
  chmodSync(home, 0o700);
  expect(readConfig(env, home).filesDir).toBe(files);

  // The message names the variable and the rule, and no path.
  chmodSync(files, 0o777);
  expect(failureOf(env)).not.toContain(home);
  // It is reported with the other faults, in order.
  expect(failureOf({ ...env, TENDER_NETWORK: "devnet" })).toMatch(
    /^TENDER_NETWORK must be one of sandbox, testnet, mainnet; TENDER_FILES_DIR must be a directory that only you can write to: /,
  );
});

test("files_dir_is_looked_at_up_to_the_home_directory_or_else_up_to_the_root", () => {
  // A directory above the home is not looked at: this one is open to everybody, as /tmp is.
  const open = makeDir(home, "open", 0o777);
  const mine = makeDir(open, "me");
  const files = makeDir(mine, "files");
  const env = { ...ENV, TENDER_FILES_DIR: files };
  expect(readConfig(env, mine).filesDir).toBe(files);
  // The home itself is the top (and the only one, for the directory that is the home).
  expect(readConfig({ ...ENV, TENDER_FILES_DIR: mine }, mine).filesDir).toBe(mine);

  // Under no home of the user's, the way goes on up through `me` to the open directory.
  expect(failureOf(env, join(home, "elsewhere"))).toMatch(SHARED);
  chmodSync(open, 0o755);
  expect(readConfig(env, home).filesDir).toBe(files);
});

test("a_files_dir_that_is_not_there_or_is_no_directory_is_refused", () => {
  // It could be made by anybody later, with any mode, so it is refused now.
  writeFileSync(join(home, "plain"), "x");
  for (const bad of ["nothing", "plain", join("nothing", "deeper"), join("plain", "deeper")]) {
    expect(failureOf({ ...ENV, TENDER_FILES_DIR: join(home, bad) }), bad).toBe(MISSING);
  }
  expect(failureOf({ ...ENV, TENDER_FILES_DIR: join(home, "nothing") })).not.toContain(home);
});

test("a_files_dir_may_be_reached_through_a_link_if_where_it_leads_is_the_users_alone", () => {
  // `lstat` does not follow a link, so a link on the way is judged as a link (it must be the user's
  // or root's) and the place it leads to is looked at by its real path as well.
  const real = makeDir(home, "real");
  const files = makeDir(real, "files");
  symlinkSync(real, join(home, "link"), "dir");
  symlinkSync(files, join(home, "files-link"), "dir");

  for (const through of [join(home, "link", "files"), join(home, "files-link")]) {
    expect(readConfig({ ...ENV, TENDER_FILES_DIR: through }, home).filesDir, through).toBe(through);
  }
  // The link is the user's, and the place it leads to is open to a group: refused.
  chmodSync(real, 0o775);
  expect(failureOf({ ...ENV, TENDER_FILES_DIR: join(home, "link", "files") })).toMatch(SHARED);
  chmodSync(real, 0o700);
  chmodSync(files, 0o775);
  expect(failureOf({ ...ENV, TENDER_FILES_DIR: join(home, "files-link") })).toMatch(SHARED);
});

test("files_dir_and_the_directories_above_it_belong_to_the_user_or_to_root", () => {
  const me = process.getuid?.();
  if (me === undefined) return;
  const other = me + 1;
  const found = (uid: number, mode: number, kind: "dir" | "link" | "file" = "dir") => ({
    uid,
    mode: { dir: 0o40000, link: 0o120000, file: 0o100000 }[kind] | mode,
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => kind === "link",
  });
  type Found = ReturnType<typeof found>;
  const FILES = "/srv/tender/files";
  const clean = (): Record<string, Found> => ({
    [FILES]: found(me, 0o700),
    "/srv/tender": found(0, 0o755),
    "/srv": found(0, 0o755),
    "/": found(0, 0o755),
  });
  /**
   * What `readConfig` makes of FILES on a disk that has `entries` and nothing else, under the home
   * `at`, where `leads` says where each path leads (to itself, unless it is a link).
   */
  const verdict = (
    entries: Record<string, Found>,
    at = "/home/me",
    leads: (path: string) => string = (path) => path,
  ): string | undefined => {
    vi.mocked(lstatSync).mockImplementation(((path: string) => {
      const entry = entries[path];
      if (entry === undefined) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), {
          code: "ENOENT",
        });
      }
      return entry;
    }) as never);
    vi.mocked(realpathSync).mockImplementation(((path: string) => leads(path)) as never);
    try {
      return readConfig({ ...ENV, TENDER_FILES_DIR: FILES }, at).filesDir;
    } catch (error) {
      return (error as Error).message;
    }
  };

  // Directories above it may be root's, or the user's.
  expect(verdict(clean())).toBe(FILES);
  expect(verdict({ ...clean(), "/srv/tender": found(me, 0o700) })).toBe(FILES);
  // The directory itself must be the user's: not root's, not another user's.
  expect(verdict({ ...clean(), [FILES]: found(0, 0o700) })).toMatch(SHARED);
  expect(verdict({ ...clean(), [FILES]: found(other, 0o700) })).toMatch(SHARED);
  // Any directory above it must be the user's or root's, however high.
  for (const above of ["/srv/tender", "/srv", "/"]) {
    expect(verdict({ ...clean(), [above]: found(other, 0o755) }), above).toMatch(SHARED);
  }
  // And not open to a group or to others, however high; the sticky bit is no excuse.
  for (const above of ["/srv/tender", "/srv", "/"]) {
    for (const mode of [0o775, 0o757, 0o1777]) {
      expect(verdict({ ...clean(), [above]: found(0, mode) }), `${above} ${mode}`).toMatch(SHARED);
    }
  }
  // The way stops at the home, and at the root otherwise.
  expect(verdict({ ...clean(), "/": found(other, 0o777) }, "/srv")).toBe(FILES);
  expect(verdict({ ...clean(), "/srv": found(other, 0o777) }, "/srv")).toMatch(SHARED);
  expect(verdict({ ...clean(), "/srv": found(other, 0o777) }, FILES)).toBe(FILES);

  // A link is judged as a link: the user's or root's will do, another user's will not.
  expect(verdict({ ...clean(), [FILES]: found(me, 0o777, "link") })).toBe(FILES);
  expect(verdict({ ...clean(), [FILES]: found(0, 0o777, "link") })).toBe(FILES);
  expect(verdict({ ...clean(), [FILES]: found(other, 0o777, "link") })).toMatch(SHARED);
  expect(verdict({ ...clean(), "/srv/tender": found(other, 0o777, "link") })).toMatch(SHARED);

  // A link that leads to another place: that place is looked at, up to the root, and not the way
  // to the link. (Nothing but the link's own owner and its parents is asked of the link.)
  const away = (path: string) => (path === FILES ? "/data/files" : path);
  const leading = (): Record<string, Found> => ({
    ...clean(),
    [FILES]: found(me, 0o777, "link"),
    "/data/files": found(me, 0o700),
    "/data": found(0, 0o755),
  });
  expect(verdict(leading(), "/home/me", away)).toBe(FILES);
  expect(verdict({ ...leading(), "/data/files": found(other, 0o700) }, "/home/me", away)).toMatch(
    SHARED,
  );
  expect(verdict({ ...leading(), "/data/files": found(me, 0o770) }, "/home/me", away)).toMatch(
    SHARED,
  );
  expect(verdict({ ...leading(), "/data": found(other, 0o755) }, "/home/me", away)).toMatch(SHARED);
  expect(verdict({ ...leading(), "/data": found(0, 0o777) }, "/home/me", away)).toMatch(SHARED);
  // A way that lstat found and that cannot be followed to a real path is refused as missing.
  const vanished = () => {
    throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
  };
  expect(verdict(clean(), "/home/me", vanished)).toBe(MISSING);

  // A directory that is not there, or is a file, is refused; a parent that cannot be read, too.
  const { [FILES]: _gone, ...without } = clean();
  expect(verdict(without)).toBe(MISSING);
  expect(verdict({ ...clean(), [FILES]: found(me, 0o600, "file") })).toBe(MISSING);
  const { "/srv": _hidden, ...unseen } = clean();
  expect(verdict(unseen)).toMatch(SHARED);
});

test("files_dir_is_not_looked_at_where_there_are_no_user_ids", () => {
  // Windows has no owner or mode of the kind: nothing is compared, and the disk is not asked.
  const original = Object.getOwnPropertyDescriptor(process, "getuid");
  Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
  try {
    const files = join(home, "not-there-and-not-looked-for");
    expect(readConfig({ ...ENV, TENDER_FILES_DIR: files }, home).filesDir).toBe(files);
    expect(lstatSync).not.toHaveBeenCalled();
  } finally {
    if (original !== undefined) Object.defineProperty(process, "getuid", original);
  }
});

/** A contract whose token list is `tokens`, as `get_config` reports it. */
function chainListing(tokens: Array<[token: string, enabled: boolean]>) {
  const getConfig = vi.fn<TenderClient["getConfig"]>(
    async () =>
      ({
        tokens: tokens.map(([token, enabled]) => ({
          token,
          enabled,
          min_reward: "1",
          max_reward: "1000000000",
        })),
      }) as ConfigView,
  );
  return { client: { getConfig }, getConfig };
}

test("the_default_token_is_the_env_then_usdc_then_the_first_enabled", async () => {
  const usdc = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";

  // TENDER_TOKEN, whatever the contract lists. The contract is not even asked.
  const named = chainListing([[usdc, true]]);
  expect(
    await resolveDefaultToken({ network: "testnet", token: "mine.testnet" }, named.client),
  ).toBe("mine.testnet");
  expect(named.getConfig).not.toHaveBeenCalled();

  // The network's USDC when it is listed as enabled, even if another token comes first.
  const withUsdc = chainListing([
    ["wrap.testnet", true],
    [usdc, true],
  ]);
  expect(await resolveDefaultToken({ network: "testnet" }, withUsdc.client)).toBe(usdc);

  // Listed but switched off, USDC is not the default: the first enabled token is.
  const off = chainListing([
    [usdc, false],
    ["wrap.testnet", false],
    ["tusdc.testnet", true],
  ]);
  expect(await resolveDefaultToken({ network: "testnet" }, off.client)).toBe("tusdc.testnet");

  // The sandbox has no USDC, so its first enabled token it is.
  const sandbox = chainListing([["usdc.sandbox", true]]);
  expect(await resolveDefaultToken({ network: "sandbox" }, sandbox.client)).toBe("usdc.sandbox");

  // With no enabled token there is no default, and the message says what to set.
  const none = chainListing([[usdc, false]]);
  await expect(resolveDefaultToken({ network: "mainnet" }, none.client)).rejects.toThrow(
    new ConfigError("the contract lists no enabled token: set TENDER_TOKEN"),
  );
});

test("a_startup_failure_prints_on_one_line_without_secrets", () => {
  const key = KEY.toString();
  const body = key.slice("ed25519:".length);
  expect(secretsOf(readConfig(ENV, home))).toEqual([key, body]);
  const error = new TypeError(
    `cannot use ${key} (${body}) at https://rpc.example.com/?apiKey=K\nbad`,
  );

  expect(describeFailure(error, [key, body])).toBe(
    "TypeError: cannot use <redacted> (<redacted>) at <url> bad",
  );
  // The body alone is cut too, when a library quotes only that.
  expect(describeFailure(new Error(`bad key ${body}`), [key, body])).toBe(
    "Error: bad key <redacted>",
  );
  // A message about the environment is already one clean line, and has no name in front.
  expect(describeFailure(new ConfigError("missing environment variable: TENDER_ACCOUNT"))).toBe(
    "missing environment variable: TENDER_ACCOUNT",
  );
  // An empty secret cuts nothing, and not everything.
  expect(describeFailure(new Error("fine"), [""])).toBe("Error: fine");
  expect(describeFailure("a string", [])).toBe("a string");
  // A bearer token is cut by its shape, as it is in the tools' errors, since no list names it.
  expect(
    describeFailure(new Error("sent Authorization: Bearer abc123.DEF-456_ghi= and failed")),
  ).toBe("Error: sent Authorization: Bearer <redacted> and failed");
});

test("the_secrets_include_the_credentials_of_the_rpc_url", () => {
  const key = KEY.toString();
  const body = key.slice("ed25519:".length);
  // A provider's URL can carry a password, a key in its query or a token in its path.
  const password = "word-word-word";
  const queryValue = "query-query-1234";
  const pathToken = "ab12ab12ab12ab12ab12";
  const url = `https://user:${password}@rpc.example.com/v2/${pathToken}?apiKey=${queryValue}&network=mainnet`;
  const config = readConfig({ ...ENV, NEAR_RPC_URL: url }, home);

  const secrets = secretsOf(config);

  // The key first, then what the URL holds; the user name, the network and the host are not secrets.
  expect(secrets).toEqual([key, body, password, queryValue, pathToken]);
  // So a failure that quotes the URL's pieces has them cut out, as the key is.
  expect(
    describeFailure(new Error(`bad gateway: ${password}, ${queryValue}, ${pathToken}`), secrets),
  ).toBe("Error: bad gateway: <redacted>, <redacted>, <redacted>");

  // A URL with nothing secret in it adds nothing, and neither does none.
  for (const plain of [
    "https://rpc.testnet.near.org",
    "https://rpc.example.com/?key=1",
    "http://127.0.0.1:3030",
  ]) {
    expect(secretsOf(readConfig({ ...ENV, NEAR_RPC_URL: plain }, home)), plain).toEqual([
      key,
      body,
    ]);
  }
  expect(secretsOf(readConfig(ENV, home))).toEqual([key, body]);
});

/** What the bin did with `env` as its whole environment. */
async function runBin(env: Record<string, string>) {
  try {
    const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", BIN], {
      cwd: ROOT,
      env,
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string };
    return { code, stdout, stderr };
  }
}

test("bin_exits_naming_missing_vars", { timeout: 120_000 }, async () => {
  const key = KEY.toString();
  const body = key.slice("ed25519:".length);
  const pieces = [key, body, body.slice(0, 8), body.slice(-8)];

  // Nothing set: one line on stderr naming every variable that is needed, and none that is not.
  const empty = await runBin({});
  expect(empty).toEqual({
    code: 1,
    stdout: "",
    stderr:
      "tender-mcp: missing environment variables: TENDER_NETWORK, TENDER_CONTRACT, " +
      "TENDER_API_URL, TENDER_ACCOUNT, TENDER_PRIVATE_KEY\n",
  });

  // With the key set and others missing, the line names the others and holds no part of the key.
  const partial = await runBin({
    TENDER_NETWORK: "testnet",
    TENDER_ACCOUNT: "alice.testnet",
    TENDER_PRIVATE_KEY: key,
  });
  expect(partial).toEqual({
    code: 1,
    stdout: "",
    stderr: "tender-mcp: missing environment variables: TENDER_CONTRACT, TENDER_API_URL\n",
  });

  // A key that is no key is refused without being quoted.
  const garbage = await runBin({ ...ENV, TENDER_PRIVATE_KEY: "ed25519:SECRETGARBAGE123" });
  expect(garbage).toEqual({
    code: 1,
    stdout: "",
    stderr: "tender-mcp: TENDER_PRIVATE_KEY must be an access key, as ed25519:<base58>\n",
  });

  for (const output of [empty, partial, garbage].map((r) => r.stdout + r.stderr)) {
    for (const piece of pieces) expect(output).not.toContain(piece);
    expect(output).not.toContain("SECRETGARBAGE123");
  }
});
