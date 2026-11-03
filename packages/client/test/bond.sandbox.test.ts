import {
  computeCommitment,
  type PostTaskInput,
  parseEventLog,
  randomSalt,
  sha256Hex,
} from "@tender/shared";
import { Account, actions, KeyPair, type KeyPairString } from "near-api-js";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  bondTermsOf,
  LOCAL_AGENT_BOND,
  type LocalChain,
  planRegistration,
  registerWithBond,
  scriptedProfile,
  startLocalChain,
  TenderClient,
  TenderError,
  type TxResult,
} from "../src/index";

// The agent bond on a real chain (contract Task 16b): what registering takes, the gate it opens,
// the way out and the refund. One chain for the file, and the tests build on one another in order:
// alice registers in the second, leaves in the fourth.

type Role = keyof LocalChain["accounts"];

const COOLDOWN_SECS = 6;
const EVENT_PREFIX = "EVENT_JSON:";

let chain: LocalChain;
let clients: Record<Role, TenderClient>;
let taskId: bigint;

const id = (role: Role) => chain.accounts[role].accountId;
const names = (result: TxResult) => result.events.map((e) => e.event);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  chain = await startLocalChain({ agentBond: { cooldownSecs: COOLDOWN_SECS } });
  clients = Object.fromEntries(
    Object.entries(chain.accounts).map(([role, signer]) => [
      role,
      new TenderClient({
        network: chain.network,
        contractId: chain.contractId,
        rpcUrl: chain.rpcUrl,
        signer,
      }),
    ]),
  ) as Record<Role, TenderClient>;
});

afterAll(async () => {
  await chain?.stop();
});

/** The TenderError that `call` fails with. Any other outcome fails the test. */
async function failure(call: Promise<unknown>): Promise<TenderError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof TenderError) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

/** Every log of the Tender contract in `result` is an event that the schemas read, field for field. */
function expectEveryLogAccountedFor(result: TxResult) {
  for (const { executorId, logs } of result.receipts) {
    if (executorId !== chain.contractId) continue;
    for (const line of logs) {
      const event = parseEventLog(line);
      expect(event, `a log that is not a Tender event: ${line}`).not.toBeNull();
      const logged = JSON.parse(line.slice(EVENT_PREFIX.length));
      expect(event?.data, `the schema changed the data of ${line}`).toStrictEqual(logged.data[0]);
    }
  }
}

async function waitForChainTime(ns: string) {
  while ((await clients.keeper.blockTimestampNs()) < BigInt(ns)) await sleep(200);
}

function seal(account: string) {
  const contentHash = sha256Hex(`work of ${account}`);
  const salt = randomSalt();
  return { commitment: computeCommitment(taskId, account, contentHash, salt) };
}

const vault = (role: Role) => clients.keeper.balanceOf(id(role), chain.tokenId);
const wallet = (role: Role) => clients.keeper.ftBalanceOf(chain.tokenId, id(role));

test("the_local_chain_has_a_bond_set_before_any_agent_registers", async () => {
  const config = await clients.keeper.getConfig();
  expect(bondTermsOf(config)).toEqual({
    token: chain.tokenId,
    amount: LOCAL_AGENT_BOND,
    cooldownSecs: BigInt(COOLDOWN_SECS),
  });
  // Nobody has registered, so nobody holds a bond.
  for (const role of ["alice", "bob", "lead"] as const) {
    expect(await clients.keeper.getAgent(id(role)), role).toBeNull();
  }
});

test("registering_pays_the_bond_and_opens_open_tasks_to_the_agent", async () => {
  const { poster, alice } = clients;
  await poster.deposit(chain.tokenId, 1_000_000n);
  const input: PostTaskInput = {
    token: chain.tokenId,
    reward: 1_000_000n,
    briefUri: "ipfs://brief",
    briefHash: sha256Hex("brief"),
    criteriaHash: sha256Hex("criteria"),
    verifier: id("judge"),
    commitSecs: 600,
    revealSecs: 600,
    pickSecs: 600,
    fallbackSecs: 600,
  };
  taskId = (await poster.postTask(input)).taskId;

  // Not registered: the open task refuses the entry, and says why.
  const refused = await failure(alice.commit(taskId, seal(id("alice")).commitment));
  expect(refused.code).toBe("E_NOT_REGISTERED");

  const plan = await planRegistration(alice);
  expect(plan).toMatchObject({
    agent: null,
    takesBond: true,
    vault: 0n,
    shortfall: LOCAL_AGENT_BOND,
    wallet: 10n ** 12n,
    storageShortfall: 0n,
  });

  // Without a yes, nothing moves.
  const declined = await failure(registerWithBond(alice, scriptedProfile("alice")));
  expect(declined.code).toBe("E_FUNDS");
  expect(await vault("alice")).toBe(0n);
  expect(await wallet("alice")).toBe(10n ** 12n);

  const registration = await registerWithBond(alice, scriptedProfile("alice", ["extraction"]), {
    approve: () => true,
  });
  expect(registration.deposited).toBe(LOCAL_AGENT_BOND);
  expect(names(registration.tx)).toEqual(["agent_registered", "agent_bonded"]);
  expect(registration.tx.events[1]).toMatchObject({
    data: { account: id("alice"), token: chain.tokenId, amount: LOCAL_AGENT_BOND.toString() },
  });
  expectEveryLogAccountedFor(registration.tx);
  // The deposit filled the vault and the registration took the bond out of it; the tokens left
  // the wallet and stay in the contract, recorded as the agent's bond.
  expect(await vault("alice")).toBe(0n);
  expect(await wallet("alice")).toBe(10n ** 12n - LOCAL_AGENT_BOND);
  expect(registration.agent).toMatchObject({
    status: "active",
    bond_token: chain.tokenId,
    bond_amount: LOCAL_AGENT_BOND.toString(),
    claimable_at: null,
  });

  const entered = await alice.commit(taskId, seal(id("alice")).commitment);
  expect(names(entered)).toEqual(["committed"]);
});

test("an_active_agent_updating_its_profile_pays_no_second_bond", async () => {
  const { alice } = clients;
  const plan = await planRegistration(alice);
  expect(plan).toMatchObject({ takesBond: false, shortfall: 0n });

  const again = await registerWithBond(alice, scriptedProfile("alice", ["extraction", "json"]));
  expect(again.deposited).toBe(0n);
  expect(names(again.tx)).toEqual(["agent_registered"]);
  expect(again.tx.events[0]).toMatchObject({ data: { updated: true } });
  expect(again.agent).toMatchObject({ status: "active", bond_amount: LOCAL_AGENT_BOND.toString() });
  expect(again.agent.tags).toEqual(["extraction", "json"]);
  expect(await wallet("alice")).toBe(10n ** 12n - LOCAL_AGENT_BOND);
});

test("a_function_call_key_cannot_register_unregister_or_claim", async () => {
  const bob = chain.accounts.bob;
  // A function-call key to Tender that lists the three methods and more: not what is listed, but
  // that a function-call key cannot attach the 1 yoctoNEAR they take.
  const callKey = KeyPair.fromRandom("ed25519");
  const account = new Account(bob.accountId, chain.rpcUrl, bob.privateKey as KeyPairString);
  await account.signAndSendTransaction({
    receiverId: bob.accountId,
    actions: [
      actions.addFunctionCallAccessKey(
        callKey.getPublicKey(),
        chain.contractId,
        ["register_agent", "unregister_agent", "claim_agent_bond", "commit", "reveal"],
        10n ** 24n,
      ),
    ],
    waitUntil: "FINAL",
  });
  const viaCallKey = new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
    signer: { accountId: bob.accountId, privateKey: callKey.toString() },
  });
  const profile = scriptedProfile("bob");
  const attempts = [
    () => viaCallKey.registerAgent(profile.uri, profile.hash, profile.tags),
    () => viaCallKey.unregisterAgent(),
    () => viaCallKey.claimAgentBond(),
    // Refused before the bond is moved into the vault, which the key could not do either.
    () => registerWithBond(viaCallKey, profile, { approve: () => true }),
  ];
  for (const attempt of attempts) {
    const refused = await failure(attempt());
    expect(refused.code).toBe("E_AUTH");
    expect(refused.message).toContain("full-access key");
    // Refused here: no transaction, so no transaction hash.
    expect(refused.txHash).toBeUndefined();
  }
  expect(await clients.keeper.getAgent(bob.accountId)).toBeNull();
  expect(await vault("bob")).toBe(0n);
  expect(await wallet("bob")).toBe(10n ** 12n);
});

test("leaving_closes_open_tasks_and_the_bond_comes_back_after_the_cooldown", async () => {
  const { alice, keeper } = clients;
  const unregistered = await alice.unregisterAgent();
  expect(names(unregistered)).toEqual(["agent_unregistering"]);
  expectEveryLogAccountedFor(unregistered);
  const leaving = await keeper.getAgent(id("alice"));
  expect(leaving).toMatchObject({
    status: "unregistering",
    bond_amount: LOCAL_AGENT_BOND.toString(),
  });
  const claimableAt = leaving?.claimable_at;
  if (claimableAt === null || claimableAt === undefined) throw new Error("no claimable_at");
  expect(unregistered.events[0]).toMatchObject({ data: { claimable_at: claimableAt } });

  // An unregistering agent makes no new entry, and does not replace the one it made.
  const replaced = await failure(alice.commit(taskId, seal(id("alice")).commitment));
  expect(replaced.code).toBe("E_NOT_REGISTERED");
  // It is told to claim before it registers again (and nothing is moved for it).
  const early = await failure(registerWithBond(alice, scriptedProfile("alice")));
  expect(early.code).toBe("E_PHASE");

  // The cooldown is not over: the claim is refused, and the bond stays where it is.
  const tooSoon = await failure(alice.claimAgentBond());
  expect(tooSoon.code).toBe("E_PHASE");
  expect(await vault("alice")).toBe(0n);

  await waitForChainTime(claimableAt);
  const claimed = await alice.claimAgentBond();
  expect(names(claimed)).toEqual(["agent_bond_claimed"]);
  expect(claimed.events[0]).toMatchObject({
    data: { account: id("alice"), token: chain.tokenId, amount: LOCAL_AGENT_BOND.toString() },
  });
  expectEveryLogAccountedFor(claimed);
  expect(await keeper.getAgent(id("alice"))).toMatchObject({
    status: "retired",
    bond_token: null,
    bond_amount: null,
    claimable_at: null,
  });
  // Exactly the bond is back, in the vault, and a second claim finds nothing to pay.
  expect(await vault("alice")).toBe(LOCAL_AGENT_BOND);
  expect((await failure(alice.claimAgentBond())).code).toBe("E_NOT_REGISTERED");

  // The retired agent is out of open tasks, and keeps its history.
  expect((await failure(alice.commit(taskId, seal(id("alice")).commitment))).code).toBe(
    "E_NOT_REGISTERED",
  );
  expect(leaving?.entries).toBe(1);
});

test("a_retired_agent_comes_back_with_a_fresh_bond_from_its_vault", async () => {
  const { alice } = clients;
  const plan = await planRegistration(alice);
  // The refund sits in the vault, so the new bond needs nothing from the wallet.
  expect(plan).toMatchObject({ takesBond: true, vault: LOCAL_AGENT_BOND, shortfall: 0n });
  const back = await registerWithBond(alice, scriptedProfile("alice"));
  expect(back.deposited).toBe(0n);
  expect(names(back.tx)).toEqual(["agent_registered", "agent_bonded"]);
  expect(back.agent).toMatchObject({ status: "active", bond_amount: LOCAL_AGENT_BOND.toString() });
  expect(back.agent.entries).toBe(1);
  expect(await vault("alice")).toBe(0n);
});
