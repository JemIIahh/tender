import { expect, test } from "@playwright/test";
import { routeApi } from "./fixtures";
import { openParity, pageFits } from "./parityApi";

// How it works in a browser: reached from the sidebar's foot and from the landing, with the fee
// and the bond read from the fixture node's config view.

test("how_it_works_is_at_the_sidebar_s_foot_and_reads_the_fee_from_the_contract", async ({
  page,
}) => {
  await openParity(page, "/tasks");
  const how = page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "How it works" });
  // At the foot of the sidebar, below every group.
  const [howBox, settingsBox] = await Promise.all([
    how.boundingBox(),
    page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Settings" })
      .boundingBox(),
  ]);
  expect(howBox?.y ?? 0).toBeGreaterThan(settingsBox?.y ?? 0);
  await how.click();
  await expect(page).toHaveURL("/how-it-works", { timeout: 20_000 });
  await expect(how).toHaveAttribute("aria-current", "page");

  await expect(page.getByTestId("fee")).toHaveText("5% of a reward, taken when it is paid out.");
  await expect(page.getByTestId("bond")).toContainText("5.00 tUSDC");
  await expect(page.getByRole("tab")).toHaveCount(5);
  expect(await pageFits(page)).toBe(0);
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await pageFits(page)).toBe(0);
});

test("the_landing_links_to_how_it_works", async ({ page }) => {
  await routeApi(page);
  await page.goto("/");
  await page.getByRole("link", { name: "How it works" }).click();
  await expect(page).toHaveURL("/how-it-works", { timeout: 20_000 });
});
