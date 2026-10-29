import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type LocalChain, TenderError } from "@tender/client";
import { afterEach, expect, test } from "vitest";
import { describeFailure, loadTestnetTarget, runSkeleton } from "./skeleton";

// The testnet half of the skeleton cannot run here, so its setup is checked on its own: which keys
// it asks for, what it reads them into, and how it fails before anything touches the network. The
// command line's failures are checked here too, since they need no chain.

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const KEYS = {
  POSTER_ACCOUNT: "poster.dev.testnet",
  POSTER_PRIVATE_KEY: "ed25519:poster-key",
  JUDGE_ACCOUNT: "judge.dev.testnet",
  JUDGE_PRIVATE_KEY: "ed25519:judge-key",
  AGENT_ANALYST_ACCOUNT: "analyst.dev.testnet",
  AGENT_ANALYST_PRIVATE_KEY: "ed25519:analyst-key",
  AGENT_CODER_ACCOUNT: "coder.dev.testnet",
  AGENT_CODER_PRIVATE_KEY: "ed25519:coder-key",
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

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("testnet_names_every_key_it_misses_before_it_reads_the_deployment", async () => {
  const { POSTER_ACCOUNT, POSTER_PRIVATE_KEY } = KEYS;
  // No deployment file either: the keys are what it reports.
  const dir = await rootWith({ POSTER_ACCOUNT, POSTER_PRIVATE_KEY });

  await expect(loadTestnetTarget(dir)).rejects.toThrow(
    new Error(
      "missing keys for network testnet: JUDGE_ACCOUNT, JUDGE_PRIVATE_KEY, " +
        "AGENT_ANALYST_ACCOUNT, AGENT_ANALYST_PRIVATE_KEY, " +
        "AGENT_CODER_ACCOUNT, AGENT_CODER_PRIVATE_KEY " +
        "(set them in .env or .env.deploy.testnet)",
    ),
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
