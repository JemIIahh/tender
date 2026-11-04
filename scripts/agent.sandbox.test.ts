import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LocalChain,
  registerWithBond,
  type Signer,
  scriptedProfile,
  startLocalChain,
  TenderClient,
} from "@tender/client";
import { computeCommitment, randomSalt, sha256Hex } from "@tender/shared";
import {
  Account,
  actions,
  JsonRpcProvider,
  KeyPair,
  type KeyPairString,
  PublicKey,
} from "near-api-js";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  type CommandOptions,
  claimBondCommand,
  initAgent,
  registerAgentCommand,
  retireAgentCommand,
} from "./agent";

// The agent commands against a local chain with Tender on it, the bond set (1 test token) and a
// cooldown of 20 seconds: an agent's key is made by `init`, put on a chain account as a full-access
// key, and then registers, updates, retires and claims. Everything it prints is kept and searched
// for the key, which must not be in it.

const COOLDOWN_SECS = 20;

let chain: LocalChain;
let reader: TenderClient;
let provider: JsonRpcProvider;
let keys: string;
let out: string[];
const dirs: string[] = [];

beforeAll(async () => {
  chain = await startLocalChain({ agentBond: { cooldownSecs: COOLDOWN_SECS } });
  reader = new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
  });
  provider = new JsonRpcProvider({ url: chain.rpcUrl });
  keys = await mkdtemp(join(tmpdir(), "tender-agent-sandbox-"));
  dirs.push(keys);
  out = [];
});

afterAll(async () => {
  await chain?.stop();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (line: string) => out.push(line);

function options(extra: Partial<CommandOptions> = {}): CommandOptions {
  return {
    dir: keys,
    log,
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

/** The chain account's own key signs for the account, to put `publicKey` on it. */
async function addKey(signer: Signer, publicKey: string, kind: "full" | "function-call") {
  const account = new Account(signer.accountId, provider, signer.privateKey as KeyPairString);
  const key = PublicKey.from(publicKey);
  await account.signAndSendTransaction({
    receiverId: signer.accountId,
    actions: [
      kind === "full"
        ? actions.addFullAccessKey(key)
        : actions.addFunctionCallAccessKey(key, chain.contractId, ["commit", "reveal"]),
    ],
    waitUntil: "FINAL",
  });
}

const secretOf = async (name: string): Promise<string> =>
  (JSON.parse(await readFile(join(keys, `${name}.json`), "utf8")).privateKey as string).slice(
    "ed25519:".length,
  );

const vault = (account: string) => reader.balanceOf(account, chain.tokenId);

test("an_agent_is_made_registered_updated_retired_and_pays_its_bond_back", async () => {
  const bob = chain.accounts.bob;
  const account = bob.accountId;

  // The key is made here and goes on the chain account as a full-access key; the account's own key
  // is not used again.
  const { publicKey } = await initAgent({
    name: "scout",
    network: "sandbox",
    dir: keys,
    log,
  });
  expect(out.filter((line) => line.startsWith("public key: "))).toEqual([
    `public key: ${publicKey}`,
  ]);
  expect((await stat(join(keys, "scout.json"))).mode & 0o777).toBe(0o600);
  await addKey(bob, publicKey, "full");

  // Bob holds the bond's token in his wallet and none in his vault. Without a yes nothing moves.
  const walletBefore = await reader.ftBalanceOf(chain.tokenId, account);
  expect(await vault(account)).toBe(0n);
  await expect(
    registerAgentCommand(options({ account, confirm: async () => false })),
  ).rejects.toMatchObject({ code: "E_FUNDS" });
  expect(await reader.getAgent(account)).toBeNull();
  expect(await vault(account)).toBe(0n);
  expect(await reader.ftBalanceOf(chain.tokenId, account)).toBe(walletBefore);

  // With a yes the bond goes from the wallet to the vault, is taken from it, and the agent is
  // active with the bond recorded.
  const bond = (await reader.getConfig()).agent_bond_amount;
  const registered = await registerAgentCommand(
    options({
      account,
      confirm: async () => true,
      tags: "regex,json",
      description: "finds totals",
    }),
  );
  expect(registered).toMatchObject({
    status: "active",
    bond_token: chain.tokenId,
    bond_amount: bond,
    claimable_at: null,
    tags: ["regex", "json"],
  });
  expect(await vault(account)).toBe(0n);
  expect(await reader.ftBalanceOf(chain.tokenId, account)).toBe(walletBefore - BigInt(bond ?? 0));
  expect(out).toEqual(
    expect.arrayContaining([`OK register ${account} as agent scout`, "status: active"]),
  );
  // The file now knows the account, so the other commands need no flag.
  expect(JSON.parse(await readFile(join(keys, "scout.json"), "utf8")).account).toBe(account);

  // Registering again is an update: no second bond, no question.
  const walletAfter = await reader.ftBalanceOf(chain.tokenId, account);
  const asked: string[] = [];
  const updated = await registerAgentCommand(
    options({
      confirm: async (q) => {
        asked.push(q);
        return false;
      },
      tags: "regex",
    }),
  );
  expect(asked).toEqual([]);
  expect(updated).toMatchObject({ status: "active", bond_amount: bond, tags: ["regex"] });
  expect(await reader.ftBalanceOf(chain.tokenId, account)).toBe(walletAfter);
  expect(await vault(account)).toBe(0n);

  // Retiring asks, then the agent is unregistering, with the bond kept and a date.
  await expect(retireAgentCommand(options({ confirm: async () => false }))).rejects.toThrow(
    /not retired/,
  );
  expect((await reader.getAgent(account))?.status).toBe("active");
  const leaving = await retireAgentCommand(options({ yes: true }));
  expect(leaving).toMatchObject({ status: "unregistering", bond_amount: bond });
  expect(leaving.claimable_at).not.toBeNull();

  // Too soon: refused with the date, and the bond stays where it is.
  const early = await claimBondCommand(options()).catch((e: unknown) => e);
  expect(early).toMatchObject({ code: "E_PHASE" });
  expect((early as Error).message).toMatch(/claimable from \d{4}-\d\d-\d\dT/);
  expect(await vault(account)).toBe(0n);

  // Once the cooldown is over the bond is back in the vault, exactly, and the agent is retired.
  while ((await reader.blockTimestampNs()) < BigInt(leaving.claimable_at ?? "0")) await sleep(300);
  const claimed = await claimBondCommand(options());
  expect(claimed).toMatchObject({ status: "retired", bond_token: null, bond_amount: null });
  expect(await vault(account)).toBe(BigInt(bond ?? 0));

  // The private key is nowhere in what the commands printed.
  const secret = await secretOf("scout");
  expect(out.join("\n")).not.toContain(secret);
});

test("a_function_call_key_is_refused_for_register_retire_and_claim_before_anything_is_sent", async () => {
  const alice = chain.accounts.alice;
  const account = alice.accountId;
  const pair = KeyPair.fromRandom("ed25519");
  const publicKey = pair.getPublicKey().toString();
  await addKey(alice, publicKey, "function-call");

  // A key file made by hand: the file is the same whatever the key is.
  await writeFile(
    join(keys, "delegate.json"),
    JSON.stringify({
      version: 1,
      name: "delegate",
      network: "sandbox",
      account,
      publicKey,
      privateKey: pair.toString(),
    }),
    { mode: 0o600 },
  );
  const vaultBefore = await vault(account);
  const walletBefore = await reader.ftBalanceOf(chain.tokenId, account);

  // Registering: refused with the reason, and neither the bond nor the storage moved.
  const registration = await registerAgentCommand(options({ name: "delegate", yes: true })).catch(
    (e: unknown) => e,
  );
  expect(registration).toMatchObject({ code: "E_AUTH" });
  expect((registration as Error).message).toMatch(/full-access key/);
  expect(await reader.getAgent(account)).toBeNull();
  expect(await vault(account)).toBe(vaultBefore);
  expect(await reader.ftBalanceOf(chain.tokenId, account)).toBe(walletBefore);

  // Retiring an agent that exists: the account has its own full-access key for that, and the
  // function-call key is refused.
  const client = await registerAgentWith(alice);
  const retire = await retireAgentCommand(options({ name: "delegate", yes: true })).catch(
    (e: unknown) => e,
  );
  expect(retire).toMatchObject({ code: "E_AUTH" });
  expect((await reader.getAgent(account))?.status).toBe("active");

  // Claiming: once the account has retired with its own key, the function-call key cannot claim.
  await client.unregisterAgent();
  const claim = await claimBondCommand(options({ name: "delegate" })).catch((e: unknown) => e);
  expect(claim).toMatchObject({ code: "E_AUTH" });
  expect((await reader.getAgent(account))?.status).toBe("unregistering");

  expect(out.join("\n")).not.toContain(pair.toString().slice("ed25519:".length));
});

/** A client of the chain that signs as `signer`. */
function clientOf(signer: Signer): TenderClient {
  return new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
    signer,
  });
}

/** Registers `signer`'s account as an agent with the client directly, as a setup step. */
async function registerAgentWith(signer: Signer, name = "alice"): Promise<TenderClient> {
  const client = clientOf(signer);
  await registerWithBond(client, scriptedProfile(name, []), { approve: () => true });
  return client;
}

test("an_agent_in_an_open_task_has_its_bond_held_until_the_commit_deadline_and_the_commands_say_so", async () => {
  const lead = chain.accounts.lead;
  const account = lead.accountId;
  const member = await registerAgentWith(lead, "lead");

  // The commands act for the account with its own full-access key, in a key file made by hand.
  await writeFile(
    join(keys, "holder.json"),
    JSON.stringify({
      version: 1,
      name: "holder",
      network: "sandbox",
      account,
      publicKey: KeyPair.fromString(lead.privateKey as KeyPairString)
        .getPublicKey()
        .toString(),
      privateKey: lead.privateKey,
    }),
    { mode: 0o600 },
  );

  // A task whose commit window is longer than the cooldown (20 s), so what holds the bond is the
  // task and not the cooldown. The agent enters it.
  const poster = clientOf(chain.accounts.poster);
  const reward = 1_000_000n;
  await poster.deposit(chain.tokenId, reward);
  const posted = await poster.postTask({
    token: chain.tokenId,
    reward,
    briefUri: "ipfs://brief",
    briefHash: sha256Hex("brief"),
    criteriaHash: sha256Hex("criteria"),
    verifier: chain.accounts.judge.accountId,
    commitSecs: 45,
    revealSecs: 5,
    pickSecs: 5,
    fallbackSecs: 5,
  });
  const task = await reader.getTask(posted.taskId);
  if (task === null) throw new Error(`task ${posted.taskId} is missing right after posting`);
  expect((await reader.getAgent(account))?.locked_until).toBeNull();
  await member.commit(
    posted.taskId,
    computeCommitment(posted.taskId, account, sha256Hex("work"), randomSalt()),
  );

  // The agent's view shows the deadline that holds it.
  expect((await reader.getAgent(account))?.locked_until).toBe(task.commit_deadline);

  // Retiring: the bond becomes claimable at that deadline, which is later than the cooldown's end,
  // and the commands print it.
  out.length = 0;
  const leaving = await retireAgentCommand(options({ name: "holder", yes: true }));
  const retiredAt = await reader.blockTimestampNs();
  expect(leaving).toMatchObject({ status: "unregistering", locked_until: task.commit_deadline });
  expect(leaving.claimable_at).toBe(task.commit_deadline);
  expect(BigInt(leaving.claimable_at ?? "0")).toBeGreaterThan(
    retiredAt + BigInt(COOLDOWN_SECS) * 1_000_000_000n,
  );
  const deadline = new Date(Number(BigInt(task.commit_deadline) / 1_000_000n)).toISOString();
  expect(out.filter((line) => line.startsWith("held by an open task until: "))).toEqual([
    expect.stringContaining(deadline),
  ]);
  expect(out.filter((line) => line.startsWith("claimable at: "))).toEqual([
    expect.stringContaining(deadline),
  ]);

  // Too soon: refused, with the deadline as the date, and the bond stays where it is.
  const vaultBefore = await vault(account);
  const early = await claimBondCommand(options({ name: "holder" })).catch((e: unknown) => e);
  expect(early).toMatchObject({ code: "E_PHASE" });
  expect((early as Error).message).toContain(`claimable from ${deadline}`);
  expect(await vault(account)).toBe(vaultBefore);
  expect((await reader.getAgent(account))?.status).toBe("unregistering");

  // Once the commit deadline is over the bond is back in the vault, exactly.
  while ((await reader.blockTimestampNs()) < BigInt(task.commit_deadline)) await sleep(300);
  const bond = BigInt((await reader.getConfig()).agent_bond_amount ?? "0");
  const claimed = await claimBondCommand(options({ name: "holder" }));
  expect(claimed).toMatchObject({ status: "retired", bond_token: null, bond_amount: null });
  expect(await vault(account)).toBe(vaultBefore + bond);

  // The private key is nowhere in what the commands printed.
  expect(out.join("\n")).not.toContain(lead.privateKey.slice("ed25519:".length));
});
