import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { TenderClient } from "@tender/client";
import { type ConfigView, computeCommitment, sha256Hex } from "@tender/shared";
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

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = "packages/mcp/bin/tender-mcp.ts";

const KEY = KeyPair.fromRandom("ed25519");
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
  await rm(home, { recursive: true, force: true });
});

/** The message `readConfig` fails with. */
function failureOf(env: Record<string, string>): string {
  try {
    readConfig(env, home);
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
  const everything = {
    ...ENV,
    TENDER_NETWORK: " mainnet\n",
    NEAR_RPC_URL: "https://rpc.example.com/?key=1",
    TENDER_STATE_DIR: "/srv/tender-state",
    TENDER_FILES_DIR: "/srv/tender-files",
    TENDER_JUDGE_ACCOUNT: "judge.testnet",
    TENDER_TOKEN: "usdc.testnet",
  };
  expect(readConfig(everything, home)).toMatchObject({
    network: "mainnet",
    rpcUrl: "https://rpc.example.com/?key=1",
    stateDir: "/srv/tender-state",
    filesDir: "/srv/tender-files",
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
      "TENDER_API_URL must be an https URL, or an http URL to localhost, 127.0.0.1 or [::1]; " +
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
  const refusal =
    "TENDER_API_URL must be an https URL, or an http URL to localhost, 127.0.0.1 or [::1]";
  const apiUrl = (value: string) => readConfig({ ...ENV, TENDER_API_URL: value }, home).apiUrl;

  for (const url of ["https://api.tender.example", "https://api.tender.example:8443/v1"]) {
    expect(apiUrl(url)).toBe(url);
  }
  // A local API for development is plain http, and that stays possible.
  for (const url of [
    "http://localhost:3000",
    "http://127.0.0.1:3000/v1",
    "http://[::1]:3000",
    "http://LOCALHOST:3000",
    "http://user:pass@localhost:3000",
  ]) {
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

  expect(filesDir("/srv/tender-files")).toBe("/srv/tender-files");
  // Space around the value is not part of it, and a leading ~ is the home directory, as in
  // TENDER_STATE_DIR: a config file holds `~/...` and no shell expands it there.
  expect(filesDir(" /srv/tender-files \n")).toBe("/srv/tender-files");
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
