import { expect, type Page, test } from "@playwright/test";
import { ApiClient, TenderClient } from "@tender/client";
import { formatTokenAmount, sha256Hex } from "@tender/shared";
import { TEAM_LABEL } from "../fixtures";
import { cardTitled } from "./cards";
import { loadRun, type RunInfo } from "./run";

// The pages that move money, with the dev wallet: a wallet in the page that signs with the key of
// a new account of the run's chain (e2e/chain/stack.ts), so there is no picker and no extension.
// What the page does goes to the real node, and each spec reads the chain back afterwards. The
// account starts with tokens in its wallet and nothing at Tender, and the specs run in this order
// on it: the wallet page sets it up and moves tokens in and out, and the post form then posts a
// task from what is left. The wizard turns away an account that Tender does not know, so a run of
// the post spec alone sets the account up first, on the wallet page. The wallet spec needs the
// account as the setup made it, so each spec runs once on a chain (`retries` is 0).

const tusdc = (whole: number) => BigInt(whole) * 1_000_000n;
/** An amount as the page writes it. */
const show = (units: bigint) => `${formatTokenAmount(units, 6)} tUSDC`;

/** A client that reads the chain of the run. */
const readerOf = (run: RunInfo) =>
  new TenderClient({ network: "sandbox", contractId: run.contractId, rpcUrl: run.rpcUrl });

const section = (page: Page, title: string) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: title, exact: true }) });

const row = (page: Page, token: string) => page.getByTestId("token-row").filter({ hasText: token });

test("register_deposit_withdraw_round_trip", async ({ page }) => {
  const run = loadRun();
  const chain = readerOf(run);
  const token = row(page, run.tokenId);

  // The account holds tokens, has no storage at Tender and nothing in the vault.
  const wallet = await chain.ftBalanceOf(run.tokenId, run.dev);
  expect(wallet, "the dev account's tokens, from the chain").toBeGreaterThanOrEqual(tusdc(25));
  expect(await chain.storageBalanceOf(run.dev), "the dev account's storage at Tender").toBeNull();
  expect(await chain.balanceOf(run.dev, run.tokenId), "the dev account's vault").toBe(0n);

  // Signed out, the page offers the one thing there is to do.
  await page.goto("/wallet");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Wallet");
  await expect(page.getByTestId("account-id")).toHaveCount(0);
  // The dev wallet has no picker: it connects at once.
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByTestId("account-id")).toHaveText(run.dev);
  await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();

  // The page reads the balances from the chain: the wallet holds the tokens, the vault is empty,
  // and there is nowhere to put anything until the account is set up.
  await expect(token.getByTestId("wallet-balance")).toHaveText(show(wallet));
  await expect(token.getByTestId("vault-balance")).toHaveText(show(0n));
  await expect(section(page, "Add funds").getByTestId("form-unavailable")).toHaveText(
    "Set up your account first.",
  );

  // Register: 0.05 NEAR for storage, one transaction to Tender.
  await page.getByRole("button", { name: "Set up account" }).click();
  await expect(page.getByTestId("notice")).toHaveText(
    "Your account is set up. 0.05 NEAR is deposited for storage.",
  );
  await expect(page.getByTestId("storage-total")).toHaveText("0.05 NEAR");
  expect(await chain.storageBalanceOf(run.dev), "the storage the chain holds").toMatchObject({
    total: "50000000000000000000000",
  });

  // Deposit: 20 of the tokens, from the wallet into the vault.
  const add = section(page, "Add funds");
  await add.getByLabel("Amount").fill("20");
  await add.getByRole("button", { name: "Add funds" }).click();
  await expect(page.getByTestId("notice")).toHaveText("Added 20.00 tUSDC to your vault.");
  await expect(token.getByTestId("vault-balance")).toHaveText(show(tusdc(20)));
  await expect(token.getByTestId("wallet-balance")).toHaveText(show(wallet - tusdc(20)));
  await expect
    .poll(() => chain.balanceOf(run.dev, run.tokenId), { message: "the vault, from the chain" })
    .toBe(tusdc(20));
  expect(await chain.ftBalanceOf(run.tokenId, run.dev), "the wallet, from the chain").toBe(
    wallet - tusdc(20),
  );

  // Withdraw: 5 of the 20 back. The token already knows the account, so it is one transaction.
  const take = section(page, "Withdraw");
  await take.getByLabel("Amount").fill("5");
  await take.getByRole("button", { name: "Withdraw" }).click();
  await expect(page.getByTestId("notice")).toHaveText("Withdrew 5.00 tUSDC to your wallet.");
  await expect(token.getByTestId("vault-balance")).toHaveText(show(tusdc(15)));
  await expect(token.getByTestId("wallet-balance")).toHaveText(show(wallet - tusdc(15)));
  await expect
    .poll(() => chain.balanceOf(run.dev, run.tokenId), { message: "the vault, from the chain" })
    .toBe(tusdc(15));
  expect(await chain.ftBalanceOf(run.tokenId, run.dev), "the wallet, from the chain").toBe(
    wallet - tusdc(15),
  );

  // Disconnecting leaves the connect button, with nothing of the account on the page.
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
  await expect(page.getByTestId("token-row")).toHaveCount(0);
});

/** A line of the held-out checks. It must reach the held-out upload and nothing else. */
const SECRET = "held-out-secret-7f3a";
const TITLE = "Regex for NEAR account ids (chain suite)";

const more = (page: Page) => page.getByRole("button", { name: /^More options/ });

async function openMore(page: Page): Promise<void> {
  if ((await more(page).getAttribute("aria-expanded")) === "false") await more(page).click();
}

async function fillBrief(page: Page): Promise<void> {
  await page.getByLabel("Title", { exact: true }).fill(TITLE);
  await page
    .getByLabel("Instructions", { exact: true })
    .fill("Return the pattern and its flags.\nAnchor it at both ends.");
  await openMore(page);
  await page.getByLabel("Summary (optional)").fill("One regex that tells valid ids from invalid.");
  await page.getByLabel("Tags (optional)").fill("regex, near");
}

async function fillRegexChecks(page: Page): Promise<void> {
  await openMore(page);
  await page.getByRole("radio", { name: /Regex cases/ }).check();
  await page.getByLabel("Should match", { exact: true }).fill("alice.near\nbob.testnet");
  await page.getByLabel("Should not match", { exact: true }).fill("-bad\nUPPER");
  await page.getByLabel("Hidden: should match", { exact: true }).fill(`${SECRET}.near\ncarol.near`);
  await page.getByLabel("Hidden: should not match", { exact: true }).fill("dave..near\n_eve.near");
}

/** The windows set by hand under More options: 10, 5, 10 and 10 minutes. */
async function setWindows(page: Page): Promise<void> {
  await openMore(page);
  await page.getByRole("checkbox", { name: "Set each window yourself" }).check();
  for (const [name, amount] of [
    ["Answer", "10"],
    ["Open", "5"],
    ["Pick", "10"],
    ["Fallback", "10"],
  ] as const) {
    await page.getByLabel(`${name} window`, { exact: true }).fill(amount);
    await page.getByLabel(`${name} window unit`).selectOption("minutes");
  }
}

/**
 * Sets the dev account up at Tender on the wallet page, as a person does, unless the chain says it
 * is set up already (the wallet spec did it). The page is left signed out, as a new page is.
 */
async function ensureAccountIsSetUp(page: Page, run: RunInfo): Promise<void> {
  if ((await readerOf(run).storageBalanceOf(run.dev)) !== null) return;
  await page.goto("/wallet");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByTestId("account-id")).toHaveText(run.dev);
  await page.getByRole("button", { name: "Set up account" }).click();
  await expect(page.getByTestId("storage-total")).toHaveText("0.05 NEAR");
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
}

test("post_task_end_to_end", async ({ page }) => {
  const run = loadRun();
  const chain = readerOf(run);
  const api = new ApiClient({ baseUrl: run.apiUrl });
  await ensureAccountIsSetUp(page, run);

  // What the wizard has to add to the vault for the reward, from what the chain holds now.
  const reward = tusdc(20);
  const inVault = await chain.balanceOf(run.dev, run.tokenId);
  const toAdd = reward > inVault ? reward - inVault : 0n;
  expect(
    await chain.ftBalanceOf(run.tokenId, run.dev),
    "the dev account's tokens, from the chain",
  ).toBeGreaterThanOrEqual(toAdd);

  /** What the page sent to the held-out upload. */
  const uploads: Array<{ commitment: string; bytes: Buffer }> = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/v1/heldout") {
      const body = request.postDataJSON() as { commitment: string; content_base64: string };
      uploads.push({
        commitment: body.commitment,
        bytes: Buffer.from(body.content_base64, "base64"),
      });
    }
  });

  await page.goto("/post");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Post a task");
  await fillBrief(page);
  await fillRegexChecks(page);
  await setWindows(page);
  await page.getByLabel("Amount (tUSDC)").fill("20");
  await more(page).click();

  // The page says what is about to happen. Without a wallet its one button connects one.
  await expect(page.getByTestId("review-reward")).toContainText(show(reward));
  await expect(page.getByTestId("review-verifier")).toContainText("Tender Judge");
  await expect(page.getByTestId("review-account")).toHaveText("Not connected");
  const post = page.getByRole("button", { name: "Post task" });
  await expect(post).toHaveCount(0);

  // The dev wallet connects at once, and the page reads the vault from the chain.
  await page.locator("main").getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByTestId("review-account")).toHaveText(run.dev);
  await expect(page.getByTestId("review-funding")).toHaveText(
    toAdd === 0n
      ? `Your vault: ${show(inVault)}, enough already.`
      : `Your vault: ${show(inVault)}. Added from your wallet first: ${show(toAdd)}.`,
  );
  await expect(post).toHaveAttribute("aria-disabled", "false");
  // Nothing has been uploaded yet.
  expect(uploads).toEqual([]);

  await post.click();
  await page.waitForURL(/\/tasks\/\d+$/, { timeout: 120_000 });
  const taskId = BigInt(new URL(page.url()).pathname.split("/").at(-1) ?? "");

  // The task on the chain is the one that was written: ours, in the test token, with the Judge.
  const task = await chain.getTask(taskId);
  if (task === null) throw new Error(`the chain has no task ${taskId}`);
  expect(task).toMatchObject({
    poster: run.dev,
    token: run.tokenId,
    reward: reward.toString(),
    verifier: run.judge,
    phase: "open",
  });
  expect(await chain.balanceOf(run.dev, run.tokenId), "what is left in the vault").toBe(
    inVault + toAdd - reward,
  );

  // The held-out document went up once, and the task commits to exactly those bytes.
  expect(uploads).toHaveLength(1);
  const [uploaded] = uploads;
  if (uploaded === undefined) throw new Error("no held-out document was uploaded");
  expect(sha256Hex(uploaded.bytes), "the hash of the uploaded held-out").toBe(uploaded.commitment);
  expect(task.heldout_commitment, "the commitment on the chain").toBe(uploaded.commitment);
  expect(JSON.parse(uploaded.bytes.toString("utf8"))).toEqual({
    regex_cases: {
      match: [`${SECRET}.near`, "carol.near"],
      no_match: ["dave..near", "_eve.near"],
    },
    salt: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  // The API has the same commitment, once its index has the task.
  await expect
    .poll(async () => (await api.getTask(taskId))?.task.heldout_commitment, {
      message: "the commitment the API serves for the task",
    })
    .toBe(uploaded.commitment);

  // The held-out text is kept, and goes into no public document.
  expect(await api.getBlob(uploaded.commitment), "the held-out, from the API").toBeNull();
  for (const [what, hash] of [
    ["brief", task.brief_hash],
    ["criteria", task.criteria_hash],
  ] as const) {
    const bytes = await api.getBlob(hash);
    expect(bytes, `the ${what} the API serves`).not.toBeNull();
    expect(new TextDecoder().decode(bytes ?? new Uint8Array())).not.toContain(SECRET);
  }

  // The task page shows the task as it was written, open, and its windows counting down.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(TITLE);
  await expect(page.getByTestId("phase-chip")).toHaveText("Open");
  const status = page.getByTestId("live-status");
  await expect(status).toContainText("Answer window (commit) closes in");
  const timeline = page.getByTestId("phase-timeline");
  for (const [phase, span] of [
    ["open", "10m"],
    ["revealing", "5m"],
    ["judging", "10m"],
    ["fallback", "10m"],
  ] as const) {
    await expect(timeline.locator(`[data-phase="${phase}"]`)).toContainText(span);
  }
  const timer = status.getByRole("timer");
  const before = await timer.textContent();
  // The first window is ten minutes long and the page was opened within a minute of the post.
  expect(before).toMatch(/^(?:[0-9]|10)m \d+s$/);
  await expect(timer).not.toHaveText(before ?? "");

  // The Judge, which runs with the services, takes the task up: it reads the brief, the criteria
  // and the held-out the page uploaded, and finds them to be the ones the task commits to. Its
  // answer is in the API's database and on no stream, so the page shows it when it loads again.
  await expect
    .poll(
      async () => {
        const seen = (await api.getTask(taskId))?.task;
        return [seen?.judge_status, seen?.judge_reason].filter(Boolean).join(" · ");
      },
      { message: "what the Judge made of the task, from the API", timeout: 60_000 },
    )
    .toMatch(/^accepted\b/);
  await page.reload();
  await expect(page.getByTestId("judge-note")).toContainText("Judge: accepted");

  // The board lists the task under the account that posted it, and without the team's label, as
  // that account is not the team's. The board spec shows the label where it belongs; this shows the
  // page does not put it on every poster.
  await page.goto("/tasks");
  const card = cardTitled(page, TITLE);
  await expect(card, "the card of the task the wizard posted").toBeVisible();
  const poster = card.getByTestId("poster");
  await expect(poster, "the poster of the task the wizard posted").toContainText(run.dev);
  await expect(
    poster.getByText(TEAM_LABEL, { exact: true }),
    "the team label on a poster that is not the team's",
  ).toHaveCount(0);
});
