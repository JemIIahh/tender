import { expect, test } from "@playwright/test";
import { OWNER } from "./accountApi";
import { openParity, pageFits } from "./parityApi";

// Activity in a browser, against the fixture API: the backlog read once, then the fixture's event
// stream from its newest id, a filter, Mine, and the phone.

test("activity_shows_the_backlog_then_what_the_stream_says_and_filters", async ({ page }) => {
  const { fixture, parity } = await openParity(page, "/activity", {
    // The backlog's newest id is 4: the fixture's stream is moved there before the page opens, so
    // that it resumes after it as the API's would. These four are not sent to the page.
    beforeOpen: (api) => {
      for (const account of ["a.testnet", "b.testnet", "c.testnet", "d.testnet"]) {
        api.commit("1", account);
      }
    },
  });
  const lines = page.getByTestId("activity-line");
  await expect(lines).toHaveCount(4);
  await expect(lines.nth(0)).toHaveAttribute("data-kind", "paid");
  await expect(lines.nth(0)).toContainText("smallest units of 5f3a9c0e…5f3a9c0e");
  await expect(lines.nth(1)).toHaveAttribute("data-kind", "hired");
  await expect(lines.nth(1)).toContainText(`${OWNER} hired writer.acme.testnet with task #46`);
  await expect(lines.nth(1)).toContainText("price2.50 tUSDC");
  await expect(lines.nth(3)).toContainText("1d ago");
  // The backlog is read when the page opens (twice under `next dev`, whose strict mode mounts the
  // page twice), and not again: what comes after is the stream's.
  const backlogReads = () =>
    parity.requests.filter((request) => request.startsWith("GET /v1/events/recent")).length;
  const opened = backlogReads();
  expect(opened).toBeGreaterThanOrEqual(1);
  expect(opened).toBeLessThanOrEqual(2);

  // An entrant commits: the stream says so, and the line is on top, without a reload.
  fixture.commit("2", "carol.testnet");
  await expect(lines).toHaveCount(5);
  await expect(lines.nth(0)).toContainText("carol.testnet entered task #2");
  await expect(lines.nth(0)).toContainText("just now");
  expect(backlogReads()).toBe(opened);
  expect(await pageFits(page)).toBe(0);

  await page.getByRole("button", { name: "Hires" }).click();
  await expect(lines).toHaveCount(1);
  await page.getByRole("button", { name: "All" }).click();
  await expect(lines).toHaveCount(5);

  await page.setViewportSize({ width: 375, height: 812 });
  expect(await pageFits(page)).toBe(0);
});

test("activity_offers_mine_only_once_a_wallet_is_connected", async ({ page }) => {
  await openParity(page, "/my-tasks", { connect: true });
  await expect(page.getByRole("tab", { name: /To pick/ })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Activity" })
    .click();
  await expect(page).toHaveURL("/activity", { timeout: 20_000 });
  const mine = page.getByRole("checkbox", { name: "Mine only" });
  await mine.check();
  // Alice is named by one line of the backlog: the hire she made.
  await expect(page.getByTestId("activity-line")).toHaveCount(1);
  await expect(page.getByTestId("activity-line")).toHaveAttribute("data-kind", "hired");
});
