import { expect, type Locator, type Page, test } from "@playwright/test";
import { SIGN_IN_MESSAGE, sha256Hex } from "@tender/shared";
import { FakeChain } from "../test/fakeChain";
import { API_URL, routeApi } from "./fixtures";
import { installInjectedWallet } from "./injectedWallet";
import { routePostApi } from "./postApi";
import { STUB_WALLET_NAME } from "./walletStub";

// The post wizard in a browser: a person writes a task, the wizard uploads its documents to a
// fixture API (e2e/postApi.ts), asks a wallet (e2e/injectedWallet.ts) to sign in and to send one
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

async function fillBrief(page: Page): Promise<void> {
  await page.getByLabel("Title", { exact: true }).fill("Regex for NEAR account ids");
  await page.getByLabel("Summary (optional)").fill("One regex that tells valid ids from invalid.");
  await page
    .getByLabel("Instructions", { exact: true })
    .fill("Return the pattern and its flags.\nAnchor it at both ends.");
  await page.getByLabel("Category", { exact: true }).selectOption("coding");
  await page.getByLabel("Tags (optional)").fill("regex, near");
}

async function fillRegexChecks(page: Page): Promise<void> {
  await page.getByRole("radio", { name: /Regex cases/ }).check();
  await page.getByLabel("Should match", { exact: true }).fill("alice.near\nbob.testnet");
  await page.getByLabel("Should not match", { exact: true }).fill("-bad\nUPPER");
  await page
    .getByLabel("Held-out: should match", { exact: true })
    .fill(`${SECRET}.near\ncarol.near`);
  await page
    .getByLabel("Held-out: should not match", { exact: true })
    .fill("dave..near\n_eve.near");
}

/** Writes the whole task, step by step, and stops on the Review step. */
async function writeTask(page: Page, amount = "5"): Promise<void> {
  await page.goto("/post");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Post a task");
  await fillBrief(page);
  await page.getByRole("button", { name: "Next: Checks" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Checks" })).toBeFocused();
  await fillRegexChecks(page);
  await page.getByRole("button", { name: "Next: Reward" }).click();
  await page.getByLabel("Amount (tUSDC)").fill(amount);
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Review" })).toBeFocused();
}

async function connect(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Connect wallet" }).click();
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

  // The review says what is about to happen, and counts the checks the Judge keeps.
  await expect(page.getByTestId("review-title")).toHaveText("Regex for NEAR account ids");
  await expect(page.getByTestId("review-reward")).toContainText("5.00 tUSDC");
  await expect(page.getByTestId("review-heldout")).toHaveText("4 cases");
  await expect(page.getByTestId("review-verifier")).toContainText("Tender Judge");
  await expect(page.getByTestId("review-account")).toHaveText("Not connected");
  await expect(page.getByRole("button", { name: "Post task" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
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
  await expect(status).toContainText("Commit window closes in");
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

test("post_wizard_fits_a_phone_and_shows_the_keyboard_focus", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const chain = new FakeChain(CONTRACT, [{ token: TOKEN, minReward: TUSDC(1) }]);
  chain.give(TOKEN, ALICE, TUSDC(50));
  chain.fundVault(ALICE, TOKEN, TUSDC(2));
  await routeApi(page);
  await installInjectedWallet(page, { account: ALICE, chain });
  await routePostApi(page, chain);

  /** No step is wider than the screen: nothing scrolls sideways. */
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
   * Every control the keyboard reaches shows where it is. Gives the ids it reached. The walk begins
   * at the top of the page, or on `from` (which is not one of the controls it reached).
   */
  const focusRing = async (from?: Locator): Promise<string[]> => {
    const reached: string[] = [];
    await from?.focus();
    for (let presses = 0; presses < 60; presses++) {
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
      reached.push(focus.name);
      expect(focus.style, `${focus.name} shows no focus ring`).not.toBe("none");
      expect(focus.width, `${focus.name}: the focus ring is thin`).toBeGreaterThanOrEqual(2);
    }
    return reached;
  };

  await page.goto("/post");
  await expect(page.getByRole("heading", { level: 2, name: "Brief" })).toBeVisible();
  await fits("brief");
  expect(await focusRing()).toEqual(
    expect.arrayContaining([
      "post-title",
      "post-summary",
      "post-instructions",
      "post-category",
      "post-tags",
      "post-outputFormat",
      "post-maxBytes",
      "Next: Checks",
    ]),
  );

  await fillBrief(page);
  await page.getByRole("button", { name: "Next: Checks" }).click();
  for (const kind of [/Exact answer/, /JSON shape/, /Regex cases/]) {
    await page.getByRole("radio", { name: kind }).check();
    await fits(`checks: ${kind}`);
  }
  await fillRegexChecks(page);
  await page.getByRole("button", { name: "Next: Reward" }).click();
  await page.getByLabel("Amount (tUSDC)").fill("5");
  await fits("reward");
  await page.getByRole("radio", { name: /^Custom/ }).check();
  await fits("reward, custom windows");
  await page.getByRole("radio", { name: /^Another account/ }).check();
  await fits("reward, another verifier");
  await page.getByRole("radio", { name: /^Tender Judge/ }).check();
  await page.getByRole("radio", { name: /^Quick/ }).check();

  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Review" })).toBeVisible();
  await fits("review, not connected");
  await connect(page);
  await expect(page.getByRole("button", { name: "Post task" })).toHaveAttribute(
    "aria-disabled",
    "false",
  );
  await fits("review, connected");
  expect(await focusRing(page.getByRole("button", { name: "1 Brief" }))).toEqual(
    expect.arrayContaining(["Back", "Post task"]),
  );
});
