import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type LocalChain,
  type Signer,
  startLocalChain,
  TenderClient,
  TenderError,
} from "@tender/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { describeFailure, loadTestnetTarget, runSkeleton } from "./skeleton";

// The testnet half of the skeleton cannot run here, so its setup is checked on its own: which keys
// it asks for, what it reads them into, and how it fails before anything touches the network. The
// command line's failures are checked here too, since they need no chain, and so is what becomes
// of a chain when a step fails: a fake one stands in for the node.

// Only `startLocalChain` is replaced, so that a test hands the skeleton a fake chain to start.
vi.mock("@tender/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tender/client")>()),
  startLocalChain: vi.fn(),
}));
const start = vi.mocked(startLocalChain);

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));

// The names the deploy script writes: the full-access key of each account, which the skeleton needs
// to mint, deposit and post. The `_PRIVATE_KEY` names are the services' function-call keys.
const KEYS = {
  POSTER_ACCOUNT: "poster.dev.testnet",
  POSTER_FULL_ACCESS_KEY: "ed25519:poster-key",
  JUDGE_ACCOUNT: "judge.dev.testnet",
  JUDGE_FULL_ACCESS_KEY: "ed25519:judge-key",
  AGENT_ANALYST_ACCOUNT: "analyst.dev.testnet",
  AGENT_ANALYST_FULL_ACCESS_KEY: "ed25519:analyst-key",
  AGENT_CODER_ACCOUNT: "coder.dev.testnet",
  AGENT_CODER_FULL_ACCESS_KEY: "ed25519:coder-key",
};
const DEPLOYMENT = {
  network: "testnet",
  contract: "tender.dev.testnet",
  tokens: { tusdc: "tusdc.dev.testnet" },
};

const dirs: string[] = [];

/** A new repository root holding the given files, with `.env.deploy.testnet` made from `env`. */
async function rootWith(env: Record<string, string>, deployment?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tender-skeleton-"));
  dirs.push(dir);
  const lines = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  await writeFile(join(dir, ".env.deploy.testnet"), lines.join("\n"));
  if (deployment !== undefined) {
    await mkdir(join(dir, "deployments"));
    await writeFile(join(dir, "deployments", "testnet.json"), deployment);
  }
  return dir;
}

beforeEach(() => {
  start.mockReset();
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("testnet_names_every_key_it_misses_before_it_reads_the_deployment", async () => {
  const { POSTER_ACCOUNT, POSTER_FULL_ACCESS_KEY } = KEYS;
  // No deployment file either: the keys are what it reports.
  const dir = await rootWith({ POSTER_ACCOUNT, POSTER_FULL_ACCESS_KEY });

  await expect(loadTestnetTarget(dir)).rejects.toThrow(
    new Error(
      "missing keys for network testnet: JUDGE_ACCOUNT, JUDGE_FULL_ACCESS_KEY, " +
        "AGENT_ANALYST_ACCOUNT, AGENT_ANALYST_FULL_ACCESS_KEY, " +
        "AGENT_CODER_ACCOUNT, AGENT_CODER_FULL_ACCESS_KEY " +
        "(set them in .env or .env.deploy.testnet)",
    ),
  );
});

test("testnet_does_not_sign_with_the_function_call_keys_of_the_services", async () => {
  // A <STEM>_PRIVATE_KEY is the key a service signs with. It cannot mint or deposit, and it is not
  // what the deploy wrote, so the skeleton neither asks for it nor takes it in place of a missing
  // full-access key.
  const runtime = {
    POSTER_PRIVATE_KEY: "ed25519:poster-fc-key",
    JUDGE_PRIVATE_KEY: "ed25519:judge-fc-key",
    AGENT_ANALYST_PRIVATE_KEY: "ed25519:analyst-fc-key",
    AGENT_CODER_PRIVATE_KEY: "ed25519:coder-fc-key",
  };
  const withBoth = await rootWith({ ...runtime, ...KEYS }, JSON.stringify(DEPLOYMENT));
  const target = await loadTestnetTarget(withBoth);
  expect([target.poster, target.judge, target.alice, target.bob].map((s) => s.privateKey)).toEqual([
    "ed25519:poster-key",
    "ed25519:judge-key",
    "ed25519:analyst-key",
    "ed25519:coder-key",
  ]);

  const accountsOnly = Object.fromEntries(
    Object.entries(KEYS).filter(([name]) => name.endsWith("_ACCOUNT")),
  );
  const onlyRuntime = await rootWith({ ...runtime, ...accountsOnly }, JSON.stringify(DEPLOYMENT));
  await expect(loadTestnetTarget(onlyRuntime)).rejects.toThrow(
    "missing keys for network testnet: POSTER_FULL_ACCESS_KEY, JUDGE_FULL_ACCESS_KEY, " +
      "AGENT_ANALYST_FULL_ACCESS_KEY, AGENT_CODER_FULL_ACCESS_KEY ",
  );
});

test("testnet_asks_for_a_deploy_when_the_deployment_file_is_missing", async () => {
  const dir = await rootWith(KEYS);

  await expect(loadTestnetTarget(dir)).rejects.toThrow(
    /deployments[\\/]testnet\.json.*deploy:testnet/,
  );
});

test("testnet_rejects_a_deployment_file_that_is_not_usable", async () => {
  const notJson = await rootWith(KEYS, "{ not json");
  await expect(loadTestnetTarget(notJson)).rejects.toThrow(/testnet\.json is not valid JSON/);

  const noToken = await rootWith(KEYS, JSON.stringify({ contract: "tender.dev.testnet" }));
  await expect(loadTestnetTarget(noToken)).rejects.toThrow(/"contract" and "tokens.tusdc"/);
});

test("testnet_runs_as_the_poster_the_judge_and_the_analyst_and_coder_agents", async () => {
  const dir = await rootWith(KEYS, JSON.stringify(DEPLOYMENT));

  expect(await loadTestnetTarget(dir)).toEqual({
    network: "testnet",
    contractId: "tender.dev.testnet",
    tokenId: "tusdc.dev.testnet",
    poster: { accountId: "poster.dev.testnet", privateKey: "ed25519:poster-key" },
    judge: { accountId: "judge.dev.testnet", privateKey: "ed25519:judge-key" },
    alice: { accountId: "analyst.dev.testnet", privateKey: "ed25519:analyst-key" },
    bob: { accountId: "coder.dev.testnet", privateKey: "ed25519:coder-key" },
    // The network's own minimum, which the contract was deployed with.
    windowSecs: 60,
  });
});

test("testnet_has_no_local_chain_to_run_on", async () => {
  await expect(runSkeleton({ network: "testnet", chain: {} as LocalChain })).rejects.toThrow(
    /sandbox/,
  );
});

test("a_tender_error_is_reported_by_its_code", () => {
  const error = new TenderError("E_PHASE", "E_PHASE: task 3 is not open for commits", {
    txHash: "9xTxHash",
  });

  expect(describeFailure(error)).toBe(
    "skeleton failed with E_PHASE\nE_PHASE: task 3 is not open for commits\ntransaction 9xTxHash",
  );
  expect(describeFailure(new Error("boom"))).toBe("skeleton failed: boom");
});

test("the_command_line_fails_with_a_message_and_a_non_zero_exit", async () => {
  // Run the way `pnpm skeleton` runs it.
  const failure = await run(
    process.execPath,
    ["--import", "tsx", "scripts/skeleton.ts", "--network", "mainnet"],
    { cwd: ROOT, timeout: 60_000 },
  ).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(failure).toMatchObject({
    code: 1,
    stdout: "",
    stderr: expect.stringContaining(
      "skeleton failed: --network must be sandbox or testnet, not mainnet",
    ),
  });
});

// The chain's lifecycle when a step fails. The fake chain's keys are not keys, so the run fails at
// once and offline: building the poster's client throws, before any request is made.

const NOT_A_KEY = "not-a-key";
/** Never contacted. It only has to be a URL, since a client without one fails for that instead. */
const FAKE_RPC = "http://127.0.0.1:1";

/** A local chain with the given `stop`, whose every role has a private key that is not a key. */
function fakeChain(stop: LocalChain["stop"]): LocalChain {
  const signer = (name: string): Signer => ({
    accountId: `${name}.sandbox`,
    privateKey: NOT_A_KEY,
  });
  return {
    network: "sandbox",
    rpcUrl: FAKE_RPC,
    contractId: "tender.sandbox",
    tokenId: "usdc.sandbox",
    accounts: {
      owner: signer("owner"),
      treasury: signer("treasury"),
      judge: signer("judge"),
      keeper: signer("keeper"),
      poster: signer("poster"),
      alice: signer("alice"),
      bob: signer("bob"),
      lead: signer("lead"),
    },
    stop,
  };
}

/**
 * The error that building a client with the fake chain's keys throws, which is what the run fails
 * with. Taken from the client itself, so the test does not repeat the wording of its library.
 */
function keyError(): Error {
  try {
    new TenderClient({
      network: "sandbox",
      contractId: "tender.sandbox",
      rpcUrl: FAKE_RPC,
      signer: { accountId: "poster.sandbox", privateKey: NOT_A_KEY },
    });
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error(
    "a client was built with a private key that is not one, so the run would not fail",
  );
}

test("a_failed_run_stops_the_chain_it_started_once", async () => {
  const stop = vi.fn(() => Promise.resolve());
  start.mockResolvedValue(fakeChain(stop));

  await expect(runSkeleton({ network: "sandbox" })).rejects.toThrow(keyError());

  expect(start).toHaveBeenCalledTimes(1);
  expect(stop).toHaveBeenCalledTimes(1);
});

test("a_failed_run_reports_its_failure_and_not_a_failed_teardown", async () => {
  const stop = vi.fn(() => Promise.reject(new Error("the node would not stop")));
  start.mockResolvedValue(fakeChain(stop));

  await expect(runSkeleton({ network: "sandbox" })).rejects.toThrow(keyError());

  expect(stop).toHaveBeenCalledTimes(1);
});

test("a_failed_run_leaves_a_given_chain_running", async () => {
  const stop = vi.fn(() => Promise.resolve());

  await expect(runSkeleton({ network: "sandbox", chain: fakeChain(stop) })).rejects.toThrow(
    keyError(),
  );

  expect(stop).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});
