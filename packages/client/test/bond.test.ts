import {
  type AgentView,
  type ConfigView,
  canonicalJson,
  ProfileSchema,
  sha256Hex,
} from "@tender/shared";
import { expect, test, vi } from "vitest";
import {
  bondTermsOf,
  planRegistration,
  registerWithBond,
  scriptedProfile,
  type TenderClient,
  TenderError,
} from "../src/index";

const ME = "agent.test.near";
const TOKEN = "usdc.test.near";
const BOND = 1_000_000n;

const CONFIG: ConfigView = {
  owner: "owner.test.near",
  pending_owner: null,
  treasury: "treasury.test.near",
  fee_bps: 500,
  min_window_secs: 5,
  max_window_secs: 1_209_600,
  paused: false,
  version: 1,
  tokens: [],
  agent_bond_token: TOKEN,
  agent_bond_amount: BOND.toString(),
  agent_bond_cooldown_secs: "3600",
};

function agentView(over: Partial<AgentView> = {}): AgentView {
  return {
    account: ME,
    asp: null,
    profile_uri: "tender://agent/agent",
    profile_hash: "ab".repeat(32),
    tags: [],
    registered_at: "1793745950569746000",
    entries: 0,
    reveals: 0,
    wins: 0,
    earned: [],
    picks_made: 0,
    voids_after_reveals: 0,
    status: "active",
    bond_token: TOKEN,
    bond_amount: BOND.toString(),
    claimable_at: null,
    locked_until: null,
    ...over,
  };
}

interface World {
  config: ConfigView;
  agent: AgentView | null;
  /** The storage balance's available yoctoNEAR, or null if there is none. */
  storageAvailable: string | null;
  vault: bigint;
  wallet: bigint;
  /** Whether the token is registered for the account at all. */
  tokenRegistered: boolean;
  /** Tender refuses a deposit, as it does for an account without a storage balance. */
  refuseDeposit: boolean;
}

/** A client over a small world, which records every call that changes it, in order. */
function fake(over: Partial<World> = {}) {
  const world: World = {
    config: CONFIG,
    agent: null,
    storageAvailable: "100000000000000000000000",
    vault: 0n,
    wallet: 5n * BOND,
    tokenRegistered: true,
    refuseDeposit: false,
    ...over,
  };
  const log: string[] = [];
  const client = {
    accountId: ME,
    getConfig: async () => world.config,
    getAgent: async () => world.agent,
    storageBalanceOf: async () =>
      world.storageAvailable === null
        ? null
        : { total: world.storageAvailable, available: world.storageAvailable, used_bytes: "0" },
    balanceOf: async () => world.vault,
    ftStorageBalanceOf: async () => (world.tokenRegistered ? { total: "1", available: "0" } : null),
    ftBalanceOf: async () => world.wallet,
    requireFullAccessKey: async (method: string) => {
      log.push(`key ${method}`);
    },
    storageDeposit: async (amount: bigint) => {
      log.push(`storage ${amount}`);
      world.storageAvailable = amount.toString();
    },
    deposit: async (token: string, amount: bigint) => {
      log.push(`deposit ${amount} ${token}`);
      if (world.refuseDeposit) return;
      world.wallet -= amount;
      world.vault += amount;
    },
    registerAgent: async () => {
      log.push("register");
      // As the contract does after its bond fix round: a new agent pays, a retired one coming back,
      // and an active one that holds no bond. An active one that holds its bond pays nothing.
      const takes =
        world.agent === null ||
        world.agent.status === "retired" ||
        (world.agent.status === "active" && world.agent.bond_amount === null);
      if (takes) world.vault -= BOND;
      world.agent = agentView();
      return { txHash: "TX", events: [], returnValue: undefined, receipts: [] };
    },
  };
  return { client: client as unknown as TenderClient, world, log };
}

const profile = scriptedProfile("agent", ["regex"]);
const yes = { approve: () => true };

test("bond_terms_come_from_the_config_and_are_null_until_the_owner_sets_one", () => {
  expect(bondTermsOf(CONFIG)).toEqual({ token: TOKEN, amount: BOND, cooldownSecs: 3600n });
  expect(bondTermsOf({ ...CONFIG, agent_bond_token: null, agent_bond_amount: null })).toBeNull();
  // The amount is a u128, which a number would lose digits of.
  const huge = { ...CONFIG, agent_bond_amount: (2n ** 100n).toString() };
  expect(bondTermsOf(huge)?.amount).toBe(2n ** 100n);
});

test("a_scripted_profile_is_a_profile_the_registry_pins", () => {
  const p = scriptedProfile("agent", ["regex", "json"], "answers regexes");
  expect(ProfileSchema.safeParse(p.document).success).toBe(true);
  expect(p.hash).toBe(sha256Hex(canonicalJson(p.document)));
  expect(p.tags).toEqual(["regex", "json"]);
  expect(new TextEncoder().encode(p.uri).length).toBeLessThanOrEqual(256);
  // The same profile again is the same hash, another name is another.
  expect(scriptedProfile("agent", ["regex", "json"], "answers regexes").hash).toBe(p.hash);
  expect(scriptedProfile("other", ["regex", "json"], "answers regexes").hash).not.toBe(p.hash);
});

test("the_plan_of_a_new_agent_shows_the_bond_it_lacks", async () => {
  const { client } = fake({ vault: 400_000n, wallet: 7n });
  expect(await planRegistration(client)).toEqual({
    account: ME,
    agent: null,
    terms: { token: TOKEN, amount: BOND, cooldownSecs: 3600n },
    takesBond: true,
    vault: 400_000n,
    shortfall: 600_000n,
    wallet: 7n,
    storageShortfall: 0n,
  });
});

test("the_plan_takes_a_bond_from_a_new_retired_or_bond_free_agent_and_not_from_a_bonded_one", async () => {
  for (const [agent, takes] of [
    [null, true],
    [agentView({ status: "retired", bond_token: null, bond_amount: null }), true],
    // An agent that registered before the owner set a bond holds none: its next registration pays.
    [agentView({ status: "active", bond_token: null, bond_amount: null }), true],
    [agentView({ status: "active" }), false],
    [agentView({ status: "active", locked_until: "1793745956336648000" }), false],
    [agentView({ status: "unregistering", claimable_at: "5" }), false],
  ] as const) {
    const { client } = fake({ agent });
    const plan = await planRegistration(client);
    expect(plan.takesBond, String(agent?.status)).toBe(takes);
    // An agent that takes no bond lacks none, whatever its vault holds.
    if (!takes) expect(plan.shortfall).toBe(0n);
  }
});

test("a_chain_with_no_bond_takes_none_and_lacks_none", async () => {
  const config = { ...CONFIG, agent_bond_token: null, agent_bond_amount: null };
  const { client, log } = fake({ config });
  const plan = await planRegistration(client);
  expect(plan).toMatchObject({ terms: null, takesBond: false, shortfall: 0n, wallet: null });
  const registered = await registerWithBond(client, profile);
  expect(registered.deposited).toBe(0n);
  expect(log).toEqual(["key register_agent", "register"]);
});

test("a_short_vault_is_filled_from_the_wallet_only_after_a_yes", async () => {
  const { client, world, log } = fake({ vault: 250_000n });
  const seen: bigint[] = [];
  const registered = await registerWithBond(client, profile, {
    approve: (plan) => {
      seen.push(plan.shortfall);
      return true;
    },
  });
  expect(seen).toEqual([750_000n]);
  expect(log).toEqual(["key register_agent", `deposit 750000 ${TOKEN}`, "register"]);
  expect(registered).toMatchObject({ deposited: 750_000n, storageAdded: 0n });
  expect(world.wallet).toBe(5n * BOND - 750_000n);
  expect(registered.agent.status).toBe("active");
});

test("without_a_yes_nothing_moves", async () => {
  for (const options of [undefined, { approve: () => false }, { approve: async () => false }]) {
    const { client, log } = fake();
    await expect(registerWithBond(client, profile, options)).rejects.toMatchObject({
      code: "E_FUNDS",
      message: expect.stringContaining(`${BOND} more has to be deposited`),
    });
    expect(log).toEqual(["key register_agent"]);
  }
});

test("a_full_vault_needs_no_question", async () => {
  let asked = false;
  const { client, log } = fake({ vault: BOND });
  await registerWithBond(client, profile, {
    approve: () => {
      asked = true;
      return false;
    },
  });
  expect(asked).toBe(false);
  expect(log).toEqual(["key register_agent", "register"]);
});

test("a_short_wallet_is_refused_before_anything_moves", async () => {
  const { client, log } = fake({ wallet: 10n, storageAvailable: null });
  const error = await registerWithBond(client, profile, yes).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(TenderError);
  expect(error).toMatchObject({ code: "E_FUNDS" });
  expect((error as Error).message).toContain("holds 10");
  // Not even the storage deposit that a new account needs.
  expect(log).toEqual(["key register_agent"]);
});

test("nobody_is_asked_to_approve_a_registration_the_wallet_cannot_pay_for", async () => {
  const { client } = fake({ wallet: 10n });
  const approve = vi.fn(() => true);
  const error = await registerWithBond(client, profile, { approve }).catch((e: unknown) => e);
  expect(error).toMatchObject({ code: "E_FUNDS" });
  expect(approve).not.toHaveBeenCalled();
});

test("a_token_the_account_never_registered_counts_as_an_empty_wallet", async () => {
  const { client } = fake({ tokenRegistered: false, wallet: 99n * BOND });
  expect((await planRegistration(client)).wallet).toBe(0n);
});

test("a_new_account_adds_the_storage_it_lacks_before_the_bond", async () => {
  const { client, log } = fake({ storageAvailable: null });
  const registered = await registerWithBond(client, profile, { ...yes, storageMargin: 7n });
  expect(registered.plan.storageShortfall).toBeGreaterThan(0n);
  expect(registered.storageAdded).toBe(registered.plan.storageShortfall + 7n);
  expect(log).toEqual([
    "key register_agent",
    `storage ${registered.storageAdded}`,
    `deposit ${BOND} ${TOKEN}`,
    "register",
  ]);
});

test("storage_alone_can_be_what_is_short", async () => {
  const { client, log } = fake({ storageAvailable: null, vault: BOND });
  await expect(registerWithBond(client, profile)).rejects.toMatchObject({ code: "E_STORAGE" });
  expect(log).toEqual(["key register_agent"]);
});

test("a_deposit_tender_refuses_is_noticed_before_registering", async () => {
  // Tender refunds a deposit it will not take and does not fail, so only the vault shows it.
  const { client, log } = fake({ refuseDeposit: true });
  await expect(registerWithBond(client, profile, yes)).rejects.toMatchObject({
    code: "E_FUNDS",
    message: expect.stringContaining("did not take the deposit"),
  });
  expect(log).toEqual(["key register_agent", `deposit ${BOND} ${TOKEN}`]);
});

test("an_active_agent_updates_without_a_bond", async () => {
  const { client, log, world } = fake({ agent: agentView(), vault: 0n });
  const updated = await registerWithBond(client, profile);
  expect(updated.deposited).toBe(0n);
  expect(log).toEqual(["key register_agent", "register"]);
  expect(world.vault).toBe(0n);
});

test("an_active_agent_that_holds_no_bond_pays_it_at_its_next_registration", async () => {
  // It registered before the owner set a bond. The contract takes the bond at the next
  // register_agent, so the vault is filled first, after a yes.
  const agent = agentView({ status: "active", bond_token: null, bond_amount: null });
  const { client, log, world } = fake({ agent, vault: 0n, wallet: 3n * BOND });
  await expect(registerWithBond(client, profile)).rejects.toMatchObject({ code: "E_FUNDS" });
  expect(log).toEqual(["key register_agent"]);

  const paid = await registerWithBond(client, profile, yes);
  expect(paid.deposited).toBe(BOND);
  expect(paid.plan.takesBond).toBe(true);
  expect(log).toEqual([
    "key register_agent",
    "key register_agent",
    `deposit ${BOND} ${TOKEN}`,
    "register",
  ]);
  expect(world.vault).toBe(0n);
});

test("an_unregistering_agent_is_told_to_claim_first_and_nothing_moves", async () => {
  const agent = agentView({ status: "unregistering", claimable_at: "1793745956336648000" });
  const { client, log } = fake({ agent });
  await expect(registerWithBond(client, profile, yes)).rejects.toMatchObject({
    code: "E_PHASE",
    message: expect.stringContaining("claim its bond"),
  });
  expect(log).toEqual(["key register_agent"]);
});

test("a_retired_agent_pays_a_fresh_bond_and_may_use_the_refund_in_its_vault", async () => {
  const agent = agentView({ status: "retired", bond_token: null, bond_amount: null });
  const { client, log, world } = fake({ agent, vault: BOND });
  const back = await registerWithBond(client, profile);
  expect(back.deposited).toBe(0n);
  expect(log).toEqual(["key register_agent", "register"]);
  expect(world.vault).toBe(0n);
});

test("a_key_that_cannot_register_stops_everything_first", async () => {
  const { client, log } = fake();
  (client as unknown as { requireFullAccessKey: unknown }).requireFullAccessKey = async () => {
    log.push("key refused");
    throw new TenderError("E_AUTH", "needs a full-access key");
  };
  await expect(registerWithBond(client, profile, yes)).rejects.toMatchObject({ code: "E_AUTH" });
  expect(log).toEqual(["key refused"]);
});

test("a_client_without_a_signer_cannot_register", async () => {
  const { client } = fake();
  (client as unknown as { accountId: undefined }).accountId = undefined;
  await expect(registerWithBond(client, profile)).rejects.toThrow(/no signer/);
});
