import { expect, type Page, test } from "@playwright/test";
import { ApiClient, type Signer, TenderClient } from "@tender/client";
import {
  type Brief,
  canonicalJson,
  computeCommitment,
  formatTokenAmount,
  type PublicCriteria,
  randomSalt,
  sha256Hex,
  type TaskView,
} from "@tender/shared";
import { loadRun, loadSigners, type RunInfo } from "./run";

// The task page's actions on a real local chain, with the real services and the dev wallet: the
// dev account picks as the verifier and the winner's vault grows by the reward less the fee, a task
// nobody revealed in is refunded from the page, and a top-up from the page raises a reward. The
// spec posts its own tasks as the poster and enters them as alice, the registered agent, with the
// keys the setup hands over (run.ts `loadSigners`). It runs after dev-wallet.chain.ts, which needs
// the dev account as the setup made it, and leaves that account with a storage balance and a vault.

const tusdc = (whole: number) => BigInt(Math.round(whole * 1_000_000));
const show = (units: bigint) => `${formatTokenAmount(units, 6)} tUSDC`;
const NEAR = 10n ** 24n;
const API_TIMEOUT_MS = 15_000;

/** A client of the run's chain, signing as `signer` if one is given. */
const clientOf = (run: RunInfo, signer?: Signer) =>
  new TenderClient({ network: "sandbox", contractId: run.contractId, rpcUrl: run.rpcUrl, signer });

const apiOf = (run: RunInfo, signer?: Signer) =>
  new ApiClient({ baseUrl: run.apiUrl, signer, timeoutMs: API_TIMEOUT_MS });

/** Waits until the chain's block time reaches `ns`. */
async function chainTimeReaches(client: TenderClient, ns: bigint): Promise<void> {
  await expect
    .poll(async () => (await client.blockTimestampNs()) >= ns, {
      message: `the chain's time to reach ${ns}`,
      timeout: 120_000,
      intervals: [500],
    })
    .toBe(true);
}

/** The criteria every task here is posted with: regex cases, with no held-out part. */
const CRITERIA: PublicCriteria = {
  version: 1,
  kind: "regex_cases",
  min_score: 100,
  split: "winner_take_all",
  has_heldout: false,
  examples: { match: ["C3-045", "A1-001"], no_match: ["G1-010", "C0-045"] },
};

/**
 * Posts a task as the poster, with a brief and criteria the API stores, and waits until the API
 * lists it. The reward goes into the poster's vault first.
 */
async function postTask(
  run: RunInfo,
  options: {
    title: string;
    verifier: string;
    reward: bigint;
    windows: { commit: number; reveal: number; pick: number; fallback: number };
  },
): Promise<TaskView> {
  const { poster } = loadSigners();
  const client = clientOf(run, poster);
  const api = apiOf(run, poster);
  const brief: Brief = {
    version: 1,
    title: options.title,
    summary: "A task the chain suite posts for the task page's actions.",
    instructions: "Reply with one JSON object holding a regex for hotel room codes.",
    category: "coding",
    tags: ["chain-suite"],
    output: { format: "regex_json", max_bytes: 4096 },
  };
  const briefStored = await api.uploadBlob({
    kind: "brief",
    contentType: "application/json",
    bytes: canonicalJson(brief),
  });
  const criteriaStored = await api.uploadBlob({
    kind: "criteria",
    contentType: "application/json",
    bytes: canonicalJson(CRITERIA),
  });
  await client.deposit(run.tokenId, options.reward);
  const { taskId } = await client.postTask({
    token: run.tokenId,
    reward: options.reward,
    briefUri: briefStored.uri,
    briefHash: briefStored.sha256,
    criteriaHash: criteriaStored.sha256,
    verifier: options.verifier,
    commitSecs: options.windows.commit,
    revealSecs: options.windows.reveal,
    pickSecs: options.windows.pick,
    fallbackSecs: options.windows.fallback,
  });
  await expect
    .poll(async () => (await apiOf(run).getTask(taskId))?.brief?.title, {
      message: `the API to list task ${taskId}`,
      timeout: 60_000,
    })
    .toBe(options.title);
  const task = await clientOf(run).getTask(taskId);
  if (task === null) throw new Error(`the chain has no task ${taskId}`);
  return task;
}

/** Connects the dev wallet from the Connect button in `scope`: it has no picker. */
async function connect(scope: ReturnType<Page["getByTestId"]>): Promise<void> {
  await scope.getByRole("button", { name: "Connect wallet" }).click();
}

test("web_verifier_picks_and_the_winner_is_paid_the_reward_less_the_fee", async ({ page }) => {
  const run = loadRun();
  const { alice } = loadSigners();
  const reader = clientOf(run);
  const reward = tusdc(2);
  const task = await postTask(run, {
    title: "Room-code regex (task actions, pick)",
    verifier: run.dev,
    reward,
    windows: { commit: 20, reveal: 20, pick: 300, fallback: 60 },
  });
  const taskId = BigInt(task.id);

  // Alice commits a sealed answer, then reveals it: the work goes to the result store first.
  const work = new TextEncoder().encode(
    '{"pattern":"^[A-F][1-9]-(?:0\\\\d[1-9]|0[1-9]0|1[01]\\\\d|120)$","flags":""}',
  );
  const contentHash = sha256Hex(work);
  const salt = randomSalt();
  const agent = clientOf(run, alice);
  await agent.commit(taskId, computeCommitment(taskId, alice.accountId, contentHash, salt));
  await chainTimeReaches(reader, BigInt(task.commit_deadline));
  await expect
    .poll(async () => (await apiOf(run).getTask(taskId))?.entries.length, {
      message: "alice's entry in the index",
    })
    .toBe(1);
  const stored = await apiOf(run, alice).uploadBlob({
    kind: "result",
    contentType: "text/plain",
    bytes: work,
    taskId,
  });
  await agent.reveal(taskId, contentHash, salt, stored.uri);
  await chainTimeReaches(reader, BigInt(task.reveal_deadline));
  await expect
    .poll(async () => (await apiOf(run).getTask(taskId))?.entries[0]?.revealed, {
      message: "alice's reveal in the index",
    })
    .toBe(true);

  const before = await reader.balanceOf(alice.accountId, run.tokenId);
  const { fee_bps: feeBps } = task;
  const fee = (reward * BigInt(feeBps)) / 10_000n;

  // The dev account is the verifier: the page, opened at #pick, offers it the pick.
  await page.goto(`/tasks/${task.id}#pick`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Room-code regex (task actions, pick)",
  );
  const pick = page.getByTestId("action-pick");
  await expect(pick).toContainText(`Picking is open for ${run.dev}.`);
  await connect(pick);
  await expect(pick).toContainText("You're the verifier.");
  const row = pick.getByTestId("pick-entry");
  await expect(row).toHaveCount(1);
  // Her delivery, read through the API and hashed again, as text.
  await expect(row.getByTestId("delivery")).toHaveText(new TextDecoder().decode(work));
  await expect(row.getByTestId("pick-entry-when")).toContainText("Revealed ");
  await pick.getByRole("radio", { name: `Winner: ${alice.accountId}` }).check();
  await row.getByLabel("Reason (optional, public)").fill("Matches the brief.");
  await expect(pick.getByTestId("pick-payout")).toHaveText([
    `${alice.accountId}100%${show(reward - fee)}`,
  ]);
  await pick.getByRole("button", { name: "Pick the winner" }).click();
  await expect(pick.getByTestId("pick-sent")).toContainText("The pick is on chain", {
    timeout: 120_000,
  });

  // On chain: picked, alice paid the reward less the fee, and her vault grew by exactly that.
  const after = await reader.getTask(taskId);
  expect(after?.outcome).toMatchObject({
    kind: "picked",
    winners: [{ account: alice.accountId, bps: 10_000, amount: (reward - fee).toString() }],
    fee: fee.toString(),
  });
  expect((await reader.balanceOf(alice.accountId, run.tokenId)) - before).toBe(reward - fee);

  // The scorecard the chain pins is the one the API serves: the dev account's pick by hand.
  if (after?.outcome?.kind !== "picked") throw new Error("the task is not picked");
  const { scorecard_hash: hash } = after.outcome;
  const served = await apiOf(run).getBlob(hash);
  expect(served, "the scorecard at the API").not.toBeNull();
  expect(sha256Hex(served ?? new Uint8Array())).toBe(hash);
  expect(JSON.parse(new TextDecoder().decode(served ?? new Uint8Array()))).toMatchObject({
    task_id: task.id,
    verifier: run.dev,
    winners: [{ account: alice.accountId, bps: 10_000 }],
    judge: { software: "tender-web/1", model: null },
    entries: [
      { account: alice.accountId, score: 100, passed: true, reasons: ["Matches the brief."] },
    ],
  });

  // The page updates from the event stream: the payouts and the scorecard are there.
  await expect(page.getByTestId("payouts")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("settled-by")).toHaveText(`Picked by ${run.dev} (verifier)`);
  await expect(page.getByTestId("scored-by")).toHaveText(
    `The scorecard says ${run.dev} picked by hand, with no software scoring the entries: each winner is listed at 100, every other entry at 0.`,
  );
  await expect(pick.getByTestId("pick-sent")).toHaveText(
    "The pick is on chain. The payouts and the scorecard are below.",
  );
});

test("web_refund_pays_the_reward_back_to_the_funders", async ({ page }) => {
  const run = loadRun();
  const reader = clientOf(run);
  const reward = tusdc(1.5);
  const task = await postTask(run, {
    title: "Room-code regex (task actions, refund)",
    verifier: run.poster,
    reward,
    // A reveal window wide enough that a slow page still opens inside it.
    windows: { commit: 10, reveal: 60, pick: 60, fallback: 60 },
  });
  const before = await reader.balanceOf(run.poster, run.tokenId);

  // In the reveal window, with nothing revealed, it says when the refund opens. (In the commit
  // window there is no refund to speak of: the task takes entries and top-ups.)
  await chainTimeReaches(reader, BigInt(task.commit_deadline));
  await page.goto(`/tasks/${task.id}#refund`);
  const refund = page.getByTestId("action-refund");
  await expect(refund.getByTestId("refund-opens")).toContainText(
    "at the reveal deadline, if nobody has revealed an entry by then.",
  );
  await expect(refund.getByRole("button", { name: "Refund the funders" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );

  // Nobody entered: from the reveal deadline anyone may refund, and the dev account does.
  await chainTimeReaches(reader, BigInt(task.reveal_deadline));
  await expect(refund.getByTestId("refund-open")).toBeVisible({ timeout: 30_000 });
  await connect(refund);
  await expect(refund.getByTestId("refund-funder")).toHaveText([`${run.poster}${show(reward)}`]);
  await refund.getByRole("button", { name: "Refund the funders" }).click();
  await expect(refund.getByTestId("refund-sent")).toContainText("Refunded", { timeout: 120_000 });

  const after = await reader.getTask(BigInt(task.id));
  expect(after?.outcome).toMatchObject({ kind: "voided", reason: "no_reveals" });
  expect((await reader.balanceOf(run.poster, run.tokenId)) - before).toBe(reward);
  await expect(page.getByTestId("payouts")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("refund-row")).toHaveText([`${run.poster}${show(reward)}`]);
});

test("web_top_up_raises_the_reward", async ({ page }) => {
  const run = loadRun();
  const { poster } = loadSigners();
  const reader = clientOf(run);
  const funder = clientOf(run, poster);
  // The dev account gets a storage balance, if the wallet spec did not give it one, and 3 tUSDC
  // in its vault, from the poster.
  if ((await reader.storageBalanceOf(run.dev)) === null) {
    await funder.storageDeposit(NEAR / 20n, run.dev);
  }
  await funder.deposit(run.tokenId, tusdc(3), run.dev);
  const vault = await reader.balanceOf(run.dev, run.tokenId);
  const reward = tusdc(2);
  const task = await postTask(run, {
    title: "Room-code regex (task actions, top up)",
    verifier: run.poster,
    reward,
    windows: { commit: 600, reveal: 60, pick: 60, fallback: 60 },
  });

  await page.goto(`/tasks/${task.id}#top-up`);
  const topUp = page.getByTestId("action-top-up");
  await connect(topUp);
  await expect(topUp.getByTestId("top-up-vault")).toContainText(`Your vault: ${show(vault)}.`);
  await topUp.getByLabel("Amount (tUSDC)").fill("1.5");
  await topUp.getByRole("button", { name: "Top up" }).click();
  await expect(topUp.getByTestId("top-up-sent")).toHaveText(
    `Added 1.50 tUSDC. The reward is now ${show(reward + tusdc(1.5))}.`,
    { timeout: 120_000 },
  );

  // On chain: the reward is higher by the top-up, the dev account funds it, and its vault paid.
  const after = await reader.getTask(BigInt(task.id));
  expect(after?.reward).toBe((reward + tusdc(1.5)).toString());
  expect(after?.funders).toContainEqual({ account: run.dev, amount: tusdc(1.5).toString() });
  expect(await reader.balanceOf(run.dev, run.tokenId)).toBe(vault - tusdc(1.5));
  // The page's reward follows from the event stream.
  await expect(page.getByTestId("funder-row").filter({ hasText: run.dev })).toBeVisible({
    timeout: 60_000,
  });
});
