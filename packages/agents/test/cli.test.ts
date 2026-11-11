import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, relative as relativePath, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ApiClient, ApiTimeoutError, KeyPair } from "@tender/client";
import {
  type AgentView,
  ApiError,
  type ConfigView,
  canonicalJson,
  MODEL_AGENT_POLICY,
  SIGN_IN_MESSAGE,
  sha256Hex,
  type TenderApi,
} from "@tender/shared";
import { afterEach, expect, test, vi } from "vitest";
import { AGENT_NAMES, AGENTS, agentVariables } from "../src/agents";
import {
  type CliClient,
  CliError,
  type CliOptions,
  checkAgentKey,
  createApiClient,
  type ExitIo,
  envDirOf,
  exitWhenFlushed,
  main,
  parseCli,
  privateSeedsDirOf,
  type RunConfig,
  readEnv,
  readRunConfig,
  registrationWarning,
} from "../src/cli";
import { ENTRY_COUNTS_FILE } from "../src/policy";
import type { RunAgentOptions } from "../src/runner";
import { FAKE_TOKEN, type FakeApi, REFUSAL_TEXT, startFakeApi } from "./fake-api";
import { startFakeLlm } from "./fake-llm";
import { BRIEF, contextOf, taskSpec } from "./helpers";

// The command line of the reference agents, run in-process: the test hands `main` an environment,
// env files in a directory of its own, and a client that stands in for the chain, so that nothing
// here reaches a network, a model, or the real home directory. The `run` that `main` calls is a
// stand-in too; it records what it was given.

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SEEDS = join(ROOT, "seeds");
const BIN = "packages/agents/bin/run-agent.ts";

const CONTRACT = "tender.testnet";
const ACCOUNT = "analyst.tender.testnet";
/** The function-call key the analyst signs with, and the full-access key the deploy made for it. */
const AGENT_KEY = KeyPair.fromRandom("ed25519");
const FULL_KEY = KeyPair.fromRandom("ed25519");
const AGENT_PUBLIC = AGENT_KEY.getPublicKey().toString();

/** What the command needs for the analyst on testnet, and nothing it does not. */
const ENV: Record<string, string> = {
  TENDER_CONTRACT: CONTRACT,
  TENDER_API_URL: "https://api.tender.example",
  AGENT_ANALYST_ACCOUNT: ACCOUNT,
  AGENT_ANALYST_PRIVATE_KEY: AGENT_KEY.toString(),
};
/** Recognisable in any output: the model's key must never be printed. */
const LLM_KEY = "sk-test-LLM-SECRET-0001";
/** The Judge the API serves, which the deploy writes to `.env.deploy.<network>`. */
const JUDGE_ACCOUNT = "judge.tender.testnet";
/** What an agent with a model needs besides `ENV`: the model, and the Judge, its only verifier by default. */
const LLM_ENV: Record<string, string> = {
  LLM_BASE_URL: "https://llm.example/v1",
  LLM_API_KEY: LLM_KEY,
  LLM_MODEL: "test-org/test-model-7",
  JUDGE_ACCOUNT,
};
const ARGS = ["--agent", "analyst", "--solver", "offline", "--network", "testnet"];
const LLM_ARGS = ["--agent", "analyst", "--solver", "llm", "--network", "testnet"];
const USAGE =
  "usage: pnpm exec tsx packages/agents/bin/run-agent.ts --agent analyst|coder|extractor --solver llm|offline|weak --network sandbox|testnet|mainnet [--max-llm-calls-per-hour N] [--verifiers judge|any|<account>,...] [--min-reward <token>=<amount>]... [--daily-entries N] [--daily-judged-hires N] [--max-voids-after-reveals N] [--max-poster-voids N]";
const KEY_COMMAND =
  "pnpm exec tsx scripts/keeper-key.ts --network testnet --role agent --agent analyst";

/** What a key of the account looks like to the RPC: limited to a receiver, for some methods. */
const functionCall = (over: Record<string, unknown> = {}) => ({
  FunctionCall: {
    allowance: null,
    receiver_id: CONTRACT,
    method_names: ["commit", "reveal"],
    ...over,
  },
});

type Found = Awaited<ReturnType<CliClient["viewAccessKey"]>>;

/** The part of a private key after `ed25519:`, and pieces of it: none may reach any output. */
function piecesOf(key: KeyPair): string[] {
  const text = key.toString();
  const body = text.slice("ed25519:".length);
  return [text, body, body.slice(0, 8), body.slice(-8)];
}

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A new directory holding the given files. */
async function dirWith(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tender-run-agent-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}

/** The agent as the chain shows it: active, with a bond. */
function agentView(over: Partial<AgentView> = {}): AgentView {
  return {
    account: ACCOUNT,
    asp: null,
    profile_uri: "tender://agent/analyst",
    profile_hash: "ab".repeat(32),
    tags: [],
    registered_at: "1793745950569746000",
    entries: 0,
    reveals: 0,
    wins: 0,
    earned: [],
    picks_made: 0,
    voids_after_reveals: 0,
    status: "active",
    bond_token: "usdc.testnet",
    bond_amount: "1000000",
    claimable_at: null,
    locked_until: null,
    ...over,
  };
}

/** The config as the chain shows it, with the bond of 1 USDC set unless a test says otherwise. */
function configView(over: Partial<ConfigView> = {}): ConfigView {
  return {
    owner: "owner.testnet",
    pending_owner: null,
    treasury: "treasury.testnet",
    fee_bps: 500,
    min_window_secs: 60,
    max_window_secs: 604_800,
    paused: false,
    version: 1,
    tokens: [],
    agent_bond_token: "usdc.testnet",
    agent_bond_amount: "1000000",
    agent_bond_cooldown_secs: "86400",
    ...over,
  };
}

/**
 * A client whose working parts are the read of a key's permission and the read of the agent. Whatever else the command
 * asks of it fails the test: checking a key must never commit, reveal or read an entry.
 */
function fakeClient(
  viewAccessKey: CliClient["viewAccessKey"],
  getAgent: CliClient["getAgent"],
  getConfig: CliClient["getConfig"],
): CliClient {
  const unexpected = (what: string) => () => {
    throw new Error(`the agent's client was asked to ${what}`);
  };
  return {
    accountId: ACCOUNT,
    viewAccessKey,
    getAgent,
    getConfig,
    commit: unexpected("commit"),
    reveal: unexpected("reveal"),
    storageBalanceOf: unexpected("read a storage balance"),
    getEntry: unexpected("read an entry"),
  } as unknown as CliClient;
}

interface Setup {
  /** The process's variables. Default: `ENV`. */
  env?: Record<string, string | undefined>;
  /** Files of the repository root. */
  files?: Record<string, string>;
  /**
   * Gives the files' directory to `main` as `TENDER_ENV_DIR` of the environment, and no `dir`, as
   * the bin gives it.
   */
  dirFromEnv?: boolean;
  /** What the chain says of the key. Default: a function-call key limited to Tender. */
  key?: () => Promise<Found>;
  /** What the chain says of the agent's registration. Default: an active agent. */
  agent?: () => Promise<AgentView | null>;
  /** What the chain's config says. Default: a bond of 1 USDC is set. */
  config?: () => Promise<ConfigView>;
  /** What the agent's loop does. Default: nothing, and it ends. */
  loop?: (options: RunAgentOptions) => Promise<void>;
  /** The Tender API client. Default: an empty stand-in. */
  createApi?: (config: RunConfig) => TenderApi;
  /** How long the chain has to answer the key check. */
  keyCheckMs?: number;
  /** What stops the agent. Default: a signal that never aborts; `null` leaves it to the process's. */
  signal?: AbortSignal | null;
  /** Where the scripted solvers find the seeds. Default: the repository's `seeds/`. */
  seedsDir?: string;
  /** Where they find the real seeds' solutions. Default: what the environment says. */
  privateDir?: string;
}

/** Runs the command line with `args` against the setup, and reports what happened. */
async function start(args: string[], setup: Setup = {}) {
  const dir = await dirWith(setup.files);
  const home = await dirWith();
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[] = [];
  // The agent signs in once when it starts, and the stand-in lets it.
  const api = {
    signIn: vi.fn(async () => {
      calls.push("signIn");
      return "token";
    }),
  } as unknown as TenderApi;

  const viewAccessKey = vi.fn(async (_account: string, _publicKey: string): Promise<Found> => {
    calls.push("viewAccessKey");
    return setup.key === undefined
      ? ({ permission: functionCall() } as unknown as Found)
      : setup.key();
  });
  const getAgent = vi.fn(async (_account: string): Promise<AgentView | null> => {
    calls.push("getAgent");
    return setup.agent === undefined ? agentView() : setup.agent();
  });
  const getConfig = vi.fn(async (): Promise<ConfigView> => {
    calls.push("getConfig");
    return setup.config === undefined ? configView() : setup.config();
  });
  const client = fakeClient(viewAccessKey, getAgent, getConfig);
  const makeClient = vi.fn((_config: RunConfig) => {
    calls.push("makeClient");
    return client;
  });
  const createApi = vi.fn((config: RunConfig) => {
    calls.push("createApi");
    return setup.createApi === undefined ? api : setup.createApi(config);
  });
  // `main` reports a failure of the loop as a line on stderr. An assertion made inside the loop must
  // fail the test with its own message, and not as an exit code that differs.
  let assertion: Error | undefined;
  const loop = vi.fn(async (options: RunAgentOptions) => {
    calls.push("run");
    try {
      await setup.loop?.(options);
    } catch (error) {
      if (error instanceof Error && error.name === "AssertionError") assertion = error;
      throw error;
    }
  });

  const options: CliOptions = {
    createApi,
    ...(setup.dirFromEnv !== true && { dir }),
    home,
    env: {
      ...(setup.env ?? ENV),
      ...(setup.dirFromEnv === true && { TENDER_ENV_DIR: dir }),
    },
    seedsDir: setup.seedsDir ?? SEEDS,
    ...(setup.privateDir !== undefined && { privateDir: setup.privateDir }),
    out: (line) => out.push(line),
    err: (text) => err.push(text),
    makeClient,
    run: loop,
    keyCheckMs: setup.keyCheckMs,
    ...(setup.signal !== null && { signal: setup.signal ?? new AbortController().signal }),
  };
  const code = await main(args, options);
  if (assertion !== undefined) throw assertion;
  return {
    code,
    out,
    err,
    calls,
    client,
    api,
    home,
    viewAccessKey,
    getAgent,
    getConfig,
    makeClient,
    createApi,
    loop,
  };
}

/** The one thing `main` printed to stderr, which holds nothing of the environment's values. */
const said = (result: { err: string[] }) => result.err.join("\n");

// ---- The agent's key ----------------------------------------------------------------------------

test("run_agent_refuses_a_full_access_key", async () => {
  const result = await start(ARGS, {
    env: { ...ENV, AGENT_ANALYST_PRIVATE_KEY: FULL_KEY.toString() },
    key: async () => ({ permission: "FullAccess" }),
  });

  expect(result.code).toBe(1);
  expect(result.out).toEqual([]);
  const message = said(result);
  expect(message).toMatch(/^run-agent: /);
  // It names the variable and the account, shows the key by its public half, and says what is wrong.
  expect(message).toContain("AGENT_ANALYST_PRIVATE_KEY");
  expect(message).toContain("AGENT_ANALYST_ACCOUNT");
  expect(message).toContain(FULL_KEY.getPublicKey().toString());
  expect(message).toContain("a full-access key");
  // It points to the key script, and warns off the one fix that would lock the account for good.
  expect(message).toContain(KEY_COMMAND);
  expect(message).toContain("Do not delete this key from the account");
  for (const piece of piecesOf(FULL_KEY)) expect(message).not.toContain(piece);

  // The chain was asked about this key on this account. The agent went no further: no API client,
  // no solver, no loop.
  expect(result.viewAccessKey).toHaveBeenCalledTimes(1);
  expect(result.viewAccessKey).toHaveBeenCalledWith(ACCOUNT, FULL_KEY.getPublicKey().toString());
  expect(result.createApi).not.toHaveBeenCalled();
  expect(result.loop).not.toHaveBeenCalled();
});

test("run_agent_refuses_a_key_that_is_not_limited_to_tender", async () => {
  const cases: Array<[string, unknown]> = [
    ["another receiver", functionCall({ receiver_id: "other.testnet" })],
    ["a receiver that only starts like Tender", functionCall({ receiver_id: `${CONTRACT}.evil` })],
    ["a gas key", { GasKeyFunctionCall: { receiver_id: CONTRACT, method_names: [] } }],
    ["a kind it does not know", "SomethingNew"],
  ];
  for (const [what, permission] of cases) {
    const result = await start(ARGS, { key: async () => ({ permission }) as unknown as Found });

    expect(result.code, what).toBe(1);
    const message = said(result);
    expect(message, what).toContain("is not a function-call key limited to tender.testnet");
    expect(message, what).toContain("AGENT_ANALYST_PRIVATE_KEY");
    expect(message, what).toContain(AGENT_PUBLIC);
    expect(message, what).toContain(KEY_COMMAND);
    for (const piece of piecesOf(AGENT_KEY)) expect(message, what).not.toContain(piece);
    expect(result.createApi, what).not.toHaveBeenCalled();
    expect(result.loop, what).not.toHaveBeenCalled();
  }
});

test("run_agent_refuses_a_key_the_account_does_not_have", async () => {
  const result = await start(ARGS, { key: async () => null });

  expect(result.code).toBe(1);
  const message = said(result);
  expect(message).toContain(`AGENT_ANALYST_PRIVATE_KEY holds ${AGENT_PUBLIC}`);
  expect(message).toContain(`not a key of ${ACCOUNT} (AGENT_ANALYST_ACCOUNT)`);
  expect(message).toContain(KEY_COMMAND);
  for (const piece of piecesOf(AGENT_KEY)) expect(message).not.toContain(piece);
  expect(result.loop).not.toHaveBeenCalled();
});

test("run_agent_does_not_start_when_the_chain_cannot_say_what_the_key_may_do", async () => {
  // The error is not quoted: a message can hold the RPC's URL with its key in it.
  const result = await start(ARGS, {
    key: async () => {
      throw Object.assign(new Error("POST https://rpc.example/?apikey=RPC-SECRET-9 failed"), {
        code: "ECONNREFUSED",
      });
    },
  });

  expect(result.code).toBe(1);
  const message = said(result);
  expect(message).toContain("cannot ask the chain what AGENT_ANALYST_PRIVATE_KEY may do");
  expect(message).toContain("(Error ECONNREFUSED)");
  expect(message).toContain("does not start with a key that was not checked");
  expect(message).not.toContain("RPC-SECRET-9");
  expect(message).not.toContain("rpc.example");
  expect(result.createApi).not.toHaveBeenCalled();
  expect(result.loop).not.toHaveBeenCalled();

  // A chain that does not answer is given 15 seconds by default; here, 20 ms.
  const silent = await start(ARGS, { key: () => new Promise(() => {}), keyCheckMs: 20 });
  expect(silent.code).toBe(1);
  expect(said(silent)).toContain("(TimeoutError)");
  expect(silent.loop).not.toHaveBeenCalled();
});

test("check_agent_key_takes_a_function_call_key_limited_to_tender_whatever_its_methods", async () => {
  const config = {
    agent: AGENTS.analyst,
    network: "testnet" as const,
    contractId: CONTRACT,
    signer: { accountId: ACCOUNT, privateKey: AGENT_KEY.toString() },
    publicKey: AGENT_PUBLIC,
  };
  // The policy is the sign-in's (`keyKindOf`): the receiver decides. The methods and the allowance
  // are the key script's to get right, and not this check's.
  for (const permission of [functionCall(), functionCall({ method_names: [] })]) {
    const chain = { viewAccessKey: vi.fn(async () => ({ permission }) as unknown as Found) };
    await expect(checkAgentKey(chain, config)).resolves.toBeUndefined();
    expect(chain.viewAccessKey).toHaveBeenCalledWith(ACCOUNT, AGENT_PUBLIC);
  }
});

// ---- The registration -------------------------------------------------------------------------

test("an_agent_that_is_not_active_is_warned_about_and_still_starts", async () => {
  const states: Array<[string, () => Promise<AgentView | null>, RegExp]> = [
    ["not registered", async () => null, /is not registered as an agent/],
    [
      "unregistering",
      async () => agentView({ status: "unregistering", claimable_at: "1793745956336648000" }),
      /is unregistering/,
    ],
    [
      "retired",
      async () => agentView({ status: "retired", bond_token: null, bond_amount: null }),
      /has retired/,
    ],
  ];
  for (const [name, agent, standing] of states) {
    const result = await start(ARGS, { agent });

    // It starts: a task pinned to the agent takes it without a registration.
    expect(result.code, name).toBe(0);
    expect(result.err, name).toEqual([]);
    expect(result.calls, name).toContain("run");
    expect(result.out, name).toHaveLength(1);
    const [line] = result.out;
    expect(line, name).toMatch(/^WARN run-agent: analyst\.tender\.testnet /);
    expect(line, name).toMatch(standing);
    expect(line, name).toContain("E_NOT_REGISTERED");
    expect(line, name).toContain("pnpm agent:register");
  }
});

test("an_active_agent_gets_no_registration_warning_and_a_chain_that_does_not_answer_none_either", async () => {
  const active = await start(ARGS);
  expect(active.out).toEqual([]);

  // The read fails: the agent is not held back, and no one is told that it is unregistered.
  const failing = await start(ARGS, {
    agent: async () => {
      throw new Error("rpc down");
    },
  });
  expect(failing.code).toBe(0);
  expect(failing.out).toEqual([]);

  const slow = await registrationWarning(
    { getAgent: () => new Promise(() => undefined), getConfig: async () => configView() },
    ACCOUNT,
    20,
  );
  expect(slow).toBeNull();

  // An active agent that holds its bond is not held back, and the config is not even read.
  expect(active.calls).not.toContain("getConfig");
});

test("an_active_agent_that_holds_no_bond_is_warned_while_a_bond_is_set_and_not_when_none_is", async () => {
  const bondFree = async () => agentView({ bond_token: null, bond_amount: null });

  // The owner set a bond after the agent registered: every open task refuses it, and the line says
  // so and names the way (registering again pays the bond), and the agent starts all the same.
  const held = await start(ARGS, { agent: bondFree });
  expect(held.code).toBe(0);
  expect(held.err).toEqual([]);
  expect(held.calls).toContain("run");
  expect(held.calls).toContain("getConfig");
  expect(held.out).toHaveLength(1);
  const [line] = held.out;
  expect(line).toMatch(
    /^WARN run-agent: analyst\.tender\.testnet registered before the bond was set/,
  );
  expect(line).toContain("holds none");
  expect(line).toContain("E_NOT_REGISTERED");
  expect(line).toContain("pnpm agent:register");

  // No bond set: such an agent is not held back, so no one is warned.
  const free = await start(ARGS, {
    agent: bondFree,
    config: async () => configView({ agent_bond_token: null, agent_bond_amount: null }),
  });
  expect(free.code).toBe(0);
  expect(free.out).toEqual([]);

  // The config does not answer (it fails, or is too slow): the agent is not held back for a read.
  const failing = await start(ARGS, {
    agent: bondFree,
    config: async () => {
      throw new Error("rpc down");
    },
  });
  expect(failing.code).toBe(0);
  expect(failing.out).toEqual([]);
  const slow = await registrationWarning(
    {
      getAgent: async () => agentView({ bond_token: null, bond_amount: null }),
      getConfig: () => new Promise(() => undefined),
    },
    ACCOUNT,
    20,
  );
  expect(slow).toBeNull();
});

// ---- Starting ---------------------------------------------------------------------------------

test("run_agent_starts_with_a_function_call_key_limited_to_tender", async () => {
  const stop = new AbortController();
  const result = await start(ARGS, {
    signal: stop.signal,
    loop: async (options) => {
      // What the loop is given: the agent's name and tags, its client, API and solver, a log that
      // reaches the command's output, and the signal that stops it.
      expect(options.name).toBe("analyst");
      expect(options.tags).toEqual(["research", "writing", "data"]);
      expect(options.solver.name).toBe("offline");
      expect(options.solver.scripted).toBe(true);
      expect(options.signal).toBe(stop.signal);
      options.log?.("a line from the agent");
    },
  });

  expect(result.code).toBe(0);
  expect(result.err).toEqual([]);
  expect(result.out).toEqual(["a line from the agent"]);
  // In this order: the client is made, the key is checked, only then is there an API client, which
  // signs in once, and the loop starts.
  expect(result.calls).toEqual([
    "makeClient",
    "viewAccessKey",
    "getAgent",
    "createApi",
    "signIn",
    "run",
  ]);

  const options = result.loop.mock.calls[0]?.[0];
  expect(options?.client).toBe(result.client);
  expect(options?.api).toBe(result.api);
  // What the client and the API client are built from.
  const config = result.makeClient.mock.calls[0]?.[0];
  expect(config).toMatchObject({
    network: "testnet",
    contractId: CONTRACT,
    apiUrl: "https://api.tender.example",
    signer: { accountId: ACCOUNT, privateKey: AGENT_KEY.toString() },
    publicKey: AGENT_PUBLIC,
  });
  expect(config).not.toHaveProperty("rpcUrl");
  expect(config).not.toHaveProperty("llm");
  expect(result.createApi.mock.calls[0]?.[0]).toBe(config);
});

test("each_agent_runs_with_its_own_variables_and_tags", async () => {
  for (const name of AGENT_NAMES) {
    const vars = agentVariables(name);
    const key = KeyPair.fromRandom("ed25519");
    const env = {
      TENDER_CONTRACT: CONTRACT,
      TENDER_API_URL: "https://api.tender.example",
      [vars.account]: `${name}.tender.testnet`,
      [vars.privateKey]: key.toString(),
    };

    const result = await start(["--agent", name, "--solver", "weak", "--network", "testnet"], {
      env,
      key: async () => ({ permission: functionCall() }) as unknown as Found,
    });

    expect(result.code, name).toBe(0);
    const options = result.loop.mock.calls[0]?.[0];
    expect(options?.name, name).toBe(name);
    expect(options?.tags, name).toEqual(AGENTS[name].tags);
    expect(options?.solver.name, name).toBe("weak");
    expect(result.viewAccessKey, name).toHaveBeenCalledWith(
      `${name}.tender.testnet`,
      key.getPublicKey().toString(),
    );
  }

  // Another agent's variables are no help: the coder does not sign as the analyst.
  const coder = await start(["--agent", "coder", "--solver", "offline", "--network", "testnet"]);
  expect(coder.code).toBe(1);
  expect(said(coder)).toContain("AGENT_CODER_ACCOUNT, AGENT_CODER_PRIVATE_KEY");
  expect(said(coder)).not.toContain("AGENT_ANALYST");
  expect(coder.viewAccessKey).not.toHaveBeenCalled();
});

test("the_sandbox_is_not_asked_what_the_key_may_do", async () => {
  // The sandbox's accounts hold full-access keys and nothing there is worth the key's loss. It has
  // no RPC of its own either, so the environment names one.
  const sandbox = ["--agent", "analyst", "--solver", "offline", "--network", "sandbox"];
  const env = { ...ENV, NEAR_RPC_URL: "http://127.0.0.1:3030" };

  const result = await start(sandbox, { env, key: async () => ({ permission: "FullAccess" }) });

  expect(result.code).toBe(0);
  expect(result.viewAccessKey).not.toHaveBeenCalled();
  expect(result.calls).toEqual(["makeClient", "getAgent", "createApi", "signIn", "run"]);
  expect(result.makeClient.mock.calls[0]?.[0]).toMatchObject({
    network: "sandbox",
    rpcUrl: "http://127.0.0.1:3030",
  });

  const lacking = await start(sandbox, { env: ENV });
  expect(lacking.code).toBe(1);
  expect(said(lacking)).toContain("missing environment variable: NEAR_RPC_URL");
  expect(lacking.loop).not.toHaveBeenCalled();
});

test("the_drafts_are_kept_under_the_agents_account_in_the_home_directory", async () => {
  // A draft holds the work and the salt that open the entry, so where it lives matters.
  const result = await start(ARGS, {
    loop: async (options) => {
      await options.state.saveDraft({
        taskId: "7",
        contentBase64: "",
        contentHash: "0".repeat(64),
        salt: "1".repeat(64),
        commitment: "2".repeat(64),
      });
    },
  });

  expect(result.code).toBe(0);
  const file = join(result.home, ".tender", "testnet", ACCOUNT, "drafts", "7.json");
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ taskId: "7" });
});

// ---- The environment --------------------------------------------------------------------------

test("run_agent_names_the_variables_it_lacks_and_how_to_make_the_key", async () => {
  const result = await start(ARGS, { env: {} });

  expect(result.code).toBe(1);
  expect(result.out).toEqual([]);
  const message = said(result);
  // One message, every variable that is missing, in the order the command reads them.
  expect(message).toMatch(
    /^run-agent: missing environment variables: TENDER_CONTRACT, TENDER_API_URL, AGENT_ANALYST_ACCOUNT, AGENT_ANALYST_PRIVATE_KEY \(set them in \.env or \.env\.deploy\.testnet\)/,
  );
  // The key is the one thing the deploy does not write, and the message says how to get it.
  expect(message).toContain("AGENT_ANALYST_PRIVATE_KEY is a function-call key limited to Tender");
  expect(message).toContain("does not sign with AGENT_ANALYST_FULL_ACCESS_KEY");
  expect(message).toContain(`Make it with: ${KEY_COMMAND}`);
  expect(result.makeClient).not.toHaveBeenCalled();
  expect(result.loop).not.toHaveBeenCalled();

  // A single one is named in the singular, and the model's settings are not asked for.
  const one = await start(ARGS, { env: { ...ENV, TENDER_API_URL: undefined } });
  expect(said(one)).toBe(
    "run-agent: missing environment variable: TENDER_API_URL (set them in .env or .env.deploy.testnet)",
  );
});

test("run_agent_never_signs_with_the_full_access_key_the_deploy_wrote", async () => {
  // The deploy writes AGENT_ANALYST_FULL_ACCESS_KEY and never a private key. Without the function-call
  // key the agent does not start; it does not fall back to the one that is there.
  const env = {
    ...ENV,
    AGENT_ANALYST_PRIVATE_KEY: undefined,
    AGENT_ANALYST_FULL_ACCESS_KEY: FULL_KEY.toString(),
  };
  for (const network of ["testnet", "sandbox"]) {
    const result = await start(
      ["--agent", "analyst", "--solver", "offline", "--network", network],
      {
        env: { ...env, NEAR_RPC_URL: "http://127.0.0.1:3030" },
      },
    );

    expect(result.code, network).toBe(1);
    const message = said(result);
    expect(message, network).toContain("AGENT_ANALYST_PRIVATE_KEY");
    for (const piece of piecesOf(FULL_KEY)) expect(message, network).not.toContain(piece);
    expect(result.makeClient, network).not.toHaveBeenCalled();
    expect(result.viewAccessKey, network).not.toHaveBeenCalled();
    expect(result.loop, network).not.toHaveBeenCalled();
    // The key script is the way to a key on a chain that has a deploy; the sandbox has none.
    expect(message.includes("keeper-key"), network).toBe(network === "testnet");
  }
});

test("run_agent_names_a_wrong_variable_and_never_shows_its_value", async () => {
  const cases: Array<[string, Record<string, string>, string]> = [
    [
      "a contract",
      { TENDER_CONTRACT: "NOT A CONTRACT SECRET-1" },
      "TENDER_CONTRACT must be a NEAR account id",
    ],
    [
      "an api url",
      { TENDER_API_URL: "ftp://x.example SECRET-2" },
      "TENDER_API_URL must be an http(s) URL",
    ],
    [
      "an account",
      { AGENT_ANALYST_ACCOUNT: "Not An Account SECRET-3" },
      "AGENT_ANALYST_ACCOUNT must be a NEAR account id",
    ],
    [
      "a key that is no key",
      { AGENT_ANALYST_PRIVATE_KEY: "ed25519:SECRETGARBAGE123" },
      "AGENT_ANALYST_PRIVATE_KEY must be an ed25519 access key, as ed25519:<base58>",
    ],
    [
      "a key of another curve",
      { AGENT_ANALYST_PRIVATE_KEY: "secp256k1:SECRETGARBAGE456" },
      "AGENT_ANALYST_PRIVATE_KEY must be an ed25519 access key, as ed25519:<base58>",
    ],
    ["an rpc url", { NEAR_RPC_URL: "not a url SECRET-4" }, "NEAR_RPC_URL must be an http(s) URL"],
  ];
  for (const [what, over, message] of cases) {
    const result = await start(ARGS, { env: { ...ENV, ...over } });

    expect(result.code, what).toBe(1);
    expect(said(result), what).toBe(`run-agent: ${message}`);
    expect(said(result), what).not.toMatch(/SECRET/);
    expect(result.makeClient, what).not.toHaveBeenCalled();
    expect(result.loop, what).not.toHaveBeenCalled();
  }

  // Several faults are reported together, the wrong ones after the missing.
  const both = await start(ARGS, {
    env: { ...ENV, TENDER_CONTRACT: undefined, TENDER_API_URL: "ftp://x.example SECRET-5" },
  });
  expect(said(both)).toBe(
    "run-agent: missing environment variable: TENDER_CONTRACT (set them in .env or .env.deploy.testnet); TENDER_API_URL must be an http(s) URL",
  );
});

test("the_model_settings_are_needed_by_the_llm_solver_alone", async () => {
  const llm = ["--agent", "analyst", "--solver", "llm", "--network", "testnet"];

  const missing = await start(llm, { env: ENV });
  expect(missing.code).toBe(1);
  expect(said(missing)).toContain(
    "missing environment variables: LLM_BASE_URL, LLM_API_KEY, LLM_MODEL",
  );
  expect(missing.loop).not.toHaveBeenCalled();

  const wrong = await start(llm, {
    env: { ...ENV, ...LLM_ENV, LLM_BASE_URL: "not a url SECRET-6" },
  });
  expect(said(wrong)).toContain("LLM_BASE_URL must be an http(s) URL");
  expect(said(wrong)).not.toContain("SECRET-6");

  // With them, the loop gets the model solver, and the key is nowhere in the output.
  const ready = await start(llm, { env: { ...ENV, ...LLM_ENV } });
  expect(ready.code).toBe(0);
  const options = ready.loop.mock.calls[0]?.[0];
  expect(options?.solver.name).toBe("llm");
  expect(options?.solver.scripted).toBe(false);
  expect(ready.makeClient.mock.calls[0]?.[0]).toMatchObject({
    llm: { baseUrl: LLM_ENV.LLM_BASE_URL, model: LLM_ENV.LLM_MODEL },
  });
  expect([...ready.out, ...ready.err].join("\n")).not.toContain(LLM_KEY);

  // The scripted solvers need none of it, and do not read it: a wrong value is of no concern.
  for (const solver of ["offline", "weak"]) {
    const result = await start(["--agent", "analyst", "--solver", solver, "--network", "testnet"], {
      env: { ...ENV, LLM_BASE_URL: "not a url", LLM_API_KEY: "" },
    });
    expect(result.code, solver).toBe(0);
    expect(result.loop.mock.calls[0]?.[0].solver.name, solver).toBe(solver);
    expect(result.makeClient.mock.calls[0]?.[0], solver).not.toHaveProperty("llm");
  }
});

test("the_llm_solver_the_command_makes_asks_the_model_the_environment_names", async () => {
  // The only place where the three LLM_ variables meet the solver: a swapped pair would show here.
  const reply = JSON.stringify({ pattern: "^\\d+\\.\\d+\\.\\d+$", flags: "" });
  const llm = await startFakeLlm(reply);
  try {
    let answer: Uint8Array | null = null;
    const result = await start(["--agent", "analyst", "--solver", "llm", "--network", "testnet"], {
      env: {
        ...ENV,
        LLM_BASE_URL: llm.baseUrl,
        LLM_API_KEY: LLM_KEY,
        LLM_MODEL: "env-model",
        JUDGE_ACCOUNT,
      },
      loop: async (options) => {
        answer = await options.solver.solve(contextOf(taskSpec({ id: 1 })));
      },
    });

    expect(result.code).toBe(0);
    expect(new TextDecoder().decode(answer ?? new Uint8Array())).toBe(reply);
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.path).toBe("/v1/chat/completions");
    expect(llm.requests[0]?.body?.model).toBe("env-model");
    expect(llm.requests[0]?.headers.authorization).toBe(`Bearer ${LLM_KEY}`);
  } finally {
    await llm.stop();
  }
});

test("the_hourly_limit_of_the_flag_reaches_the_llm_solver_and_its_warning_the_commands_output", async () => {
  const reply = JSON.stringify({ pattern: "^\\d+\\.\\d+\\.\\d+$", flags: "" });
  const llm = await startFakeLlm(reply);
  try {
    const env = {
      ...ENV,
      LLM_BASE_URL: llm.baseUrl,
      LLM_API_KEY: LLM_KEY,
      LLM_MODEL: "env-model",
      JUDGE_ACCOUNT,
    };
    const answers: Array<Uint8Array | null> = [];
    const result = await start([...LLM_ARGS, "--max-llm-calls-per-hour", "2"], {
      env,
      loop: async (options) => {
        for (let id = 1; id <= 3; id += 1) {
          answers.push(await options.solver.solve(contextOf(taskSpec({ id }))));
        }
      },
    });

    expect(result.code).toBe(0);
    // Two of the three tasks are asked of the model and the third is not: no request, no answer.
    expect(answers.map((answer) => answer !== null)).toEqual([true, true, false]);
    expect(llm.requests).toHaveLength(2);
    // The solver's warning is a line of the agent's own output, and says the limit that was set.
    expect(result.out).toHaveLength(1);
    expect(result.out[0]).toMatch(/^WARN llm solver: the limit of 2 model calls an hour/);
    expect(result.err).toEqual([]);
    expect([...result.out, ...result.err].join("\n")).not.toContain(LLM_KEY);
    expect(result.makeClient.mock.calls[0]?.[0]).toMatchObject({ maxLlmCallsPerHour: 2 });

    // With no flag the config carries no limit, and the solver's own default (30) applies.
    const plain = await start(LLM_ARGS, { env });
    expect(plain.makeClient.mock.calls[0]?.[0]).not.toHaveProperty("maxLlmCallsPerHour");
  } finally {
    await llm.stop();
  }
});

// ---- The entry policy -------------------------------------------------------------------------

/** The tokens of the contract's config, with the least reward of each. */
const TOKENS: ConfigView["tokens"] = [
  { token: "usdc.testnet", min_reward: "10000", max_reward: "1000000000", enabled: true },
  { token: "tusdc.tender.testnet", min_reward: "1", max_reward: "1000000000", enabled: false },
];

test("policy_a_scripted_agent_enters_as_before_any_verifier_any_reward_no_cap", async () => {
  for (const solver of ["offline", "weak"]) {
    const result = await start(["--agent", "analyst", "--solver", solver, "--network", "testnet"]);
    expect(result.code, solver).toBe(0);
    const options = result.loop.mock.calls[0]?.[0];
    expect(options?.policy, solver).toEqual({ verifiers: "any" });
    expect(options?.entryCounts, solver).toBeUndefined();
    // Nothing more is read for it: no Judge, no minimum of the chain.
    expect(result.getConfig, solver).not.toHaveBeenCalled();
    expect(result.out, solver).toEqual([]);
  }
});

test("policy_an_agent_with_a_model_takes_the_judges_tasks_only_20_a_day_and_none_below_the_chains_least_reward", async () => {
  const result = await start(LLM_ARGS, {
    env: { ...ENV, ...LLM_ENV },
    config: async () => configView({ tokens: TOKENS }),
    loop: async (options) => {
      await options.entryCounts?.write("2026-11-04", { entries: 3, judgedHires: 1 });
    },
  });

  expect(result.code).toBe(0);
  expect(result.err).toEqual([]);
  expect(result.loop.mock.calls[0]?.[0].policy).toEqual({
    verifiers: "judge",
    judgeAccount: JUDGE_ACCOUNT,
    minReward: { "usdc.testnet": 10_000n, "tusdc.tender.testnet": 1n },
    maxPosterVoids: 2,
    dailyEntries: 20,
    dailyJudgedHires: 50,
  });
  // They are `MODEL_AGENT_POLICY` of @tender/shared, which the API shows on the page of each agent the
  // deployment names in `TEAM_MODEL_AGENTS`.
  expect(result.loop.mock.calls[0]?.[0].policy).toMatchObject({
    verifiers: MODEL_AGENT_POLICY.verifiers,
    maxPosterVoids: MODEL_AGENT_POLICY.maxPosterVoids,
    dailyEntries: MODEL_AGENT_POLICY.dailyEntries,
    dailyJudgedHires: MODEL_AGENT_POLICY.dailyJudgedHires,
  });
  // The count of the day is kept in the agent's state directory, beside its drafts.
  const file = join(result.home, ".tender", "testnet", ACCOUNT, ENTRY_COUNTS_FILE);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
    day: "2026-11-04",
    entries: 3,
    judgedHires: 1,
  });
  // The chain's least rewards are read once the key is checked, and before anything else starts.
  expect(result.calls).toEqual([
    "makeClient",
    "viewAccessKey",
    "getAgent",
    "getConfig",
    "createApi",
    "signIn",
    "run",
  ]);
});

test("policy_an_agent_with_a_model_does_not_start_without_the_chains_least_rewards", async () => {
  const result = await start(LLM_ARGS, {
    env: { ...ENV, ...LLM_ENV },
    config: async () => {
      throw new Error("rpc down LEAK-9");
    },
  });

  expect(result.code).toBe(1);
  expect(said(result)).toMatch(
    /^run-agent: cannot read the tokens' least rewards from the chain \(Error\), and an agent with a model does not start without them/,
  );
  expect(said(result)).not.toContain("LEAK-9");
  expect(result.createApi).not.toHaveBeenCalled();
  expect(result.loop).not.toHaveBeenCalled();
});

test("policy_the_judges_account_is_needed_for_the_judges_tasks_and_for_nothing_else", async () => {
  const { JUDGE_ACCOUNT: _judge, ...noJudge } = { ...ENV, ...LLM_ENV };

  const refused = await start(LLM_ARGS, { env: noJudge });
  expect(refused.code).toBe(1);
  expect(said(refused)).toMatch(
    /^run-agent: missing environment variable: JUDGE_ACCOUNT \(set them in \.env or \.env\.deploy\.testnet\)/,
  );
  expect(said(refused)).toContain("--verifiers");
  expect(refused.makeClient).not.toHaveBeenCalled();
  expect(refused.loop).not.toHaveBeenCalled();

  const wrong = await start(LLM_ARGS, { env: { ...noJudge, JUDGE_ACCOUNT: "Not An Id SECRET-7" } });
  expect(wrong.code).toBe(1);
  expect(said(wrong)).toContain("JUDGE_ACCOUNT must be a NEAR account id");
  expect(said(wrong)).not.toContain("SECRET-7");

  // Any verifier, or a list of them: there is no Judge to know, and a stray value is not read.
  for (const verifiers of ["any", "a.testnet,b.testnet"]) {
    const result = await start([...LLM_ARGS, "--verifiers", verifiers], {
      env: { ...noJudge, JUDGE_ACCOUNT: "not read" },
    });
    expect(result.code, verifiers).toBe(0);
    expect(result.loop.mock.calls[0]?.[0].policy, verifiers).not.toHaveProperty("judgeAccount");
  }

  // A scripted agent held to the Judge's tasks needs it as well.
  const scripted = await start([...ARGS, "--verifiers", "judge"]);
  expect(scripted.code).toBe(1);
  expect(said(scripted)).toContain("missing environment variable: JUDGE_ACCOUNT");
  const judged = await start([...ARGS, "--verifiers", "judge"], {
    env: { ...ENV, JUDGE_ACCOUNT },
  });
  expect(judged.loop.mock.calls[0]?.[0].policy).toEqual({
    verifiers: "judge",
    judgeAccount: JUDGE_ACCOUNT,
  });
});

test("policy_the_flags_set_the_policy_over_the_defaults_of_the_solver", async () => {
  const flags = [
    "--verifiers",
    "a.testnet,b.testnet",
    "--min-reward",
    "usdc.testnet=2000000",
    "--min-reward",
    "other.testnet=5",
    "--daily-entries",
    "5",
    "--daily-judged-hires",
    "7",
    "--max-voids-after-reveals",
    "0",
    "--max-poster-voids",
    "5",
  ];
  const llm = await start([...LLM_ARGS, ...flags], {
    env: { ...ENV, ...LLM_ENV },
    config: async () => configView({ tokens: TOKENS }),
  });
  expect(llm.code).toBe(0);
  // The flagged amounts win over the chain's, and a token the chain has not is added.
  expect(llm.loop.mock.calls[0]?.[0].policy).toEqual({
    verifiers: ["a.testnet", "b.testnet"],
    minReward: { "usdc.testnet": 2_000_000n, "tusdc.tender.testnet": 1n, "other.testnet": 5n },
    maxVoidsAfterReveals: 0,
    maxPosterVoids: 5,
    dailyEntries: 5,
    dailyJudgedHires: 7,
  });

  // Without the flag, an agent with a model takes 50 hires the Judge checks a day.
  const fewer = await start([...LLM_ARGS, "--daily-entries", "5"], {
    env: { ...ENV, ...LLM_ENV },
  });
  expect(fewer.loop.mock.calls[0]?.[0].policy).toMatchObject({
    dailyEntries: 5,
    dailyJudgedHires: 50,
  });

  // A scripted agent takes them as they are, and reads nothing of the chain for them.
  const scripted = await start([...ARGS, "--daily-entries", "3", "--min-reward", "usdc.testnet=7"]);
  expect(scripted.code).toBe(0);
  const options = scripted.loop.mock.calls[0]?.[0];
  expect(options?.policy).toEqual({
    verifiers: "any",
    minReward: { "usdc.testnet": 7n },
    dailyEntries: 3,
  });
  expect(options?.entryCounts).toBeDefined();
  expect(scripted.getConfig).not.toHaveBeenCalled();

  // The cap of the hires the Judge checks alone also keeps a count.
  const judged = await start([...ARGS, "--daily-judged-hires", "2"]);
  expect(judged.loop.mock.calls[0]?.[0].policy).toEqual({ verifiers: "any", dailyJudgedHires: 2 });
  expect(judged.loop.mock.calls[0]?.[0].entryCounts).toBeDefined();
});

test("policy_a_flag_of_the_policy_that_cannot_be_read_is_a_usage_error_that_quotes_nothing", () => {
  const verifiers = "--verifiers must be judge, any, or NEAR account ids separated by commas";
  const reward = "--min-reward must be <token account id>=<amount in the token's smallest unit>";
  const cases: Array<[string[], string]> = [
    [["--verifiers", "Not An Id SECRET-8"], verifiers],
    [["--verifiers", ""], verifiers],
    [["--verifiers", "a.testnet,,b.testnet"], verifiers],
    [["--min-reward", "SECRET-8"], reward],
    [["--min-reward", "usdc.testnet="], reward],
    [["--min-reward", "=5"], reward],
    [["--min-reward", "usdc.testnet=1.5"], reward],
    [["--min-reward=usdc.testnet=-1"], reward],
    [["--min-reward", `usdc.testnet=${2n ** 128n}`], reward],
    [
      ["--min-reward", "usdc.testnet=1", "--min-reward", "usdc.testnet=2"],
      "--min-reward names a token twice",
    ],
    [["--daily-entries", "0"], "--daily-entries must be a whole number from 1"],
    [["--daily-entries", "SECRET-8"], "--daily-entries must be a whole number from 1"],
    [["--daily-judged-hires", "0"], "--daily-judged-hires must be a whole number from 1"],
    [["--daily-judged-hires", "SECRET-8"], "--daily-judged-hires must be a whole number from 1"],
    // Written with `=`: node refuses a value that starts with a dash as a separate argument.
    [["--max-voids-after-reveals=-1"], "--max-voids-after-reveals must be a whole number from 0"],
    [["--max-voids-after-reveals=1.5"], "--max-voids-after-reveals must be a whole number from 0"],
    [["--max-poster-voids=-1"], "--max-poster-voids must be a whole number from 0"],
    [["--max-poster-voids", "SECRET-8"], "--max-poster-voids must be a whole number from 0"],
  ];
  for (const [flags, sentence] of cases) {
    const what = flags.join(" ");
    expect(() => parseCli([...ARGS, ...flags]), what).toThrow(
      new CliError(`${sentence}\n${USAGE}`),
    );
  }

  expect(parseCli([...ARGS, "--verifiers", "judge"])).toMatchObject({ verifiers: "judge" });
  expect(parseCli([...ARGS, "--verifiers", " a.testnet , b.testnet "])).toMatchObject({
    verifiers: ["a.testnet", "b.testnet"],
  });
  expect(parseCli([...ARGS, "--min-reward", `usdc.testnet=${2n ** 128n - 1n}`])).toMatchObject({
    minReward: { "usdc.testnet": 2n ** 128n - 1n },
  });
  expect(parseCli([...ARGS, "--max-voids-after-reveals", "0"])).toMatchObject({
    maxVoidsAfterReveals: 0,
  });
  expect(parseCli([...ARGS, "--max-poster-voids", "0"])).toMatchObject({ maxPosterVoids: 0 });
  // None of them is there unless its flag is.
  expect(Object.keys(parseCli(ARGS)).sort()).toEqual(["agent", "network", "solver"]);
});

test("the_environment_comes_from_the_files_and_the_process_wins", async () => {
  const dir = await dirWith({
    ".env": [
      "TENDER_CONTRACT=from-dotenv.testnet",
      "TENDER_API_URL=https://dotenv.example",
      "LLM_MODEL=model-from-dotenv",
      "PADDED= ",
      "NEXT=after-the-padded-line",
    ].join("\n"),
    ".env.deploy.testnet": [
      "TENDER_CONTRACT=from-network-file.testnet",
      `AGENT_ANALYST_ACCOUNT=${ACCOUNT}`,
      `AGENT_ANALYST_FULL_ACCESS_KEY=${FULL_KEY.toString()}`,
    ].join("\n"),
    ".env.deploy.mainnet": "TENDER_CONTRACT=mainnet-contract.near\nONLY_MAINNET=1\n",
  });

  const env = readEnv(dir, "testnet", {
    TENDER_API_URL: "https://process.example",
    LLM_MODEL: "model-from-process",
    // A variable set to nothing counts as not set, and never hides one of a file.
    TENDER_CONTRACT: "",
    AGENT_ANALYST_ACCOUNT: "   ",
    FROM_PROCESS: "yes",
    UNSET: undefined,
  });

  expect(env).toMatchObject({
    // The network's file over `.env`; the process over both; an empty process variable over none.
    TENDER_CONTRACT: "from-network-file.testnet",
    TENDER_API_URL: "https://process.example",
    LLM_MODEL: "model-from-process",
    AGENT_ANALYST_ACCOUNT: ACCOUNT,
    AGENT_ANALYST_FULL_ACCESS_KEY: FULL_KEY.toString(),
    FROM_PROCESS: "yes",
    // A line that ends in a space does not swallow the next one.
    NEXT: "after-the-padded-line",
  });
  // Another network's file is not read, and a variable set to undefined is not there.
  expect(env).not.toHaveProperty("ONLY_MAINNET");
  expect(env).not.toHaveProperty("UNSET");

  // A directory with no env files has nothing, and that is not an error.
  expect(readEnv(await dirWith(), "testnet", {})).toEqual({});
});

test("a_run_reads_the_key_and_the_account_from_the_files_of_its_network", async () => {
  const result = await start(ARGS, {
    env: {},
    files: {
      ".env": `TENDER_API_URL=https://api.tender.example\nAGENT_ANALYST_PRIVATE_KEY=${AGENT_KEY.toString()}\n`,
      ".env.deploy.testnet": `TENDER_CONTRACT=${CONTRACT}\nAGENT_ANALYST_ACCOUNT=${ACCOUNT}\nAGENT_ANALYST_FULL_ACCESS_KEY=${FULL_KEY.toString()}\n`,
    },
  });

  expect(result.code).toBe(0);
  expect(result.makeClient.mock.calls[0]?.[0]).toMatchObject({
    contractId: CONTRACT,
    signer: { accountId: ACCOUNT, privateKey: AGENT_KEY.toString() },
  });
  // The key it asked the chain about is the function-call key, never the one the deploy wrote.
  expect(result.viewAccessKey).toHaveBeenCalledWith(ACCOUNT, AGENT_PUBLIC);
});

test("a_run_given_no_dir_reads_the_files_of_the_directory_tender_env_dir_names", async () => {
  const result = await start(ARGS, {
    env: {},
    dirFromEnv: true,
    files: {
      ".env": `TENDER_API_URL=https://api.tender.example\nAGENT_ANALYST_PRIVATE_KEY=${AGENT_KEY.toString()}\n`,
      ".env.deploy.testnet": `TENDER_CONTRACT=${CONTRACT}\nAGENT_ANALYST_ACCOUNT=${ACCOUNT}\n`,
    },
  });

  expect(result.code).toBe(0);
  expect(result.makeClient.mock.calls[0]?.[0]).toMatchObject({
    contractId: CONTRACT,
    signer: { accountId: ACCOUNT, privateKey: AGENT_KEY.toString() },
  });
});

test("env_dir_of_is_the_repository_root_unless_tender_env_dir_names_another", async () => {
  for (const unset of [
    {},
    { TENDER_ENV_DIR: undefined },
    { TENDER_ENV_DIR: "" },
    { TENDER_ENV_DIR: "  " },
  ]) {
    expect(resolve(envDirOf(unset)), JSON.stringify(unset)).toBe(resolve(ROOT));
  }
  const dir = await dirWith();
  expect(envDirOf({ TENDER_ENV_DIR: dir })).toBe(dir);
  const relative = relativePath(process.cwd(), dir);
  expect(envDirOf({ TENDER_ENV_DIR: ` ${relative} ` })).toBe(resolve(relative));
});

test("a_run_stops_naming_tender_env_dir_when_it_is_not_an_existing_directory", async () => {
  const dir = await dirWith({ "a-file": "x" });
  const sentence =
    "TENDER_ENV_DIR is not an existing directory: create it, and give an absolute path " +
    "(a leading ~ is not expanded, and a relative path is taken from the working directory)";
  for (const value of [
    join(dir, "missing"),
    "~/tender-env-dir-that-is-not-there",
    join(dir, "a-file"),
  ]) {
    expect(() => envDirOf({ TENDER_ENV_DIR: value }), value).toThrow(new CliError(sentence));
    const err: string[] = [];
    const code = await main(ARGS, {
      createApi: vi.fn(),
      env: { ...ENV, TENDER_ENV_DIR: value },
      out: () => undefined,
      err: (text) => err.push(text),
      signal: new AbortController().signal,
    });
    // No file was read instead: the run ends at once, with the one sentence and no value of ENV.
    expect(code, value).toBe(1);
    expect(err, value).toEqual([`run-agent: ${sentence}`]);
  }
});

test("read_run_config_trims_the_values_and_reads_the_model_for_the_llm_solver_only", () => {
  const spaced = Object.fromEntries(
    Object.entries({ ...ENV, ...LLM_ENV }).map(([k, v]) => [k, ` ${v}\n`]),
  );

  const llm = readRunConfig(
    parseCli(["--agent", "analyst", "--solver", "llm", "--network", "testnet"]),
    spaced,
  );
  expect(llm).toMatchObject({
    agent: AGENTS.analyst,
    solver: "llm",
    network: "testnet",
    contractId: CONTRACT,
    apiUrl: "https://api.tender.example",
    signer: { accountId: ACCOUNT, privateKey: AGENT_KEY.toString() },
    publicKey: AGENT_PUBLIC,
    llm: { baseUrl: LLM_ENV.LLM_BASE_URL, apiKey: LLM_KEY, model: LLM_ENV.LLM_MODEL },
  });
  expect(llm).not.toHaveProperty("rpcUrl");
  expect(llm).not.toHaveProperty("maxLlmCallsPerHour");

  const offline = readRunConfig(parseCli(ARGS), spaced);
  expect(offline).not.toHaveProperty("llm");

  // The call limit of the flag is carried along as the number it is.
  const capped = readRunConfig(parseCli([...LLM_ARGS, "--max-llm-calls-per-hour", "7"]), spaced);
  expect(capped.maxLlmCallsPerHour).toBe(7);
});

// ---- The command line -------------------------------------------------------------------------

test("a_bad_command_line_is_a_usage_error_that_runs_nothing", async () => {
  const key = "ed25519:SECRETGARBAGE000";
  const cases: Array<[string[], RegExp]> = [
    [[], /^run-agent: missing --agent, --solver, --network\n/],
    [["--agent", "analyst", "--network", "testnet"], /^run-agent: missing --solver\n/],
    // An unknown name is not quoted back, however harmless it looks: it can be a key that was
    // pasted into the wrong flag. The usage that follows lists the names that are known.
    [
      ["--agent", "nobody", "--solver", "offline", "--network", "testnet"],
      /^run-agent: unknown agent: use one of analyst, coder, extractor\n/,
    ],
    [
      ["--agent", "lead", "--solver", "offline", "--network", "testnet"],
      /^run-agent: unknown agent: use one of analyst, coder, extractor\n/,
    ],
    [
      ["--agent", "analyst", "--solver", "gpt", "--network", "testnet"],
      /^run-agent: unknown solver: use one of llm, offline, weak\n/,
    ],
    [
      ["--agent", "analyst", "--solver", "offline", "--network", "devnet"],
      /^run-agent: unknown network: use one of sandbox, testnet, mainnet\n/,
    ],
    [
      ["--agent", "analyst", "--solver", "offline", "--network", "constructor"],
      /^run-agent: unknown network: use one of sandbox, testnet, mainnet\n/,
    ],
    [
      ["--agent", key, "--solver", "offline", "--network", "testnet"],
      /^run-agent: unknown agent: use one of analyst, coder, extractor\n/,
    ],
    [
      ["--agent", "analyst", "--solver", key, "--network", "testnet"],
      /^run-agent: unknown solver: use one of llm, offline, weak\n/,
    ],
    [
      ["--agent", "analyst", "--solver", "offline", "--network", key],
      /^run-agent: unknown network: use one of sandbox, testnet, mainnet\n/,
    ],
    // The call limit is a whole number from 1, in digits, and the llm solver's alone. A value that
    // is none of that is not quoted back either. (Written with `=`: node refuses a value that starts
    // with a dash when it is a separate argument, and says so without quoting it.)
    ...["0", "-1", "1.5", "1e3", " 5", "5 ", "five", "", "99999999999999999999", key].map(
      (value): [string[], RegExp] => [
        [...LLM_ARGS, `--max-llm-calls-per-hour=${value}`],
        /^run-agent: --max-llm-calls-per-hour must be a whole number from 1\n/,
      ],
    ),
    [
      [...LLM_ARGS, "--max-llm-calls-per-hour", "-1"],
      /^run-agent: cannot read the command line \(TypeError ERR_PARSE_ARGS_INVALID_OPTION_VALUE\)\n/,
    ],
    [
      [...ARGS, "--max-llm-calls-per-hour", "5"],
      /^run-agent: --max-llm-calls-per-hour is for --solver llm only\n/,
    ],
    [
      [...ARGS, "--key", "x"],
      /^run-agent: cannot read the command line \(TypeError ERR_PARSE_ARGS_UNKNOWN_OPTION\)\n/,
    ],
    [
      ["--agent"],
      /^run-agent: cannot read the command line \(TypeError ERR_PARSE_ARGS_INVALID_OPTION_VALUE\)\n/,
    ],
    // A stray argument is not quoted: it can be a key pasted in the wrong place.
    [
      [...ARGS, "ed25519:SECRETGARBAGE789"],
      /^run-agent: cannot read the command line \(TypeError ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL\)\n/,
    ],
  ];
  for (const [args, message] of cases) {
    const result = await start(args);

    expect(result.code, args.join(" ")).toBe(1);
    expect(said(result), args.join(" ")).toMatch(message);
    expect(said(result), args.join(" ")).toContain(USAGE);
    expect(said(result), args.join(" ")).not.toContain("SECRETGARBAGE");
    expect(result.out).toEqual([]);
    expect(result.calls, args.join(" ")).toEqual([]);
  }

  // Nothing of an unknown name is in what it says, down to the last character: the message is the
  // same for a key as for a word.
  const unknown = await start(["--agent", key, "--solver", "offline", "--network", "testnet"]);
  expect(said(unknown)).toBe(
    `run-agent: unknown agent: use one of analyst, coder, extractor\n${USAGE}`,
  );
});

test("parse_cli_returns_the_agent_the_solver_and_the_network", () => {
  expect(parseCli(["--network", "sandbox", "--solver", "weak", "--agent", "extractor"])).toEqual({
    agent: AGENTS.extractor,
    solver: "weak",
    network: "sandbox",
  });
  expect(() => parseCli(["--agent", "analyst"])).toThrow(CliError);

  // The call limit is there only when the flag sets it, and is a number.
  expect(parseCli([...LLM_ARGS, "--max-llm-calls-per-hour", "12"])).toEqual({
    agent: AGENTS.analyst,
    solver: "llm",
    network: "testnet",
    maxLlmCallsPerHour: 12,
  });
  expect(parseCli(["--max-llm-calls-per-hour=007", ...LLM_ARGS]).maxLlmCallsPerHour).toBe(7);
  expect(parseCli(LLM_ARGS)).not.toHaveProperty("maxLlmCallsPerHour");
});

// ---- Failures ---------------------------------------------------------------------------------

test("a_failure_of_the_loop_is_reported_by_name_and_code_and_never_by_message", async () => {
  const quoting = (message: string, code?: string) => async () => {
    throw Object.assign(new Error(message), code === undefined ? {} : { code });
  };

  const coded = await start(ARGS, {
    loop: quoting(`GET https://rpc.example/?key=LEAK-1 with ${AGENT_KEY.toString()}`, "ECONNRESET"),
  });
  expect(coded.code).toBe(1);
  expect(coded.err).toEqual(["run-agent: Error ECONNRESET"]);

  // A code that does not look like one is dropped, and a thrown string is only its type.
  const odd = await start(ARGS, { loop: quoting("x", "some thing that is a sentence") });
  expect(odd.err).toEqual(["run-agent: Error"]);
  const text = await start(ARGS, {
    loop: async () => {
      throw `the key is ${AGENT_KEY.toString()}`;
    },
  });
  expect(text.err).toEqual(["run-agent: string"]);

  for (const result of [coded, odd, text]) {
    const output = [...result.out, ...result.err].join("\n");
    expect(output).not.toContain("LEAK-1");
    for (const piece of piecesOf(AGENT_KEY)) expect(output).not.toContain(piece);
  }
});

test("a_key_that_reaches_a_message_is_cut_out_of_it", async () => {
  // The messages of the command's own are written without any value. If one is ever made with a
  // value in it, the keys of the run are removed all the same.
  const llm = ["--agent", "analyst", "--solver", "llm", "--network", "testnet"];
  const result = await start(llm, {
    env: { ...ENV, ...LLM_ENV },
    createApi: () => {
      throw new CliError(`broken with ${AGENT_KEY.toString()} and ${LLM_KEY}`);
    },
  });

  expect(result.code).toBe(1);
  expect(said(result)).toBe("run-agent: broken with <redacted> and <redacted>");
});

test("an_api_client_that_cannot_be_made_stops_the_agent_after_its_key_is_checked", async () => {
  const result = await start(ARGS, {
    createApi: () => {
      throw new CliError("TENDER_API_URL: the API base URL must not carry a query");
    },
  });

  expect(result.code).toBe(1);
  expect(result.err).toEqual([
    "run-agent: TENDER_API_URL: the API base URL must not carry a query",
  ]);
  // The key was checked first, and the loop never started.
  expect(result.calls).toEqual(["makeClient", "viewAccessKey", "getAgent", "createApi"]);
});

// ---- The Tender API client --------------------------------------------------------------------

test("what_the_api_client_refuses_in_a_base_is_said_in_its_own_words_and_quotes_nothing", async () => {
  const cases: Array<[string, string, string]> = [
    [
      "plain http to a host that is not this machine",
      "http://api.tender.example",
      "an ApiClient with a signer needs an https baseUrl, or http to localhost, 127.0.0.1 or [::1]",
    ],
    [
      "a user name and a password",
      "https://user:SECRET-1@api.tender.example",
      "the API base URL must not carry a user name or password",
    ],
    [
      "a query",
      "https://api.tender.example/?key=SECRET-2",
      "the API base URL must not carry a query",
    ],
    [
      "a fragment",
      "https://api.tender.example/#SECRET-3",
      "the API base URL must not carry a fragment",
    ],
    [
      "an empty path segment",
      "https://api.tender.example//tender",
      "the API base URL must not have an empty path segment (//)",
    ],
    [
      "a repeated version",
      "https://api.tender.example/v1/v1",
      "the API base URL must not repeat /v1",
    ],
    [
      "a host that ends in a dot",
      "https://api.tender.example./",
      "the API base URL must not have a host that ends in a dot",
    ],
  ];
  for (const [what, apiUrl, sentence] of cases) {
    const result = await start(ARGS, {
      env: { ...ENV, TENDER_API_URL: apiUrl },
      createApi: createApiClient,
    });

    expect(result.code, what).toBe(1);
    // The client's sentence, after the variable it is about, and no word of the URL it was given.
    expect(said(result), what).toMatch(/^run-agent: TENDER_API_URL: /);
    expect(said(result), what).toContain(sentence);
    expect(said(result), what).not.toMatch(/SECRET|user:|tender\.example/);
    // It stops the agent where the API client is made: after the key check, before the loop.
    expect(result.calls, what).toEqual(["makeClient", "viewAccessKey", "getAgent", "createApi"]);
    expect(result.out, what).toEqual([]);
  }
});

test("run_agent_acts_through_the_api_client_at_the_base_it_is_given_as_the_agent", async () => {
  // The API sits under a path, as the base allows, and the agent is given it with the slash and the
  // version that `canonicalBase` takes off.
  const api = await startFakeApi("/tender");
  try {
    let health: unknown;
    let refusal: unknown;
    const result = await start(ARGS, {
      env: { ...ENV, TENDER_API_URL: `${api.base}/v1/` },
      createApi: createApiClient,
      loop: async (options) => {
        health = await options.api.health();
        refusal = await options.api.start(1n).catch((error: unknown) => error);
      },
    });

    expect(result.code).toBe(0);
    expect(result.err).toEqual([]);
    // Every request went under the base, with the version once. The agent's own sign-in, made as it
    // starts, is the first; the fake refused its signature (it knows no account), so nothing was
    // kept, and the loop's call that acts signed in again.
    expect(health).toMatchObject({ ok: true });
    expect(api.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /tender/v1/auth/challenge",
      "POST /tender/v1/auth/verify",
      "GET /tender/v1/health",
      "POST /tender/v1/auth/challenge",
      "POST /tender/v1/auth/verify",
    ]);
    // Both signed in as the agent: its account, the public half of its key, for this base. The
    // call failed with the API's answer.
    for (const verify of [api.requests[1], api.requests[4]]) {
      expect(verify?.body).toMatchObject({
        account_id: ACCOUNT,
        public_key: AGENT_PUBLIC,
        message: SIGN_IN_MESSAGE,
        recipient: api.base,
      });
    }
    expect(refusal).toMatchObject({ name: "ApiError", status: 401 });
    expect(result.out).toEqual([
      "WARN run-agent: sign-in failed at start: request failed with status 401 (unauthorized)",
    ]);
    // The private key went nowhere: not in the sign-in, and not in the agent's output.
    const sent = JSON.stringify(api.requests);
    for (const piece of piecesOf(AGENT_KEY)) {
      expect(sent).not.toContain(piece);
      expect([...result.out, ...result.err].join("\n")).not.toContain(piece);
    }
  } finally {
    await api.stop();
  }
});

// ---- The first sign-in ------------------------------------------------------------------------

/** The requests a fake API saw, as `METHOD path`. */
const seenBy = (api: FakeApi) => api.requests.map((request) => `${request.method} ${request.path}`);

test("the_agent_signs_in_once_as_it_starts_and_the_loop_finds_the_token_kept", async () => {
  const api = await startFakeApi("/tender", { accept: true });
  try {
    let atStart: string[] = [];
    let later: string | undefined;
    const result = await start(ARGS, {
      env: { ...ENV, TENDER_API_URL: api.base },
      createApi: createApiClient,
      loop: async (options) => {
        // The sign-in is done before the loop is given anything to do...
        atStart = seenBy(api);
        // ... and a call that acts finds its token, and signs in no more.
        later = await options.api.signIn();
      },
    });

    expect(result.code).toBe(0);
    expect(atStart).toEqual(["POST /tender/v1/auth/challenge", "POST /tender/v1/auth/verify"]);
    expect(later).toBe(FAKE_TOKEN);
    expect(seenBy(api)).toHaveLength(2);
    // A sign-in that worked is no news, and its token is no one's business.
    expect(result.out).toEqual([]);
    expect(result.err).toEqual([]);
  } finally {
    await api.stop();
  }
});

test("a_sign_in_that_fails_as_the_agent_starts_is_one_warning_and_the_agent_starts_all_the_same", async () => {
  const live = await startFakeApi("/tender");
  // An API that calls itself by another name than the base it is reached at.
  const renamed = await startFakeApi("/tender", { recipient: "https://api.tender.example/tender" });
  const stalled = await startFakeApi("/tender", { hang: true });
  const gone = await startFakeApi("/tender");
  const goneBase = gone.base;
  await gone.stop();
  try {
    const cases: Array<{
      what: string;
      base: string;
      api?: FakeApi;
      timeoutMs?: number;
      requests?: string[];
      said: string;
    }> = [
      {
        what: "the API refuses the key",
        base: live.base,
        api: live,
        requests: ["POST /tender/v1/auth/challenge", "POST /tender/v1/auth/verify"],
        said: "request failed with status 401 (unauthorized)",
      },
      {
        // The one the client can only find out by asking: the sentence is the client's own, and
        // nothing was signed.
        what: "the base is not what the API calls itself",
        base: renamed.base,
        api: renamed,
        requests: ["POST /tender/v1/auth/challenge"],
        said: "refusing to sign the API's sign-in challenge: its recipient is not this client's baseUrl",
      },
      {
        what: "the API does not answer in time",
        base: stalled.base,
        api: stalled,
        timeoutMs: 150,
        requests: ["POST /tender/v1/auth/challenge"],
        said: "ApiClient.signIn timed out after 150 ms",
      },
      { what: "nothing is listening", base: goneBase, said: "TypeError ECONNREFUSED" },
    ];
    for (const { what, base, api, timeoutMs, requests, said: line } of cases) {
      const result = await start(ARGS, {
        env: { ...ENV, TENDER_API_URL: base },
        createApi:
          timeoutMs === undefined
            ? createApiClient
            : (config) =>
                new ApiClient({ baseUrl: config.apiUrl, signer: config.signer, timeoutMs }),
      });

      // The agent started all the same, and said so in one line, which is the client's sentence or
      // the error's name and code: no address, no key and no body.
      expect(result.code, what).toBe(0);
      expect(result.err, what).toEqual([]);
      expect(result.out, what).toEqual([`WARN run-agent: sign-in failed at start: ${line}`]);
      expect(result.calls, what).toEqual([
        "makeClient",
        "viewAccessKey",
        "getAgent",
        "createApi",
        "run",
      ]);
      if (api !== undefined) expect(seenBy(api), what).toEqual(requests);
      const shown = result.out.join("\n");
      expect(shown, what).not.toContain("127.0.0.1");
      expect(shown, what).not.toContain(REFUSAL_TEXT);
      for (const piece of piecesOf(AGENT_KEY)) expect(shown, what).not.toContain(piece);
    }
  } finally {
    await Promise.all([live.stop(), renamed.stop(), stalled.stop()]);
  }
});

test("a_sign_in_error_that_is_not_the_clients_is_shown_by_name_and_code_and_never_by_message", async () => {
  const cases: Array<[string, unknown, string]> = [
    [
      "an error with a code",
      Object.assign(new Error(`GET https://rpc.example/?key=LEAK-1 ${AGENT_KEY.toString()}`), {
        code: "ECONNRESET",
      }),
      "Error ECONNRESET",
    ],
    [
      "a fetch that failed, with the socket's code in its cause",
      new TypeError("fetch failed for https://rpc.example/?key=LEAK-2", {
        cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443 LEAK-3"), {
          code: "ECONNREFUSED",
        }),
      }),
      "TypeError ECONNREFUSED",
    ],
    ["a code that is a sentence", Object.assign(new Error("x"), { code: "not a code" }), "Error"],
    ["a thrown string", `the key is ${AGENT_KEY.toString()}`, "string"],
  ];
  for (const [what, thrown, shown] of cases) {
    const result = await start(ARGS, {
      createApi: () =>
        ({
          signIn: async () => {
            throw thrown;
          },
        }) as unknown as TenderApi,
    });

    expect(result.code, what).toBe(0);
    expect(result.out, what).toEqual([`WARN run-agent: sign-in failed at start: ${shown}`]);
    const output = [...result.out, ...result.err].join("\n");
    expect(output, what).not.toMatch(/LEAK/);
    for (const piece of piecesOf(AGENT_KEY)) expect(output, what).not.toContain(piece);
  }

  // The client's own sentences are shown as they are, and a key that is in one all the same is cut.
  const sentence = await start(ARGS, {
    createApi: () =>
      ({
        signIn: async () => {
          throw new ApiError(500, null, `broken with ${AGENT_KEY.toString()}`);
        },
      }) as unknown as TenderApi,
  });
  expect(sentence.out).toEqual(["WARN run-agent: sign-in failed at start: broken with <redacted>"]);
  const timeout = await start(ARGS, {
    createApi: () =>
      ({
        signIn: async () => {
          throw new ApiTimeoutError("signIn", 30_000);
        },
      }) as unknown as TenderApi,
  });
  expect(timeout.out).toEqual([
    "WARN run-agent: sign-in failed at start: ApiClient.signIn timed out after 30000 ms",
  ]);
});

test("an_agent_that_is_stopped_while_it_signs_in_does_not_wait_for_the_sign_in", async () => {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 20);
  try {
    const result = await start(ARGS, {
      signal: stop.signal,
      // A sign-in that never ends: the client would give up on it at its own timeout.
      createApi: () => ({ signIn: () => new Promise<string>(() => {}) }) as unknown as TenderApi,
      loop: async (options) => {
        expect(options.signal.aborted).toBe(true);
      },
    });

    // The loop was started with the stop signal given, and ended at once; there is no one to warn.
    expect(result.code).toBe(0);
    expect(result.out).toEqual([]);
    expect(result.err).toEqual([]);
    expect(result.calls).toContain("run");
  } finally {
    clearTimeout(timer);
  }

  // A sign-in that fails once the agent is stopped is not reported either.
  const stopped = new AbortController();
  stopped.abort();
  const quiet = await start(ARGS, {
    signal: stopped.signal,
    createApi: () =>
      ({
        signIn: async () => {
          throw new TypeError("fetch failed");
        },
      }) as unknown as TenderApi,
  });
  expect(quiet.code).toBe(0);
  expect(quiet.out).toEqual([]);
});

// ---- Stopping ---------------------------------------------------------------------------------

test("the_agent_is_stopped_by_the_signal_it_is_given", async () => {
  const stop = new AbortController();
  const result = await start(ARGS, {
    signal: stop.signal,
    loop: async (options) => {
      expect(options.signal.aborted).toBe(false);
      stop.abort();
      expect(options.signal.aborted).toBe(true);
    },
  });

  expect(result.code).toBe(0);
});

test("without_a_signal_the_agent_stops_on_sigint_and_sigterm_and_leaves_the_process_as_it_was", async () => {
  for (const name of ["SIGINT", "SIGTERM"] as const) {
    const before = process.listeners(name);
    let during = 0;

    const result = await start(ARGS, {
      signal: null,
      loop: async (options) => {
        const added = process.listeners(name).filter((listener) => !before.includes(listener));
        during = added.length;
        expect(options.signal.aborted).toBe(false);
        // What the signal does, without sending one to the test runner.
        added[0]?.(name);
        expect(options.signal.aborted).toBe(true);
      },
    });

    expect(result.code, name).toBe(0);
    expect(during, name).toBe(1);
    // Nothing is left on the process, so that a second signal ends it as it would anyway.
    expect(process.listeners(name), name).toEqual(before);
  }
});

// ---- The bin ----------------------------------------------------------------------------------

/**
 * What the bin did with `env` as its whole environment, and with a directory of its own, which has
 * no env file, in the place of the repository root (`TENDER_ENV_DIR`): nothing of the machine's
 * `.env` or `.env.deploy.<network>` reaches it.
 */
async function runBin(args: string[], env: Record<string, string>) {
  const noFiles = await dirWith();
  try {
    const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", BIN, ...args], {
      cwd: ROOT,
      env: { TENDER_ENV_DIR: noFiles, ...env },
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string };
    return { code, stdout, stderr };
  }
}

test("the_bin_exits_1_with_the_usage_for_a_bad_command_line", { timeout: 120_000 }, async () => {
  // A command line that fails before any env file is read, so that nothing on this machine can change
  // what happens.
  const result = await runBin(
    ["--agent", "ed25519:SECRETGARBAGE000", "--solver", "offline", "--network", "testnet"],
    {},
  );

  // The agent is a key pasted into the wrong flag: the message is the same as for any unknown name,
  // and says nothing of the value.
  expect(result).toEqual({
    code: 1,
    stdout: "",
    stderr: `run-agent: unknown agent: use one of analyst, coder, extractor\n${USAGE}\n`,
  });
});

test("the_bin_acts_through_the_api_client_and_says_what_it_refuses", {
  timeout: 120_000,
}, async () => {
  // On the sandbox the agent's key is not asked about, and nothing here reaches a network: the API
  // client is made, and refuses a base that is plain http to a host that is not this machine, before
  // the agent lists a task. The environment is the whole of the bin's.
  const result = await runBin(
    ["--agent", "analyst", "--solver", "offline", "--network", "sandbox"],
    {
      TENDER_CONTRACT: "tender.sandbox",
      TENDER_API_URL: "http://api.tender.example",
      NEAR_RPC_URL: "http://127.0.0.1:1",
      AGENT_ANALYST_ACCOUNT: "analyst.sandbox",
      AGENT_ANALYST_PRIVATE_KEY: AGENT_KEY.toString(),
    },
  );

  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(
    /^run-agent: TENDER_API_URL: an ApiClient with a signer needs an https baseUrl, or http to localhost, 127\.0\.0\.1 or \[::1\]/,
  );
  for (const piece of piecesOf(AGENT_KEY)) expect(result.stderr).not.toContain(piece);
  expect(result.stderr).not.toContain("api.tender.example");
});

test("the_bin_ends_the_process_when_told_to_stop_though_the_sign_in_request_is_still_out", {
  timeout: 120_000,
}, async () => {
  // Review M3. The stop comes while the sign-in at start is out and the API does not answer: the
  // agent stops at once (the stop wins the race), but the abandoned request keeps the event loop
  // open for its own 30 s limit, unless the bin ends the process.
  const requests: string[] = [];
  const hanging = createServer((req) => {
    requests.push(req.url ?? "");
  });
  await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", resolve));
  const home = await mkdtemp(join(tmpdir(), "tender-bin-home-"));
  const noFiles = await dirWith();
  const child = spawn(
    process.execPath,
    ["--import", "tsx", BIN, "--agent", "analyst", "--solver", "offline", "--network", "sandbox"],
    {
      cwd: ROOT,
      env: {
        HOME: home,
        TENDER_ENV_DIR: noFiles,
        TENDER_CONTRACT: "tender.sandbox",
        TENDER_API_URL: `http://127.0.0.1:${(hanging.address() as AddressInfo).port}`,
        NEAR_RPC_URL: "http://127.0.0.1:1",
        AGENT_ANALYST_ACCOUNT: "analyst.sandbox",
        AGENT_ANALYST_PRIVATE_KEY: AGENT_KEY.toString(),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0), {
      timeout: 90_000,
      interval: 50,
    });

    const stoppedAt = performance.now();
    child.kill("SIGTERM");
    const code = await exited;

    expect(code).toBe(0);
    // Far short of the client's 30 s: it was the bin that ended the process.
    expect(performance.now() - stoppedAt).toBeLessThan(10_000);
  } finally {
    child.kill("SIGKILL");
    hanging.closeAllConnections();
    await new Promise((resolve) => hanging.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("exit_when_flushed_exits_with_the_code_after_both_streams_have_taken_their_writes", async () => {
  const events: string[] = [];
  // A stream that takes its writes late, as a pipe does: the callback of a write comes later.
  const slow = (name: string): ExitIo["stdout"] => ({
    write: ((_chunk: unknown, callback?: () => void) => {
      events.push(`${name} write`);
      setTimeout(() => {
        events.push(`${name} flushed`);
        callback?.();
      }, 20);
      return true;
    }) as ExitIo["stdout"]["write"],
  });
  const exit = ((code: number) => {
    events.push(`exit ${code}`);
  }) as ExitIo["exit"];

  await exitWhenFlushed(3, { stdout: slow("stdout"), stderr: slow("stderr"), exit });

  expect(events.at(-1)).toBe("exit 3");
  expect(events.slice(0, 2).sort()).toEqual(["stderr write", "stdout write"]);
  expect(events.slice(2, 4).sort()).toEqual(["stderr flushed", "stdout flushed"]);
});

// ---- Where the scripted solvers find the solutions ----------------------------------------------

test("the_private_directory_is_the_one_the_environment_names_else_seeds_private", () => {
  const root = "/the/repo";
  expect(privateSeedsDirOf({}, root)).toBe(join(root, "seeds-private"));
  // A variable set to nothing is not set.
  expect(privateSeedsDirOf({ TENDER_SEEDS_PRIVATE_DIR: "  " }, root)).toBe(
    join(root, "seeds-private"),
  );
  expect(privateSeedsDirOf({ TENDER_SEEDS_PRIVATE_DIR: "/vault/seeds" }, root)).toBe(
    "/vault/seeds",
  );
  expect(privateSeedsDirOf({ TENDER_SEEDS_PRIVATE_DIR: "~/vault" }, root)).toBe(
    join(homedir(), "vault"),
  );
});

test("the_offline_agent_answers_from_the_private_directory_named_in_its_environment", async () => {
  // A seeds folder with the public half of a seed, and a private directory with its solution.
  const seeds = await dirWith();
  const vault = await dirWith();
  await mkdir(join(seeds, "alpha"));
  await writeFile(join(seeds, "alpha", "brief.json"), JSON.stringify(BRIEF));
  await mkdir(join(vault, "alpha"));
  await writeFile(join(vault, "alpha", "solution.txt"), "THE PRIVATE SOLUTION");
  const ctx = contextOf(taskSpec({ id: 1, briefHash: sha256Hex(canonicalJson(BRIEF)) }));

  const answers: Array<string | null> = [];
  const ask = async (options: RunAgentOptions) => {
    const answer = await options.solver.solve(ctx);
    answers.push(answer === null ? null : new TextDecoder().decode(answer));
  };

  // The directory comes from the environment of the run...
  const named = await start(ARGS, {
    seedsDir: seeds,
    env: { ...ENV, TENDER_SEEDS_PRIVATE_DIR: vault },
    loop: ask,
  });
  expect(named.code).toBe(0);
  // ... or from the options, which win...
  const given = await start(ARGS, {
    seedsDir: seeds,
    privateDir: vault,
    env: { ...ENV, TENDER_SEEDS_PRIVATE_DIR: join(vault, "nowhere") },
    loop: ask,
  });
  expect(given.code).toBe(0);
  // ... and with neither it is the repository's seeds-private/, which a seed of this folder is not in.
  const neither = await start(ARGS, { seedsDir: seeds, loop: ask });
  expect(neither.code).toBe(0);

  expect(answers).toEqual(["THE PRIVATE SOLUTION", "THE PRIVATE SOLUTION", null]);
});
