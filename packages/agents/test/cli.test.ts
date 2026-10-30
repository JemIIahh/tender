import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { KeyPair } from "@tender/client";
import { SIGN_IN_MESSAGE, type TenderApi } from "@tender/shared";
import { afterEach, expect, test, vi } from "vitest";
import { AGENT_NAMES, AGENTS, agentVariables } from "../src/agents";
import {
  type CliClient,
  CliError,
  type CliOptions,
  checkAgentKey,
  createApiClient,
  main,
  parseCli,
  type RunConfig,
  readEnv,
  readRunConfig,
} from "../src/cli";
import type { RunAgentOptions } from "../src/runner";
import { startFakeApi } from "./fake-api";
import { startFakeLlm } from "./fake-llm";
import { contextOf, taskSpec } from "./helpers";

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
const LLM_ENV: Record<string, string> = {
  LLM_BASE_URL: "https://llm.example/v1",
  LLM_API_KEY: LLM_KEY,
  LLM_MODEL: "test-org/test-model-7",
};
const ARGS = ["--agent", "analyst", "--solver", "offline", "--network", "testnet"];
const LLM_ARGS = ["--agent", "analyst", "--solver", "llm", "--network", "testnet"];
const USAGE =
  "usage: pnpm exec tsx packages/agents/bin/run-agent.ts --agent analyst|coder|extractor --solver llm|offline|weak --network sandbox|testnet|mainnet [--max-llm-calls-per-hour N]";
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

/**
 * A client whose one working part is the read of a key's permission. Whatever else the command
 * asks of it fails the test: checking a key must never commit, reveal or read an entry.
 */
function fakeClient(viewAccessKey: CliClient["viewAccessKey"]): CliClient {
  const unexpected = (what: string) => () => {
    throw new Error(`the agent's client was asked to ${what}`);
  };
  return {
    accountId: ACCOUNT,
    viewAccessKey,
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
  /** What the chain says of the key. Default: a function-call key limited to Tender. */
  key?: () => Promise<Found>;
  /** What the agent's loop does. Default: nothing, and it ends. */
  loop?: (options: RunAgentOptions) => Promise<void>;
  /** The Tender API client. Default: an empty stand-in. */
  createApi?: (config: RunConfig) => TenderApi;
  /** How long the chain has to answer the key check. */
  keyCheckMs?: number;
  /** What stops the agent. Default: a signal that never aborts; `null` leaves it to the process's. */
  signal?: AbortSignal | null;
}

/** Runs the command line with `args` against the setup, and reports what happened. */
async function start(args: string[], setup: Setup = {}) {
  const dir = await dirWith(setup.files);
  const home = await dirWith();
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[] = [];
  const api = {} as TenderApi;

  const viewAccessKey = vi.fn(async (_account: string, _publicKey: string): Promise<Found> => {
    calls.push("viewAccessKey");
    return setup.key === undefined
      ? ({ permission: functionCall() } as unknown as Found)
      : setup.key();
  });
  const client = fakeClient(viewAccessKey);
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
    dir,
    home,
    env: setup.env ?? ENV,
    seedsDir: SEEDS,
    out: (line) => out.push(line),
    err: (text) => err.push(text),
    makeClient,
    run: loop,
    keyCheckMs: setup.keyCheckMs,
    ...(setup.signal !== null && { signal: setup.signal ?? new AbortController().signal }),
  };
  const code = await main(args, options);
  if (assertion !== undefined) throw assertion;
  return { code, out, err, calls, client, api, home, viewAccessKey, makeClient, createApi, loop };
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
  // In this order: the client is made, the key is checked, and only then is there an API client.
  expect(result.calls).toEqual(["makeClient", "viewAccessKey", "createApi", "run"]);

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
  expect(result.calls).toEqual(["makeClient", "createApi", "run"]);
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
      env: { ...ENV, LLM_BASE_URL: llm.baseUrl, LLM_API_KEY: LLM_KEY, LLM_MODEL: "env-model" },
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
    const env = { ...ENV, LLM_BASE_URL: llm.baseUrl, LLM_API_KEY: LLM_KEY, LLM_MODEL: "env-model" };
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
  expect(result.calls).toEqual(["makeClient", "viewAccessKey", "createApi"]);
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
    expect(result.calls, what).toEqual(["makeClient", "viewAccessKey", "createApi"]);
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
    // Every request went under the base, with the version once.
    expect(health).toMatchObject({ ok: true });
    expect(api.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /tender/v1/health",
      "POST /tender/v1/auth/challenge",
      "POST /tender/v1/auth/verify",
    ]);
    // It signed in as the agent: its account, the public half of its key, for this base. The fake
    // refused the signature (it knows no account), and the call failed with the API's answer.
    expect(api.requests[2]?.body).toMatchObject({
      account_id: ACCOUNT,
      public_key: AGENT_PUBLIC,
      message: SIGN_IN_MESSAGE,
      recipient: api.base,
    });
    expect(refusal).toMatchObject({ name: "ApiError", status: 401 });
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

/** What the bin did with `env` as its whole environment. */
async function runBin(args: string[], env: Record<string, string>) {
  try {
    const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", BIN, ...args], {
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
