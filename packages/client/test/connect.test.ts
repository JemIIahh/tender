import {
  ApiError,
  type ConnectLookup,
  connectFingerprint,
  implicitAccountOf,
} from "@tender/shared";
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
/** The implicit account of the agent's key: where the agent goes when the owner chooses it. */
const IMPLICIT = implicitAccountOf(PUBLIC) ?? "";

const lookupOf = (over: Partial<ConnectLookup> = {}): ConnectLookup => ({
  owner: OWNER,
  name: "writer",
  account_id: ACCOUNT,
  account_kind: "sub_account",
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
    /** What the lookups after the first answer, in order (the last one again and again). */
    later?: Array<ConnectLookup | Error>;
    keyStates?: ConnectKeyState[];
    plans?: RegistrationPlan[];
    attach?: () => Promise<ConnectLookup>;
    registered?: Array<() => Promise<unknown>>;
    existingKey?: boolean;
    /** The account's full-access keys; the agent's own alone unless a test says. */
    keys?: string[];
    /** The full-access keys, read after read (the last one again and again), over `keys`. */
    keyLists?: string[][];
  } = {},
) {
  const calls: string[] = [];
  /** The accounts the chain was asked about, and the accounts registered. */
  const asked: string[] = [];
  const registeredAs: string[] = [];
  const later = [...(options.later ?? [])];
  const keyLists = [...(options.keyLists ?? [])];
  let looked = false;
  /** The key attached, once it is: later lookups carry its fingerprint, as the API's do. */
  let attachedKey: string | null = null;
  /** Whether the fake key store holds the agent's key: made by the engine, or there before. */
  let held = options.existingKey ?? false;
  const lines: string[] = [];
  let clock = 1_000_000;
  const keyStates = [...(options.keyStates ?? ["has-key"])];
  const plans = [...(options.plans ?? [planOf({ vault: 5_000_000n, shortfall: 0n })])];
  const registered = [...(options.registered ?? [async () => ({})])];
  const api: ConnectApi = {
    async connectLookup(code) {
      calls.push(`lookup ${code}`);
      if (looked && later.length > 0) {
        const next = later.length > 1 ? later.shift() : later[0];
        if (next instanceof Error) throw next;
        if (next !== undefined) return next;
      }
      looked = true;
      const first = options.lookup ?? lookupOf();
      return attachedKey === null
        ? first
        : { ...first, state: "attached", fingerprint: connectFingerprint(attachedKey) };
    },
    async connectAttach(code, publicKey) {
      calls.push(`attach ${code} ${publicKey}`);
      attachedKey = publicKey;
      return (
        options.attach?.() ?? {
          ...(options.lookup ?? lookupOf()),
          state: "attached",
          fingerprint: connectFingerprint(publicKey),
        }
      );
    },
    async connectContest(code) {
      calls.push(`contest ${code}`);
      return lookupOf({ state: "contested" });
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
        keyState: async (account) => {
          asked.push(account);
          const state = keyStates.length > 1 ? keyStates.shift() : keyStates[0];
          calls.push(`keyState ${state}`);
          return state ?? "missing";
        },
        plan: async () => {
          const plan = plans.length > 1 ? plans.shift() : plans[0];
          calls.push(`plan ${plan?.shortfall}`);
          return plan ?? planOf();
        },
        fullAccessKeys: async () => {
          calls.push("keys");
          if (keyLists.length > 0)
            return (keyLists.length > 1 ? keyLists.shift() : keyLists[0]) ?? [];
          return options.keys ?? [PUBLIC];
        },
      };
    },
    key: async (_lookup, name, mayMake) => {
      calls.push(`key ${name} ${mayMake}`);
      if (!held && !mayMake) return null;
      const made = !held;
      held = true;
      return { publicKey: PUBLIC, path: `/keys/${name}.json`, made };
    },
    register: async (lookup, name) => {
      calls.push(`register ${name}`);
      registeredAs.push(lookup.account_id);
    },
  };
  return { calls, lines, opts, asked, registeredAs, elapsed: () => clock - 1_000_000 };
}

test("the_steps_run_in_order_and_each_says_one_plain_line", async () => {
  const w = world({ keyStates: ["missing", "missing", "has-key"] });
  const outcome = await connectAgent(w.opts);
  expect(outcome).toEqual({
    status: "registered",
    accountId: ACCOUNT,
    accountKind: "sub_account",
    name: "writer",
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
    "keys",
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
    "still waiting for alice.testnet to create the account (2m more, then this stops)",
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
  // It says where the owner finds Fund agent.
  expect(bondless.lines.at(-1)).toBe(
    "stopped waiting: the bond is not in the agent's vault yet. alice.testnet presses Fund agent " +
      "on the Add an agent page of the web app: in step 4 if the page that made the code is " +
      "still open, or else after typing writer in step 1 and pressing Finish this agent. Then " +
      "run the same command again.",
  );
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

test("a_code_with_someone_elses_key_is_contested_before_a_key_is_made_or_anything_attached", async () => {
  const other = KeyPair.fromRandom("ed25519").getPublicKey().toString();
  const w = world({
    lookup: lookupOf({ state: "attached", fingerprint: connectFingerprint(other) }),
  });
  await expect(connectAgent(w.opts)).rejects.toThrow(
    /another key attached already.*page now says two different keys tried it.*NOT to press Create agent/,
  );
  // It was told it may not make a key, attached nothing, and told the API (nothing secret).
  expect(w.calls).toEqual([
    `lookup ${CODE}`,
    "chain testnet tender.testnet",
    "key writer false",
    `contest ${CODE}`,
  ]);

  // The key on this machine is not the one attached: contested and refused as well.
  const mine = world({
    lookup: lookupOf({ state: "attached", fingerprint: connectFingerprint(other) }),
    existingKey: true,
  });
  await expect(connectAgent(mine.opts)).rejects.toBeInstanceOf(ConnectError);
  expect(mine.calls.some((call) => call.startsWith("attach"))).toBe(false);
  expect(mine.calls).toContain(`contest ${CODE}`);

  // A code the API already says is contested is refused before anything is made or attached.
  const contested = world({
    lookup: lookupOf({ state: "contested", fingerprint: connectFingerprint(other) }),
  });
  await expect(connectAgent(contested.opts)).rejects.toThrow(
    /two different keys tried this connect code/,
  );
  expect(contested.calls).toEqual([
    `lookup ${CODE}`,
    "chain testnet tender.testnet",
    "key writer false",
  ]);
});

test("a_contested_code_whose_first_key_was_this_agents_says_so_truthfully", async () => {
  // This agent attached first; another key tried the code after: still refused, in other words.
  const mine = world({
    lookup: lookupOf({ state: "contested", fingerprint: connectFingerprint(PUBLIC) }),
    existingKey: true,
  });
  await expect(connectAgent(mine.opts)).rejects.toThrow(
    "Another key tried this code after your agent's. To be safe, start over with a new code.",
  );
  expect(mine.calls.some((call) => call.startsWith("attach") || call.startsWith("register"))).toBe(
    false,
  );

  // Contested after this agent registered: it says so, and does not wait for a tick that never comes.
  const late = world({
    registered: [
      async () => {
        throw new ApiError(409, { error: "contested" });
      },
    ],
  });
  expect(await connectAgent(late.opts)).toMatchObject({ status: "registered", confirmed: false });
  expect(late.lines.at(-1)).toMatch(
    /registered on the chain with this agent's key\. Another key tried this code after your agent's/,
  );
  expect(late.calls.filter((call) => call.startsWith("registered"))).toHaveLength(1);
});

test("a_contest_the_api_did_not_take_is_said_truthfully", async () => {
  const other = KeyPair.fromRandom("ed25519").getPublicKey().toString();
  const w = world({
    lookup: lookupOf({ state: "attached", fingerprint: connectFingerprint(other) }),
  });
  w.opts.api.connectContest = async () => {
    throw new ApiError(429, { error: "rate_limited" });
  };
  const failure = connectAgent(w.opts);
  await expect(failure).rejects.toThrow(
    "Tell the owner NOT to press Create agent: someone else's key is on this code (this agent could not record it on the page).",
  );
  await expect(connectAgent(w.opts)).rejects.not.toThrow(/page now says/);
});

test("an_answer_whose_account_is_not_the_name_under_the_owner_is_not_acted_on", async () => {
  const w = world({ lookup: lookupOf({ account_id: "writer.mallory.testnet" }) });
  await expect(connectAgent(w.opts)).rejects.toThrow(/the API's answer does not add up/);
  expect(w.calls).toEqual([`lookup ${CODE}`]);
});

test("an_account_with_another_full_access_key_is_not_registered", async () => {
  const other = KeyPair.fromRandom("ed25519").getPublicKey().toString();
  const two = world({ keys: [PUBLIC, other] });
  await expect(connectAgent(two.opts)).rejects.toThrow(
    /has 2 full-access keys besides or instead of this agent's.*nothing was registered/,
  );
  expect(two.calls).not.toContain("register writer");
  const swapped = world({ keys: [other] });
  await expect(connectAgent(swapped.opts)).rejects.toThrow(/has another full-access key/);
  expect(swapped.calls).not.toContain("register writer");
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

// ---- The implicit account ---------------------------------------------------------------------

/** The API's answer once the owner chose the implicit account of the agent's key. */
const movedOf = (over: Partial<ConnectLookup> = {}) =>
  lookupOf({
    state: "attached",
    fingerprint: connectFingerprint(PUBLIC),
    account_kind: "implicit",
    account_id: IMPLICIT,
    ...over,
  });

test("the_owner_choosing_the_implicit_account_moves_the_wait_and_the_key_file_there", async () => {
  // The owner's wallet refuses the sub-account; 40 s in, the owner chooses the separate account,
  // and its NEAR arrives a little later.
  const attached = lookupOf({ state: "attached", fingerprint: connectFingerprint(PUBLIC) });
  const w = world({
    later: [attached, movedOf()],
    keyStates: [...Array<ConnectKeyState>(14).fill("missing"), "missing", "has-key"],
  });
  const outcome = await connectAgent(w.opts);
  expect(outcome).toMatchObject({
    status: "registered",
    accountId: IMPLICIT,
    accountKind: "implicit",
    confirmed: true,
  });
  // The API is asked at most every 20 s, never between; the chain is asked about the sub-account
  // until the move, and about the implicit account after it.
  expect(w.calls.filter((call) => call.startsWith("lookup"))).toHaveLength(3);
  expect(w.asked.slice(0, 7).every((account) => account === ACCOUNT)).toBe(true);
  expect(w.asked.at(-1)).toBe(IMPLICIT);
  expect(new Set(w.asked)).toEqual(new Set([ACCOUNT, IMPLICIT]));
  // The key file is asked for again, for the implicit account, and nothing is made.
  expect(w.calls.filter((call) => call.startsWith("key "))).toEqual([
    "key writer true",
    "key writer false",
  ]);
  expect(w.registeredAs).toEqual([IMPLICIT]);
  expect(w.lines).toContain(
    `${OWNER} chose a separate account for this agent: ${IMPLICIT}, the implicit account of its ` +
      `key. It is its own account, so Tender's directory won't list it under ${OWNER} as its provider.`,
  );
  expect(w.lines).toContain(`registered: ${IMPLICIT} is an agent`);
});

test("a_run_after_the_move_goes_on_at_the_implicit_account_and_stops_with_the_right_words", async () => {
  const w = world({ lookup: movedOf(), later: [movedOf()], existingKey: true, plans: [planOf()] });
  w.opts.waitMs = 10_000;
  const outcome = await connectAgent(w.opts);
  expect(outcome).toMatchObject({ status: "waiting_for_bond", accountId: IMPLICIT });
  expect(w.asked).toEqual([IMPLICIT]);
  expect(w.lines[0]).toBe(`connect code for ${IMPLICIT}, made by ${OWNER}, on testnet`);
  expect(w.lines).toContain(`waiting for ${OWNER} to send ${IMPLICIT} its NEAR…`);
  // Finish this agent works by name, which an implicit account has not.
  expect(w.lines.at(-1)).toBe(
    "stopped waiting: the bond is not in the agent's vault yet. alice.testnet presses Fund agent " +
      "in step 4 of the Add an agent page of the web app, in the browser tab that made the code. " +
      "Then run the same command again.",
  );
});

test("an_implicit_account_that_is_not_this_keys_is_not_acted_on", async () => {
  const other = implicitAccountOf(KeyPair.fromRandom("ed25519").getPublicKey().toString()) ?? "";
  // From the first look (a run after the move)...
  const first = world({ lookup: movedOf({ account_id: other }), existingKey: true });
  await expect(connectAgent(first.opts)).rejects.toThrow(/the API's answer does not add up/);
  expect(first.calls).not.toContain(`attach ${CODE} ${PUBLIC}`);
  // ... and while it waits: it stops, and registers nothing.
  const later = world({ later: [movedOf({ account_id: other })], keyStates: ["missing"] });
  await expect(connectAgent(later.opts)).rejects.toThrow(/the API's answer does not add up/);
  expect(later.calls).not.toContain("register writer");
  // An answer whose key changed is not acted on either.
  const swapped = world({
    later: [lookupOf({ state: "attached", fingerprint: "0000-0000-0000-0000" })],
    keyStates: ["missing"],
  });
  await expect(connectAgent(swapped.opts)).rejects.toThrow(/does not add up/);
});

test("a_code_contested_while_the_agent_waits_stops_it", async () => {
  const w = world({ later: [movedOf({ state: "contested" })], keyStates: ["missing"] });
  await expect(connectAgent(w.opts)).rejects.toThrow(/two different keys tried this connect code/);
  expect(w.calls).not.toContain("register writer");
});

test("an_api_that_cant_be_reached_while_the_agent_waits_does_not_stop_it", async () => {
  const w = world({
    later: [new TypeError("fetch failed"), new ApiError(429, { error: "rate_limited" })],
    keyStates: [...Array<ConnectKeyState>(20).fill("missing"), "has-key"],
  });
  expect(await connectAgent(w.opts)).toMatchObject({
    status: "registered",
    accountId: ACCOUNT,
    accountKind: "sub_account",
  });
  expect(w.calls.filter((call) => call.startsWith("lookup")).length).toBeGreaterThan(2);
});

test("an_account_whose_setup_key_is_on_its_way_is_waited_for", async () => {
  // The setup code adds the key in a receipt of its own: for a block the account has no key.
  const w = world({
    keyStates: ["other-keys", "has-key"],
    keyLists: [[], [PUBLIC]],
  });
  expect((await connectAgent(w.opts)).status).toBe("registered");
  expect(w.calls).toContain("register writer");
});
