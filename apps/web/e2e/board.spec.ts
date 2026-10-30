import { expect, type Page, test } from "@playwright/test";
import {
  API_URL,
  COMMUNITY_TITLE,
  INVOICE_TITLE,
  REGEX_TITLE,
  routeApi,
  TASKS,
  TEAM_LABEL,
} from "./fixtures";

const card = (page: Page, title: string) =>
  page.getByTestId("task-card").filter({ hasText: title });

test("board_renders_seeded_tasks", async ({ page }) => {
  await routeApi(page);
  await page.goto("/");

  for (const title of [REGEX_TITLE, INVOICE_TITLE]) {
    await expect(card(page, title)).toBeVisible();
    // The label is on the poster's line, where a reader looks for who is behind the task.
    await expect(
      card(page, title).getByTestId("poster").getByText(TEAM_LABEL, { exact: true }),
    ).toBeVisible();
  }

  // A poster outside the team shows its account and no label.
  await expect(card(page, COMMUNITY_TITLE)).toBeVisible();
  await expect(card(page, COMMUNITY_TITLE).getByText(TEAM_LABEL)).toHaveCount(0);
});

const PHONE = { width: 375, height: 812 };

/**
 * The routes to look at on a phone, each with a way to tell that the page has loaded. A later task
 * adds its own: "/agents", "/wallet", "/post" and "/telegram" are not here until they exist.
 */
const ROUTES: Record<string, (page: Page) => Promise<void>> = {
  "/": (page) => expect(page.getByTestId("task-card")).toHaveCount(TASKS.length),
};

test("phone_width_has_no_horizontal_scroll", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await routeApi(page);

  for (const [route, loaded] of Object.entries(ROUTES)) {
    await page.goto(route);
    await loaded(page);

    const scrollWidth = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(scrollWidth.page, `${route}: the page is wider than the screen`).toBeLessThanOrEqual(
      PHONE.width,
    );
    expect(scrollWidth.body, `${route}: the body is wider than the screen`).toBeLessThanOrEqual(
      PHONE.width,
    );
  }
});

test("keyboard_focus_is_visible", async ({ page }) => {
  await routeApi(page);
  await page.goto("/");
  await expect(page.getByTestId("task-card")).toHaveCount(TASKS.length);

  await page.keyboard.press("Tab");

  const focused = page.locator(":focus");
  await expect(focused).toBeVisible();
  const outline = await focused.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
  });
  expect(outline.style).not.toBe("none");
  expect(outline.width).toBeGreaterThanOrEqual(2);
});

// A request that gets no answer must end, and not leave the board loading for good. The page's own
// timers run on Playwright's clock here, so the wait is a jump and not 15 seconds.
test("silent_api_ends_in_an_error_state_and_retry_loads_the_board", async ({ page }) => {
  await page.clock.install();
  await routeApi(page);
  // Registered after the fixture, so it is asked first: while `silent` is set it never answers
  // (in development the board asks twice at start), and after that it passes the request on.
  let silent = true;
  await page.route(`${API_URL}/v1/tasks*`, async (route) => {
    if (!silent) await route.fallback();
  });

  await page.goto("/");
  await expect(page.getByRole("status")).toContainText("Loading");
  await page.clock.fastForward(20_000);

  const error = page.getByTestId("error-state");
  await expect(error).toContainText("too long");
  await expect(page.getByRole("status")).toHaveCount(0);

  silent = false;
  await error.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("task-card")).toHaveCount(TASKS.length);
  await expect(error).toHaveCount(0);
});
