import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { sha256Hex, type TaskDetailResponse } from "@tender/shared";
import { FakeChain, type FakeTask } from "../test/fakeChain";
import { AT, agent, detail, entry, POSTER, SECOND, TOKEN } from "../test/tasks";
import { API_URL, routeApi } from "./fixtures";
import { installInjectedWallet } from "./injectedWallet";
import { pickStubWallet } from "./walletStub";

// The actions of the task page (`#pick`, `#refund`, `#top-up`) against the fixture API, a wallet in
// the page through the real wallet picker, and the model of the chain (test/fakeChain.ts). Each
// spec opens the page at the action's address, as My tasks links to it, and looks at what the
// person sees; the refund and the top-up are sent, and the model shows what they did. A pick is
// sent against a real chain, in e2e/chain/task-actions.chain.ts.
//
// With ACTION_SHOTS set to a directory, each state is also saved there as a screenshot at 375 and
// 1440 px wide.

const CONTRACT = "tender.tender-team.testnet";
const PERSON = "person.testnet";
const ALICE = "alice.testnet";
const BOB = "bob.testnet";
const JUDGE = "judge.tender-team.testnet";
const WORK: Record<string, string> = {
  [ALICE]: '{"pattern":"^(?:[a-z0-9]+[-_])*[a-z0-9]+(?:\\\\.[a-z0-9]+)*$","flags":""}\n',
  [BOB]: "Here is my answer.\n\nPattern: ^[a-z0-9._-]{2,64}$\nIt accepts every id in the brief.",
};
const hashOf = (account: string) => sha256Hex(WORK[account] ?? "");

/** The time `ns` nanoseconds after the epoch, as Playwright's clock takes one. */
const at = (ns: bigint) => new Date(Number(ns / 1_000_000n));

const SHOTS = process.env.ACTION_SHOTS;

/** Saves the actions of the page as `name`, at a phone's width and a desktop's. */
async function shoot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined || SHOTS === "") return;
  mkdirSync(SHOTS, { recursive: true });
  // The sticky header and the dev server's badge would sit over the section in the picture.
  await page.addStyleTag({
    content: "header.sticky { position: static !important } nextjs-portal { display: none }",
  });
  const actions = page.getByTestId("task-actions");
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await actions.scrollIntoViewIfNeeded();
    await actions.screenshot({ path: join(SHOTS, `${width}-${name}.png`), animations: "disabled" });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** A task of the fixtures in the model of the chain, as the API lists it. */
function chainTask(data: TaskDetailResponse, extra: Partial<FakeTask> = {}): FakeTask {
  const { task } = data;
  return {
    id: BigInt(task.id),
    poster: task.poster,
    token: task.token,
    reward: BigInt(task.reward),
    feeBps: task.fee_bps,
    briefUri: task.brief_uri,
    briefHash: task.brief_hash,
    criteriaHash: task.criteria_hash,
    heldoutCommitment: task.heldout_commitment,
    verifier: task.verifier,
    createdAt: BigInt(task.created_at),
    commitDeadline: BigInt(task.commit_deadline),
    revealDeadline: BigInt(task.reveal_deadline),
    pickDeadline: BigInt(task.pick_deadline),
    fallbackDeadline: BigInt(task.fallback_deadline),
    maxEntries: task.max_entries,
    maxWinners: task.max_winners,
    invited: task.invited,
    commitCount: task.commit_count,
    revealCount: task.reveal_count,
    ...extra,
  };
}

/** A task with alice and bob revealed, verified by `verifier`, paying up to `maxWinners`. */
function judged(verifier: string, maxWinners: number, task = {}): TaskDetailResponse {
  const revealedBy = (account: string, index: number, height: string, revealedAt: string) =>
    entry(account, {
      entry_index: index,
      committed_height: height,
      content_hash: hashOf(account),
      uri: `${API_URL}/v1/blobs/${hashOf(account)}`,
      revealed: true,
      revealed_at: revealedAt,
    });
  return detail(
    {
      id: "7",
      title: "Regex for valid NEAR account IDs",
      verifier,
      max_winners: maxWinners,
      commit_count: 3,
      reveal_count: 2,
      ...task,
    },
    {
      entries: [
        revealedBy(ALICE, 0, "123456", (AT.commit + 40n * SECOND).toString()),
        revealedBy(BOB, 1, "123460", (AT.commit + 95n * SECOND).toString()),
        entry("carol.testnet", { entry_index: 2, committed_height: "123470" }),
      ],
    },
  );
}

/**
 * The page of `data` at `now`, opened at `#anchor`, with a wallet for `account` over `chain`. The
 * deliveries are served by the API by their hash.
 */
async function open(
  page: Page,
  data: TaskDetailResponse,
  options: { now: bigint; anchor: string; account: string; chain?: FakeChain },
) {
  await page.clock.install({ time: at(options.now) });
  const api = await routeApi(page);
  api.details.set(data.task.id, data);
  api.agents.set(data.task.verifier, {
    agent: agent({ account: data.task.verifier }),
    recent_entries: [],
  });
  await page.route(`${API_URL}/v1/blobs/*`, async (route) => {
    const hash = new URL(route.request().url()).pathname.split("/").at(-1);
    const found = Object.values(WORK).find((text) => sha256Hex(text) === hash);
    await route.fulfill(
      found === undefined
        ? { status: 404, json: { error: "not_found", message: "no such blob" } }
        : { status: 200, body: found, headers: { "content-type": "text/plain" } },
    );
  });
  const chain = options.chain ?? new FakeChain(CONTRACT, [{ token: TOKEN }]);
  chain.now = () => options.now;
  const wallet = await installInjectedWallet(page, { account: options.account, chain });
  await page.goto(`/tasks/${data.task.id}#${options.anchor}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(data.task.title ?? "");
  return { api, chain, wallet };
}

/** Connects the page's wallet from the Connect button in `scope`. */
async function connect(page: Page, scope = page.getByTestId("task-actions")): Promise<void> {
  await scope.getByRole("button", { name: "Sign in" }).click();
  await pickStubWallet(page);
}

const IN_JUDGING = AT.reveal + 120n * SECOND;

test("verifier_picks_one_winner_from_the_deliveries", async ({ page }) => {
  await open(page, judged(PERSON, 1), { now: IN_JUDGING, anchor: "pick", account: PERSON });
  const pick = page.getByTestId("action-pick");
  await expect(pick).toContainText("Picking is open for person.testnet.");
  await connect(page, pick);

  await expect(pick).toContainText(
    "You're the checker (the verifier). Your window to pick closes in about",
  );
  const rows = pick.getByTestId("pick-entry");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).getByTestId("delivery")).toHaveText(WORK[ALICE]?.trimEnd() ?? "");
  await expect(rows.nth(0).getByTestId("pick-entry-when")).toHaveText(
    "Revealed 29 Oct, 21:03:29 UTC · committed at block 123456",
  );
  await expect(pick.getByTestId("pick-problem")).toHaveText("Choose a winner.");

  await pick.getByRole("radio", { name: `Winner: ${ALICE}` }).check();
  const reason = rows.nth(0).getByLabel("Reason (optional, public)");
  await expect(reason).toHaveAccessibleDescription(ALICE);
  await reason.fill("Rejects every invalid id.");
  await expect(pick.getByTestId("pick-payout")).toHaveText([`${ALICE}100%1.425 tUSDC`]);
  await expect(pick).toContainText("Reward 1.50 tUSDC · platform fee 5%, 0.075 tUSDC");
  await expect(pick.getByRole("button", { name: "Pick the winner" })).toHaveAttribute(
    "aria-disabled",
    "false",
  );
  await shoot(page, "pick-one-winner");
});

test("verifier_splits_between_winners_with_the_rounding_shown", async ({ page }) => {
  // 1.000003 tUSDC does not split evenly three ways after the fee.
  const data = judged(PERSON, 3, { reward: "1000003" });
  data.task.reveal_count = 3;
  data.entries[2] = entry("carol.testnet", {
    entry_index: 2,
    committed_height: "123470",
    content_hash: hashOf(BOB),
    uri: `${API_URL}/v1/blobs/${hashOf(BOB)}`,
    revealed: true,
  });
  await open(page, data, { now: IN_JUDGING, anchor: "pick", account: PERSON });
  const pick = page.getByTestId("action-pick");
  await connect(page, pick);

  for (const who of [ALICE, BOB, "carol.testnet"]) {
    await pick.getByRole("checkbox", { name: `Winner: ${who}` }).check();
  }
  const share = (row: number) => pick.getByTestId("pick-entry").nth(row).getByLabel("Share (%)");
  await expect(share(0)).toHaveValue("33.34");
  await expect(share(0)).toHaveAccessibleDescription(ALICE);
  await expect(share(1)).toHaveValue("33.33");
  await expect(pick.getByTestId("pick-rounding-shares")).toHaveText(
    "100% doesn't split evenly 3 ways, so the first winner gets 0.01% more.",
  );
  await expect(pick.getByTestId("pick-payout")).toHaveText([
    `${ALICE}33.34%0.316733 tUSDC`,
    `${BOB}33.33%0.316635 tUSDC`,
    "carol.testnet33.33%0.316635 tUSDC",
  ]);
  await expect(pick.getByTestId("pick-rounding")).toHaveText(
    `Rounding down leaves 0.000002 tUSDC: the contract gives it to ${ALICE}, the first winner, as shown.`,
  );
  await shoot(page, "pick-split");

  // Shares that do not make 100% are said, and stop the pick.
  await share(0).fill("50");
  await expect(pick.getByTestId("pick-problem")).toHaveText(
    "The shares add up to 116.66%: 16.66% too much.",
  );
  await expect(pick.getByRole("button", { name: "Pick 3 winners" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await shoot(page, "pick-split-over");
});

test("pick_nobody_asks_first", async ({ page }) => {
  await open(page, judged(PERSON, 1), { now: IN_JUDGING, anchor: "pick", account: PERSON });
  const pick = page.getByTestId("action-pick");
  await connect(page, pick);
  await pick.getByRole("button", { name: "Pick nobody" }).click();
  const confirm = pick.getByTestId("pick-nobody-confirm");
  await expect(confirm).toBeFocused();
  await expect(confirm).toContainText("Pick nobody? The agents are not paid.");
  await expect(confirm).toContainText(`${POSTER}gets back 1.50 tUSDC`);
  await shoot(page, "pick-nobody-confirm");
});

test("the_judges_task_shows_its_state_and_no_controls", async ({ page }) => {
  await open(page, judged(JUDGE, 1, { judge_status: "accepted" }), {
    now: IN_JUDGING,
    anchor: "pick",
    account: PERSON,
  });
  const pick = page.getByTestId("action-pick");
  await expect(pick.getByTestId("pick-judge")).toContainText("The Judge picks this task.");
  await expect(pick.getByTestId("judge-note")).toHaveText("Judge: accepted");
  await expect(pick.getByRole("button")).toHaveCount(0);
  await shoot(page, "pick-judge");
});

test("refund_counts_down_then_refunds_the_funders", async ({ page }) => {
  const data = judged(PERSON, 1, { reveal_count: 0, commit_count: 1 });
  data.entries = [entry(ALICE)];
  const chain = new FakeChain(CONTRACT, [{ token: TOKEN }]);
  chain.addTask(chainTask(data));

  // In the reveal window with nothing revealed: it opens at the reveal deadline. The page's clock
  // starts 30 s before the moment looked at, which is room for a busy machine to load the page in,
  // and once the page is there it is moved on to 2m 30s before the deadline and held, so the
  // countdown reads to the second.
  const early = await open(page, data, {
    now: AT.reveal - 180n * SECOND,
    anchor: "refund",
    account: PERSON,
    chain,
  });
  // The deadline is not on a whole millisecond (the fixtures count in nanoseconds), and the clock
  // counts in them: it stops on the first millisecond of the last 150 seconds, not just before it.
  await page.clock.pauseAt(new Date(Number((AT.reveal - 150n * SECOND + 999_999n) / 1_000_000n)));
  const refund = page.getByTestId("action-refund");
  await expect(refund.getByTestId("refund-opens")).toHaveText(
    "Opens in about 2m 30s, at the reveal deadline, if nobody has revealed an entry by then.",
  );
  await expect(refund.getByRole("button", { name: "Refund the funders" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await shoot(page, "refund-not-yet-open");

  // The deadline passes on the page's clock, and the button opens.
  chain.now = () => AT.reveal + 5n * SECOND;
  await page.clock.fastForward(155_000);
  await expect(refund.getByTestId("refund-open")).toHaveText(
    "Nobody revealed an entry, so anyone can send the reward back to its funders now.",
  );
  // The clock runs again, for the wallet picker's own timers.
  await page.clock.resume();
  await connect(page, refund);
  await expect(refund.getByTestId("refund-funder")).toHaveText([`${POSTER}1.50 tUSDC`]);
  await shoot(page, "refund-open");

  await refund.getByRole("button", { name: "Refund the funders" }).click();
  await expect(refund.getByTestId("refund-sent")).toHaveText(
    "Refunded on chain. This page updates as Tender's index catches up.",
  );
  // One approval, `void_task`, and the poster has the reward back in its vault.
  expect(early.wallet.sent).toHaveLength(1);
  expect(early.wallet.sent[0]?.transactions[0]?.actions.map((a) => a.params.methodName)).toEqual([
    "void_task",
  ]);
  expect(chain.vault.get(POSTER)?.get(TOKEN)).toBe(1_500_000n);
  await shoot(page, "refund-sent");
});

test("top_up_shows_the_vault_and_adds_to_the_reward", async ({ page }) => {
  const data = detail({ id: "7", title: "Extract invoice totals", verifier: JUDGE });
  const chain = new FakeChain(CONTRACT, [{ token: TOKEN, minReward: 1_000_000n }]);
  chain.addTask(chainTask(data));
  chain.storage.set(PERSON, { total: 5n * 10n ** 22n, usedBytes: 200n });
  chain.vault.set(PERSON, new Map([[TOKEN, 4_250_000n]]));
  const { wallet } = await open(page, data, {
    now: AT.created + 90n * SECOND,
    anchor: "top-up",
    account: PERSON,
    chain,
  });
  const topUp = page.getByTestId("action-top-up");
  await connect(page, topUp);
  await expect(topUp.getByTestId("top-up-vault")).toHaveText(
    "Your vault: 4.25 tUSDC. Deposit on the Wallet page. A first top-up of a task is at least 1.00 tUSDC.",
  );
  await expect(topUp.getByRole("link", { name: "Deposit on the Wallet page" })).toHaveAttribute(
    "href",
    "/wallet",
  );
  await shoot(page, "top-up");

  // Below the minimum for a new funder: said, and not sent.
  await topUp.getByLabel("Amount (tUSDC)").fill("0.5");
  await topUp.getByRole("button", { name: "Top up" }).click();
  await expect(topUp.getByTestId("top-up-problem")).toHaveText(
    "Your first top-up of a task must be at least 1.00 tUSDC.",
  );
  await shoot(page, "top-up-below-minimum");
  expect(wallet.sent).toEqual([]);

  await topUp.getByLabel("Amount (tUSDC)").fill("2");
  await topUp.getByRole("button", { name: "Top up" }).click();
  await expect(topUp.getByTestId("top-up-sent")).toHaveText(
    "Added 2.00 tUSDC. The reward is now 3.50 tUSDC.",
  );
  expect(wallet.sent[0]?.transactions[0]?.actions.map((a) => a.params.methodName)).toEqual([
    "top_up_task",
  ]);
  expect(chain.vault.get(PERSON)?.get(TOKEN)).toBe(2_250_000n);
  await shoot(page, "top-up-sent");
});
