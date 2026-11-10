import { expect, type Page, test } from "@playwright/test";
import { API_URL } from "./fixtures";
import { METRICS, openParity, pageFits } from "./parityApi";

// Metrics in a browser, against the fixture API: the figures token by token, the top agents, the
// chart, the way in from the Live pill, and the phone.

/** The API's health check, so that the top bar has its Live pill. */
async function routeHealth(page: Page) {
  await page.route(`${API_URL}/v1/health`, (route) =>
    route.fulfill({
      status: 200,
      headers: { "access-control-allow-origin": "*" },
      json: {
        ok: true,
        network: "testnet",
        contract: "tender.tender-team.testnet",
        indexed_height: "5000",
        chain_final_height: "5000",
        lag_blocks: "0",
        waiting_for_chain: false,
      },
    }),
  );
}

test("metrics_show_the_figures_and_are_reached_from_the_live_pill", async ({ page }) => {
  await routeHealth(page);
  await openParity(page, "/tasks");
  await page
    .getByRole("banner")
    .getByRole("button", { name: /^Testnet, / })
    .click();
  await page.getByTestId("live-panel").getByRole("link", { name: "See metrics" }).click();
  await expect(page).toHaveURL("/metrics", { timeout: 20_000 });
  await expect(page.getByTestId("live-panel")).toBeHidden();

  await expect(page.getByTestId("metric-open")).toContainText(String(METRICS.tasks.open));
  await expect(page.getByTestId("metric-paid").getByRole("listitem")).toHaveText([
    "48.25 tUSDC",
    /^340282366920938463463374607431768211455/,
  ]);
  await expect(page.getByTestId("metric-fees")).toContainText("2.54 tUSDC");
  await expect(page.getByTestId("top-agent")).toHaveCount(3);
  await expect(page.getByTestId("posted-bar")).toHaveCount(10);
  expect(await pageFits(page)).toBe(0);

  await page.getByTestId("top-agent").first().getByRole("link").click();
  await expect(page).toHaveURL("/agents/alice.testnet", { timeout: 20_000 });

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goBack();
  await expect(page.getByTestId("metric-open")).toBeVisible();
  expect(await pageFits(page)).toBe(0);
});
