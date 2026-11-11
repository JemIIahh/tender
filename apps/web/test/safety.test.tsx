import {
  type AgentDetailResponse,
  AgentDetailResponseSchema,
  type AgentSummary,
  type DelegateView,
  MODEL_AGENT_POLICY,
} from "@tender/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SafetySection } from "../components/SafetySection";
import {
  couldSpendAsDelegate,
  countKeys,
  DELEGATE_CHECKS,
  durationText,
  keysText,
  shortKey,
} from "../lib/safety";
import {
  type FakeChain,
  fullAccess,
  functionCall,
  RPC_ORIGIN,
  type RpcCalls,
  rpcAnswer,
} from "./fakeRpc";
import { agent, TOKEN } from "./tasks";

// An agent's Safety section (section 04 of its page): what the contract holds it to, the keys on its
// account and the delegate keys among them, and, for an agent the deployment names as one the team
// runs with a model, the team's runner's defaults. The API's part comes in the detail; the chain's
// part is read from a fake node (fakeRpc.ts).

const CONTRACT = "tender.testnet"; // NEXT_PUBLIC_CONTRACT in vitest.config.ts
const ANALYST = "analyst.tender-team.testnet";
const LEAD = "lead.tender-team.testnet";
const ALICE = "alice.testnet";
const RUNNER_KEY = "ed25519:8hSHprDq2StXwMtNd43wDTXQYsjXcD4MJTXQYsjXcD4M";
const OWNER_KEY = "ed25519:5F6aKb2oEB8kYyN3f5f7wTqZZQ5mBqBuJ7Yr5Kc6Xh8d";
const DELEGATE_KEY = "ed25519:4YDb73cBbuU92xWx2CKDhaArzPChE2bP5ck1V54nXvyF";
const OTHER_KEY = "ed25519:GF2UCksdEsabAzeQiQUy4sTZSBXFuNCeq7Yv7RC72oz9";
/** The bond terms in force: 1 tUSDC, and 14 days from leaving to claiming. */
const CONFIG = {
  agent_bond_token: TOKEN,
  agent_bond_amount: "1000000",
  agent_bond_cooldown_secs: String(14 * 86_400),
};

/** The policy the API sends for an agent the team runs with a model: the runner's own defaults. */
const POLICY = {
  verifiers: MODEL_AGENT_POLICY.verifiers,
  daily_entries: MODEL_AGENT_POLICY.dailyEntries,
  daily_judged_hires: MODEL_AGENT_POLICY.dailyJudgedHires,
  max_poster_voids: MODEL_AGENT_POLICY.maxPosterVoids,
} as const;

/** A delegate record of the lead's key, as `get_delegate` answers it. */
const CAPS: DelegateView = {
  token: TOKEN,
  per_task_cap: "2000000",
  total_cap: "6000000",
  spent: "4000000",
};

const bonded = (over: Partial<AgentSummary> = {}): AgentSummary =>
  agent({
    status: "active",
    bond_token: TOKEN,
    bond_amount: "1000000",
    claimable_at: null,
    ...over,
  });

const analyst = bonded({ account: ANALYST, name: "Tender Analyst", is_team: true });
const lead = bonded({ account: LEAD, name: "Tender Lead", is_team: true });
const alice = bonded({ account: ALICE, name: "Alice", asp: "provider.testnet", is_team: false });

function detail(
  who: AgentSummary,
  over: Partial<Omit<AgentDetailResponse, "agent">> = {},
): AgentDetailResponse {
  // What the page reads, through the shared schema, as the API client parses it. Only the analyst
  // is named as run with a model.
  return AgentDetailResponseSchema.parse({
    agent: who,
    recent_entries: [],
    runner_policy: who.account === ANALYST ? POLICY : null,
    ...over,
  });
}

/** A node that answers from `chain`, and what it was asked. */
function fakeNode(chain: FakeChain): RpcCalls {
  const calls: RpcCalls = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== RPC_ORIGIN) throw new Error(`unexpected request to ${url}`);
    return rpcAnswer(String(init?.body ?? ""), chain, calls);
  });
  return calls;
}

/** An account with a full-access key and a runner's key for commit and reveal only. */
const chainOf = (account: string, over: FakeChain = {}): FakeChain => ({
  keys: {
    [account]: [fullAccess(OWNER_KEY), functionCall(RUNNER_KEY, CONTRACT, ["commit", "reveal"])],
  },
  config: CONFIG,
  ...over,
});

/** The lead's account: the two keys above, and a key for hiring that the contract has caps for. */
const leadChain = (over: FakeChain = {}): FakeChain =>
  chainOf(LEAD, {
    keys: {
      [LEAD]: [
        fullAccess(OWNER_KEY),
        functionCall(RUNNER_KEY, CONTRACT, ["commit", "reveal"]),
        functionCall(DELEGATE_KEY, CONTRACT, ["post_task", "top_up_task", "commit", "reveal"]),
      ],
    },
    delegates: { [`${LEAD} ${DELEGATE_KEY}`]: CAPS },
    ...over,
  });

const line = (testId: string) => screen.getByTestId(testId);
const tag = (testId: string) => within(line(testId)).getByTestId("enforced-by").textContent;
const delegateCalls = (calls: RpcCalls) => calls.filter((call) => call.startsWith("get_delegate"));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("an_agent_the_team_runs_with_a_model_shows_its_bond_its_keys_and_the_runners_defaults", async () => {
  const calls = fakeNode(chainOf(ANALYST));
  render(<SafetySection detail={detail(analyst)} />);

  expect(screen.getByRole("heading", { level: 2, name: "Safety" })).toBeTruthy();
  // The contract's lines.
  expect(line("safety-vault").textContent).toContain("Spends only from its own vault");
  expect(line("safety-vault").textContent).toContain("Withdrawing needs a full-access key.");
  expect(tag("safety-vault")).toBe("Enforced by the contract");
  expect(within(line("safety-bond")).getByTestId("amount").textContent).toBe("1.00 tUSDC");
  expect(tag("safety-bond")).toBe("Enforced by the contract");
  // The cooldown comes from the chain's config, and is today's.
  await waitFor(() =>
    expect(line("safety-bond").textContent).toContain(
      "Held while it is active. Claimable at least 14 days after it leaves, at today’s cooldown.",
    ),
  );
  // No key of its own could spend as a delegate's: the runner's key calls commit and reveal only.
  await waitFor(() => expect(line("safety-delegates").textContent).toContain("None"));
  expect(line("safety-delegates").textContent).toContain(
    "Every spend from its vault needs a full-access key.",
  );
  // A hire through Tender is the contract's; an x402 purchase is not, and the line says so.
  expect(line("safety-hiring").textContent).toContain(
    "A hire through Tender pays at most its reward, held in escrow.",
  );
  expect(tag("safety-hiring")).toBe("Enforced by the contract");
  expect(line("safety-hiring").textContent).toContain(
    "x402 purchases are paid directly. The contract doesn\u2019t limit them.",
  );
  // Its services are not known here, so nothing is said of its own x402 APIs.
  expect(line("safety-hiring").textContent).not.toContain("It lists");
  expect(line("safety-keys").textContent).toContain("1 full-access key · 1 limited to Tender");
  expect(tag("safety-keys")).toBe("Enforced by NEAR");

  // The runner's lines: the values the API sent, which are the runner's own defaults.
  expect(line("safety-runner-defaults").textContent).toBe(
    "Defaults of the team’s runner for an agent with a model. Tender can’t see the flags it runs with.",
  );
  expect(line("safety-verifiers").textContent).toContain(
    "The Judge only, once it accepts the task",
  );
  expect(line("safety-verifiers").textContent).toContain(
    "Hires through Tender: the checker its service names.",
  );
  expect(line("safety-verifiers").textContent).not.toContain("x402");
  expect(within(line("safety-daily-entries")).getByText("Tasks and hirer-checked hires a day"));
  expect(line("safety-daily-entries").textContent).toContain("At most 20");
  expect(line("safety-daily-entries").textContent).toContain(
    "Judge-checked hires have their own cap.",
  );
  expect(line("safety-daily-hires").textContent).toContain("At most 50");
  expect(line("safety-poster-voids").textContent).toContain(
    "Skips one with more than 2 tasks voided after reveal (not the team\u2019s own)",
  );
  expect(line("safety-fails-closed").textContent).toContain("It takes nothing on");
  for (const id of [
    "safety-verifiers",
    "safety-daily-entries",
    "safety-daily-hires",
    "safety-poster-voids",
    "safety-fails-closed",
  ]) {
    expect(tag(id), id).toBe("Default of the team\u2019s runner");
  }
  expect(screen.queryByTestId("safety-runner-team")).toBeNull();
  expect(screen.queryByTestId("safety-runner-unknown")).toBeNull();

  // The keys and the bond terms; no key that could spend, so no `get_delegate`.
  expect(calls.map((call) => call.split(" ")[0]).sort()).toEqual([
    "get_config",
    "view_access_key_list",
  ]);
});

test("a_team_agent_not_named_as_run_with_a_model_shows_no_runner_lines", async () => {
  fakeNode(leadChain());
  render(<SafetySection detail={detail(lead)} />);

  expect(line("safety-runner-team").textContent).toBe(
    "The team runs it. Its runner’s settings aren’t shown here.",
  );
  for (const id of ["safety-runner-defaults", "safety-verifiers", "safety-daily-entries"]) {
    expect(screen.queryByTestId(id), id).toBeNull();
  }
  expect(screen.queryByText("Default of the team\u2019s runner")).toBeNull();
  // Its contract lines are all there, its delegate key among them.
  await waitFor(() => expect(screen.getByTestId("safety-delegate")).toBeTruthy());
  expect(line("safety-vault")).toBeTruthy();
});

test("an_agent_the_team_does_not_run_says_tender_cannot_see_its_runner", async () => {
  fakeNode(chainOf(ALICE));
  render(<SafetySection detail={detail(alice)} />);

  expect(line("safety-runner-unknown").textContent).toBe(
    "Its owner’s runner sets which tasks it takes. Tender can’t see those settings.",
  );
  expect(screen.queryByTestId("safety-runner-team")).toBeNull();
  expect(screen.queryByTestId("safety-verifiers")).toBeNull();
  // The basics are there all the same: the vault and the bond.
  expect(line("safety-vault")).toBeTruthy();
  expect(within(line("safety-bond")).getByTestId("amount").textContent).toBe("1.00 tUSDC");
  await waitFor(() => expect(line("safety-keys").textContent).toContain("1 full-access key"));
});

test("an_agent_that_is_leaving_shows_when_its_bond_can_be_claimed", async () => {
  // 2026-11-25 14:00 UTC, in nanoseconds.
  const at = BigInt(Date.UTC(2026, 10, 25, 14, 0)) * 1_000_000n;
  const calls = fakeNode(chainOf(ALICE));
  const { unmount } = render(
    <SafetySection
      detail={detail(bonded({ ...alice, status: "unregistering", claimable_at: at.toString() }))}
    />,
  );

  const bond = line("safety-bond");
  expect(within(bond).getByTestId("amount").textContent).toBe("1.00 tUSDC");
  expect(bond.textContent).toContain("Leaving. Claimable from");
  const time = bond.querySelector("time");
  expect(time?.getAttribute("dateTime")).toBe("2026-11-25T14:00:00.000Z");
  expect(time?.textContent).toBe(
    new Date("2026-11-25T14:00:00.000Z").toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }),
  );
  await waitFor(() => expect(line("safety-keys").textContent).toContain("full-access"));
  // An agent that is not active has its own claim date: the bond terms in force are not read.
  expect(calls.some((call) => call.startsWith("get_config"))).toBe(false);
  unmount();

  // One from before bonds that is leaving has nothing to claim: no date, and "None".
  render(
    <SafetySection
      detail={detail(
        bonded({
          ...alice,
          status: "unregistering",
          bond_token: null,
          bond_amount: null,
          claimable_at: at.toString(),
        }),
      )}
    />,
  );
  expect(line("safety-bond").textContent).toContain("None");
  expect(line("safety-bond").textContent).toContain("Leaving.");
  expect(line("safety-bond").textContent).not.toContain("Claimable");
});

test("a_retired_agent_and_one_from_before_bonds_and_an_api_from_before_bonds", async () => {
  fakeNode(chainOf(ALICE));
  const { unmount } = render(
    <SafetySection
      detail={detail(bonded({ ...alice, status: "retired", bond_token: null, bond_amount: null }))}
    />,
  );
  expect(line("safety-bond").textContent).toContain("None now");
  // An agent from before bonds retires with none to pay back, so no claim that one was paid.
  expect(line("safety-bond").textContent).toContain("Any bond it held went back to its vault.");
  unmount();

  // Active, and registered before the owner set a bond: it holds none, and with a bond in force it
  // enters only the tasks that invite it until it pays one.
  const { unmount: gone } = render(
    <SafetySection detail={detail(bonded({ ...alice, bond_token: null, bond_amount: null }))} />,
  );
  await waitFor(() =>
    expect(line("safety-bond").textContent).toContain(
      "Until it pays one, it enters only tasks that invite it.",
    ),
  );
  expect(line("safety-bond").textContent).toContain("None");
  gone();

  // An API from before bonds sends no status: the page does not know.
  render(<SafetySection detail={detail(agent({ account: ALICE, is_team: false }))} />);
  expect(within(line("safety-bond")).getByText("Not known")).toBeTruthy();
});

test("a_delegate_key_is_found_among_the_accounts_own_keys_with_its_caps_and_what_it_spent", async () => {
  const calls = fakeNode(leadChain());
  render(<SafetySection detail={detail(lead)} />);

  expect(line("safety-delegates").textContent).toContain("Reading the chain…");
  const key = await screen.findByTestId("safety-delegate");
  expect(
    within(key)
      .getAllByTestId("amount")
      .map((amount) => amount.textContent),
  ).toEqual(["2.00 tUSDC", "6.00 tUSDC", "4.00 tUSDC"]);
  expect(key.textContent).toContain("2.00 tUSDC a post or top-up, 6.00 tUSDC in all");
  expect(key.textContent).toContain("Spent 4.00 tUSDC");
  expect(within(key).getByTitle(DELEGATE_KEY).textContent).toBe("ed25519:4YDb…XvyF");
  expect(tag("safety-delegate")).toBe("Enforced by the contract");
  expect(screen.queryByTestId("safety-delegates")).toBeNull();
  expect(line("safety-keys").textContent).toContain("1 full-access key · 2 limited to Tender");
  // Only the key that could spend is asked about: not the full-access key, nor the runner's.
  expect(delegateCalls(calls)).toEqual([
    `get_delegate {"account_id":"${LEAD}","public_key":"${DELEGATE_KEY}"}`,
  ]);
});

test("a_key_that_could_spend_but_has_no_record_leaves_none", async () => {
  // The key allows every method of Tender, but the contract has no delegate record for it.
  const calls = fakeNode(
    chainOf(ALICE, {
      keys: { [ALICE]: [fullAccess(OWNER_KEY), functionCall(OTHER_KEY, CONTRACT, [])] },
    }),
  );
  render(<SafetySection detail={detail(alice)} />);
  await waitFor(() => expect(line("safety-delegates").textContent).toContain("None"));
  expect(screen.queryByTestId("safety-delegate")).toBeNull();
  expect(delegateCalls(calls)).toHaveLength(1);
});

test("at_most_ten_keys_are_asked_about_and_the_rest_are_counted", async () => {
  const many = Array.from({ length: DELEGATE_CHECKS + 3 }, (_, i) =>
    functionCall(`ed25519:key${String(i).padStart(2, "0")}`, CONTRACT, ["post_task"]),
  );
  const calls = fakeNode(chainOf(ALICE, { keys: { [ALICE]: [fullAccess(OWNER_KEY), ...many] } }));
  const { unmount } = render(<SafetySection detail={detail(alice)} />);
  await waitFor(() =>
    expect(line("safety-delegates").textContent).toContain("None among the 10 keys checked"),
  );
  expect(line("safety-delegates").textContent).toContain("And 3 more keys not checked.");
  expect(delegateCalls(calls)).toHaveLength(DELEGATE_CHECKS);
  unmount();

  // With a record among those checked, the count goes under the last key found.
  fakeNode(
    chainOf(ALICE, {
      keys: { [ALICE]: [fullAccess(OWNER_KEY), ...many] },
      delegates: { [`${ALICE} ed25519:key04`]: CAPS },
    }),
  );
  render(<SafetySection detail={detail(alice)} />);
  const key = await screen.findByTestId("safety-delegate");
  expect(key.textContent).toContain("And 3 more keys not checked.");
});

test("a_read_of_the_chain_that_fails_says_so_on_its_line_and_leaves_the_rest", async () => {
  // The keys cannot be read: neither can the delegate keys among them. The bond terms can.
  fakeNode(chainOf(ANALYST, { fail: new Set(["view_access_key_list"]) }));
  const first = render(<SafetySection detail={detail(analyst)} />);
  await waitFor(() =>
    expect(line("safety-keys").textContent).toContain("Can’t read it from the chain now."),
  );
  expect(line("safety-delegates").textContent).toContain("Can’t read it from the chain now.");
  expect(line("safety-bond").textContent).toContain("at least 14 days after it leaves");
  first.unmount();

  // A node that lacks the block it was asked at answers UNKNOWN_BLOCK: a failed read, not an
  // account with no keys, so neither line says "None" or "no such account".
  fakeNode(chainOf(ANALYST, { unknownBlock: true }));
  const second = render(<SafetySection detail={detail(analyst)} />);
  await waitFor(() =>
    expect(line("safety-keys").textContent).toContain("Can’t read it from the chain now."),
  );
  expect(line("safety-delegates").textContent).toContain("Can’t read it from the chain now.");
  expect(line("safety-delegates").textContent).not.toContain("None");
  second.unmount();

  // A delegate record that cannot be read: "None" would be unproven, so the line says so.
  fakeNode(leadChain({ fail: new Set(["get_delegate"]) }));
  render(<SafetySection detail={detail(lead)} />);
  await waitFor(() =>
    expect(line("safety-delegates").textContent).toContain("Can’t read it from the chain now."),
  );
  expect(line("safety-keys").textContent).toContain("2 limited to Tender");
});

test("an_agent_that_lists_x402_apis_says_they_are_paid_outside_the_contract_with_no_checker", async () => {
  fakeNode(chainOf(ANALYST));
  const { unmount } = render(<SafetySection detail={detail(analyst)} x402Apis={1} />);
  const hiring = line("safety-hiring").textContent;
  expect(hiring).toContain("A hire through Tender pays at most its reward, held in escrow.");
  expect(hiring).toContain(
    "x402 purchases are paid directly. The contract doesn\u2019t limit them. It lists an x402 API.",
  );
  // A call to an x402 API has no checker: the line never says the service names one for it.
  const checked = line("safety-verifiers").textContent;
  expect(checked).toContain(
    "Hires through Tender: the checker its service names. Its x402 API has no checker.",
  );
  unmount();

  // Two of them, and none: the counts in words, and nothing about x402 APIs it does not list.
  const { unmount: two } = render(<SafetySection detail={detail(analyst)} x402Apis={2} />);
  expect(line("safety-hiring").textContent).toContain("It lists 2 x402 APIs.");
  expect(line("safety-verifiers").textContent).toContain("Its x402 APIs have no checker.");
  two();
  render(<SafetySection detail={detail(analyst)} x402Apis={0} />);
  expect(line("safety-hiring").textContent).not.toContain("It lists");
  expect(line("safety-verifiers").textContent).not.toContain("x402");
  await waitFor(() => expect(line("safety-keys").textContent).toContain("full-access"));
});

test("an_api_from_before_the_runner_policy_shows_the_basics_and_no_runner_lines", async () => {
  fakeNode(chainOf(ANALYST));
  const old = AgentDetailResponseSchema.parse({ agent: analyst, recent_entries: [] });
  render(<SafetySection detail={old} />);
  expect(line("safety-runner-team")).toBeTruthy();
  expect(screen.queryByTestId("safety-verifiers")).toBeNull();
  expect(line("safety-vault")).toBeTruthy();
  await waitFor(() => expect(line("safety-keys").textContent).toContain("full-access"));
});

test("which_keys_could_spend_as_a_delegates_and_the_words_of_the_lines", () => {
  const full = { publicKey: "a", kind: "full_access" as const };
  const call = (receiver: string, methods: string[]) => ({
    publicKey: "b",
    kind: "function_call" as const,
    receiver,
    methods,
  });
  expect(couldSpendAsDelegate(full, CONTRACT)).toBe(false);
  expect(couldSpendAsDelegate(call(CONTRACT, []), CONTRACT)).toBe(true);
  expect(couldSpendAsDelegate(call(CONTRACT, ["post_task"]), CONTRACT)).toBe(true);
  expect(couldSpendAsDelegate(call(CONTRACT, ["commit", "top_up_task"]), CONTRACT)).toBe(true);
  expect(couldSpendAsDelegate(call(CONTRACT, ["commit", "reveal"]), CONTRACT)).toBe(false);
  expect(couldSpendAsDelegate(call("dex.testnet", ["post_task"]), CONTRACT)).toBe(false);

  const keys = [full, call(CONTRACT, []), call(CONTRACT, ["commit"]), call("dex.testnet", [])];
  expect(countKeys(keys, CONTRACT)).toEqual({ full: 1, tender: 2, other: 1 });
  expect(keysText(countKeys(keys, CONTRACT))).toBe(
    "1 full-access key · 2 limited to Tender · 1 for another contract",
  );
  expect(keysText({ full: 0, tender: 1, other: 2 })).toBe(
    "No full-access key · 1 limited to Tender · 2 for other contracts",
  );
  expect(keysText({ full: 2, tender: 0, other: 0 })).toBe("2 full-access keys");
  expect(durationText(14 * 86_400)).toBe("14 days");
  expect(durationText(86_400)).toBe("1 day");
  expect(durationText(3_600)).toBe("1 hour");
  expect(durationText(5_400)).toBe("90 minutes");
  expect(durationText(90)).toBe("90 seconds");
  expect(durationText(1)).toBe("1 second");
  expect(shortKey(DELEGATE_KEY)).toBe("ed25519:4YDb…XvyF");
  expect(shortKey("ed25519:short")).toBe("ed25519:short");
});
