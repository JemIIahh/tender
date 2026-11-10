import { sha256Hex, type TaskDetailResponse } from "@tender/shared";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TaskActions } from "../components/actions/TaskActions";
import { keepToken, signInTicket } from "../lib/apiToken";
import { clearApiToken } from "../lib/auth";
import { createWalletStore, type WalletStore } from "../lib/wallet";
import { FakeChain, FakeNode, fakeFetch } from "./fakeChain";
import { AT, detail, entry, POSTER, SECOND, TOKEN } from "./tasks";
import { type ChainWallet, chainWallet, fakeProvider } from "./walletDoubles";

// The actions of a task's page (`#pick`, `#refund`, `#top-up`) as each person sees them, by role
// and phase, over a wallet double, a fake API for the deliveries and a model of the chain for the
// vault.

const holder = vi.hoisted(() => ({ store: undefined as unknown as WalletStore }));
vi.mock("../lib/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wallet")>();
  return {
    ...actual,
    useWallet: (options?: { start?: boolean }) => actual.useWalletStore(holder.store, options),
  };
});

const JUDGE = "judge.tender-team.testnet";
const PERSON = "person.testnet";
const ALICE = "alice.testnet";
const BOB = "bob.testnet";
const WORK = { [ALICE]: "alice's answer\n<b>not bold</b>", [BOB]: "bob's answer" };
const hashOf = (account: keyof typeof WORK) => sha256Hex(WORK[account]);

/** A task in judging with two revealed entries, verified by `verifier`. */
function judged(verifier: string, task: Partial<TaskDetailResponse["task"]> = {}) {
  return detail(
    { verifier, reveal_count: 2, max_winners: 2, ...task },
    {
      entries: [
        entry(ALICE, {
          committed_height: "100",
          content_hash: hashOf(ALICE),
          uri: `http://api.test/v1/blobs/${hashOf(ALICE)}`,
          revealed: true,
          revealed_at: "1793307299820229000",
        }),
        entry(BOB, {
          entry_index: 1,
          committed_height: "101",
          content_hash: hashOf(BOB),
          uri: `http://api.test/v1/blobs/${hashOf(BOB)}`,
          revealed: true,
        }),
      ],
    },
  );
}

/**
 * The page's world: the deliveries at the API, the chain's views at the node, and a wallet. With
 * `task`, the API also answers for task 7 and stores a scorecard, as a pick asks it to.
 */
function setup(account: string | null, options: { task?: TaskDetailResponse } = {}) {
  const chain = new FakeChain("tender.testnet", [{ token: TOKEN, minReward: 1_000_000n }]);
  const node = new FakeNode(chain);
  const rpc = fakeFetch("http://rpc.test", node);
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === "api.test" && options.task !== undefined) {
      if (url.pathname === "/v1/tasks/7") return new Response(JSON.stringify(options.task));
      if (url.pathname === "/v1/blobs" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { content_base64: string };
        const bytes = Uint8Array.from(atob(body.content_base64), (c) => c.charCodeAt(0));
        const hash = sha256Hex(bytes);
        return new Response(
          JSON.stringify({ sha256: hash, uri: `http://api.test/v1/blobs/${hash}` }),
        );
      }
    }
    if (url.host === "api.test") {
      const found = Object.entries(WORK).find(([, text]) => url.pathname.endsWith(sha256Hex(text)));
      return found === undefined
        ? new Response(JSON.stringify({ error: "not_found", message: "no such blob" }), {
            status: 404,
          })
        : new Response(found[1], { status: 200 });
    }
    return rpc(input, init);
  });
  const wallet: ChainWallet = chainWallet(chain, account ?? PERSON);
  const provider = fakeProvider(
    { wallet, accountId: account ?? PERSON },
    { restored: account !== null },
  );
  holder.store = createWalletStore(async () => provider);
  return { chain, wallet, provider };
}

/**
 * The actions of `data` at `nowNs`, with the wallet looked for (the tab signed in before), once the
 * code of the panels shown is in (each comes in a chunk of its own, components/actions/TaskActions).
 */
async function show(data: TaskDetailResponse, nowNs: bigint, judgeAccount: string | null = JUDGE) {
  const view = render(<TaskActions data={data} nowNs={nowNs} judgeAccount={judgeAccount} />);
  await act(() => holder.store.start());
  await waitFor(() => expect(screen.queryByTestId("action-loading")).toBeNull());
  return view;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearApiToken();
  sessionStorage.clear();
  window.location.hash = "";
});

const IN_JUDGING = AT.reveal + 30n * SECOND;
const IN_FALLBACK = AT.pick + 30n * SECOND;

test("the_verifier_sees_each_revealed_entry_with_its_delivery_as_text", async () => {
  setup(PERSON);
  await show(judged(PERSON), IN_JUDGING);

  const pick = screen.getByTestId("action-pick");
  expect(within(pick).getByRole("heading", { level: 2 }).textContent).toBe("Pick the winners");
  const rows = within(pick).getAllByTestId("pick-entry");
  expect(rows.map((row) => within(row).getByRole("checkbox").getAttribute("aria-label"))).toEqual([
    `Winner: ${ALICE}`,
    `Winner: ${BOB}`,
  ]);
  // The delivery is read through the API, hashed again, and shown as text, markup and all.
  const delivery = await within(rows[0] as HTMLElement).findByTestId("delivery");
  expect(delivery.textContent).toBe(WORK[ALICE]);
  expect(delivery.querySelector("b")).toBeNull();
  // Each field is named by its visible label and described by whose entry it is.
  expect(
    within(rows[0] as HTMLElement).getByRole("textbox", {
      name: "Reason (optional, public)",
      description: ALICE,
    }),
  ).toBeTruthy();
  // When each revealed, where the API says, and the block it committed at.
  expect(within(rows[0] as HTMLElement).getByTestId("pick-entry-when").textContent).toBe(
    "Revealed 29 Oct, 20:54:59 UTC · committed at block 100",
  );
  expect(within(rows[1] as HTMLElement).getByTestId("pick-entry-when").textContent).toBe(
    "Committed at block 101",
  );
});

test("one_winner_gets_all_of_it_after_the_fee_with_the_exact_amount", async () => {
  setup(PERSON);
  await show(judged(PERSON), IN_JUDGING);
  const user = userEvent.setup();
  const pick = screen.getByTestId("action-pick");

  // Nothing chosen: the button says what is missing and does nothing.
  expect(within(pick).getByTestId("pick-problem").textContent).toBe("Choose a winner.");
  const button = within(pick).getByRole("button", { name: "Pick the winner" });
  expect(button.getAttribute("aria-disabled")).toBe("true");

  await user.click(within(pick).getByRole("checkbox", { name: `Winner: ${ALICE}` }));
  // 1.50 tUSDC at 5%: 0.075 to the fee and 1.425 to alice, with no share field for one winner.
  const payouts = within(pick).getAllByTestId("pick-payout");
  expect(payouts).toHaveLength(1);
  expect(payouts[0]?.textContent).toBe(`${ALICE}100%1.425 tUSDC`);
  expect(pick.textContent).toContain("platform fee 5%, 0.075 tUSDC");
  expect(within(pick).queryByRole("textbox", { name: "Share (%)" })).toBeNull();
  expect(button.getAttribute("aria-disabled")).toBe("false");
});

test("several_winners_split_equally_with_labelled_shares_that_must_make_100_percent", async () => {
  setup(PERSON);
  await show(judged(PERSON), IN_JUDGING);
  const user = userEvent.setup();
  const pick = screen.getByTestId("action-pick");

  await user.click(within(pick).getByRole("checkbox", { name: `Winner: ${ALICE}` }));
  await user.click(within(pick).getByRole("checkbox", { name: `Winner: ${BOB}` }));
  const alice = within(pick).getByRole("textbox", { name: "Share (%)", description: ALICE });
  const bob = within(pick).getByRole("textbox", { name: "Share (%)", description: BOB });
  expect((alice as HTMLInputElement).value).toBe("50");
  expect((bob as HTMLInputElement).value).toBe("50");
  expect(
    within(pick)
      .getAllByTestId("pick-payout")
      .map((row) => row.textContent),
  ).toEqual([`${ALICE}50%0.7125 tUSDC`, `${BOB}50%0.7125 tUSDC`]);
  expect(within(pick).getByRole("button", { name: "Pick 2 winners" })).toBeTruthy();

  // Shares that do not add up are said, and nothing can be sent.
  await user.clear(alice);
  await user.type(alice, "60");
  await user.clear(bob);
  await user.type(bob, "30");
  expect(within(pick).getByTestId("pick-problem").textContent).toBe(
    "The shares add up to 90%: 10% is left to give.",
  );
  expect(
    within(pick).getByRole("button", { name: "Pick 2 winners" }).getAttribute("aria-disabled"),
  ).toBe("true");
  // A share that is no share is marked on its field and announced.
  await user.clear(bob);
  await user.type(bob, "33.333");
  expect(bob.getAttribute("aria-invalid")).toBe("true");
  expect(within(pick).getByRole("alert").textContent).toBe("Use at most two decimal places.");

  await user.click(within(pick).getByRole("button", { name: "Split equally" }));
  expect((bob as HTMLInputElement).value).toBe("50");
  expect(within(pick).queryByTestId("pick-problem")).toBeNull();
});

test("picking_nobody_asks_first_and_says_the_agents_are_not_paid", async () => {
  setup(PERSON);
  await show(judged(PERSON), IN_JUDGING);
  const user = userEvent.setup();
  const pick = screen.getByTestId("action-pick");

  await user.click(within(pick).getByRole("button", { name: "Pick nobody" }));
  const confirm = within(pick).getByTestId("pick-nobody-confirm");
  expect(document.activeElement).toBe(confirm);
  expect(confirm.textContent).toContain("Pick nobody? The agents are not paid.");
  expect(confirm.textContent).toContain("The whole reward, 1.50 tUSDC, goes back to the funders");
  expect(confirm.textContent).toContain(`${POSTER}gets back 1.50 tUSDC`);
  await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
  expect(within(pick).queryByTestId("pick-nobody-confirm")).toBeNull();
});

test("a_send_stays_on_its_own_button_whichever_is_pressed_while_the_other_waits", async () => {
  const data = judged(PERSON);
  setup(PERSON, { task: data });
  await show(data, IN_JUDGING);
  keepToken({ accountId: PERSON, token: "tok", expiresAtMs: Date.now() + 60_000 }, signInTicket());
  const user = userEvent.setup();
  const pick = screen.getByTestId("action-pick");
  await user.click(within(pick).getByRole("checkbox", { name: `Winner: ${ALICE}` }));

  // The question about picking nobody is open, and Pick is pressed: the question closes, and the
  // pick's stage is on the Pick button.
  await user.click(within(pick).getByRole("button", { name: "Pick nobody" }));
  expect(within(pick).getByTestId("pick-nobody-confirm")).toBeTruthy();
  await user.click(within(pick).getByRole("button", { name: "Pick the winner" }));
  expect(within(pick).queryByTestId("pick-nobody-confirm")).toBeNull();
  await within(pick).findByRole("alert");

  // Now the other way: "Yes, pick nobody" is sent, and a press of Pick while it runs leaves the
  // question open and its stage on its own button.
  await user.click(within(pick).getByRole("button", { name: "Pick nobody" }));
  const confirm = within(pick).getByTestId("pick-nobody-confirm");
  act(() => {
    within(confirm).getByRole("button", { name: "Yes, pick nobody" }).click();
    within(pick).getAllByRole("button")[0]?.click();
  });
  expect(within(pick).getByTestId("pick-nobody-confirm")).toBe(confirm);
  expect(within(confirm).getAllByRole("button")[0]?.textContent).toMatch(/…$/);
  await waitFor(() =>
    expect(within(pick).getByRole("alert").textContent).toMatch(/^Tender refused the pick/),
  );
});

test("the_poster_picks_in_the_fallback_window_even_when_the_judge_was_the_verifier", async () => {
  setup(POSTER);
  await show(judged(JUDGE), IN_FALLBACK);
  const pick = screen.getByTestId("action-pick");
  expect(pick.textContent).toContain("The checker didn't pick in time, so you, the poster, can.");
  expect(within(pick).getAllByTestId("pick-entry")).toHaveLength(2);
});

test("the_judges_window_shows_its_state_and_no_controls", async () => {
  setup(POSTER);
  await show(judged(JUDGE, { judge_status: "accepted" }), IN_JUDGING);
  const pick = screen.getByTestId("action-pick");
  expect(within(pick).getByTestId("pick-judge").textContent).toContain(
    "The Judge picks this task.",
  );
  expect(within(pick).getByTestId("judge-note").textContent).toBe("Judge: accepted");
  expect(within(pick).queryByRole("button")).toBeNull();
  expect(within(pick).queryByRole("checkbox")).toBeNull();
});

test("someone_else_sees_no_pick_but_the_refund_still_to_come", async () => {
  setup("stranger.testnet");
  await show(judged(PERSON), IN_JUDGING);
  expect(screen.queryByTestId("action-pick")).toBeNull();
  // It opens at the fallback deadline if nobody picks: 19m 30s from 30 s into the pick window.
  expect(screen.getByTestId("refund-opens").textContent).toBe(
    "Opens in about 19m 30s, at the fallback deadline, if nobody has picked by then.",
  );
});

test("a_reader_is_offered_to_connect_once_the_tab_knows_and_the_actions_look_for_no_wallet", async () => {
  const { provider } = setup(null);
  const restore = vi.spyOn(provider, "restore");
  render(<TaskActions data={judged(PERSON)} nowNs={IN_JUDGING} judgeAccount={JUDGE} />);
  const pick = screen.getByTestId("action-pick");
  // The actions look for no wallet themselves (this tab never signed in). Until the tab's store
  // knows, they offer no Connect, which would flash for someone about to be taken up again.
  await act(async () => {});
  expect(restore).not.toHaveBeenCalled();
  expect(within(pick).queryByRole("button", { name: "Connect wallet" })).toBeNull();
  expect(within(pick).getByRole("status").textContent).toBe("Checking for your wallet…");

  // The app shell starts the store; it finds no wallet: the way in, and no status.
  await act(() => holder.store.start());
  expect(pick.textContent).toContain(`Picking is open for ${PERSON}.`);
  expect(within(pick).getByRole("button", { name: "Connect wallet" })).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
});

test("refund_says_when_it_opens_then_offers_the_one_button", async () => {
  const { wallet } = setup(PERSON);
  const empty = judged(PERSON, { reveal_count: 0 });
  empty.entries = [entry(ALICE)];
  // Revealing, nothing revealed yet: it opens at the reveal deadline if that stays so.
  const before = await show(empty, AT.reveal - 90n * SECOND);
  const refund = screen.getByTestId("action-refund");
  expect(within(refund).getByTestId("refund-opens").textContent).toBe(
    "Opens in about 1m 30s, at the reveal deadline, if nobody has revealed an entry by then.",
  );
  const button = within(refund).getByRole("button", { name: "Refund the funders" });
  expect(button.getAttribute("aria-disabled")).toBe("true");
  // Until it opens, nothing more: who gets what back is in the Funders section below.
  expect(within(refund).queryByTestId("refund-funder")).toBeNull();
  expect(within(refund).queryByTestId("keeper-note")).toBeNull();
  before.unmount();

  // From the reveal deadline anyone may refund, and the page says who gets what.
  await show(empty, AT.reveal);
  const open = screen.getByTestId("action-refund");
  expect(within(open).getByTestId("refund-open").textContent).toBe(
    "Nobody revealed an entry, so anyone can send the reward back to its funders now.",
  );
  expect(within(open).getAllByTestId("refund-funder")[0]?.textContent).toBe(`${POSTER}1.50 tUSDC`);
  // The team's keeper sends the same refund on its own; the button is the manual way.
  expect(within(open).getByTestId("keeper-note").textContent).toMatch(
    /^Tender's keeper, a service the Tender team runs, sends this refund on its own/,
  );
  const live = within(open).getByRole("button", { name: "Refund the funders" });
  expect(live.getAttribute("aria-disabled")).toBe("false");
  await userEvent.setup().click(live);
  // The model has no such task, so the contract refuses it in words, and nothing changed.
  expect((await within(open).findByRole("alert")).textContent).toBe("Tender has no such task.");
  expect(wallet?.sent[0]?.transactions[0]?.actions[0]?.params.methodName).toBe("void_task");
});

test("top_up_shows_the_vault_and_holds_a_first_top_up_to_the_minimum", async () => {
  const { chain } = setup(PERSON);
  chain.storage.set(PERSON, { total: 10n ** 22n, usedBytes: 0n });
  chain.vault.set(PERSON, new Map([[TOKEN, 3_000_000n]]));
  chain.addTask({
    id: 7n,
    poster: POSTER,
    token: TOKEN,
    reward: 1_500_000n,
    feeBps: 500,
    briefUri: "http://api.test/v1/blobs/brief",
    briefHash: "a".repeat(64),
    criteriaHash: "b".repeat(64),
    heldoutCommitment: null,
    verifier: JUDGE,
    createdAt: AT.created,
    commitDeadline: AT.commit,
    revealDeadline: AT.reveal,
    pickDeadline: AT.pick,
    fallbackDeadline: AT.fallback,
    maxEntries: 0,
    maxWinners: 1,
    invited: [],
  });
  chain.now = () => AT.created + 30n * SECOND;
  await show(detail(), AT.created + 30n * SECOND);
  const user = userEvent.setup();

  const topUp = screen.getByTestId("action-top-up");
  await waitFor(() =>
    expect(within(topUp).getByTestId("top-up-vault").textContent).toBe(
      "Your vault: 3.00 tUSDC. Deposit on the Wallet page. A first top-up of a task is at least 1.00 tUSDC.",
    ),
  );
  expect(within(topUp).getByRole("link", { name: "Deposit on the Wallet page" })).toHaveProperty(
    "pathname",
    "/wallet",
  );
  const field = within(topUp).getByLabelText("Amount (tUSDC)");
  await user.type(field, "0.5");
  await user.click(within(topUp).getByRole("button", { name: "Top up" }));
  expect(within(topUp).getByRole("alert").textContent).toBe(
    "Your first top-up of a task must be at least 1.00 tUSDC.",
  );
  expect(field.getAttribute("aria-invalid")).toBe("true");

  await user.clear(field);
  await user.type(field, "2");
  await user.click(within(topUp).getByRole("button", { name: "Top up" }));
  expect((await within(topUp).findByTestId("top-up-sent")).textContent).toBe(
    "Added 2.00 tUSDC. The reward is now 3.50 tUSDC.",
  );
  expect(chain.vault.get(PERSON)?.get(TOKEN)).toBe(1_000_000n);
});

// ---- A second press ----------------------------------------------------------------------------

/** Task 7 of the fixtures on the model of the chain, open for top-ups. */
function addTaskSeven(chain: FakeChain): void {
  chain.addTask({
    id: 7n,
    poster: POSTER,
    token: TOKEN,
    reward: 1_500_000n,
    feeBps: 500,
    briefUri: "http://api.test/v1/blobs/brief",
    briefHash: "a".repeat(64),
    criteriaHash: "b".repeat(64),
    heldoutCommitment: null,
    verifier: JUDGE,
    createdAt: AT.created,
    commitDeadline: AT.commit,
    revealDeadline: AT.reveal,
    pickDeadline: AT.pick,
    fallbackDeadline: AT.fallback,
    maxEntries: 0,
    maxWinners: 1,
    invited: [],
  });
}

/** Presses `button` twice before the page can draw the first press. */
function pressTwice(button: HTMLElement): void {
  act(() => {
    button.click();
    button.click();
  });
}

test("a_pick_pressed_twice_at_once_is_sent_once", async () => {
  const data = judged(PERSON);
  const { wallet } = setup(PERSON, { task: data });
  await show(data, IN_JUDGING);
  keepToken({ accountId: PERSON, token: "tok", expiresAtMs: Date.now() + 60_000 }, signInTicket());
  const pick = screen.getByTestId("action-pick");
  await userEvent.setup().click(within(pick).getByRole("checkbox", { name: `Winner: ${ALICE}` }));

  pressTwice(within(pick).getByRole("button", { name: "Pick the winner" }));

  // The model of the chain has no `pick`: the one send is refused, and there was one.
  expect((await within(pick).findByRole("alert")).textContent).toMatch(
    /^Tender refused the pick \(E_ARGS\)\. The scorecard is published; this pick paid nobody\.$/,
  );
  expect(wallet.sent).toHaveLength(1);
});

test("a_refund_pressed_twice_at_once_is_sent_once", async () => {
  const { wallet } = setup(PERSON);
  const empty = judged(PERSON, { reveal_count: 0 });
  empty.entries = [entry(ALICE)];
  await show(empty, AT.reveal);
  const refund = screen.getByTestId("action-refund");

  pressTwice(within(refund).getByRole("button", { name: "Refund the funders" }));

  expect((await within(refund).findByRole("alert")).textContent).toBe("Tender has no such task.");
  expect(wallet.sent).toHaveLength(1);
});

test("a_top_up_pressed_twice_at_once_is_sent_once", async () => {
  const { chain, wallet } = setup(PERSON);
  chain.storage.set(PERSON, { total: 10n ** 22n, usedBytes: 0n });
  chain.vault.set(PERSON, new Map([[TOKEN, 5_000_000n]]));
  addTaskSeven(chain);
  chain.now = () => AT.created + 30n * SECOND;
  await show(detail(), AT.created + 30n * SECOND);
  const topUp = screen.getByTestId("action-top-up");
  await waitFor(() =>
    expect(within(topUp).getByTestId("top-up-vault").textContent).toMatch(/^Your vault/),
  );
  await userEvent.setup().type(within(topUp).getByLabelText("Amount (tUSDC)"), "2");

  pressTwice(within(topUp).getByRole("button", { name: "Top up" }));

  expect((await within(topUp).findByTestId("top-up-sent")).textContent).toBe(
    "Added 2.00 tUSDC. The reward is now 3.50 tUSDC.",
  );
  expect(wallet.sent).toHaveLength(1);
  expect(chain.vault.get(PERSON)?.get(TOKEN)).toBe(3_000_000n);
});

test("nothing_shows_once_the_task_is_settled", async () => {
  setup(PERSON);
  const settled = judged(PERSON, { outcome_kind: "voided", phase: "settled" });
  const { container } = await show(settled, IN_JUDGING);
  expect(container.textContent).toBe("");
});
