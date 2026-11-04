import { computeCommitment, type PostTaskInput, randomSalt, sha256Hex } from "@tender/shared";
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
} from "../src/index";

// An agent that registered before the owner set a bond (contract Task 16b, held-bond rule): it is
// active and holds none. While no bond is set it enters open tasks; once the owner sets one it is
// refused at every open task, until it registers again, which takes the bond from its vault.
// `startLocalChain({ agentBond: null })` is the chain for it: the owner sets no bond at start-up.

type Role = keyof LocalChain["accounts"];

let chain: LocalChain;
let clients: Record<Role, TenderClient>;

const id = (role: Role) => chain.accounts[role].accountId;

beforeAll(async () => {
  chain = await startLocalChain({ agentBond: null, registerAgents: ["lead"] });
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

/** Funds the poster's vault and posts a task with long windows, so it stays open for the test. */
async function postOpenTask(): Promise<bigint> {
  const { poster } = clients;
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
  return (await poster.postTask(input)).taskId;
}

const commitmentFor = (taskId: bigint, account: string) =>
  computeCommitment(taskId, account, sha256Hex(`work of ${account}`), randomSalt());

test("an_agent_that_registered_before_the_bond_was_set_is_refused_until_it_pays_it", async () => {
  const { keeper, owner, lead } = clients;

  // No bond is set: lead registered for nothing and is active with none.
  expect(bondTermsOf(await keeper.getConfig())).toBeNull();
  expect(await keeper.getAgent(id("lead"))).toMatchObject({
    status: "active",
    bond_token: null,
    bond_amount: null,
    claimable_at: null,
    locked_until: null,
  });
  expect(await planRegistration(lead)).toMatchObject({ terms: null, takesBond: false });

  // It enters an open task all the same: the rule holds an agent to a bond only once one is set.
  const first = await postOpenTask();
  await lead.commit(first, commitmentFor(first, id("lead")));
  const entered = await keeper.getTask(first);
  expect((await keeper.getAgent(id("lead")))?.locked_until).toBe(entered?.commit_deadline);

  // The owner sets a bond. Lead keeps what it holds, which is nothing, and is refused at the next
  // open task; the refusal says why and names the way.
  await owner.setAgentBond(chain.tokenId, LOCAL_AGENT_BOND);
  expect(bondTermsOf(await keeper.getConfig())).toMatchObject({ amount: LOCAL_AGENT_BOND });
  expect(await keeper.getAgent(id("lead"))).toMatchObject({
    status: "active",
    bond_token: null,
    bond_amount: null,
  });
  const second = await postOpenTask();
  const refused = await failure(lead.commit(second, commitmentFor(second, id("lead"))));
  expect(refused.code).toBe("E_NOT_REGISTERED");
  expect(refused.message).toContain("registered before the bond was set and holds none");
  expect(refused.message).toContain("call register_agent");

  // An agent that never registered is refused too, with the plain refusal.
  const stranger = await failure(clients.alice.commit(second, commitmentFor(second, id("alice"))));
  expect(stranger.code).toBe("E_NOT_REGISTERED");
  expect(stranger.message).not.toContain("holds none");

  // The plan says it would pay the bond now, from the wallet into the vault, and it does.
  const plan = await planRegistration(lead);
  expect(plan).toMatchObject({
    takesBond: true,
    vault: 0n,
    shortfall: LOCAL_AGENT_BOND,
    wallet: 10n ** 12n,
  });
  const registration = await registerWithBond(lead, scriptedProfile("lead"), {
    approve: () => true,
  });
  expect(registration.deposited).toBe(LOCAL_AGENT_BOND);
  expect(registration.tx.events.map((e) => e.event)).toEqual(["agent_registered", "agent_bonded"]);
  expect(registration.agent).toMatchObject({
    status: "active",
    bond_token: chain.tokenId,
    bond_amount: LOCAL_AGENT_BOND.toString(),
  });
  expect(await keeper.balanceOf(id("lead"), chain.tokenId)).toBe(0n);
  expect(await keeper.ftBalanceOf(chain.tokenId, id("lead"))).toBe(10n ** 12n - LOCAL_AGENT_BOND);

  // With the bond held it enters the open task, and a second registration pays nothing more.
  const accepted = await lead.commit(second, commitmentFor(second, id("lead")));
  expect(accepted.events.map((e) => e.event)).toEqual(["committed"]);
  expect(await planRegistration(lead)).toMatchObject({ takesBond: false, shortfall: 0n });
});
