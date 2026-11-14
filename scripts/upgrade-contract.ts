import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Signer, TenderClient, TenderError, toTxResult } from "@tender/client";
import { AccountIdSchema, NETWORKS, type NetworkId } from "@tender/shared";
import { Account, actions, baseEncode, JsonRpcProvider, type KeyPairString } from "near-api-js";
import { parseKey } from "./deploy";
import { envDir, loadEnv, REPO_ROOT } from "./lib/env";

/**
 * Upgrades Tender's code in place: deploys `contract/res/tender.wasm` to the contract account of a
 * deployment, over the state it has, and calls `migrate` in the same transaction. A transaction is
 * all or nothing, so if the new code cannot read the stored state, `migrate` fails and the old code
 * stays. The state keeps its layout (`version` 1): the attested signers live under their own
 * storage prefix, outside the contract struct.
 *
 *   pnpm exec tsx scripts/upgrade-contract.ts --network testnet
 *   pnpm exec tsx scripts/upgrade-contract.ts --network sandbox --rpc-url http://127.0.0.1:<port>
 *
 * It signs as the contract account, with `TENDER_CONTRACT` and `TENDER_CONTRACT_FULL_ACCESS_KEY` of
 * `.env.deploy.<network>`, the key `scripts/deploy.ts` made for it and deployed the code with. The
 * key is never printed. It prints the account's code hash (NEAR's base58 SHA-256 of the code)
 * before and after, and then that the state still reads, and adds an entry to `upgrades` in
 * `deployments/<network>.json` with the new `wasmSha256`. If the account runs this code already, it
 * says so and sends nothing.
 *
 * Mainnet is refused, by name and by the chain id the node reports. The upgrade of testnet is the
 * owner's call (AGENTS.md rule 5).
 */

const TGAS = 10n ** 12n;
/** Gas for `migrate`, which reads and writes the root state once. */
const MIGRATE_GAS = 100n * TGAS;

const MAINNET_REFUSED =
  "mainnet is not upgraded by this script: the mainnet deploy needs the owner's approval";

const USAGE =
  "usage: tsx scripts/upgrade-contract.ts --network testnet\n" +
  "       tsx scripts/upgrade-contract.ts --network sandbox --rpc-url <the local node's RPC URL>";

/** What an upgrade needs: the chain, and the contract account with a full-access key of its own. */
export interface UpgradeTarget {
  network: NetworkId;
  rpcUrl: string;
  /** The contract account, which deploys to itself. */
  contract: Signer;
}

export interface UpgradeOptions {
  /** Where `deployments/` is. The repository root by default, or what `TENDER_ENV_DIR` names. */
  dir?: string;
  /** The wasm to deploy; `contract/res/tender.wasm` by default. */
  wasmPath?: string;
  /** Receives each line the upgrade prints. Defaults to `console.log`. */
  log?: (line: string) => void;
  now?: Date;
}

/** One upgrade, as `deployments/<network>.json` lists it under `upgrades`. */
export interface UpgradeEntry {
  /** When the upgrade was final (ISO 8601, UTC). */
  at: string;
  txHash: string;
  /** The height of the block that holds the transaction, as a decimal string. */
  blockHeight: string;
  /** NEAR's code hash of the account before and after (base58 SHA-256 of the code). */
  fromCodeHash: string;
  toCodeHash: string;
  /** The SHA-256 of the wasm deployed, as 64 lowercase hex characters. */
  wasmSha256: string;
}

export interface UpgradeResult {
  before: string;
  after: string;
  /** The upgrade, or null when the account ran this code already and nothing was sent. */
  upgrade: UpgradeEntry | null;
  /** The record that was updated, or null if the network has none. */
  record: string | null;
}

/** A mistake in how the script was run. */
export class UsageError extends Error {}

/** The account's code hash as of the last final block. */
async function codeHashOf(provider: JsonRpcProvider, accountId: string): Promise<string> {
  const view = await provider.viewAccount({ accountId, blockQuery: { finality: "final" } });
  return view.code_hash;
}

/** The record of `network` in `dir/deployments` as raw JSON, with its path, or null if none. */
async function readRecord(
  network: NetworkId,
  dir: string,
): Promise<{ path: string; json: Record<string, unknown> } | null> {
  const path = join(dir, "deployments", `${network}.json`);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON`, { cause: error });
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error(`${path} is not a deployment record`);
  }
  return { path, json: json as Record<string, unknown> };
}

/**
 * Deploys the wasm over the contract's code and state, with `migrate` in the same transaction, and
 * records it. Before anything is sent it throws if the network is mainnet (by name or by the node's
 * chain id), if a testnet target's node is on another chain, if the record of the network names
 * another contract, or if the key is not a full-access key of the contract account. After, it
 * throws if the code hash is not the wasm's or the state does not read.
 */
export async function upgradeContract(
  target: UpgradeTarget,
  options: UpgradeOptions = {},
): Promise<UpgradeResult> {
  const { network, rpcUrl, contract } = target;
  if (network === "mainnet") throw new Error(MAINNET_REFUSED);
  if (rpcUrl.trim() === "") throw new Error("the upgrade needs the RPC URL of the chain");
  const log = options.log ?? console.log;
  const dir = options.dir ?? envDir();
  const accountId = contract.accountId;
  const key = parseKey(contract.privateKey, "the contract account's key").getPublicKey().toString();

  const wasmPath = options.wasmPath ?? join(REPO_ROOT, "contract", "res", "tender.wasm");
  const wasm = await readFile(wasmPath);
  const digest = createHash("sha256").update(wasm).digest();
  const wasmSha256 = digest.toString("hex");
  const codeHash = baseEncode(digest);

  // What needs no network first: the record must be this contract's.
  const record = await readRecord(network, dir);
  if (record !== null && record.json.contract !== accountId) {
    throw new Error(
      `${record.path} is the record of ${String(record.json.contract)}, not of ${accountId}`,
    );
  }

  const provider = new JsonRpcProvider({ url: rpcUrl });
  const { chain_id: chainId } = await provider.viewNodeStatus();
  if (chainId === "mainnet") {
    throw new Error(`${MAINNET_REFUSED} (the node answered with chain id "mainnet")`);
  }
  if (network === "testnet" && chainId !== "testnet") {
    throw new Error(
      `this is a testnet upgrade, but the node answered with chain id ${JSON.stringify(String(chainId).slice(0, 40))}`,
    );
  }
  const reader = new TenderClient({ network, contractId: accountId, rpcUrl });
  const access = await reader.viewAccessKey(accountId, key);
  if (access?.permission !== "FullAccess") {
    throw new Error(`the key given is not a full-access key of ${accountId}`);
  }

  const before = await codeHashOf(provider, accountId);
  log(`code hash before: ${before}`);
  log(`wasm: ${wasmPath} (${wasm.length} bytes, sha256 ${wasmSha256}, code hash ${codeHash})`);
  if (before === codeHash) {
    log(`SKIP upgrade (${accountId} runs this code already)`);
    log(`code hash after: ${before}`);
    return { before, after: before, upgrade: null, record: null };
  }
  const config = await reader.getConfig();
  log(`state before: version ${config.version}, owner ${config.owner}`);

  const account = new Account(accountId, provider, contract.privateKey as KeyPairString);
  const resp = await account.signAndSendTransaction({
    receiverId: accountId,
    actions: [actions.deployContract(wasm), actions.functionCall("migrate", {}, MIGRATE_GAS, 0n)],
    waitUntil: "FINAL",
    throwOnFailure: false,
  });
  const { txHash } = toTxResult(resp, accountId);
  const block = await provider.viewBlock({ blockId: resp.transaction_outcome.block_hash });
  const blockHeight = String(block.header.height);
  log(`OK deploy and migrate in transaction ${txHash} (block ${blockHeight})`);

  const after = await codeHashOf(provider, accountId);
  log(`code hash after: ${after}`);
  if (after !== codeHash) {
    throw new Error(`${accountId} has code hash ${after} after the upgrade, not ${codeHash}`);
  }
  const reread = await reader.getConfig();
  if (reread.version !== config.version || reread.owner !== config.owner) {
    throw new Error(
      `the state reads differently after the upgrade: version ${reread.version}, owner ${reread.owner}`,
    );
  }
  log(`state after: version ${reread.version}, owner ${reread.owner}`);

  const upgrade: UpgradeEntry = {
    at: (options.now ?? new Date()).toISOString(),
    txHash,
    blockHeight,
    fromCodeHash: before,
    toCodeHash: after,
    wasmSha256,
  };
  if (record === null) {
    log(`no deployments/${network}.json in ${dir}: nothing recorded`);
    return { before, after, upgrade, record: null };
  }
  const previous = Array.isArray(record.json.upgrades) ? record.json.upgrades : [];
  const updated = { ...record.json, wasmSha256, upgrades: [...previous, upgrade] };
  const temporary = `${record.path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`);
  await rename(temporary, record.path);
  log(`OK record deployments/${network}.json`);
  return { before, after, upgrade, record: record.path };
}

/**
 * The target for the command line: the contract account and its key from `.env.deploy.<network>`
 * (and `.env`) of `dir`, and the RPC URL: the network's for testnet, `--rpc-url` for the sandbox.
 * Throws a `UsageError` for mainnet, another network, or a sandbox without `--rpc-url`. It reads
 * no more than those two files and uses no network.
 */
export function loadTarget(
  network: string | undefined,
  rpcUrl: string | undefined,
  options: { dir?: string } = {},
): UpgradeTarget {
  if (network === undefined) throw new UsageError(USAGE);
  if (network === "mainnet") throw new UsageError(MAINNET_REFUSED);
  if (network !== "testnet" && network !== "sandbox") {
    throw new UsageError(`unknown network ${JSON.stringify(network)}\n${USAGE}`);
  }
  const url = network === "testnet" ? (rpcUrl ?? NETWORKS.testnet.rpcUrl) : rpcUrl;
  if (url === undefined || url.trim() === "") {
    throw new UsageError(`the sandbox picks its port when it starts: pass --rpc-url\n${USAGE}`);
  }
  const env = loadEnv(network, {
    dir: options.dir,
    required: ["TENDER_CONTRACT", "TENDER_CONTRACT_FULL_ACCESS_KEY"],
  });
  const accountId = env.TENDER_CONTRACT.trim();
  if (!AccountIdSchema.safeParse(accountId).success) {
    throw new UsageError("TENDER_CONTRACT is not a valid NEAR account id");
  }
  const privateKey = parseKey(
    env.TENDER_CONTRACT_FULL_ACCESS_KEY.trim(),
    "TENDER_CONTRACT_FULL_ACCESS_KEY",
  ).toString();
  return { network, rpcUrl: url.trim(), contract: { accountId, privateKey } };
}

/** Runs the command line and returns the exit code: 0 after an upgrade (or none needed), else 1. */
export async function main(
  args: readonly string[],
  options: {
    dir?: string;
    out?: (line: string) => void;
    err?: (text: string) => void;
    upgrade?: typeof upgradeContract;
  } = {},
): Promise<number> {
  const out = options.out ?? console.log;
  const err = options.err ?? console.error;
  try {
    let values: { network?: string; "rpc-url"?: string };
    try {
      values = parseArgs({
        args: [...args],
        options: { network: { type: "string" }, "rpc-url": { type: "string" } },
      }).values;
    } catch (error) {
      throw new UsageError(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    }
    const target = loadTarget(values.network, values["rpc-url"], { dir: options.dir });
    await (options.upgrade ?? upgradeContract)(target, { dir: options.dir, log: out });
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      err(error.message);
    } else if (error instanceof TenderError) {
      const tx = error.txHash === undefined ? "" : `\ntransaction ${error.txHash}`;
      err(`upgrade failed with ${error.code}\n${error.message}${tx}`);
    } else {
      err(`upgrade failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 1;
  }
}

// Only when run as the script, never when a test imports from here.
if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
