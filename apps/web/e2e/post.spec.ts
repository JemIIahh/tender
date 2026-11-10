import { expect, type Page, test } from "@playwright/test";
import { SIGN_IN_MESSAGE, sha256Hex } from "@tender/shared";
import { FakeChain } from "../test/fakeChain";
import { API_URL, routeApi } from "./fixtures";
import { installInjectedWallet } from "./injectedWallet";
import { routePostApi } from "./postApi";
import { STUB_WALLET_NAME } from "./walletStub";

// The post form in a browser: a person writes a task on one page, the page uploads its documents to
// a fixture API (e2e/postApi.ts), asks a wallet (e2e/injectedWallet.ts) to sign in and to send one
// batch to a model of the contract and its token (test/fakeChain.ts), and the task page opens on
// the task that was posted. The page finds the wallet through near-connect, so the picker, the
// signature and the batch are the real ones; what the contract does with the batch is the model's.

// The contract is the one the web server is built for (playwright.config.ts), and so is the Judge.
const CONTRACT = "tender.tender-team.testnet";
const TOKEN = "tusdc.tender-team.testnet";
const JUDGE = "judge.tender-team.testnet";
const ALICE = "alice.testnet";
const TUSDC = (whole: number) => BigInt(whole) * 1_000_000n;
/** A line of the held-out checks. It must reach the held-out upload and nothing else. */
const SECRET = "held-out-secret-7f3a";

const more = (page: Page) => page.getByRole("button", { name: /^More options/ });

async function openMore(page: Page): Promise<void> {
  if ((await more(page).getAttribute("aria-expanded")) === "false") await more(page).click();
}

async function fillBrief(page: Page): Promise<void> {
  await page.getByLabel("Title", { exact: true }).fill("Regex for NEAR account ids");
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

/** Writes the whole task on the one page, More options and all. */
async function writeTask(page: Page, amount = "5"): Promise<void> {
  await page.goto("/post");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Post a task");
  await fillBrief(page);
  await fillRegexChecks(page);
  await setWindows(page);
  await page.getByLabel("Amount (tUSDC)").fill(amount);
  await expect(page.getByTestId("reward-net")).toHaveText(
    `Winner receives ${(Number(amount) * 0.95).toFixed(2)} tUSDC after the 5% fee.`,
  );
  // Closed again: the fields that hold the hidden cases are not on the page.
  await more(page).click();
}

async function connect(page: Page): Promise<void> {
  await page.locator("main").getByRole("button", { name: "Connect wallet" }).click();
  await page.locator(".hot-connector-popup .connect-item", { hasText: STUB_WALLET_NAME }).click();
  await expect(page.getByTestId("review-account")).toHaveText(ALICE);
}

test("post_task_end_to_end", async ({ page }) => {
  // Alice holds 50 test USDC, and 2 of them are in her vault already: 3 more have to go in first.
  const chain = new FakeChain(CONTRACT, [{ token: TOKEN, minReward: TUSDC(1) }]);
  chain.give(TOKEN, ALICE, TUSDC(50));
  chain.fundVault(ALICE, TOKEN, TUSDC(2));
  const fixture = await routeApi(page);
  const wallet = await installInjectedWallet(page, { account: ALICE, chain });
  const api = await routePostApi(page, chain);
  const logged: string[] = [];
  page.on("console", (message) => logged.push(message.text()));

  await writeTask(page);

  // The page says what is about to happen. Without a wallet its one button connects one.
  await expect(page.getByTestId("review-reward")).toHaveText("5.00 tUSDC");
  await expect(page.getByTestId("review-verifier")).toContainText("Tender Judge");
  await expect(page.getByTestId("review-account")).toHaveText("Not connected");
  await expect(page.getByTestId("deadline-plan")).toContainText("open them (reveal) for 5m");
  await expect(page.getByRole("button", { name: "Post task" })).toHaveCount(0);
  expect(await page.locator("body").textContent()).not.toContain(SECRET);
  await connect(page);
  await expect(page.getByTestId("review-funding")).toHaveText(
    "Your vault: 2.00 tUSDC. Added from your wallet first: 3.00 tUSDC.",
  );
  const post = page.getByRole("button", { name: "Post task" });
  await expect(post).toHaveAttribute("aria-disabled", "false");
  // Nothing has been sent anywhere yet.
  expect(api.requests).toEqual([]);
  expect(wallet.sent).toEqual([]);

  await post.click();
  await page.waitForURL("**/tasks/1");

  // Signed in once, with the challenge the API gave. Then the brief and the criteria went up, and
  // the held-out checks after them, each to its own place, before the wallet was asked to send.
  expect(api.requests).toEqual([
    "POST /v1/auth/challenge",
    "POST /v1/auth/verify",
    "POST /v1/blobs",
    "POST /v1/blobs",
    "POST /v1/heldout",
  ]);
  expect(wallet.signed).toHaveLength(1);
  expect(wallet.signed[0]).toMatchObject({ message: SIGN_IN_MESSAGE, recipient: API_URL });
  expect(wallet.signed[0]?.nonce).toHaveLength(32);
  expect(api.blobs.map(({ kind }) => kind)).toEqual(["brief", "criteria"]);
  const [brief, criteria] = api.blobs;
  const [heldout] = api.heldouts;
  expect([...api.blobs, ...api.heldouts].every(({ token }) => token === api.tokens[0])).toBe(true);

  // One batch: the deposit that tops the vault up, then the post.
  expect(wallet.sent).toHaveLength(1);
  const batch = wallet.sent[0]?.transactions ?? [];
  expect(batch.map(({ receiverId }) => receiverId)).toEqual([TOKEN, CONTRACT]);
  expect(batch[0]?.actions[0]).toMatchObject({
    params: { methodName: "ft_transfer_call", deposit: "1" },
  });
  expect(batch[0]?.actions[0]?.params.args).toEqual({
    receiver_id: CONTRACT,
    amount: "3000000",
    msg: "",
  });
  expect(batch[1]?.actions[0]).toMatchObject({ params: { methodName: "post_task", deposit: "1" } });

  // The task on the chain is the one that was written, and commits to what was uploaded.
  const task = chain.tasks.get(1n);
  expect(task).toMatchObject({
    poster: ALICE,
    token: TOKEN,
    reward: TUSDC(5),
    verifier: JUDGE,
    briefHash: brief?.sha256,
    briefUri: `${API_URL}/v1/blobs/${brief?.sha256}`,
    criteriaHash: criteria?.sha256,
    heldoutCommitment: heldout?.commitment,
    maxWinners: 1,
  });
  expect(sha256Hex(heldout?.bytes ?? new Uint8Array())).toBe(task?.heldoutCommitment);
  expect(JSON.parse(heldout?.text ?? "{}")).toEqual({
    regex_cases: {
      match: [`${SECRET}.near`, "carol.near"],
      no_match: ["dave..near", "_eve.near"],
    },
    salt: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  expect(chain.vault.get(ALICE)?.get(TOKEN)).toBe(0n);

  // The held-out text went to the held-out upload and nowhere else: not the documents, not the
  // wallet, not the address, not the console, not the browser's storage.
  const stored = await page.evaluate(
    () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
  );
  const elsewhere = [
    ...api.blobs.map(({ text }) => text),
    JSON.stringify(wallet.sent),
    JSON.stringify(wallet.signed),
    JSON.stringify(fixture.requests),
    page.url(),
    logged.join("\n"),
    stored,
  ].join("\n");
  expect(elsewhere).not.toContain(SECRET);

  // The task page shows the task as it was written, open, and its windows counting down.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Regex for NEAR account ids");
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
});

test("post_task_end_to_end_with_the_default_deadline_and_rule", async ({ page }) => {
  // The page as most posters leave it: the exact-answer rule, the Judge, and the deadline a day off.
  const chain = new FakeChain(CONTRACT, [{ token: TOKEN, minReward: TUSDC(1) }]);
  chain.give(TOKEN, ALICE, TUSDC(50));
  chain.fundVault(ALICE, TOKEN, TUSDC(10));
  await routeApi(page);
  await installInjectedWallet(page, { account: ALICE, chain });
  const api = await routePostApi(page, chain);

  await page.goto("/post");
  await page.getByLabel("Title", { exact: true }).fill("Capital of Australia");
  await page.getByLabel("Instructions", { exact: true }).fill("Answer with the city's name.");
  await page.getByLabel("Accepted answers").fill(`Canberra\n${SECRET}`);
  await page.getByLabel("Amount (tUSDC)").fill("10");
  await expect(page.getByTestId("reward-net")).toHaveText(
    "Winner receives 9.50 tUSDC after the 5% fee.",
  );
  await expect(page.getByTestId("deadline-plan")).toContainText(
    "open them (reveal) for 2h, and the Judge picks by about",
  );
  // The field holds a time a day off, to the minute.
  const typed = await page.getByLabel("Agents answer until").inputValue();
  const ahead = new Date(typed).getTime() - Date.now();
  expect(ahead).toBeGreaterThan(86_400_000 - 120_000);
  expect(ahead).toBeLessThanOrEqual(86_400_000 + 60_000);

  await connect(page);
  await expect(page.getByTestId("review-funding")).toHaveText(
    "Your vault: 10.00 tUSDC, enough already.",
  );
  const post = page.getByRole("button", { name: "Post task" });
  await expect(post).toHaveAttribute("aria-disabled", "false");
  await post.click();
  await page.waitForURL("**/tasks/1");

  // The task on the chain has the windows a day gives: about a day to answer, then 2 hours to
  // open, 4 to pick and a day of the poster's fallback.
  const task = chain.tasks.get(1n);
  const SECOND = 1_000_000_000n;
  expect(task).toMatchObject({ poster: ALICE, reward: TUSDC(10), verifier: JUDGE });
  const commit = task === undefined ? 0n : (task.commitDeadline - task.createdAt) / SECOND;
  expect(commit).toBeGreaterThan(86_400n - 180n);
  expect(commit).toBeLessThanOrEqual(86_400n + 60n);
  expect(task && task.revealDeadline - task.commitDeadline).toBe(7_200n * SECOND);
  expect(task && task.pickDeadline - task.revealDeadline).toBe(14_400n * SECOND);
  expect(task && task.fallbackDeadline - task.pickDeadline).toBe(86_400n * SECOND);
  // The Judge got the accepted answers, salted; nothing else did.
  const [heldout] = api.heldouts;
  expect(sha256Hex(heldout?.bytes ?? new Uint8Array())).toBe(task?.heldoutCommitment);
  const document = JSON.parse(heldout?.text ?? "{}") as { exact?: unknown; salt?: string };
  expect(document.exact).toEqual({ expected: ["Canberra", SECRET] });
  expect(document.salt).toMatch(/^[0-9a-f]{64,128}$/);
  expect(api.blobs.map(({ text }) => text).join("\n")).not.toContain(SECRET);

  // The task page shows the windows it was posted with.
  const timeline = page.getByTestId("phase-timeline");
  for (const [phase, span] of [
    ["revealing", "2h"],
    ["judging", "4h"],
    ["fallback", "1d"],
  ] as const) {
    await expect(timeline.locator(`[data-phase="${phase}"]`)).toContainText(span);
  }
});

test("post_form_fits_a_phone_and_shows_the_keyboard_focus", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const chain = new FakeChain(CONTRACT, [{ token: TOKEN, minReward: TUSDC(1) }]);
  chain.give(TOKEN, ALICE, TUSDC(50));
  chain.fundVault(ALICE, TOKEN, TUSDC(2));
  await routeApi(page);
  await installInjectedWallet(page, { account: ALICE, chain });
  await routePostApi(page, chain);

  /** Nothing is wider than the screen: nothing scrolls sideways. */
  const fits = async (where: string) => {
    const widths = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    const room = Math.min(375, widths.client);
    expect(widths.page, where).toBeLessThanOrEqual(room);
    expect(widths.body, where).toBeLessThanOrEqual(room);
  };

  /**
   * Every control the keyboard reaches shows where it is. Gives the ids it reached (or the words of
   * a control that has none). The walk begins at the top of the page.
   */
  const focusRing = async (): Promise<string[]> => {
    const reached: string[] = [];
    for (let presses = 0; presses < 120; presses++) {
      await page.keyboard.press("Tab");
      const focus = await page.evaluate(() => {
        const element = document.activeElement;
        // Past the last control of the page the Tab goes to the browser, or, in development, to
        // the dev tools' button that Next adds to the page.
        if (element === null || element === document.body) return null;
        if (element.tagName === "NEXTJS-PORTAL") return null;
        const style = getComputedStyle(element);
        return {
          name: element.id || element.textContent?.trim() || element.tagName,
          style: style.outlineStyle,
          width: Number.parseFloat(style.outlineWidth),
        };
      });
      if (focus === null) break;
      // A date and time field is one control with a stop for each of its parts.
      if (reached.at(-1) !== focus.name) reached.push(focus.name);
      expect(focus.style, `${focus.name} shows no focus ring`).not.toBe("none");
      expect(focus.width, `${focus.name}: the focus ring is thin`).toBeGreaterThanOrEqual(2);
    }
    return reached;
  };

  await page.goto("/post");
  await expect(page.getByLabel("Amount (tUSDC)")).toBeVisible();
  await fits("the form");
  // From the top of the page to its last control, and then from More options, opened, on.
  const top = await focusRing();
  await openMore(page);
  await fits("more options");
  expect([...top, ...(await focusRing())]).toEqual(
    expect.arrayContaining([
      "post-title",
      "post-instructions",
      "post-expected",
      "post-amount",
      "post-deadline",
      "post-more",
      "post-summary",
      "post-tags",
      "post-minScore",
      "post-outputFormat",
      "post-maxBytes",
      "post-invited",
      "Connect wallet",
    ]),
  );

  await fillBrief(page);
  for (const kind of [/Exact answer/, /JSON shape/, /Regex cases/]) {
    await page.getByRole("radio", { name: kind }).check();
    await fits(`checks: ${kind}`);
  }
  await fillRegexChecks(page);
  await page.getByLabel("Amount (tUSDC)").fill("5");
  await setWindows(page);
  await fits("windows set by hand");
  await page.getByRole("checkbox", { name: "Another account checks the work" }).check();
  await page.getByLabel("Their NEAR account").fill("bob.testnet");
  await fits("another checker");
  await page.getByRole("radio", { name: /^Tender Judge/ }).check();
  await page.getByRole("checkbox", { name: "Set each window yourself" }).uncheck();
  await page.getByRole("button", { name: "1 week from now" }).click();
  await fits("a deadline");

  await fits("not connected");
  await connect(page);
  await expect(page.getByRole("button", { name: "Post task" })).toHaveAttribute(
    "aria-disabled",
    "false",
  );
  await fits("connected");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Post task" })).toBeFocused();
  const ring = await page.evaluate(
    () => getComputedStyle(document.activeElement as Element).outlineStyle,
  );
  expect(ring).not.toBe("none");
});
