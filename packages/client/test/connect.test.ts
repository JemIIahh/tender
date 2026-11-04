import { ApiError, type ConnectLookup, connectFingerprint } from "@tender/shared";
import { KeyPair } from "near-api-js";
import { expect, test } from "vitest";
import {
  type ConnectAgentOptions,
  type ConnectApi,
  ConnectError,
  type ConnectKeyState,
  connectAgent,
  type RegistrationPlan,
} from "../src/index";

// The agent's side of "Connect your agent" (`connectAgent`), with every party a fake: the API's
// three routes, the chain's two reads, the key store and the registration. A clock of the test's
// own moves only when the engine sleeps, so the waits run at once and their ends are exact.

const CODE = "tc_abcdefghijklmnopqrstuvwxyz";
const OWNER = "alice.testnet";
const ACCOUNT = `writer.${OWNER}`;
const PUBLIC = KeyPair.fromRandom("ed25519").getPublicKey().toString();

const lookupOf = (over: Partial<ConnectLookup> = {}): ConnectLookup => ({
  owner: OWNER,
  name: "writer",
  account_id: ACCOUNT,
  network: "testnet",
  contract: "tender.testnet",
  state: "waiting",
  expires_at: "2026-11-04T10:30:00.000Z",
  fingerprint: null,
  ...over,
});

const planOf = (over: Partial<RegistrationPlan> = {}): RegistrationPlan => ({
  account: ACCOUNT,
  agent: null,
  terms: { token: "tusdc.testnet", amount: 5_000_000n, cooldownSecs: 60n },
  takesBond: true,
  vault: 0n,
  shortfall: 5_000_000n,
  wallet: 0n,
  storageShortfall: 0n,
  ...over,
});

/** A world for the engine: what each party answers, and a record of what was asked. */
function world(
  options: {
    lookup?: ConnectLookup;
    keyStates?: ConnectKeyState[];
    plans?: RegistrationPlan[];
    attach?: () => Promise<ConnectLookup>;
    registered?: Array<() => Promise<unknown>>;
    existingKey?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const lines: string[] = [];
  let clock = 1_000_000;
  const keyStates = [...(options.keyStates ?? ["has-key"])];
  const plans = [...(options.plans ?? [planOf({ vault: 5_000_000n, shortfall: 0n })])];
  const registered = [...(options.registered ?? [async () => ({})])];
  const api: ConnectApi = {
    async connectLookup(code) {
      calls.push(`lookup ${code}`);
      return options.lookup ?? lookupOf();
    },
    async connectAttach(code, publicKey) {
      calls.push(`attach ${code} ${publicKey}`);
      return (
        options.attach?.() ??
        lookupOf({ state: "attached", fingerprint: connectFingerprint(publicKey) })
      );
    },
    async connectRegistered(code) {
      calls.push(`registered ${code}`);
      const next = registered.length > 1 ? registered.shift() : registered[0];
      return (await next?.()) as never;
    },
  };
  const opts: ConnectAgentOptions = {
    code: CODE,
    api,
    log: (line) => lines.push(line),
    waitMs: 60_000,
    pollMs: 3_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    chainFor: (lookup) => {
      calls.push(`chain ${lookup.network} ${lookup.contract}`);
      return {
        keyState: async () => {
          const state = keyStates.length > 1 ? keyStates.shift() : keyStates[0];
          calls.push(`keyState ${state}`);
          return state ?? "missing";
        },
        plan: async () => {
          const plan = plans.length > 1 ? plans.shift() : plans[0];
          calls.push(`plan ${plan?.shortfall}`);
          return plan ?? planOf();
        },
      };
    },
    key: async (_lookup, name, mayMake) => {
      calls.push(`key ${name} ${mayMake}`);
      if (!(options.existingKey ?? false) && !mayMake) return null;
      return {
        publicKey: PUBLIC,
        path: `/keys/${name}.json`,
        made: !(options.existingKey ?? false),
      };
    },
    register: async (_lookup, name) => {
      calls.push(`register ${name}`);
    },
  };
  return { calls, lines, opts, elapsed: () => clock - 1_000_000 };
}

test("the_steps_run_in_order_and_each_says_one_plain_line", async () => {
  const w = world({ keyStates: ["missing", "missing", "has-key"] });
  const outcome = await connectAgent(w.opts);
  expect(outcome).toEqual({
    status: "registered",
    accountId: ACCOUNT,
    owner: OWNER,
    fingerprint: connectFingerprint(PUBLIC),
    keyPath: "/keys/writer.json",
    confirmed: true,
  });
  // The chain is settled before any key is made, and the key before it is attached.
  expect(w.calls).toEqual([
    `lookup ${CODE}`,
    "chain testnet tender.testnet",
    "key writer true",
    `attach ${CODE} ${PUBLIC}`,
    "keyState missing",
    "keyState missing",
    "keyState has-key",
    "plan 0",
    "register writer",
    `registered ${CODE}`,
  ]);
  expect(w.lines).toEqual([
    `connect code for ${ACCOUNT}, made by ${OWNER}, on testnet`,
    "key: made /keys/writer.json (mode 600; the private key is in it and is never printed)",
    `public key: ${PUBLIC}`,
    `fingerprint: ${connectFingerprint(PUBLIC)}`,
    `attached. On the page of ${OWNER}, check that the fingerprint is ${connectFingerprint(PUBLIC)}, then press Create agent.`,
    `waiting for ${OWNER} to create ${ACCOUNT}…`,
    `created: ${ACCOUNT} exists, with this key as its full-access key`,
    "funded: the bond is in the agent's vault",
    `registered: ${ACCOUNT} is an agent`,
    `done: ${ACCOUNT} is an active agent, and the page of ${OWNER} says so`,
  ]);
  // Nothing printed is the private key: the engine never sees it.
  expect(w.lines.join("\n")).not.toMatch(/ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/);
});

test("a_wait_that_runs_out_says_where_it_stopped_and_how_to_go_on", async () => {
  const w = world({ keyStates: ["missing"] });
  w.opts.waitMs = 100_000;
  const outcome = await connectAgent(w.opts);
  expect(outcome.status).toBe("waiting_for_account");
  expect(w.elapsed()).toBe(100_000);
  expect(w.lines).toContain(
    "still waiting for writer.alice.testnet to be created (2m more, then this stops)",
  );
  expect(w.lines.at(-1)).toBe(
    `stopped waiting: ${ACCOUNT} does not exist yet. Run the same command again to go on.`,
  );
  expect(w.calls).not.toContain("register writer");

  // The account is there and the bond never comes: it stops at the bond.
  const bondless = world({ plans: [planOf()] });
  bondless.opts.waitMs = 10_000;
  expect((await connectAgent(bondless.opts)).status).toBe("waiting_for_bond");
  expect(bondless.lines).toContain(
    "waiting for the bond: 5.00 tUSDC into the agent's vault (it holds 0.00 tUSDC)…",
  );
  expect(bondless.calls).not.toContain("register writer");
});

test("the_bond_arriving_later_is_waited_for_and_then_the_agent_registers", async () => {
  const w = world({ plans: [planOf(), planOf(), planOf({ vault: 5_000_000n, shortfall: 0n })] });
  expect((await connectAgent(w.opts)).status).toBe("registered");
  expect(w.calls.filter((call) => call.startsWith("plan"))).toEqual([
    "plan 5000000",
    "plan 5000000",
    "plan 0",
  ]);
});

test("an_agent_that_registered_on_an_earlier_run_is_not_registered_twice", async () => {
  const active = planOf({
    agent: {
      status: "active",
      bond_token: "tusdc.testnet",
      bond_amount: "5000000",
    } as RegistrationPlan["agent"],
    takesBond: false,
    shortfall: 0n,
  });
  const w = world({
    lookup: lookupOf({ state: "registered", fingerprint: connectFingerprint(PUBLIC) }),
    plans: [active],
    existingKey: true,
  });
  expect((await connectAgent(w.opts)).status).toBe("registered");
  expect(w.calls).not.toContain("register writer");
  expect(w.lines).toContain(`registered: ${ACCOUNT} is an agent already`);
  expect(w.lines).toContain("key: using /keys/writer.json");
});

test("a_code_with_someone_elses_key_is_refused_before_a_key_is_made_or_anything_attached", async () => {
  const other = KeyPair.fromRandom("ed25519").getPublicKey().toString();
  const w = world({
    lookup: lookupOf({ state: "attached", fingerprint: connectFingerprint(other) }),
  });
  await expect(connectAgent(w.opts)).rejects.toThrow(
    /another key attached already.*Tell the owner NOT to press Create agent/,
  );
  // It was told it may not make a key, and attached nothing.
  expect(w.calls).toEqual([`lookup ${CODE}`, "chain testnet tender.testnet", "key writer false"]);

  // The key on this machine is not the one attached: refused as well.
  const mine = world({
    lookup: lookupOf({ state: "attached", fingerprint: connectFingerprint(other) }),
    existingKey: true,
  });
  await expect(connectAgent(mine.opts)).rejects.toBeInstanceOf(ConnectError);
  expect(mine.calls.some((call) => call.startsWith("attach"))).toBe(false);
});

test("each_refusal_of_the_api_is_told_in_words_of_ours", async () => {
  const refusing = (error: string, status: number) => {
    const w = world();
    w.opts.api.connectLookup = async () => {
      throw new ApiError(status, { error, message: "a server's own words, never shown" });
    };
    return connectAgent(w.opts);
  };
  await expect(refusing("not_found", 404)).rejects.toThrow(/knows no such connect code/);
  await expect(refusing("code_expired", 410)).rejects.toThrow(
    /has expired: ask the owner for a new code/,
  );
  await expect(refusing("rate_limited", 429)).rejects.toThrow(/try again in a minute/);
  await expect(refusing("rate_limited", 429)).rejects.not.toThrow(/a server's own words/);

  const expired = world({ lookup: lookupOf({ state: "expired" }) });
  await expect(connectAgent(expired.opts)).rejects.toThrow(/has expired/);
  expect(expired.calls).toEqual([`lookup ${CODE}`]);

  const malformed = world();
  malformed.opts.code = "tc_SHORT";
  await expect(connectAgent(malformed.opts)).rejects.toThrow(/that is not a connect code/);
  expect(malformed.calls).toEqual([]);
});

test("a_name_that_cannot_name_a_key_file_asks_for_one", async () => {
  const w = world({ lookup: lookupOf({ name: "2nd_writer", account_id: `2nd_writer.${OWNER}` }) });
  await expect(connectAgent(w.opts)).rejects.toThrow(/cannot name a key file.*pass --name/);
  const named = world({
    lookup: lookupOf({ name: "2nd_writer", account_id: `2nd_writer.${OWNER}` }),
  });
  named.opts.name = "second";
  expect((await connectAgent(named.opts)).status).toBe("registered");
  expect(named.calls).toContain("key second true");
});

test("an_account_made_another_way_is_refused", async () => {
  const w = world({ keyStates: ["other-keys"] });
  await expect(connectAgent(w.opts)).rejects.toThrow(/exists, and not with this agent's key/);
  expect(w.calls).not.toContain("register writer");
});

test("the_api_is_asked_again_until_its_index_shows_the_agent_and_a_late_index_fails_nothing", async () => {
  const notYet = async () => {
    throw new ApiError(409, { error: "not_registered" });
  };
  const w = world({ registered: [notYet, notYet, async () => ({})] });
  expect(await connectAgent(w.opts)).toMatchObject({ status: "registered", confirmed: true });
  expect(w.calls.filter((call) => call.startsWith("registered"))).toHaveLength(3);

  const never = world({ registered: [notYet] });
  never.opts.confirmMs = 5_000;
  expect(await connectAgent(never.opts)).toMatchObject({ status: "registered", confirmed: false });
  expect(never.lines.at(-1)).toMatch(/registered on the chain\. The API has not listed it yet/);

  const away = world({
    registered: [
      async () => {
        throw new TypeError("fetch failed");
      },
    ],
  });
  expect(await connectAgent(away.opts)).toMatchObject({ status: "registered", confirmed: false });
});
