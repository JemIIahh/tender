import { expect, type Page, test } from "@playwright/test";
import { API_URL, routeApi, TASKS } from "./fixtures";

// The top bar's Live pill (components/LiveStatus.tsx) in a browser: its word and dot, the panel of
// figures it opens from the pointer and the keyboard, and the phone, where it is the dot alone. The
// fixture API has no health check of its own; each spec answers it as the state it needs.

const HEALTH = {
  ok: true,
  network: "testnet",
  contract: "tender.tender-team.testnet",
  indexed_height: "5000",
  chain_final_height: "5000",
  lag_blocks: "0",
  waiting_for_chain: false,
};

/** The API's health check, answered with `body` (registered after `routeApi`, so it comes first). */
async function routeHealth(page: Page, body: object, status = 200) {
  await page.route(`${API_URL}/v1/health`, (route) =>
    route.fulfill({ status, json: body, headers: { "access-control-allow-origin": "*" } }),
  );
}

const pill = (page: Page) => page.getByRole("banner").getByRole("button", { name: /^Status: / });
const panel = (page: Page) => page.getByTestId("live-panel");

test("live_pill_opens_the_figures_and_closes_with_escape", async ({ page }) => {
  await routeApi(page);
  await routeHealth(page, HEALTH);
  await page.goto("/tasks");

  await expect(pill(page)).toHaveAccessibleName("Status: Live");
  await expect(pill(page)).toHaveText("Live");
  await expect(pill(page).getByTestId("live-dot")).toHaveAttribute("data-state", "synced");
  // It sits left of Post task, in the top bar.
  const [pillBox, postBox] = await Promise.all([
    pill(page).boundingBox(),
    page.getByRole("banner").getByRole("link", { name: "Post task" }).boundingBox(),
  ]);
  expect((pillBox?.x ?? 0) + (pillBox?.width ?? 0)).toBeLessThanOrEqual(postBox?.x ?? 0);

  await pill(page).click();
  await expect(pill(page)).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("live-line")).toHaveText("Up to date");
  const open = TASKS.filter((task) => task.phase === "open").length;
  await expect(page.getByTestId("live-figure").first()).toHaveText(`Open tasks${open}`);
  // No block heights, no counts of blocks.
  await expect(panel(page)).not.toContainText("5000");
  await expect(panel(page)).not.toContainText(/block/i);

  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
  await expect(pill(page)).toBeFocused();
  await expect(pill(page)).toHaveAttribute("aria-expanded", "false");

  // From the keyboard: Enter opens it, Space closes it.
  await page.keyboard.press("Enter");
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press(" ");
  await expect(panel(page)).toBeHidden();

  // A press elsewhere on the page closes it too.
  await pill(page).click();
  await page.getByRole("heading", { level: 1 }).click();
  await expect(panel(page)).toBeHidden();
});

test("live_pill_says_catching_up_without_numbers_of_blocks", async ({ page }) => {
  await routeApi(page);
  await routeHealth(page, { ...HEALTH, chain_final_height: "5444", lag_blocks: "444" });
  await page.goto("/tasks");

  await expect(pill(page)).toHaveText("Catching up");
  await expect(pill(page).getByTestId("live-dot")).toHaveAttribute("data-state", "behind");
  await pill(page).click();
  await expect(page.getByTestId("live-line")).toHaveText("Catching up with the chain");
  await expect(panel(page)).not.toContainText("444");
});

test("live_pill_is_the_dot_alone_on_a_phone_and_its_panel_fits", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await routeApi(page);
  await routeHealth(page, HEALTH);
  await page.goto("/tasks");

  await expect(pill(page)).toHaveAccessibleName("Status: Live");
  // The word is there for a screen reader only: a box of a pixel at most.
  expect((await pill(page).getByText("Live").boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);
  expect((await pill(page).boundingBox())?.width).toBeCloseTo(40, 0);
  const fits = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
  expect(await fits()).toBe(0);

  await pill(page).click();
  const box = await panel(page).boundingBox();
  // Across the screen under the top bar, 16px in from each side.
  expect(box?.x).toBeCloseTo(16, 0);
  expect(box?.width).toBeCloseTo(375 - 32, 0);
  expect(box?.y ?? 0).toBeGreaterThanOrEqual(64);
  expect(await fits()).toBe(0);
  // It is placed against the screen, 4.5rem from its top, and not against the top bar: no box
  // around it is one that a fixed part is placed in (a transform, a filter or a backdrop filter
  // makes one), so it stays where it is whatever the bar's look.
  expect(box?.y).toBeCloseTo(72, 0);
  const holders = await panel(page).evaluate((element) => {
    const found: string[] = [];
    for (let at = element.parentElement; at !== null; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (
        style.transform !== "none" ||
        style.filter !== "none" ||
        style.backdropFilter !== "none" ||
        style.perspective !== "none" ||
        /paint|layout|strict|content/.test(style.contain) ||
        /transform|filter|perspective/.test(style.willChange)
      ) {
        found.push(`${at.tagName.toLowerCase()}.${at.className}`);
      }
    }
    return found;
  });
  expect(holders).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
  await expect(pill(page)).toBeFocused();
});
