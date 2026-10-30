import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { type Signer, TenderClient } from "@tender/client";
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
import { type Deployment, deploy } from "./deploy";
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

/**
 * The accounts the deploy creates under its parent and the stems of the variables it writes their
 * keys to (`<STEM>_ACCOUNT`, `<STEM>_PRIVATE_KEY`). Written out here, not imported, because the
 * names are what the other scripts read.
 */
const MEMBERS = [
  ["tender", "TENDER"],
  ["treasury", "TREASURY"],
  ["judge", "JUDGE"],
  ["keeper", "KEEPER"],
  ["tusdc", "TUSDC"],
  ["poster", "POSTER"],
  ["analyst", "AGENT_ANALYST"],
  ["coder", "AGENT_CODER"],
  ["extractor", "AGENT_EXTRACTOR"],
  ["lead", "AGENT_LEAD"],
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

/** The private keys in an env file's text. */
function privateKeysIn(envText: string): string[] {
  return Object.entries(parseEnv(envText))
    .filter(([name]) => name.endsWith("_PRIVATE_KEY"))
    .map(([, value]) => value as string);
}

/**
 * Checks that `height` is the block of `accountId`'s deploy: the account has no code the block
 * before, and has it in the block itself. A transaction that an account sends to itself runs in the
 * block that holds it, so that block is the first with the code.
 */
async function expectDeployBlock(accountId: string, height: string, wasm: Uint8Array) {
  const at = (blockId: number) =>
    provider.viewAccount({ accountId, blockQuery: { blockId } }).then((a) => a.code_hash);
  expect(await at(Number(height) - 1)).toBe(NO_CODE);
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
  const names = MEMBERS.flatMap(([, stem]) => [`${stem}_ACCOUNT`, `${stem}_PRIVATE_KEY`]);
  expect(Object.keys(env).sort()).toEqual([...names, "DEPLOY_TENDER_HEIGHT"].sort());

  const keys = new Set<string>();
  for (const [name, stem] of MEMBERS) {
    const accountId = `${name}.sandbox`;
    expect(env[`${stem}_ACCOUNT`]).toBe(accountId);
    const privateKey = env[`${stem}_PRIVATE_KEY`] as string;
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
    ...privateKeysIn(await readFile(join(mainDir, ".env.deploy.sandbox"), "utf8")),
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
    `TENDER_ACCOUNT=${tender.accountId}\nTENDER_PRIVATE_KEY=${tender.privateKey}\n`,
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
    /tender\.sandbox exists, but TENDER_PRIVATE_KEY is not in \.env\.deploy\.sandbox/,
  );
  expect(existsSync(join(lost, ".env.deploy.sandbox"))).toBe(false);

  // And a key that is not the account's.
  const wrong = await newDir();
  const stranger = KeyPair.fromRandom("ed25519").toString();
  await writeFile(
    join(wrong, ".env.deploy.sandbox"),
    `TENDER_ACCOUNT=tender.sandbox\nTENDER_PRIVATE_KEY=${stranger}\n`,
  );
  const error = await runDeploy(root, "usdc.sandbox", wrong).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/TENDER_PRIVATE_KEY .* is not a full-access key/);
  // The message names the variable, never the key.
  expect((error as Error).message).not.toContain(stranger);
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

  expect(resumed.filter((l) => l.startsWith("OK ")).sort()).toEqual([
    "OK record deployments/sandbox.json",
    "OK register tender.resume.sandbox at ghost.sandbox",
    "OK storage tender.resume.sandbox at tender.resume.sandbox",
  ]);
  expect(resumed.filter((l) => !l.startsWith("OK "))).toHaveLength(stopped.length);
  // The first run's deploy of Tender is the one the record names, though it was not made now.
  await expectDeployBlock("tender.resume.sandbox", deployment.deployHeight, tenderWasm);
  expect(deployment.tokens).toEqual({ tusdc: "tusdc.resume.sandbox", usdc: "ghost.sandbox" });
});
