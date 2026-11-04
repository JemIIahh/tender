import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LocalChain, startLocalChain, TenderClient } from "@tender/client";
import { DelegateViewSchema, sha256Hex } from "@tender/shared";
import { KeyPair, type KeyPairString } from "near-api-js";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  DELEGATE_METHODS,
  type DelegateOptions,
  delegateAgentCommand,
  undelegateAgentCommand,
} from "./agent";

// `agent:delegate` and `agent:undelegate` against a local chain with Tender on it: the key that
// the command makes is on the account as the node reports it (the four methods, a finite
// allowance), its caps are in the contract, the key really posts within them and really cannot do
// what it was not given, and undelegating takes it away on the chain. Everything the commands
// print is kept and searched for the private key.

let chain: LocalChain;
let reader: TenderClient;
let keys: string;
let out: string[];

beforeAll(async () => {
  chain = await startLocalChain();
  reader = new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
  });
  keys = await mkdtemp(join(tmpdir(), "tender-delegate-sandbox-"));
  out = [];
});

afterAll(async () => {
  await chain?.stop();
  if (keys !== undefined) await rm(keys, { recursive: true, force: true });
});

function options(extra: Partial<DelegateOptions> = {}): DelegateOptions {
  return {
    dir: keys,
    log: (line) => out.push(line),
    env: {
      TENDER_NETWORK: "sandbox",
      TENDER_CONTRACT: chain.contractId,
      NEAR_RPC_URL: chain.rpcUrl,
    },
    // No `.env` of the repository is read: the temporary directory has none.
    repoDir: keys,
    ...extra,
  };
}

const clientOf = (signer: { accountId: string; privateKey: string }) =>
  new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
    signer,
  });

const TERMS = {
  token: "usdc.sandbox",
  briefUri: "ipfs://brief",
  briefHash: sha256Hex("brief"),
  criteriaHash: sha256Hex("criteria"),
  commitSecs: 45,
  revealSecs: 5,
  pickSecs: 5,
  fallbackSecs: 5,
};

test("a_delegate_key_is_made_limited_used_within_its_caps_and_taken_away", async () => {
  const lead = chain.accounts.lead;
  const account = lead.accountId;

  // The agent's key file, as `init` writes it, for the account's full-access key. The account has
  // a storage balance with Tender already, and tokens in its wallet.
  await writeFile(
    join(keys, "lead.json"),
    JSON.stringify({
      version: 1,
      name: "lead",
      network: "sandbox",
      account,
      publicKey: KeyPair.fromString(lead.privateKey as KeyPairString)
        .getPublicKey()
        .toString(),
      privateKey: lead.privateKey,
    }),
    { mode: 0o600 },
  );
  await clientOf(lead).deposit(chain.tokenId, 6_000_000n);

  // ---- delegate ----
  const result = await delegateAgentCommand(
    options({ name: "lead", perTask: "2", total: "6", allowance: "0.5" }),
  );
  const file = JSON.parse(await readFile(join(keys, "lead.delegate.json"), "utf8"));
  const secrets = [file.privateKey as string, (file.privateKey as string).slice("ed25519:".length)];
  expect((await stat(join(keys, "lead.delegate.json"))).mode & 0o777).toBe(0o600);
  expect(result.publicKey).toBe(file.publicKey);

  // The access key, as the node reports it: to Tender, the four methods and no other, finite.
  const held = await reader.viewAccessKey(account, result.publicKey);
  const permission = held?.permission as {
    FunctionCall: { receiver_id: string; method_names: string[]; allowance: string | null };
  };
  expect(permission.FunctionCall.receiver_id).toBe(chain.contractId);
  expect(permission.FunctionCall.method_names).toEqual([...DELEGATE_METHODS]);
  expect(permission.FunctionCall.allowance).not.toBeNull();
  // 0.5 NEAR, less what the transactions below have burned (none yet).
  expect(BigInt(permission.FunctionCall.allowance ?? "0")).toBeLessThanOrEqual(5n * 10n ** 23n);
  expect(BigInt(permission.FunctionCall.allowance ?? "0")).toBeGreaterThan(0n);

  // The caps, as the contract holds them: 2 tUSDC a call, 6 in all, none spent.
  const caps = DelegateViewSchema.parse(
    await reader.view(chain.contractId, "get_delegate", {
      account_id: account,
      public_key: result.publicKey,
    }),
  );
  expect(caps).toEqual({
    token: chain.tokenId,
    per_task_cap: "2000000",
    total_cap: "6000000",
    spent: "0",
  });

  // ---- the key works within its caps, and no further ----
  const delegate = clientOf({ accountId: account, privateKey: file.privateKey });
  const posted = await delegate.postTask({ ...TERMS, reward: 2_000_000n }, { delegate: true });
  expect(posted.taskId).toBeGreaterThan(0n);
  // Over the per-call cap: the contract refuses.
  await expect(
    delegate.postTask({ ...TERMS, reward: 2_000_001n }, { delegate: true }),
  ).rejects.toMatchObject({ code: "E_AUTH" });
  // A method that the key does not list: the node refuses it, and nothing moves.
  const vaultBefore = await reader.balanceOf(account, chain.tokenId);
  await expect(delegate.voidTask(posted.taskId)).rejects.toThrow();
  expect(await reader.balanceOf(account, chain.tokenId)).toBe(vaultBefore);

  // ---- undelegate ----
  await undelegateAgentCommand(options({ name: "lead" }));
  expect(await reader.viewAccessKey(account, result.publicKey)).toBeNull();
  expect(
    await reader.view(chain.contractId, "get_delegate", {
      account_id: account,
      public_key: result.publicKey,
    }),
  ).toBeNull();
  expect(await readdir(keys)).toEqual(["lead.json"]);
  // The dead key sends nothing, and the account's own key is as it was.
  await expect(
    delegate.postTask({ ...TERMS, reward: 1_000_000n }, { delegate: true }),
  ).rejects.toThrow();
  expect(
    (
      await reader.viewAccessKey(
        account,
        JSON.parse(await readFile(join(keys, "lead.json"), "utf8")).publicKey,
      )
    )?.permission,
  ).toBe("FullAccess");

  // The private key is nowhere in what the commands printed.
  for (const secret of secrets) expect(out.join("\n")).not.toContain(secret);
  expect(out).toEqual(
    expect.arrayContaining([
      `OK delegate agent lead (${account})`,
      `OK undelegate agent lead (${account})`,
    ]),
  );
});
