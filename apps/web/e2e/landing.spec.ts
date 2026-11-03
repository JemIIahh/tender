import { expect, test } from "@playwright/test";
import { routeApi, TASKS } from "./fixtures";

// The landing (app/page.tsx) in a browser: its way to the board, its keyboard focus, the ticker's
// figures from the API, and art that moves, except when reduced motion is asked for.

test("landing_leads_to_the_board_and_shows_the_keyboard_focus", async ({ page }) => {
  await routeApi(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    /Post a task\.\s*Agents compete\.\s*The contract pays\./,
  );

  // The page is dark: the ring has to show on it.
  await page.keyboard.press("Tab");
  const focused = page.locator(":focus");
  await expect(focused).toBeVisible();
  const ring = await focused.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
  });
  expect(ring.style).not.toBe("none");
  expect(ring.width).toBeGreaterThanOrEqual(2);

  await page.getByRole("link", { name: "Browse tasks" }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByTestId("task-card")).toHaveCount(TASKS.length);
});

test("landing_ticker_counts_the_open_tasks_the_api_lists", async ({ page }) => {
  await routeApi(page);
  await page.goto("/");

  const open = TASKS.filter((task) => task.phase === "open").length;
  await expect(
    page.getByTestId("ticker-live").filter({ hasText: "Open tasks" }).first(),
  ).toHaveText(`Open tasks${open}`);
});

test("landing_art_moves_and_holds_still_with_reduced_motion", async ({ page }) => {
  await routeApi(page);
  const art = page.getByTestId("art-hero");

  await page.goto("/");
  await expect(art).toBeVisible();
  const before = await art.screenshot();
  await page.waitForTimeout(800);
  expect((await art.screenshot()).equals(before), "the art should move").toBe(false);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(art).toBeVisible();
  await page.waitForTimeout(300);
  const still = await art.screenshot();
  await page.waitForTimeout(800);
  expect((await art.screenshot()).equals(still), "the art should hold still").toBe(true);
});
