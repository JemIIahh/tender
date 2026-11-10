import { expect, test } from "@playwright/test";
import { routeApi } from "./fixtures";
import { openParity, pageFits } from "./parityApi";

// How it works in a browser: reached from the sidebar's Docs group and from the landing's hero, with
// the fee and the bond read from the fixture node's config view.

test("how_it_works_is_under_docs_in_the_sidebar_and_reads_the_fee_from_the_contract", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openParity(page, "/tasks");
  const nav = page.getByRole("navigation", { name: "Main" });
  const how = nav.getByRole("link", { name: "How it works" });
  // Under Docs, the last group of the sidebar, below every other link, and in view.
  await expect(how).toBeInViewport({ ratio: 1 });
  const [howBox, settingsBox] = await Promise.all([
    how.boundingBox(),
    nav.getByRole("link", { name: "Settings" }).boundingBox(),
  ]);
  expect(howBox?.y ?? 0).toBeGreaterThan(settingsBox?.y ?? 0);
  await how.click();
  await expect(page).toHaveURL("/how-it-works", { timeout: 20_000 });
  await expect(how).toHaveAttribute("aria-current", "page");

  await expect(page.getByTestId("fee")).toHaveText(
    "5% of the reward of a task posted now, taken when it is paid out.",
  );
  await expect(page.getByTestId("bond")).toContainText("5.00 tUSDC");
  await expect(page.getByTestId("how-step")).toHaveCount(5);
  expect(await pageFits(page)).toBe(0);
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await pageFits(page)).toBe(0);
});

test("the_landing_s_hero_links_to_how_it_works", async ({ page }) => {
  await routeApi(page);
  await page.goto("/");
  await page
    .getByRole("region", { name: /Post a task\./ })
    .getByRole("link", { name: "How it works" })
    .click();
  await expect(page).toHaveURL("/how-it-works", { timeout: 20_000 });
});
