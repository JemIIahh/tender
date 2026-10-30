import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { type Signer, TenderError } from "@tender/client";
import { NETWORKS } from "@tender/shared";
import { KeyPair } from "near-api-js";
import { afterEach, expect, test, vi } from "vitest";
import {
  type Deployment,
  deploy,
  loadTarget,
  main,
  orAlreadyInitialised,
  readDeployment,
} from "./deploy";
import { REPO_ROOT } from "./lib/env";

// Everything here runs without a chain and without the network. The command line is tested with a
// stand-in for `deploy` and a temporary directory in place of the repository root, so that a real
// `.env.deploy.testnet` on this machine can never make a test deploy for real.

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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

  // An env file of another deployment, whose accounts are under another parent.
  expect(await attempt("TENDER_ACCOUNT=tender.elsewhere.sandbox\n")).toMatch(
    /\.env\.deploy\.sandbox names tender\.elsewhere\.sandbox as TENDER_ACCOUNT.*tender\.sandbox/s,
  );
  // A stored key that is no key: named, but never shown.
  const damaged = await attempt(
    "TENDER_ACCOUNT=tender.sandbox\nTENDER_PRIVATE_KEY=not-a-key-at-all\n",
  );
  expect(damaged).toMatch(
    /TENDER_PRIVATE_KEY in \.env\.deploy\.sandbox is not a valid private key/,
  );
  expect(damaged).not.toContain("not-a-key-at-all");
  // The same for the parent's.
  const noKey = await attempt("", { accountId: "sandbox", privateKey: "not-the-parents-key" });
  expect(noKey).toMatch(/the parent's key is not a valid private key/);
  expect(noKey).not.toContain("not-the-parents-key");
  // A parent whose sub-accounts would have ids longer than NEAR allows: the first is named.
  const long = "p".repeat(60);
  expect(await attempt("", { accountId: long, privateKey: goodKey })).toMatch(
    /^tender\.p+ is not a valid account id/,
  );
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
