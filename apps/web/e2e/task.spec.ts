import { expect, type Page, test } from "@playwright/test";
import { sha256Hex } from "@tender/shared";
import { AT, HASH_A, HASH_B, SECOND } from "../test/tasks";
import {
  API_URL,
  HELDOUT_COMMITMENT,
  pickedPage,
  REGEX_TITLE,
  routeApi,
  TEAM_LABEL,
} from "./fixtures";

// The task page against the fixture API (e2e/fixtures.ts), which serves the event stream too. The
// page's clock is Playwright's: a spec sets the time and moves it, and the windows of a task end
// when it says so. The same page against a local chain and the real services is in
// e2e/chain/*.chain.ts (the second suite, playwright.chain.config.ts).

const TASK = "/tasks/2";
const JUDGE = "judge.tender-team.testnet";

/** The time `ns` nanoseconds after the epoch, as Playwright's clock takes one. */
const at = (ns: bigint) => new Date(Number(ns / 1_000_000n));

const chip = (page: Page) => page.getByTestId("phase-chip");
const summary = (page: Page) => page.getByTestId("entry-summary");
const row = (page: Page, account: string) =>
  page.getByTestId("entry-row").filter({ hasText: account });

test("task_page_updates_live_through_reveal", async ({ page }) => {
  await page.clock.install({ time: at(AT.commit - 20n * SECOND) });
  const api = await routeApi(page);
  await page.goto(TASK);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(REGEX_TITLE);
  await expect(page.getByTestId("poster").getByText(TEAM_LABEL)).toBeVisible();
  // A mark on the page itself: it is still there at the end only if the page was never reloaded.
  await page.evaluate(() => {
    (window as unknown as { kept: boolean }).kept = true;
  });

  // The commit window: all anyone can see is that entries were committed, and at which block.
  await expect(chip(page)).toHaveText("Open");
  await expect(page.getByTestId("live-status")).toContainText("Answer window (commit) closes in");
  await expect(summary(page)).toHaveText("2 committed · 0 revealed");
  await expect(row(page, "alice.testnet")).toContainText(
    "Sealed entry · committed at block 123456",
  );

  // An agent commits: the page shows it.
  api.commit("2", "carol.testnet");
  await expect(summary(page)).toHaveText("3 committed · 0 revealed");
  await expect(row(page, "carol.testnet")).toContainText("Sealed entry · committed at block");

  // The commit deadline passes. The page moves on with the clock, and asks for nothing.
  await page.clock.fastForward(30_000);
  await expect(chip(page)).toHaveText("Revealing");
  await expect(page.getByTestId("live-status")).toContainText("Opening window (reveal) closes in");

  // An agent reveals: its hash is there, and there is nothing to open yet.
  api.reveal("2", "alice.testnet", HASH_A);
  await expect(row(page, "alice.testnet")).toContainText(`Revealed · sha256 ${HASH_A}`);
  await expect(summary(page)).toHaveText("3 committed · 1 revealed");
  await expect(row(page, "bob.testnet")).toContainText("Sealed entry");
  await expect(page.getByRole("link", { name: /open content/i })).toHaveCount(0);

  // The reveal deadline passes: the content can be fetched, and an entry that was not revealed is out.
  await page.clock.fastForward(5 * 60_000);
  await expect(chip(page)).toHaveText("Judging");
  await expect(page.getByRole("link", { name: "Open content of alice.testnet" })).toHaveAttribute(
    "href",
    `${API_URL}/v1/blobs/${HASH_A}`,
  );
  await expect(row(page, "bob.testnet")).toContainText("Not revealed · committed at block");
  await expect(page.getByTestId("rule")).toHaveText("checker picks");

  expect(await page.evaluate(() => (window as unknown as { kept?: boolean }).kept)).toBe(true);
  // Every update came from the stream: it asked for the task again each time.
  expect(api.requests.filter((request) => request === "GET /v1/tasks/2").length).toBeGreaterThan(2);
});

test("scorecard_shows_recompute_line_after_pick", async ({ page }) => {
  await page.clock.install({ time: at(AT.reveal + 60n * SECOND) });
  const api = await routeApi(page);
  api.reveal("2", "alice.testnet", HASH_A);
  api.reveal("2", "bob.testnet", HASH_B);
  await page.goto(TASK);
  await expect(chip(page)).toHaveText("Judging");
  await expect(page.getByTestId("scorecard")).toHaveCount(0);
  await expect(page.getByTestId("payouts")).toHaveCount(0);

  // The Judge picks.
  const before = api.details.get("2");
  if (!before) throw new Error("the fixture has no task 2");
  api.settle(pickedPage(before));

  await expect(chip(page)).toHaveText("Settled");
  await expect(page.getByTestId("settled-by")).toHaveText(`Picked by ${JUDGE} (verifier)`);
  await expect(page.getByTestId("winner-row")).toHaveCount(1);
  await expect(page.getByTestId("score-row")).toHaveCount(2);
  await expect(page.getByTestId("recompute")).toHaveText(
    `Recompute: sha256(held-out) must equal ${HELDOUT_COMMITMENT}`,
  );

  // The held-out checks download as the bytes that were hashed: so the line can be followed.
  const href = await page.getByRole("link", { name: /held-out checks/i }).getAttribute("href");
  const prefix = "data:application/json;charset=utf-8,";
  expect(href?.startsWith(prefix)).toBe(true);
  expect(sha256Hex(decodeURIComponent((href ?? "").slice(prefix.length)))).toBe(HELDOUT_COMMITMENT);
});

// The settled page is the widest one: a scorecard table, the payouts, and the recompute line with
// the 64 hex characters of the commitment. "/tasks/3" (board.spec.ts) is the extreme of its data;
// this is the page that a Judge's pick turns the open one into, looked at on a phone.
test("settled_task_page_fits_a_phone", async ({ page }) => {
  const phone = { width: 375, height: 812 };
  await page.setViewportSize(phone);
  await page.clock.install({ time: at(AT.reveal + 60n * SECOND) });
  const api = await routeApi(page);
  api.reveal("2", "alice.testnet", HASH_A);
  api.reveal("2", "bob.testnet", HASH_B);
  await page.goto(TASK);
  await expect(chip(page)).toHaveText("Judging");

  const before = api.details.get("2");
  if (!before) throw new Error("the fixture has no task 2");
  api.settle(pickedPage(before));

  await expect(chip(page)).toHaveText("Settled");
  for (const id of ["scorecard", "payouts", "recompute"]) {
    await expect(page.getByTestId(id), `the ${id} of the settled page`).toBeVisible();
  }
  const { client, ...scroll } = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    page: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  // The room is the screen, less the width of a scrollbar where one takes any (`clientWidth`).
  const room = Math.min(phone.width, client);
  expect(scroll.page, "the page is wider than the screen").toBeLessThanOrEqual(room);
  expect(scroll.body, "the body is wider than the screen").toBeLessThanOrEqual(room);
});

test("api_down_shows_error_state", async ({ page }) => {
  await page.route(`${API_URL}/**`, (route) => route.abort("connectionrefused"));

  await page.goto(TASK);

  const error = page.getByTestId("error-state");
  await expect(error).toBeVisible();
  await expect(error).toContainText(/can't reach/i);
  const retry = error.getByRole("button", { name: "Retry" });
  await expect(retry).toBeVisible();
  await expect(page.getByTestId("phase-timeline")).toHaveCount(0);

  // The API comes back; the button loads the page.
  await page.unroute(`${API_URL}/**`);
  await routeApi(page);
  await retry.click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(REGEX_TITLE);
  await expect(error).toHaveCount(0);
});

test("scrubber_previews_each_rule_from_the_keyboard", async ({ page }) => {
  await page.clock.install({ time: at(AT.created + 30n * SECOND) });
  const api = await routeApi(page);
  await page.goto(TASK);
  const slider = page.getByRole("slider", { name: "Preview another moment" });
  const rule = page.getByTestId("rule");
  await expect(rule).toHaveText("answers are sealed");
  // Wait for the page to finish loading (the stream makes it ask once more when it opens), so
  // that what is counted below is what the preview does.
  const reads = () => api.requests.filter((request) => !request.includes("/v1/events")).length;
  await expect
    .poll(async () => {
      const before = reads();
      await page.waitForTimeout(300);
      return reads() === before;
    })
    .toBe(true);
  const asked = reads();

  // Home, then the arrow keys, a position at a time: a zone of the timeline is twenty presses, so
  // nineteen from the start are still in the commit window, and the twentieth is in the next.
  await slider.focus();
  await page.keyboard.press("Home");
  await expect(page.getByTestId("preview-status")).toBeVisible();
  for (let i = 0; i < 19; i++) await page.keyboard.press("ArrowRight");
  await expect(rule).toHaveText("answers are sealed");
  await page.keyboard.press("ArrowRight");
  await expect(rule).toHaveText("open or forfeit");

  // Home again, then Page Up (a tenth of the scale each): one zone per two presses.
  await page.keyboard.press("Home");
  await expect(rule).toHaveText("answers are sealed");
  const stops: Array<[presses: number, headline: string]> = [
    [3, "open or forfeit"],
    [2, "checker picks"],
    [2, "poster may pick"],
    [2, "anyone can refund"],
  ];
  for (const [presses, headline] of stops) {
    for (let i = 0; i < presses; i++) await page.keyboard.press("PageUp");
    await expect(rule).toHaveText(headline);
    await expect(slider).toHaveAttribute("aria-valuetext", new RegExp(headline));
  }

  // Back to now. The preview never touched the page: no request was made for it, the phase is
  // still the live one, and the rule is the live one.
  await page.getByRole("button", { name: "Back to now" }).click();
  await expect(rule).toHaveText("answers are sealed");
  await expect(page.getByTestId("preview-status")).toHaveCount(0);
  await expect(chip(page)).toHaveText("Open");
  expect(reads()).toBe(asked);
});

test("page_recovers_when_the_stream_is_refused_and_served_again", async ({ page }) => {
  const api = await routeApi(page);
  const streamRequests = () => api.requests.filter((request) => request.includes("/v1/events"));
  await page.goto(TASK);
  await expect(summary(page)).toHaveText("2 committed · 0 revealed");
  // The stream is up: the browser has been told where it stands and its next request is held,
  // waiting for more.
  await expect.poll(() => api.heldStreams()).toBeGreaterThan(0);

  // The server is full from now on. The open stream still delivers this one...
  api.refuseStreams(1);
  api.commit("2", "carol.testnet");
  await expect(summary(page)).toHaveText("3 committed · 0 revealed");

  // ...and then the browser is turned away. It gives up for good (an EventSource never retries
  // after a 503), and the page opens a new stream itself, after the wait, from the last id.
  await expect
    .poll(() => streamRequests().some((request) => request.endsWith("/v1/events?since=1")), {
      timeout: 15_000,
    })
    .toBe(true);

  // The server has room again. What happened meanwhile and what happens next both arrive.
  api.acceptStreams();
  api.commit("2", "dave.testnet");
  await expect(summary(page)).toHaveText("4 committed · 0 revealed", { timeout: 15_000 });
});
