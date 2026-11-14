import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { REPO_ROOT } from "./lib/env";
import { main, upgradeContract } from "./upgrade-contract";

// The upgrade script on a local chain: Tender's account runs the build testnet ran before the
// attested picks, with state, and the script deploys `contract/res/tender.wasm` over it.

/** The part of near-sandbox these tests use, loaded the way the client loads it. */
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
/** The SHA-256 of the build testnet ran before the attested picks (contract/sandbox/tests/upgrade.rs). */
const UPGRADE_FROM_SHA256 = "5ec43a10812fb9b92f47ac09c3e3a7ab619104491aa00dcec05c9e6f51b62b36";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();
const codeHashOf = (bytes: Uint8Array) => baseEncode(sha256(bytes));

/** The old build from the git history of `contract/res/tender.wasm`, or null if it is not there. */
function oldBuild(): Buffer | null {
  const git = (args: string[]) =>
    execFileSync("git", ["-C", REPO_ROOT, ...args], { maxBuffer: 64 * 1024 * 1024 });
  try {
    const commits = git(["log", "--format=%H", "--", "contract/res/tender.wasm"])
      .toString()
      .split("\n")
      .filter((line) => line !== "");
    for (const commit of commits) {
      const bytes = git(["show", `${commit}:contract/res/tender.wasm`]);
      if (sha256(bytes).toString("hex") === UPGRADE_FROM_SHA256) return bytes;
    }
  } catch {
    return null;
  }
  return null;
}

const oldWasm = oldBuild();
const newWasm = await readFile(join(REPO_ROOT, "contract", "res", "tender.wasm"));

let node: Awaited<ReturnType<NearSandbox["Sandbox"]["start"]>>;
let provider: JsonRpcProvider;
let root: Signer;
let dir: string;

async function sendAs(signer: Signer, receiverId: string, acts: Action[]) {
  const account = new Account(signer.accountId, provider, signer.privateKey as KeyPairString);
  await account.signAndSendTransaction({ receiverId, actions: acts, waitUntil: "FINAL" });
}

beforeAll(async () => {
  node = await Sandbox.start({});
  provider = new JsonRpcProvider({ url: node.rpcUrl });
  root = { accountId: DEFAULT_ACCOUNT_ID, privateKey: DEFAULT_PRIVATE_KEY };
  dir = await mkdtemp(join(tmpdir(), "tender-upgrade-"));
}, 120_000);

afterAll(async () => {
  await node?.tearDown();
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

test.skipIf(oldWasm === null)(
  "upgrade-contract deploys res/ over the old build, keeps the state, records it, and skips a second time",
  async () => {
    if (oldWasm === null) return;
    expect(codeHashOf(oldWasm)).not.toBe(codeHashOf(newWasm));
    // Tender's account, running the old build with state, as the deploy made it.
    const key = KeyPair.fromRandom("ed25519");
    const contract: Signer = {
      accountId: `tender.${DEFAULT_ACCOUNT_ID}`,
      privateKey: key.toString(),
    };
    await sendAs(root, contract.accountId, [
      actions.createAccount(),
      actions.transfer(10n * NEAR),
      actions.addFullAccessKey(key.getPublicKey()),
    ]);
    // `new` is private: the account deploys to itself and initialises in one transaction.
    await sendAs(contract, contract.accountId, [
      actions.deployContract(oldWasm),
      actions.functionCall(
        "new",
        {
          owner: root.accountId,
          treasury: root.accountId,
          fee_bps: 500,
          min_window_secs: 5,
        },
        30n * TGAS,
        0n,
      ),
    ]);
    await writeFile(
      join(dir, ".env.deploy.sandbox"),
      `TENDER_CONTRACT=${contract.accountId}\nTENDER_CONTRACT_FULL_ACCESS_KEY=${contract.privateKey}\n`,
      { mode: 0o600 },
    );
    await mkdir(join(dir, "deployments"));
    const recordPath = join(dir, "deployments", "sandbox.json");
    const record = {
      network: "sandbox",
      contract: contract.accountId,
      tokens: { tusdc: `tusdc.${DEFAULT_ACCOUNT_ID}` },
      accounts: { owner: root.accountId },
      wasmSha256: UPGRADE_FROM_SHA256,
      deployHeight: "1",
      deployedAt: "2026-11-04T07:38:44.881Z",
    };
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);

    const reader = new TenderClient({
      network: "sandbox",
      contractId: contract.accountId,
      rpcUrl: node.rpcUrl,
    });
    const before = await reader.getConfig();

    // Through the command line, as the owner runs it.
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["--network", "sandbox", "--rpc-url", node.rpcUrl], {
      dir,
      out: (line) => out.push(line),
      err: (text) => err.push(text),
    });
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(out[0]).toBe(`code hash before: ${codeHashOf(oldWasm)}`);
    expect(out).toContain(`code hash after: ${codeHashOf(newWasm)}`);
    expect(out.some((line) => line.startsWith("OK deploy and migrate in transaction "))).toBe(true);
    expect(out).toContain("OK record deployments/sandbox.json");

    // The state reads as it was, and the new methods are there.
    expect(await reader.getConfig()).toEqual(before);
    expect(
      await reader.view(contract.accountId, "get_attested_signer", { signer_id: "nobody" }),
    ).toBeNull();
    const view = await provider.viewAccount({
      accountId: contract.accountId,
      blockQuery: { finality: "final" },
    });
    expect(view.code_hash).toBe(codeHashOf(newWasm));

    // The record keeps what it had, with the new hash and the upgrade.
    const updated = JSON.parse(await readFile(recordPath, "utf8"));
    expect(updated.deployHeight).toBe("1");
    expect(updated.wasmSha256).toBe(sha256(newWasm).toString("hex"));
    expect(updated.upgrades).toHaveLength(1);
    expect(updated.upgrades[0]).toMatchObject({
      fromCodeHash: codeHashOf(oldWasm),
      toCodeHash: codeHashOf(newWasm),
      wasmSha256: sha256(newWasm).toString("hex"),
    });
    expect(updated.upgrades[0].blockHeight).toMatch(/^[1-9][0-9]*$/);

    // A second run finds the code there and sends nothing.
    const again: string[] = [];
    const result = await upgradeContract(
      { network: "sandbox", rpcUrl: node.rpcUrl, contract },
      { dir, log: (line) => again.push(line) },
    );
    expect(result.upgrade).toBeNull();
    expect(again).toContain(`SKIP upgrade (${contract.accountId} runs this code already)`);
    expect(JSON.parse(await readFile(recordPath, "utf8")).upgrades).toHaveLength(1);

    // Another account's key is refused before anything is sent.
    await expect(
      upgradeContract(
        {
          network: "sandbox",
          rpcUrl: node.rpcUrl,
          contract: { ...contract, privateKey: KeyPair.fromRandom("ed25519").toString() },
        },
        { dir, log: () => undefined },
      ),
    ).rejects.toThrow(/not a full-access key/);
  },
  180_000,
);
