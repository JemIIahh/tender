import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { type Signer, scriptedProfile, TenderError } from "@tender/client";
import { NETWORKS, ProfileSchema } from "@tender/shared";
import { KeyPair } from "near-api-js";
import { afterEach, expect, test, vi } from "vitest";
import { AGENT_NAMES, AGENTS } from "../packages/agents/src/agents";
import { LEAD_TAG } from "../packages/agents/src/agents/lead";
import {
  AGENT_BOND,
  bondTermsFor,
  type Deployment,
  deploy,
  deploymentPath,
  laneLimit,
  loadTarget,
  main,
  orAlreadyInitialised,
  REFERENCE_AGENTS,
  readDeployment,
  runLanes,
  type Step,
} from "./deploy";
import { REPO_ROOT } from "./lib/env";

// Everything here runs without a chain and without the network. The command line is tested with a
// stand-in for `deploy` and a temporary directory in place of the repository root, so that a real
// `.env.deploy.testnet` on this machine can never make a test deploy for real.

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

/** A node on a free local port that answers every request with `chainId` as its chain. */
async function nodeOnChain(chainId: string): Promise<string> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const { id } = JSON.parse(body) as { id: unknown };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id, result: { chain_id: chainId } }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A new directory holding the given files, whose names may have directories in them. */
async function dirWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tender-deploy-unit-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

/** Shaped like a key, and recognisable in any output: it must never be printed. */
const LEAKY = "ed25519:LEAKY-KEY-MATERIAL-that-must-never-be-printed";

const NOW = new Date("2026-10-30T09:15:00Z");
const PARENT = "tender-dev-20261030.testnet";
/** Not a real key: only the deploy itself ever parses the parent's. */
const PARENT_KEY = "ed25519:the-parents-key-in-these-tests";

const RECORD: Deployment = {
  network: "testnet",
  contract: `tender.${PARENT}`,
  tokens: { tusdc: `tusdc.${PARENT}`, usdc: "usdc.example.testnet" },
  accounts: { owner: PARENT, tender: `tender.${PARENT}`, tusdc: `tusdc.${PARENT}` },
  wasmSha256: "a".repeat(64),
  deployHeight: "123456",
  deployedAt: "2026-10-30T09:15:00.000Z",
};

/** Runs the command line against the files in a new directory, with `deploy` replaced. */
async function runCli(files: Record<string, string>, args: string[]) {
  const dir = await dirWith(files);
  const out: string[] = [];
  const err: string[] = [];
  const fake = vi.fn<typeof deploy>(async (_target, options) => {
    options?.log?.("OK create tender.example");
    return RECORD;
  });
  const code = await main(args, {
    dir,
    now: NOW,
    out: (line) => out.push(line),
    err: (text) => err.push(text),
    deploy: fake,
  });
  return { code, out, err: err.join("\n"), deploy: fake, dir };
}

const NEAR_CLI_COMMAND =
  "near account create-account sponsor-by-faucet-service tender-dev-20261030.testnet " +
  "autogenerate-new-keypair save-to-keychain network-config testnet create";

test("cli_without_a_parent_account_prints_the_near_cli_rs_command_and_exits_1", async () => {
  const { code, out, err, deploy: fake } = await runCli({}, ["--network", "testnet"]);

  expect(code).toBe(1);
  // The command is the one in the brief, with today's date.
  expect(err).toContain(NEAR_CLI_COMMAND);
  expect(err).toContain("DEPLOY_PARENT_ACCOUNT");
  expect(err).toContain(".env.deploy.testnet");
  expect(out).toEqual([]);
  expect(fake).not.toHaveBeenCalled();
});

test("cli_treats_a_blank_parent_account_as_unset", async () => {
  const files = { ".env.deploy.testnet": "DEPLOY_PARENT_ACCOUNT=\nDEPLOY_PARENT_PRIVATE_KEY=x\n" };
  const { code, err, deploy: fake } = await runCli(files, ["--network", "testnet"]);

  expect(code).toBe(1);
  expect(err).toContain(NEAR_CLI_COMMAND);
  expect(fake).not.toHaveBeenCalled();
});

test("cli_never_prints_a_key_that_sits_in_the_parent_account_variable", async () => {
  const layouts: Array<[string, Record<string, string>]> = [
    [
      "the two values swapped",
      {
        ".env.deploy.testnet": `DEPLOY_PARENT_ACCOUNT=${LEAKY}\nDEPLOY_PARENT_PRIVATE_KEY=${PARENT}\n`,
      },
    ],
    [
      // Node's parser alone reads the key's line as the account's value here.
      "a space after the = on the account line",
      { ".env.deploy.testnet": `DEPLOY_PARENT_ACCOUNT= \nDEPLOY_PARENT_PRIVATE_KEY=${LEAKY}\n` },
    ],
    [
      "that layout with the key in .env as well",
      {
        ".env": `DEPLOY_PARENT_PRIVATE_KEY=${LEAKY}\n`,
        ".env.deploy.testnet": `DEPLOY_PARENT_ACCOUNT= \nDEPLOY_PARENT_PRIVATE_KEY=${LEAKY}\n`,
      },
    ],
  ];
  for (const [what, files] of layouts) {
    const { code, out, err, deploy: fake } = await runCli(files, ["--network", "testnet"]);

    expect(code, what).toBe(1);
    expect(err, what).toContain("DEPLOY_PARENT_ACCOUNT");
    // Neither stream shows the key, or any part of it.
    expect(`${out.join("\n")}\n${err}`, what).not.toContain("LEAKY");
    expect(fake, what).not.toHaveBeenCalled();
  }
});

test("cli_names_the_missing_parent_key_and_nothing_else", async () => {
  const files = { ".env.deploy.testnet": `DEPLOY_PARENT_ACCOUNT=${PARENT}\n` };
  const { code, err, deploy: fake } = await runCli(files, ["--network", "testnet"]);

  expect(code).toBe(1);
  expect(err).toContain("DEPLOY_PARENT_PRIVATE_KEY");
  expect(err).not.toContain("near account create-account");
  expect(fake).not.toHaveBeenCalled();
});

test("cli_deploys_to_testnet_with_the_networks_rpc_window_and_usdc", async () => {
  const files = {
    ".env.deploy.testnet": `DEPLOY_PARENT_ACCOUNT=${PARENT}\nDEPLOY_PARENT_PRIVATE_KEY=${PARENT_KEY}\n`,
  };
  const { code, out, err, deploy: fake, dir } = await runCli(files, ["--network", "testnet"]);

  expect(code).toBe(0);
  expect(err).toBe("");
  // Only the step lines reach stdout.
  expect(out).toEqual(["OK create tender.example"]);
  expect(fake).toHaveBeenCalledTimes(1);
  expect(fake.mock.calls[0]?.[0]).toEqual({
    network: "testnet",
    rpcUrl: NETWORKS.testnet.rpcUrl,
    parent: { accountId: PARENT, privateKey: PARENT_KEY },
    minWindowSecs: 60,
    usdc: NETWORKS.testnet.usdc,
  });
  expect(fake.mock.calls[0]?.[1]).toMatchObject({ dir });
});

test("cli_refuses_mainnet_the_sandbox_and_anything_else_without_deploying", async () => {
  const files = {
    ".env.deploy.testnet": `DEPLOY_PARENT_ACCOUNT=${PARENT}\nDEPLOY_PARENT_PRIVATE_KEY=${PARENT_KEY}\n`,
  };
  const cases: Array<[string[], RegExp]> = [
    [["--network", "mainnet"], /mainnet.*plan 07/s],
    [["--network", "sandbox"], /sandbox.*tests/s],
    [["--network", "devnet"], /unknown network "devnet"/],
    [[], /usage: .*--network testnet/],
    [["--network", "testnet", "--force"], /force/],
  ];
  for (const [args, message] of cases) {
    const { code, err, out, deploy: fake } = await runCli(files, args);
    expect(code, args.join(" ")).toBe(1);
    expect(err, args.join(" ")).toMatch(message);
    expect(out).toEqual([]);
    expect(fake).not.toHaveBeenCalled();
  }
});

test("cli_prints_a_failed_deploy_with_its_code_and_exits_1", async () => {
  const files = {
    ".env.deploy.testnet": `DEPLOY_PARENT_ACCOUNT=${PARENT}\nDEPLOY_PARENT_PRIVATE_KEY=${PARENT_KEY}\n`,
  };
  const dir = await dirWith(files);
  const run = async (failure: unknown) => {
    const err: string[] = [];
    const code = await main(["--network", "testnet"], {
      dir,
      now: NOW,
      out: () => {},
      err: (text) => err.push(text),
      deploy: async () => {
        throw failure;
      },
    });
    return { code, err: err.join("\n") };
  };

  const plain = await run(new Error("the RPC is down"));
  expect(plain).toEqual({ code: 1, err: "deploy failed: the RPC is down" });

  const tender = await run(
    new TenderError("E_AUTH", "Method new is private", { txHash: "6kSpdaiEGudXLa4p43ALXFHCu96" }),
  );
  expect(tender.code).toBe(1);
  expect(tender.err).toBe(
    "deploy failed with E_AUTH\nMethod new is private\ntransaction 6kSpdaiEGudXLa4p43ALXFHCu96",
  );
  // Neither text holds the parent's key.
  expect(plain.err + tender.err).not.toContain(PARENT_KEY);
});

test("load_target_gives_testnet_the_parent_from_the_network_file_or_the_plain_env_file", async () => {
  const key = "ed25519:from-the-plain-file";
  const dir = await dirWith({
    ".env": `DEPLOY_PARENT_ACCOUNT=other.testnet\nDEPLOY_PARENT_PRIVATE_KEY=${key}\n`,
    ".env.deploy.testnet": `DEPLOY_PARENT_ACCOUNT=${PARENT}\n`,
  });

  expect(loadTarget("testnet", { dir, now: NOW }).parent).toEqual({
    accountId: PARENT,
    privateKey: key,
  });
});

test("deploy_refuses_mainnet_and_a_chain_without_an_rpc_url", async () => {
  const parent = { accountId: "sandbox", privateKey: KeyPair.fromRandom("ed25519").toString() };
  const dir = await dirWith({});

  await expect(
    deploy(
      { network: "mainnet", rpcUrl: "https://example.invalid", parent, minWindowSecs: 300 },
      { dir },
    ),
  ).rejects.toThrow(/mainnet.*plan 07/s);
  // The sandbox has no URL of its own: a local node picks its port, so the caller passes it.
  await expect(
    deploy({ network: "sandbox", rpcUrl: "", parent, minWindowSecs: 5 }, { dir }),
  ).rejects.toThrow(/RPC URL/);
});

test("deploy_checks_the_env_file_and_the_keys_before_it_uses_the_network", async () => {
  // Port 9 is the discard service: nothing answers there, so a request to it would fail with a
  // connection error and not with the messages expected below.
  const rpcUrl = "http://127.0.0.1:9";
  const goodKey = KeyPair.fromRandom("ed25519").toString();
  const parent = { accountId: "sandbox", privateKey: goodKey };
  const attempt = async (envFile: string, from: Signer = parent) => {
    const dir = await dirWith({ ".env.deploy.sandbox": envFile });
    return deploy({ network: "sandbox", rpcUrl, parent: from, minWindowSecs: 5 }, { dir }).then(
      () => "deployed",
      (error: Error) => error.message,
    );
  };

  // An env file of another deployment, whose accounts are under another parent: the message says
  // whose keys it holds, and to move it aside. It never reads as an order to delete it.
  const elsewhere = await attempt(
    `TENDER_CONTRACT=tender.elsewhere.sandbox\nTENDER_CONTRACT_FULL_ACCESS_KEY=${goodKey}\n`,
  );
  expect(elsewhere).toMatch(
    /\.env\.deploy\.sandbox names tender\.elsewhere\.sandbox as TENDER_CONTRACT, but this deploy's account is tender\.sandbox/,
  );
  expect(elsewhere).toMatch(/move it aside \(it holds the keys of tender\.elsewhere\.sandbox\)/);
  expect(elsewhere).not.toMatch(/fresh|delete|remove/i);
  expect(elsewhere).not.toContain(goodKey);
  // A value that is no account id may be a key, so it is not shown.
  const keyInPlace = await attempt(`TENDER_CONTRACT=${LEAKY}\n`);
  expect(keyInPlace).toMatch(/names something that is no account id as TENDER_CONTRACT/);
  expect(keyInPlace).toMatch(/move it aside \(it may hold keys\)/);
  expect(keyInPlace).not.toContain("LEAKY");
  // A stored key that is no key: named, but never shown.
  const damaged = await attempt(
    "TENDER_CONTRACT=tender.sandbox\nTENDER_CONTRACT_FULL_ACCESS_KEY=not-a-key-at-all\n",
  );
  expect(damaged).toMatch(
    /TENDER_CONTRACT_FULL_ACCESS_KEY in \.env\.deploy\.sandbox is not a valid private key/,
  );
  expect(damaged).not.toContain("not-a-key-at-all");
  // The same for the parent's.
  const noKey = await attempt("", { accountId: "sandbox", privateKey: "not-the-parents-key" });
  expect(noKey).toMatch(/the parent's key is not a valid private key/);
  expect(noKey).not.toContain("not-the-parents-key");
  // A parent account that is no account id may be a key that landed in the wrong variable: the
  // message names the variable, and does not show the value, whichever of the two is wrong.
  const keyAsAccount = await attempt("", { accountId: LEAKY, privateKey: goodKey });
  expect(keyAsAccount).toMatch(/^DEPLOY_PARENT_ACCOUNT is not a valid NEAR account id/);
  expect(keyAsAccount).toMatch(/space follows the =/);
  expect(keyAsAccount).not.toContain("LEAKY");
  const swapped = await attempt("", { accountId: LEAKY, privateKey: "sandbox" });
  expect(swapped).toMatch(/the parent's key is not a valid private key/);
  expect(swapped).not.toContain("LEAKY");
  // A parent whose sub-accounts would have ids longer than NEAR allows: the first is named.
  const long = "p".repeat(60);
  expect(await attempt("", { accountId: long, privateKey: goodKey })).toMatch(
    /^tender\.p+ is not a valid account id/,
  );
});

test("deploy_does_not_read_the_signing_keys_of_the_services", async () => {
  // <STEM>_PRIVATE_KEY is the key a service signs with, a function-call key that the owner adds
  // (ruling P02-R27); the deploy's own keys are <STEM>_FULL_ACCESS_KEY. The deploy neither checks
  // nor adopts the former, so a value there that is no key is no business of its. The record of
  // another deployment stops it right after the checks of the env file, before the network.
  const other = { ...RECORD, network: "sandbox", contract: "tender.elsewhere.sandbox" };
  const dir = await dirWith({
    ".env.deploy.sandbox":
      "JUDGE_PRIVATE_KEY=not-a-key-at-all\nTENDER_CONTRACT_PRIVATE_KEY=nor-is-this\n",
    "deployments/sandbox.json": `${JSON.stringify(other, null, 2)}\n`,
  });
  const parent = { accountId: "sandbox", privateKey: KeyPair.fromRandom("ed25519").toString() };

  const error = await deploy(
    { network: "sandbox", rpcUrl: "http://127.0.0.1:9", parent, minWindowSecs: 5 },
    { dir },
  ).then(
    () => "deployed",
    (e: Error) => e.message,
  );

  expect(error).toMatch(/is the record of another deployment/);
});

test("deploy_makes_an_existing_env_file_private_even_when_it_goes_no_further", async () => {
  // The owner makes .env.deploy.<network> by hand, with the parent's key in it, and gets 0644.
  const text = "# made by hand\nDEPLOY_PARENT_ACCOUNT=sandbox\n";
  const dir = await dirWith({ ".env.deploy.sandbox": text });
  const path = join(dir, ".env.deploy.sandbox");
  await chmod(path, 0o644);

  // Refused at once, so nothing is appended; the mode is changed all the same.
  const parent = { accountId: "sandbox", privateKey: "not a key" };
  await expect(
    deploy({ network: "sandbox", rpcUrl: "http://127.0.0.1:9", parent, minWindowSecs: 5 }, { dir }),
  ).rejects.toThrow(/not a valid private key/);

  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(await readFile(path, "utf8")).toBe(text);
});

test("deploy_refuses_the_record_of_another_deployment_before_it_uses_the_network", async () => {
  const other = { ...RECORD, network: "sandbox", contract: "tender.elsewhere.sandbox" };
  const text = `${JSON.stringify(other, null, 2)}\n`;
  const dir = await dirWith({ "deployments/sandbox.json": text });
  const parent = { accountId: "sandbox", privateKey: KeyPair.fromRandom("ed25519").toString() };

  // Port 9 answers nothing, so a request to it would fail with another message.
  const error = await deploy(
    { network: "sandbox", rpcUrl: "http://127.0.0.1:9", parent, minWindowSecs: 5 },
    { dir },
  ).then(
    () => "deployed",
    (e: Error) => e.message,
  );

  expect(error).toMatch(
    /is the record of another deployment \(contract tender\.elsewhere\.sandbox/,
  );
  expect(error).toMatch(/Move it aside/);
  expect(error).not.toMatch(/fresh|delete|remove/i);
  expect(await readFile(join(dir, "deployments", "sandbox.json"), "utf8")).toBe(text);
  expect(existsSync(join(dir, ".env.deploy.sandbox"))).toBe(false);
});

test("deploy_asks_the_node_which_chain_it_is_on_and_refuses_mainnet", async () => {
  const parent = { accountId: "sandbox", privateKey: KeyPair.fromRandom("ed25519").toString() };
  const attempt = async (network: "sandbox" | "testnet", chainId: string) =>
    deploy(
      { network, rpcUrl: await nodeOnChain(chainId), parent, minWindowSecs: 5 },
      { dir: await dirWith({}) },
    ).then(
      () => "deployed",
      (e: Error) => e.message,
    );

  // A mainnet node is refused whatever the target calls it.
  for (const network of ["sandbox", "testnet"] as const) {
    expect(await attempt(network, "mainnet")).toMatch(/mainnet.*plan 07.*chain id "mainnet"/s);
  }
  // A testnet deploy needs a testnet node.
  expect(await attempt("testnet", "localnet")).toMatch(
    /testnet deploy, but the node answered with chain id "localnet"/,
  );
});

test("run_lanes_runs_at_most_the_limit_of_lanes_at_once_and_still_runs_them_all", async () => {
  let running = 0;
  let peak = 0;
  const step = (label: string, fails = false): Step => ({
    label,
    async run() {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      if (fails) throw new Error(`${label} failed`);
      return "OK";
    },
  });
  const lanes = (failing: number) =>
    Array.from({ length: 11 }, (_, i) => [step(`a${i}`, i === failing), step(`b${i}`)]);

  const lines: string[] = [];
  await runLanes(lanes(-1), (line) => lines.push(line), 3);
  expect(peak).toBe(3);
  expect(lines).toHaveLength(22);

  // Without a limit they all go at once.
  peak = 0;
  await runLanes(lanes(-1), () => {});
  expect(peak).toBe(11);

  // A lane that fails stops there; the others, queued behind the limit or not, go on to the end.
  const after: string[] = [];
  await expect(runLanes(lanes(0), (line) => after.push(line), 2)).rejects.toThrow(/^a0: a0 failed/);
  expect(after).toHaveLength(20);

  // Testnet's public RPC is the one that gets the cap.
  expect(laneLimit("testnet")).toBe(3);
  expect(laneLimit("sandbox")).toBe(Number.POSITIVE_INFINITY);
});

test("or_already_initialised_turns_e_initialized_into_null_and_keeps_every_other_failure", async () => {
  expect(await orAlreadyInitialised(async () => "deployed")).toBe("deployed");

  const initialised = new TenderError("E_INITIALIZED", "The contract has already been initialized");
  expect(
    await orAlreadyInitialised(async () => {
      throw initialised;
    }),
  ).toBeNull();

  // Private `new`, called by the wrong account: a real failure, not a skip.
  const notAllowed = new TenderError("E_AUTH", "Method new is private");
  await expect(
    orAlreadyInitialised(async () => {
      throw notAllowed;
    }),
  ).rejects.toBe(notAllowed);
  const other = new Error("connection reset");
  await expect(
    orAlreadyInitialised(async () => {
      throw other;
    }),
  ).rejects.toBe(other);
});

test("read_deployment_reads_the_directory_tender_env_dir_names_when_given_no_dir", async () => {
  const named = await dirWith({
    "deployments/testnet.json": `${JSON.stringify(RECORD, null, 2)}\n`,
  });
  const empty = await dirWith({});
  try {
    vi.stubEnv("TENDER_ENV_DIR", named);
    expect(deploymentPath("testnet")).toBe(join(named, "deployments", "testnet.json"));
    expect(await readDeployment("testnet")).toEqual(RECORD);
    // A directory with no record has none, whatever the repository root holds.
    vi.stubEnv("TENDER_ENV_DIR", empty);
    expect(await readDeployment("testnet")).toBeNull();
  } finally {
    vi.unstubAllEnvs();
  }
});

test("read_deployment_reads_the_record_of_a_network_and_rejects_a_damaged_one", async () => {
  const recordFile = (record: unknown) => ({
    "deployments/testnet.json": `${JSON.stringify(record, null, 2)}\n`,
  });

  // No record: nothing to read, no error.
  expect(await readDeployment("testnet", await dirWith({}))).toBeNull();
  // The record of another network is not this one's.
  expect(await readDeployment("sandbox", await dirWith(recordFile(RECORD)))).toBeNull();
  expect(await readDeployment("testnet", await dirWith(recordFile(RECORD)))).toEqual(RECORD);
  // `usdc` is optional.
  const noUsdc = { ...RECORD, tokens: { tusdc: RECORD.tokens.tusdc } };
  expect(await readDeployment("testnet", await dirWith(recordFile(noUsdc)))).toEqual(noUsdc);

  const damaged: Array<[string, unknown]> = [
    ["not json", "{"],
    ["not an object", []],
    ["another network", { ...RECORD, network: "sandbox" }],
    ["no contract", { ...RECORD, contract: undefined }],
    ["a contract that is no account id", { ...RECORD, contract: "Not An Account" }],
    ["no tusdc", { ...RECORD, tokens: { usdc: "usdc.example.testnet" } }],
    ["an accounts list with a number in it", { ...RECORD, accounts: { owner: 1 } }],
    ["a short hash", { ...RECORD, wasmSha256: "abc" }],
    ["a height that is a number", { ...RECORD, deployHeight: 123456 }],
    ["a height with a leading zero", { ...RECORD, deployHeight: "0123" }],
    ["a time that is no date", { ...RECORD, deployedAt: "yesterday" }],
  ];
  for (const [what, record] of damaged) {
    const dir = await dirWith({
      "deployments/testnet.json": typeof record === "string" ? record : JSON.stringify(record),
    });
    await expect(readDeployment("testnet", dir), what).rejects.toThrow(
      /deployments[/\\]testnet\.json/,
    );
  }
});

test("the_env_files_of_a_deploy_are_git_ignored", async () => {
  // They hold private keys, so a commit with one in it is a leak.
  const names = [".env.deploy.testnet", ".env.deploy.sandbox", ".env.deploy.mainnet"];
  const { stdout } = await promisify(execFile)("git", ["check-ignore", ...names], {
    cwd: REPO_ROOT,
  });
  expect(stdout.trim().split("\n")).toEqual(names);
});

test("the_agent_bond_is_a_hundredth_of_a_tusdc_with_a_cooldown_of_14_days_on_testnet_and_the_shortest_window_elsewhere", () => {
  const testnet = NETWORKS.testnet;
  const sandbox = NETWORKS.sandbox;
  expect(AGENT_BOND).toBe(10_000n);
  expect(bondTermsFor({ network: "testnet", minWindowSecs: testnet.minWindowSecs })).toEqual({
    amount: 10_000n,
    cooldownSecs: 14 * 24 * 60 * 60,
  });
  // A local chain: the least the contract takes, so that a test sees a bond come back.
  expect(bondTermsFor({ network: "sandbox", minWindowSecs: sandbox.minWindowSecs })).toEqual({
    amount: 10_000n,
    cooldownSecs: sandbox.minWindowSecs,
  });
  // A target may name either or both; what it leaves out stays the default.
  expect(
    bondTermsFor({ network: "testnet", minWindowSecs: 60, agentBond: { amount: 5n } }),
  ).toEqual({ amount: 5n, cooldownSecs: 14 * 24 * 60 * 60 });
  expect(
    bondTermsFor({ network: "sandbox", minWindowSecs: 5, agentBond: { cooldownSecs: 30 } }),
  ).toEqual({ amount: 10_000n, cooldownSecs: 30 });
  // The testnet cooldown is inside the contract's bounds: the window at the least, 56 days at most.
  expect(14 * 24 * 60 * 60).toBeGreaterThanOrEqual(testnet.minWindowSecs);
  expect(14 * 24 * 60 * 60).toBeLessThanOrEqual(56 * 24 * 60 * 60);
});

test("the_reference_agents_register_with_the_tags_they_work_on_and_a_profile_the_registry_takes", () => {
  // The deploy registers the four accounts it holds keys for. The tags are the ones the agents look
  // for in a brief, so a task of theirs finds them: they must not drift from the agents package.
  expect(Object.keys(REFERENCE_AGENTS)).toEqual([...AGENT_NAMES, "lead"]);
  for (const name of AGENT_NAMES)
    expect([...REFERENCE_AGENTS[name]], name).toEqual([...AGENTS[name].tags]);
  expect([...REFERENCE_AGENTS.lead]).toEqual([LEAD_TAG]);
  // Their profiles (a name, no document) pass the registry's schema, with at most 8 short tags.
  for (const [name, tags] of Object.entries(REFERENCE_AGENTS)) {
    const profile = scriptedProfile(name, tags);
    expect(ProfileSchema.safeParse(profile.document).success, name).toBe(true);
    expect(profile.tags.length, name).toBeLessThanOrEqual(8);
  }
});
