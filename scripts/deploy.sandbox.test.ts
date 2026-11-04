import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { type Signer, scriptedProfile, TenderClient } from "@tender/client";
import {
  Account,
  type Action,
  actions,
  baseEncode,
  JsonRpcProvider,
  KeyPair,
  type KeyPairString,
} from "near-api-js";
import { afterAll, beforeAll, expect, test } from "vitest";
import { AGENT_BOND, type Deployment, deploy, REFERENCE_AGENTS } from "./deploy";
import { REPO_ROOT } from "./lib/env";

// A bare local chain, with nothing deployed on it, and then the deploy script on top of it. The
// script creates its accounts under a parent; here that is the chain's root account, or one the
// test funds for the purpose, so that the tests do not share accounts.

/**
 * The part of near-sandbox these tests use. The package is a dependency of @tender/client, not of
 * the repository root, so it is loaded the way the client loads it.
 */
interface NearSandbox {
  Sandbox: { start(params: object): Promise<{ rpcUrl: string; tearDown(): Promise<void> }> };
  DEFAULT_ACCOUNT_ID: string;
  DEFAULT_PRIVATE_KEY: string;
}
const { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } = createRequire(
  new URL("../packages/client/package.json", import.meta.url),
)("near-sandbox") as NearSandbox;

const NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;
/** The code hash of an account that has no contract. */
const NO_CODE = "11111111111111111111111111111111";

const roleVars = (stem: string) => [`${stem}_ACCOUNT`, `${stem}_FULL_ACCESS_KEY`] as const;

/**
 * The accounts the deploy creates under its parent and the variables it writes their ids and keys
 * to. Written out here, not imported, because the names are what the other scripts read. The keys
 * are full-access keys, so they are <STEM>_FULL_ACCESS_KEY and never <STEM>_PRIVATE_KEY, which is
 * what a service signs with (ruling P02-R27). Tender's are TENDER_CONTRACT and
 * TENDER_CONTRACT_FULL_ACCESS_KEY: TENDER_ACCOUNT and TENDER_PRIVATE_KEY are the MCP signer's, and
 * the deploy never writes them.
 */
const MEMBERS = [
  ["tender", "TENDER_CONTRACT", "TENDER_CONTRACT_FULL_ACCESS_KEY"],
  ["treasury", ...roleVars("TREASURY")],
  ["judge", ...roleVars("JUDGE")],
  ["keeper", ...roleVars("KEEPER")],
  ["tusdc", ...roleVars("TUSDC")],
  ["poster", ...roleVars("POSTER")],
  ["analyst", ...roleVars("AGENT_ANALYST")],
  ["coder", ...roleVars("AGENT_CODER")],
  ["extractor", ...roleVars("AGENT_EXTRACTOR")],
  ["lead", ...roleVars("AGENT_LEAD")],
] as const;

const tenderWasm = await readFile(join(REPO_ROOT, "contract", "res", "tender.wasm"));
const tokenWasm = await readFile(join(REPO_ROOT, "contract", "res", "test_token.wasm"));
const codeHashOf = (wasm: Uint8Array) => baseEncode(createHash("sha256").update(wasm).digest());

let node: Awaited<ReturnType<NearSandbox["Sandbox"]["start"]>>;
let provider: JsonRpcProvider;
/** The chain's root account, which holds 10,000 NEAR. */
let root: Signer;
/** Views of `tender.sandbox`, the contract of the deploy made under the root. */
let reader: TenderClient;
const dirs: string[] = [];

/** A new empty directory, for the env file and the record of one deploy. */
async function newDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tender-deploy-"));
  dirs.push(dir);
  return dir;
}

/** Sends one transaction as `signer` and waits until it is final. Throws if it fails. */
async function sendAs(signer: Signer, receiverId: string, acts: Action[]) {
  const account = new Account(signer.accountId, provider, signer.privateKey as KeyPairString);
  await account.signAndSendTransaction({ receiverId, actions: acts, waitUntil: "FINAL" });
}

/** A new account `<name>.sandbox` with `balance` and a fresh full-access key, made by the root. */
async function fundedAccount(name: string, balance: bigint): Promise<Signer> {
  const key = KeyPair.fromRandom("ed25519");
  const accountId = `${name}.${DEFAULT_ACCOUNT_ID}`;
  await sendAs(root, accountId, [
    actions.createAccount(),
    actions.transfer(balance),
    actions.addFullAccessKey(key.getPublicKey()),
  ]);
  return { accountId, privateKey: key.toString() };
}

/** Deploys the test token to `account` and initialises it, in one transaction. */
function deployToken(account: Signer): Promise<void> {
  return sendAs(account, account.accountId, [
    actions.deployContract(tokenWasm),
    actions.functionCall("new", { owner_id: root.accountId, total_supply: "1000" }, 30n * TGAS, 0n),
  ]);
}

/** The deploy's target on this chain, with `usdc` standing in for Circle's USDC on testnet. */
const targetFor = (parent: Signer, usdc: string) => ({
  network: "sandbox" as const,
  rpcUrl: node.rpcUrl,
  parent,
  minWindowSecs: 5,
  usdc,
});

/** Runs the deploy and returns the lines it printed with what it returned. */
async function runDeploy(parent: Signer, usdc: string, dir: string) {
  const lines: string[] = [];
  const deployment = await deploy(targetFor(parent, usdc), { dir, log: (l) => lines.push(l) });
  return { lines, deployment };
}

/** A line without its `OK ` or `SKIP ` and its ` (exists)`: the step it is about. */
const stepOf = (line: string) => line.replace(/^(OK|SKIP) /, "").replace(/ \(exists\)$/, "");

/** The full-access keys in an env file's text. */
function fullAccessKeysIn(envText: string): string[] {
  return Object.entries(parseEnv(envText))
    .filter(([name]) => name.endsWith("_FULL_ACCESS_KEY"))
    .map(([, value]) => value as string);
}

/**
 * Checks that `height` is the block of `accountId`'s deploy: the account has no code the block
 * before, and has it in the block itself. A transaction that an account sends to itself runs in the
 * block that holds it, so that block is the first with the code.
 *
 * The block before is the deploy block's parent, found by its hash, not `height - 1`: a height
 * whose producer missed its slot has no block, which a busy machine makes likely on the sandbox.
 */
async function expectDeployBlock(accountId: string, height: string, wasm: Uint8Array) {
  const at = (blockId: number | string) =>
    provider.viewAccount({ accountId, blockQuery: { blockId } }).then((a) => a.code_hash);
  const { header } = await provider.viewBlock({ blockId: Number(height) });
  expect(await at(header.prev_hash)).toBe(NO_CODE);
  expect(await at(Number(height))).toBe(codeHashOf(wasm));
}

let mainDir: string;
let first: { lines: string[]; deployment: Deployment; startedAt: Date; finishedAt: Date };

beforeAll(async () => {
  node = await Sandbox.start({});
  provider = new JsonRpcProvider({ url: node.rpcUrl });
  root = { accountId: DEFAULT_ACCOUNT_ID, privateKey: DEFAULT_PRIVATE_KEY };
  reader = new TenderClient({
    network: "sandbox",
    contractId: "tender.sandbox",
    rpcUrl: node.rpcUrl,
  });

  await deployToken(await fundedAccount("usdc", 10n * NEAR));

  // The first deploy, under the root: tender.sandbox, tusdc.sandbox and the rest.
  mainDir = await newDir();
  const startedAt = new Date();
  const { lines, deployment } = await runDeploy(root, "usdc.sandbox", mainDir);
  first = { lines, deployment, startedAt, finishedAt: new Date() };
});

afterAll(async () => {
  await node?.tearDown();
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("deploy_is_idempotent_on_sandbox", async () => {
  // The first run, made before the tests, did every step.
  expect(first.lines.length).toBeGreaterThan(0);
  for (const line of first.lines) expect(line).toMatch(/^OK \S/);

  const second: string[] = [];
  const again = await deploy(targetFor(root, "usdc.sandbox"), {
    dir: mainDir,
    log: (line) => second.push(line),
  });

  // The second run found every step done, and none other.
  for (const line of second) expect(line).toMatch(/^SKIP \S.* \(exists\)$/);
  expect(second.map(stepOf).sort()).toEqual(first.lines.map(stepOf).sort());
  // It returns the record of the first.
  expect(again).toEqual(first.deployment);

  const config = await reader.getConfig();
  expect(config.tokens.map((t) => t.token)).toContain(first.deployment.tokens.tusdc);
  expect(first.deployment.tokens.tusdc).toBe("tusdc.sandbox");
});

test("deploy_writes_every_account_and_its_full_access_key_to_the_env_file", async () => {
  const envPath = join(mainDir, ".env.deploy.sandbox");
  const env = parseEnv(await readFile(envPath, "utf8"));

  // Exactly the variables the other scripts read, and one more that the deploy reads itself.
  const names = MEMBERS.flatMap(([, accountVar, keyVar]) => [accountVar, keyVar]);
  expect(Object.keys(env).sort()).toEqual([...names, "DEPLOY_TENDER_HEIGHT"].sort());
  // A full-access key sits under a _FULL_ACCESS_KEY name and under no other. A <STEM>_PRIVATE_KEY is
  // the key a service signs with, a function-call key that the owner adds, and the network file
  // wins over .env: a full-access key under that name would replace it.
  expect(Object.keys(env).filter((name) => name.endsWith("_FULL_ACCESS_KEY"))).toHaveLength(
    MEMBERS.length,
  );
  expect(Object.keys(env).filter((name) => name.endsWith("_PRIVATE_KEY"))).toEqual([]);
  // The MCP signer's names are not the deploy's to write either.
  expect(env).not.toHaveProperty("TENDER_ACCOUNT");
  expect(env).not.toHaveProperty("TENDER_PRIVATE_KEY");

  const keys = new Set<string>();
  for (const [name, accountVar, keyVar] of MEMBERS) {
    const accountId = `${name}.sandbox`;
    expect(env[accountVar]).toBe(accountId);
    const privateKey = env[keyVar] as string;
    keys.add(privateKey);
    // It is a key of that account, with full access.
    const publicKey = KeyPair.fromString(privateKey as KeyPairString)
      .getPublicKey()
      .toString();
    expect(await reader.viewAccessKey(accountId, publicKey)).toEqual({ permission: "FullAccess" });
  }
  // Each account has a key of its own.
  expect(keys.size).toBe(MEMBERS.length);
  // The file holds secrets: only its owner may read it.
  expect(statSync(envPath).mode & 0o777).toBe(0o600);
});

test("deploy_inits_tender_by_its_own_account_and_the_token_for_the_poster", async () => {
  // `new` of Tender is private, so these values are there only if the tender account sent it.
  const config = await reader.getConfig();
  expect(config).toMatchObject({
    owner: "sandbox",
    treasury: "treasury.sandbox",
    fee_bps: 500,
    min_window_secs: 5,
    paused: false,
  });
  expect(config.tokens).toEqual([
    { token: "tusdc.sandbox", min_reward: "1", max_reward: "1000000000000", enabled: true },
    { token: "usdc.sandbox", min_reward: "100000", max_reward: "50000000", enabled: true },
  ]);
  // The token's whole supply is the poster's.
  expect(await reader.ftBalanceOf("tusdc.sandbox", "poster.sandbox")).toBe(10n ** 12n);
});

test("deploy_sets_the_agent_bond_in_the_test_token_before_any_agent_registers", async () => {
  // The owner's lane ends with the cooldown and then the bond, both in the first run's output.
  expect(first.lines).toContain("OK set_agent_bond_cooldown 5");
  expect(first.lines).toContain("OK set_agent_bond tusdc.sandbox 1000000");
  const lines = first.lines;
  expect(lines.indexOf("OK set_agent_bond_cooldown 5")).toBeLessThan(
    lines.indexOf("OK set_agent_bond tusdc.sandbox 1000000"),
  );
  expect(lines.indexOf("OK set_token tusdc.sandbox")).toBeLessThan(
    lines.indexOf("OK set_agent_bond tusdc.sandbox 1000000"),
  );

  // On a local chain the cooldown is the shortest window, the least the contract takes.
  const config = await reader.getConfig();
  expect(config).toMatchObject({
    agent_bond_token: "tusdc.sandbox",
    agent_bond_amount: String(AGENT_BOND),
    agent_bond_cooldown_secs: "5",
  });
  expect(config.agent_bond_amount).toBe("1000000");

  // Every agent registers after the bond is set, and none before it.
  const bondAt = lines.indexOf("OK set_agent_bond tusdc.sandbox 1000000");
  for (const name of Object.keys(REFERENCE_AGENTS)) {
    const at = lines.indexOf(`OK register_agent ${name}.sandbox`);
    expect(at, name).toBeGreaterThan(bondAt);
  }
});

test("deploy_registers_the_four_reference_agents_with_their_bonds", async () => {
  const names = Object.keys(REFERENCE_AGENTS);
  expect(names).toEqual(["analyst", "coder", "extractor", "lead"]);
  for (const name of names) {
    const id = `${name}.sandbox`;
    // Each step, in order: the token, the bond into the vault, the registration.
    const lines = first.lines;
    const steps = [
      `OK register ${id} at tusdc.sandbox`,
      `OK deposit bond for ${id}`,
      `OK register_agent ${id}`,
    ].map((line) => lines.indexOf(line));
    expect(
      steps.every((at) => at >= 0),
      `${name}: ${steps}`,
    ).toBe(true);
    expect(
      [...steps].sort((a, b) => a - b),
      name,
    ).toEqual(steps);

    // The agent is active with the bond the owner set, and its profile is the one of its name.
    const profile = scriptedProfile(name, REFERENCE_AGENTS[name as keyof typeof REFERENCE_AGENTS]);
    expect(await reader.getAgent(id), name).toMatchObject({
      account: id,
      status: "active",
      bond_token: "tusdc.sandbox",
      bond_amount: "1000000",
      claimable_at: null,
      profile_uri: profile.uri,
      profile_hash: profile.hash,
      tags: [...profile.tags],
    });
    // The bond came out of the vault, and the wallet holds nothing: exactly the bond was minted.
    expect(await reader.balanceOf(id, "tusdc.sandbox"), name).toBe(0n);
    expect(await reader.ftBalanceOf("tusdc.sandbox", id), name).toBe(0n);
  }
  // The others are no agents: the deploy registers the four that it holds the keys of for the work
  // of an agent, and no service.
  for (const name of ["treasury", "judge", "keeper", "poster", "tusdc", "tender"]) {
    expect(await reader.getAgent(`${name}.sandbox`), name).toBeNull();
  }
});

test("deploy_registers_storage_for_everyone_and_tender_with_both_tokens", async () => {
  const accounts = ["sandbox", ...MEMBERS.map(([name]) => `${name}.sandbox`)];
  for (const account of accounts) {
    const storage = await reader.storageBalanceOf(account);
    expect(storage, `${account} has no storage balance with Tender`).not.toBeNull();
    // 0.1 NEAR, less nothing: the first deposit is credited whole.
    expect(BigInt(storage?.total ?? "0")).toBe(NEAR / 10n);
  }
  for (const token of ["tusdc.sandbox", "usdc.sandbox"]) {
    expect(await reader.ftStorageBalanceOf(token, "tender.sandbox")).not.toBeNull();
  }
});

test("deploy_record_names_the_deploy_block_and_holds_no_secret", async () => {
  const recordPath = join(mainDir, "deployments", "sandbox.json");
  const text = await readFile(recordPath, "utf8");
  const record = JSON.parse(text) as Deployment;

  expect(text.endsWith("}\n")).toBe(true);
  expect(record).toEqual(first.deployment);
  expect(record).toEqual({
    network: "sandbox",
    contract: "tender.sandbox",
    tokens: { tusdc: "tusdc.sandbox", usdc: "usdc.sandbox" },
    accounts: {
      owner: "sandbox",
      ...Object.fromEntries(MEMBERS.map(([name]) => [name, `${name}.sandbox`])),
    },
    wasmSha256: createHash("sha256").update(tenderWasm).digest("hex"),
    deployHeight: expect.stringMatching(/^[1-9][0-9]*$/),
    deployedAt: expect.any(String),
  });
  const deployedAt = new Date(record.deployedAt);
  expect(deployedAt.toISOString()).toBe(record.deployedAt);
  expect(deployedAt.getTime()).toBeGreaterThanOrEqual(first.startedAt.getTime());
  expect(deployedAt.getTime()).toBeLessThanOrEqual(first.finishedAt.getTime());
  await expectDeployBlock("tender.sandbox", record.deployHeight, tenderWasm);

  // No private key reached the record or the lines the script printed, the parent's included.
  const secrets = [
    ...fullAccessKeysIn(await readFile(join(mainDir, ".env.deploy.sandbox"), "utf8")),
    DEFAULT_PRIVATE_KEY,
  ];
  expect(secrets).toHaveLength(MEMBERS.length + 1);
  for (const secret of secrets) {
    expect(text).not.toContain(secret);
    expect(first.lines.join("\n")).not.toContain(secret);
  }
});

test("deploy_writes_a_lost_record_again_with_the_original_deploy_block", async () => {
  // A copy of the first deploy's files, minus the record: the run that died before it wrote one.
  const dir = await newDir();
  await cp(join(mainDir, ".env.deploy.sandbox"), join(dir, ".env.deploy.sandbox"));

  const { lines, deployment } = await runDeploy(root, "usdc.sandbox", dir);

  expect(lines.filter((l) => l.startsWith("OK "))).toEqual(["OK record deployments/sandbox.json"]);
  expect(lines.filter((l) => !l.startsWith("OK "))).toHaveLength(first.lines.length - 1);
  expect(deployment).toEqual({ ...first.deployment, deployedAt: deployment.deployedAt });
  expect(JSON.parse(await readFile(join(dir, "deployments", "sandbox.json"), "utf8"))).toEqual(
    deployment,
  );
});

test("deploy_asks_for_the_deploy_block_when_it_has_neither_a_record_nor_a_note_of_it", async () => {
  // The first deploy's env file without its note of the block, and no record: nothing can say
  // which block Tender was deployed in, and a guess would start the indexer in the wrong place.
  const dir = await newDir();
  const env = (await readFile(join(mainDir, ".env.deploy.sandbox"), "utf8"))
    .split("\n")
    .filter((line) => !line.startsWith("DEPLOY_TENDER_HEIGHT="))
    .join("\n");
  await writeFile(join(dir, ".env.deploy.sandbox"), env);
  const lines: string[] = [];

  await expect(
    deploy(targetFor(root, "usdc.sandbox"), { dir, log: (l) => lines.push(l) }),
  ).rejects.toThrow(/^record deployments\/sandbox\.json: .*DEPLOY_TENDER_HEIGHT/s);

  // Every other step found its work done, and no record was written.
  expect(lines).toHaveLength(first.lines.length - 1);
  for (const line of lines) expect(line).toMatch(/^SKIP /);
  expect(existsSync(join(dir, "deployments", "sandbox.json"))).toBe(false);
});

test("deploy_does_not_overwrite_the_record_of_another_deployment", async () => {
  const dir = await newDir();
  await cp(join(mainDir, ".env.deploy.sandbox"), join(dir, ".env.deploy.sandbox"));
  const other = { ...first.deployment, contract: "tender.elsewhere.sandbox" };
  await mkdir(join(dir, "deployments"));
  const path = join(dir, "deployments", "sandbox.json");
  await writeFile(path, `${JSON.stringify(other, null, 2)}\n`);

  await expect(runDeploy(root, "usdc.sandbox", dir)).rejects.toThrow(
    /is the record of another deployment \(contract tender\.elsewhere\.sandbox/,
  );

  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(other);
});

test("deploy_refuses_the_record_of_another_deployment_for_a_fresh_parent_before_it_spends", async () => {
  // A new parent deploys everything anew, so the run used to end by writing its record over the
  // one in deployments/: the canonical record, which the skeleton and the indexer read.
  const parent = await fundedAccount("newer", 100n * NEAR);
  const dir = await newDir();
  const path = join(dir, "deployments", "sandbox.json");
  await mkdir(join(dir, "deployments"));
  await writeFile(path, `${JSON.stringify(first.deployment, null, 2)}\n`);
  const before = await readFile(path);
  const lines: string[] = [];

  await expect(
    deploy(targetFor(parent, "usdc.sandbox"), { dir, log: (l) => lines.push(l) }),
  ).rejects.toThrow(/is the record of another deployment \(contract tender\.sandbox/);

  // Refused before the first transaction: nothing printed, no key written, no account made, and
  // the record is what it was, byte for byte.
  expect(lines).toEqual([]);
  expect(existsSync(join(dir, ".env.deploy.sandbox"))).toBe(false);
  await expect(provider.viewAccount({ accountId: "tender.newer.sandbox" })).rejects.toThrow();
  expect((await readFile(path)).equals(before)).toBe(true);
});

test("deploy_stops_before_it_sends_when_the_env_file_does_not_read_back_as_written", async () => {
  // A line written by hand that ends in "= " makes node's parser take the next line as its value.
  // The deploy appends right after that line, so its first variable is the one that goes missing.
  const parent = await fundedAccount("swallow", 100n * NEAR);
  const dir = await newDir();
  await writeFile(join(dir, ".env.deploy.sandbox"), "NOTE= \n");
  const lines: string[] = [];

  const error = await deploy(targetFor(parent, "usdc.sandbox"), {
    dir,
    log: (l) => lines.push(l),
  }).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).toMatch(
    /\.env\.deploy\.sandbox does not read back as written \(.*TENDER_CONTRACT\)/,
  );
  // The key that was appended is not in the message, and the chain was not touched.
  const keyLine = (await readFile(join(dir, ".env.deploy.sandbox"), "utf8")).match(
    /^TENDER_CONTRACT_FULL_ACCESS_KEY=(.+)$/m,
  );
  expect(keyLine?.[1]).toBeDefined();
  expect(message).not.toContain(keyLine?.[1] ?? "");
  expect(lines).toEqual([]);
  await expect(provider.viewAccount({ accountId: "tender.swallow.sandbox" })).rejects.toThrow();
});

test("deploy_refuses_a_parent_that_cannot_pay_before_it_creates_anything", async () => {
  const poor = await fundedAccount("poor", 5n * NEAR);
  const dir = await newDir();
  const lines: string[] = [];

  await expect(
    deploy(targetFor(poor, "usdc.sandbox"), { dir, log: (l) => lines.push(l) }),
  ).rejects.toThrow(/poor\.sandbox has 5 NEAR.*36 NEAR/s);

  expect(lines).toEqual([]);
  expect(existsSync(join(dir, ".env.deploy.sandbox"))).toBe(false);
  await expect(provider.viewAccount({ accountId: "tender.poor.sandbox" })).rejects.toThrow();
});

test("deploy_refuses_a_usdc_that_does_not_exist_before_it_creates_anything", async () => {
  const parent = await fundedAccount("nousdc", 100n * NEAR);
  const dir = await newDir();

  await expect(runDeploy(parent, "nothing.sandbox", dir)).rejects.toThrow(
    /nothing\.sandbox does not exist/,
  );

  expect(existsSync(join(dir, ".env.deploy.sandbox"))).toBe(false);
  await expect(provider.viewAccount({ accountId: "tender.nousdc.sandbox" })).rejects.toThrow();
});

test("deploy_refuses_an_account_that_runs_other_code_before_it_creates_anything", async () => {
  const parent = await fundedAccount("other", 100n * NEAR);
  const dir = await newDir();
  // tender.other.sandbox is the test token's: the env file has its key, and it holds that code.
  const key = KeyPair.fromRandom("ed25519");
  const tender: Signer = { accountId: "tender.other.sandbox", privateKey: key.toString() };
  await sendAs(parent, tender.accountId, [
    actions.createAccount(),
    actions.transfer(8n * NEAR),
    actions.addFullAccessKey(key.getPublicKey()),
  ]);
  await sendAs(tender, tender.accountId, [actions.deployContract(tokenWasm)]);
  await writeFile(
    join(dir, ".env.deploy.sandbox"),
    `TENDER_CONTRACT=${tender.accountId}\nTENDER_CONTRACT_FULL_ACCESS_KEY=${tender.privateKey}\n`,
  );

  await expect(runDeploy(parent, "usdc.sandbox", dir)).rejects.toThrow(
    /tender\.other\.sandbox runs other code/,
  );

  await expect(provider.viewAccount({ accountId: "treasury.other.sandbox" })).rejects.toThrow();
});

test("deploy_names_the_key_it_lacks_for_an_account_that_exists", async () => {
  // tender.sandbox exists, but this directory has no env file.
  const lost = await newDir();
  await expect(runDeploy(root, "usdc.sandbox", lost)).rejects.toThrow(
    /tender\.sandbox exists, but TENDER_CONTRACT_FULL_ACCESS_KEY is not in \.env\.deploy\.sandbox/,
  );
  expect(existsSync(join(lost, ".env.deploy.sandbox"))).toBe(false);

  // And a key that is not the account's.
  const wrong = await newDir();
  const stranger = KeyPair.fromRandom("ed25519").toString();
  await writeFile(
    join(wrong, ".env.deploy.sandbox"),
    `TENDER_CONTRACT=tender.sandbox\nTENDER_CONTRACT_FULL_ACCESS_KEY=${stranger}\n`,
  );
  const error = await runDeploy(root, "usdc.sandbox", wrong).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(
    /TENDER_CONTRACT_FULL_ACCESS_KEY .* is not a full-access key/,
  );
  // The message names the variable, never the key.
  expect((error as Error).message).not.toContain(stranger);
});

test("deploy_uses_the_key_an_interrupted_run_left_for_an_account_it_never_made", async () => {
  // A run that wrote tender's key to the env file and stopped before it made the account: the
  // next run makes the account with that key, so no key on disk is ever for an account without it.
  const parent = await fundedAccount("crash", 100n * NEAR);
  const dir = await newDir();
  const key = KeyPair.fromRandom("ed25519");
  const envPath = join(dir, ".env.deploy.sandbox");
  await writeFile(
    envPath,
    `TENDER_CONTRACT=tender.crash.sandbox\nTENDER_CONTRACT_FULL_ACCESS_KEY=${key.toString()}\n`,
  );

  const { lines } = await runDeploy(parent, "usdc.sandbox", dir);

  expect(lines).toContain("OK create tender.crash.sandbox");
  const text = await readFile(envPath, "utf8");
  expect(text.match(/^TENDER_CONTRACT_FULL_ACCESS_KEY=/gm)).toHaveLength(1);
  expect(parseEnv(text).TENDER_CONTRACT_FULL_ACCESS_KEY).toBe(key.toString());
  const crashed = new TenderClient({
    network: "sandbox",
    contractId: "tender.crash.sandbox",
    rpcUrl: node.rpcUrl,
  });
  expect(
    await crashed.viewAccessKey("tender.crash.sandbox", key.getPublicKey().toString()),
  ).toEqual({ permission: "FullAccess" });
});

test("deploy_resumes_after_a_step_fails_and_still_knows_the_deploy_block", async () => {
  // The deploy stops half way when the USDC account is there but holds no token: registering
  // Tender with it fails. The other lanes carry on to the end.
  const parent = await fundedAccount("resume", 100n * NEAR);
  const ghost = await fundedAccount("ghost", 10n * NEAR);
  const dir = await newDir();
  const stopped: string[] = [];

  await expect(
    deploy(targetFor(parent, ghost.accountId), { dir, log: (l) => stopped.push(l) }),
  ).rejects.toThrow(/register tender\.resume\.sandbox at ghost\.sandbox/);

  expect(stopped.filter((l) => !l.startsWith("OK "))).toEqual([]);
  expect(stopped).toContain("OK deploy tender.resume.sandbox");
  expect(stopped).toContain("OK register tender.resume.sandbox at tusdc.resume.sandbox");
  expect(stopped).not.toContain("OK register tender.resume.sandbox at ghost.sandbox");
  expect(existsSync(join(dir, "deployments", "sandbox.json"))).toBe(false);

  // The token turns up, and the next run does what is left: three steps, the record the last.
  await deployToken(ghost);
  const resumed: string[] = [];
  const deployment = await deploy(targetFor(parent, ghost.accountId), {
    dir,
    log: (l) => resumed.push(l),
  });

  // The reference agents had not begun: they register after the lanes that stopped.
  const agents = Object.keys(REFERENCE_AGENTS).flatMap((name) => [
    `OK register ${name}.resume.sandbox at tusdc.resume.sandbox`,
    `OK deposit bond for ${name}.resume.sandbox`,
    `OK register_agent ${name}.resume.sandbox`,
  ]);
  expect(stopped.filter((l) => l.includes("register_agent"))).toEqual([]);
  expect(resumed.filter((l) => l.startsWith("OK ")).sort()).toEqual(
    [
      "OK record deployments/sandbox.json",
      "OK register tender.resume.sandbox at ghost.sandbox",
      "OK storage tender.resume.sandbox at tender.resume.sandbox",
      ...agents,
    ].sort(),
  );
  expect(resumed.filter((l) => !l.startsWith("OK "))).toHaveLength(stopped.length);
  // The first run's deploy of Tender is the one the record names, though it was not made now.
  await expectDeployBlock("tender.resume.sandbox", deployment.deployHeight, tenderWasm);
  expect(deployment.tokens).toEqual({ tusdc: "tusdc.resume.sandbox", usdc: "ghost.sandbox" });
});

// These deploy again, under parents of their own, and come last: the sandbox forgets old blocks as
// it runs, and the tests above read the blocks of the first deploy.
test("deploy_run_again_leaves_a_bond_the_owner_changed", async () => {
  const parent = await fundedAccount("bondown", 100n * NEAR);
  const dir = await newDir();
  const tender = new TenderClient({
    network: "sandbox",
    contractId: "tender.bondown.sandbox",
    rpcUrl: node.rpcUrl,
    signer: parent,
  });
  await deploy(targetFor(parent, "usdc.sandbox"), { dir, log: () => undefined });
  expect(await tender.getConfig()).toMatchObject({
    agent_bond_amount: "1000000",
    agent_bond_cooldown_secs: "5",
  });

  // The owner raises the bond and lengthens the cooldown after the deploy.
  await tender.setAgentBond("tusdc.bondown.sandbox", 2_500_000n);
  await tender.setAgentBondCooldown(30);

  // A deploy run again finds the bond set and puts nothing back.
  const again: string[] = [];
  await deploy(targetFor(parent, "usdc.sandbox"), { dir, log: (l) => again.push(l) });
  expect(again).toContain("SKIP set_agent_bond_cooldown 5 (exists)");
  expect(again).toContain("SKIP set_agent_bond tusdc.bondown.sandbox 1000000 (exists)");
  expect(await tender.getConfig()).toMatchObject({
    agent_bond_token: "tusdc.bondown.sandbox",
    agent_bond_amount: "2500000",
    agent_bond_cooldown_secs: "30",
  });
});

test("deploy_takes_the_bond_and_cooldown_a_target_names", async () => {
  const parent = await fundedAccount("bondset", 100n * NEAR);
  const dir = await newDir();
  const lines: string[] = [];
  await deploy(
    { ...targetFor(parent, "usdc.sandbox"), agentBond: { amount: 7_000_000n, cooldownSecs: 60 } },
    { dir, log: (l) => lines.push(l) },
  );
  expect(lines).toContain("OK set_agent_bond_cooldown 60");
  expect(lines).toContain("OK set_agent_bond tusdc.bondset.sandbox 7000000");
  const tender = new TenderClient({
    network: "sandbox",
    contractId: "tender.bondset.sandbox",
    rpcUrl: node.rpcUrl,
  });
  expect(await tender.getConfig()).toMatchObject({
    agent_bond_token: "tusdc.bondset.sandbox",
    agent_bond_amount: "7000000",
    agent_bond_cooldown_secs: "60",
  });
});

test("deploy_with_a_cooldown_below_the_shortest_window_fails_at_that_step_and_sets_no_bond", async () => {
  const parent = await fundedAccount("bondlow", 100n * NEAR);
  const dir = await newDir();
  const lines: string[] = [];
  await expect(
    deploy(
      { ...targetFor(parent, "usdc.sandbox"), agentBond: { cooldownSecs: 1 } },
      { dir, log: (l) => lines.push(l) },
    ),
  ).rejects.toThrow(/set_agent_bond_cooldown 1.*E_WINDOW/s);
  const tender = new TenderClient({
    network: "sandbox",
    contractId: "tender.bondlow.sandbox",
    rpcUrl: node.rpcUrl,
  });
  // The contract's rule held, and the bond was not set after a failed cooldown.
  expect((await tender.getConfig()).agent_bond_token).toBeNull();
  expect(lines).not.toContain("OK set_agent_bond tusdc.bondlow.sandbox 1000000");
});

test("deploy_finishes_a_reference_agent_that_stopped_with_its_bond_in_the_vault", async () => {
  // The run stops for the analyst the moment its bond is in the vault: the other three finish. The
  // next run mints nothing, deposits nothing, and registers the analyst with the bond that is there.
  const parent = await fundedAccount("fundstop", 100n * NEAR);
  const dir = await newDir();
  const tender = new TenderClient({
    network: "sandbox",
    contractId: "tender.fundstop.sandbox",
    rpcUrl: node.rpcUrl,
  });
  const analyst = "analyst.fundstop.sandbox";
  const token = "tusdc.fundstop.sandbox";
  const stopped: string[] = [];

  await expect(
    deploy(targetFor(parent, "usdc.sandbox"), {
      dir,
      log: (line) => {
        stopped.push(line);
        // A line that cannot be logged fails the step that made it, after its work is done.
        if (line === `OK deposit bond for ${analyst}`) throw new Error("stopped by the test");
      },
    }),
  ).rejects.toThrow(/deposit bond for analyst\.fundstop\.sandbox: stopped by the test/);

  expect(stopped).not.toContain(`OK register_agent ${analyst}`);
  expect(await tender.getAgent(analyst)).toBeNull();
  expect(await tender.balanceOf(analyst, token)).toBe(BigInt(AGENT_BOND));
  for (const name of ["coder", "extractor", "lead"]) {
    expect(await tender.getAgent(`${name}.fundstop.sandbox`), name).toMatchObject({
      status: "active",
    });
  }

  const resumed: string[] = [];
  await deploy(targetFor(parent, "usdc.sandbox"), { dir, log: (line) => resumed.push(line) });
  expect(resumed.filter((line) => line.startsWith("OK "))).toEqual([
    `OK register_agent ${analyst}`,
    "OK record deployments/sandbox.json",
  ]);
  expect(resumed).toContain(`SKIP deposit bond for ${analyst} (exists)`);
  expect(await tender.getAgent(analyst)).toMatchObject({
    status: "active",
    bond_token: token,
    bond_amount: String(AGENT_BOND),
  });
  // Exactly one bond was ever minted for it: the vault and the wallet are empty again.
  expect(await tender.balanceOf(analyst, token)).toBe(0n);
  expect(await tender.ftBalanceOf(token, analyst)).toBe(0n);
});
