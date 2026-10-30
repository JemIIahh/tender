import { statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { type LocalChain, type Signer, startLocalChain, TenderClient } from "@tender/client";
import {
  Account,
  actions,
  JsonRpcProvider,
  KeyPair,
  type KeyPairString,
  PublicKey,
} from "near-api-js";
import { afterAll, beforeAll, expect, test } from "vitest";
import { addRoleKey, type KeyTarget } from "./keeper-key";

// The script's function against a local chain with Tender on it: the keys it adds are the ones the
// chain reports, with the permission a keeper or a judge needs and no more. The env files are
// temporary ones, written the way the deploy writes them, for the chain's own accounts.

let chain: LocalChain;
/** Reads the chain's access keys. */
let reader: TenderClient;
let target: KeyTarget;
const dirs: string[] = [];

beforeAll(async () => {
  chain = await startLocalChain();
  reader = new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
  });
  target = { network: chain.network, rpcUrl: chain.rpcUrl, contractId: chain.contractId };
});

afterAll(async () => {
  await chain?.stop();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const ENV_FILE = ".env.deploy.sandbox";
const TGAS = 1_000_000_000_000n;

/** A new directory with the env file the deploy leaves for the chain's keeper and judge. */
async function deployedDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tender-keeper-key-sandbox-"));
  dirs.push(dir);
  const { keeper, judge } = chain.accounts;
  await writeFile(
    join(dir, ENV_FILE),
    `${[
      `TENDER_CONTRACT=${chain.contractId}`,
      `KEEPER_ACCOUNT=${keeper.accountId}`,
      `KEEPER_FULL_ACCESS_KEY=${keeper.privateKey}`,
      `JUDGE_ACCOUNT=${judge.accountId}`,
      `JUDGE_FULL_ACCESS_KEY=${judge.privateKey}`,
    ].join("\n")}\n`,
    { mode: 0o600 },
  );
  return dir;
}

async function envOf(dir: string): Promise<Record<string, string | undefined>> {
  return parseEnv(await readFile(join(dir, ENV_FILE), "utf8"));
}

const publicKeyOf = (privateKey: string) =>
  KeyPair.fromString(privateKey as KeyPairString)
    .getPublicKey()
    .toString();

/** A client that signs with the given key, such as a service does with the key it was given. */
const clientWith = (signer: Signer) =>
  new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
    signer,
  });

/** How many lines of the file set `name`. */
async function linesSetting(dir: string, name: string): Promise<number> {
  const text = await readFile(join(dir, ENV_FILE), "utf8");
  return text.split("\n").filter((line) => line.startsWith(`${name}=`)).length;
}

test("key_script_adds_keys_with_the_permission_of_a_keeper_and_of_a_judge", async () => {
  const dir = await deployedDir();
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  const { keeper, judge } = chain.accounts;

  const added = await addRoleKey("keeper", target, { dir, log });
  const judged = await addRoleKey("judge", target, { dir, log });

  // The chain reports a function-call key limited to Tender, with the role's methods and no cap on
  // the allowance, and the deploy's full-access key beside it, untouched.
  expect(added.outcome).toBe("OK");
  expect(added.accountId).toBe(keeper.accountId);
  expect(await reader.viewAccessKey(keeper.accountId, added.publicKey)).toEqual({
    permission: {
      FunctionCall: {
        receiver_id: chain.contractId,
        method_names: ["void_task", "cleanup"],
        allowance: null,
      },
    },
  });
  expect(judged.outcome).toBe("OK");
  expect(judged.accountId).toBe(judge.accountId);
  expect(await reader.viewAccessKey(judge.accountId, judged.publicKey)).toEqual({
    permission: {
      FunctionCall: {
        receiver_id: chain.contractId,
        method_names: ["pick", "pick_attested"],
        allowance: null,
      },
    },
  });
  expect(
    (await reader.viewAccessKey(keeper.accountId, publicKeyOf(keeper.privateKey)))?.permission,
  ).toBe("FullAccess");

  // Each private key is in the file under its role, and the file is private to its owner.
  const env = await envOf(dir);
  expect(publicKeyOf(env.KEEPER_PRIVATE_KEY ?? "")).toBe(added.publicKey);
  expect(publicKeyOf(env.JUDGE_PRIVATE_KEY ?? "")).toBe(judged.publicKey);
  expect(statSync(join(dir, ENV_FILE)).mode & 0o777).toBe(0o600);

  // What was printed names the public keys and shows no private one, of the new keys or the old.
  expect(lines).toEqual([
    `OK add keeper key ${added.publicKey} to ${keeper.accountId}`,
    `OK add judge key ${judged.publicKey} to ${judge.accountId}`,
  ]);
  const secrets = [
    env.KEEPER_PRIVATE_KEY,
    env.JUDGE_PRIVATE_KEY,
    keeper.privateKey,
    judge.privateKey,
  ];
  for (const secret of secrets) {
    expect(lines.join("\n")).not.toContain((secret ?? "").slice("ed25519:".length));
  }

  // The key does the keeper's work: the chain lets it call `void_task` and `cleanup`, and the
  // contract answers for a task that is not there. It lets it call no other method of Tender, and
  // nothing of another contract. (The permission above, which is exact, is what says it can do no
  // more than call.)
  const scoped = clientWith({
    accountId: keeper.accountId,
    privateKey: env.KEEPER_PRIVATE_KEY ?? "",
  });
  await expect(scoped.voidTask(999_999n)).rejects.toMatchObject({ code: "E_NOT_FOUND" });
  await expect(scoped.cleanup(999_999n)).rejects.toMatchObject({ code: "E_NOT_FOUND" });
  await expect(
    scoped.pick(999_999n, [{ account: keeper.accountId, bps: 10_000 }], "0".repeat(64), "x://y"),
  ).rejects.toThrow("Access key does not allow method pick");
  // Another receiver: the token the tasks are paid in. The key attaches no deposit, so that the
  // receiver is what the chain refuses, and not the 1 yoctoNEAR that `ft_transfer` asks for.
  await expect(
    scoped.send({
      receiverId: chain.tokenId,
      methodName: "ft_transfer",
      args: { receiver_id: chain.accounts.alice.accountId, amount: "1" },
      gas: 30n * TGAS,
      deposit: 0n,
    }),
  ).rejects.toThrow(
    `Access key receiver ${chain.contractId} does not match transaction receiver ${chain.tokenId}`,
  );

  // The judge's key is the other way round: the contract takes its `pick`, and the chain refuses the
  // keeper's methods.
  const judging = clientWith({
    accountId: judge.accountId,
    privateKey: env.JUDGE_PRIVATE_KEY ?? "",
  });
  await expect(
    judging.pick(999_999n, [{ account: judge.accountId, bps: 10_000 }], "0".repeat(64), "x://y"),
  ).rejects.toMatchObject({ code: "E_NOT_FOUND" });
  await expect(judging.voidTask(999_999n)).rejects.toThrow(
    "Access key does not allow method void_task",
  );
});

test("key_script_runs_again_without_a_new_key_and_restores_a_key_the_chain_lost", async () => {
  const dir = await deployedDir();
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  const { keeper } = chain.accounts;
  const first = await addRoleKey("keeper", target, { dir, log });
  const text = await readFile(join(dir, ENV_FILE), "utf8");

  // Again: the key is in the file and on the chain with the right permission, so nothing happens.
  const again = await addRoleKey("keeper", target, { dir, log });
  expect(again).toEqual({ ...first, outcome: "SKIP" });
  expect(await readFile(join(dir, ENV_FILE), "utf8")).toBe(text);
  expect(lines.at(-1)).toBe(
    `SKIP add keeper key ${first.publicKey} to ${keeper.accountId} (exists)`,
  );

  // The key is deleted from the chain (the owner's full-access key does it). The file still has it,
  // so the script adds that same key, and makes no other.
  const owner = new Account(
    keeper.accountId,
    new JsonRpcProvider({ url: chain.rpcUrl }),
    keeper.privateKey as KeyPairString,
  );
  await owner.signAndSendTransaction({
    receiverId: keeper.accountId,
    actions: [actions.deleteKey(PublicKey.from(first.publicKey))],
    waitUntil: "FINAL",
  });
  expect(await reader.viewAccessKey(keeper.accountId, first.publicKey)).toBeNull();

  const restored = await addRoleKey("keeper", target, { dir, log });
  expect(restored).toEqual(first);
  expect(await reader.viewAccessKey(keeper.accountId, first.publicKey)).toMatchObject({
    permission: { FunctionCall: { method_names: ["void_task", "cleanup"] } },
  });
  expect(await readFile(join(dir, ENV_FILE), "utf8")).toBe(text);
  expect(await linesSetting(dir, "KEEPER_PRIVATE_KEY")).toBe(1);
});
