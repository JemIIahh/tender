import { expect, type Page, test } from "@playwright/test";
import { AT, SECOND } from "../test/tasks";
import {
  API_URL,
  COMMUNITY_TITLE,
  INVOICE_TITLE,
  REGEX_TITLE,
  routeApi,
  TASKS,
  TEAM_LABEL,
} from "./fixtures";
import { routeWalletManifest } from "./walletStub";

const card = (page: Page, title: string) =>
  page.getByTestId("task-card").filter({ hasText: title });

test("board_renders_seeded_tasks", async ({ page }) => {
  await routeApi(page);
  await page.goto("/tasks");

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
 * adds its own: "/agents", "/post" and "/telegram" are not here until they exist.
 */
const ROUTES: Record<string, (page: Page) => Promise<void>> = {
  // The landing, with its ticker's live figures in (they come from the fixture's open tasks).
  "/": (page) => expect(page.getByTestId("ticker-live").first()).toBeAttached(),
  "/tasks": (page) => expect(page.getByTestId("task-card")).toHaveCount(TASKS.length),
  // An open task with its timeline and its entries.
  "/tasks/2": (page) => expect(page.getByTestId("phase-timeline")).toBeVisible(),
  // A settled one with every part of the page, each as wide as the data can be (fixtures.ts).
  "/tasks/3": (page) => expect(page.getByTestId("recompute")).toBeVisible(),
  // Signed out: the connected page is looked at on a phone in wallet.spec.ts.
  "/wallet": (page) => expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible(),
};

test("phone_width_has_no_horizontal_scroll", async ({ page }) => {
  await page.setViewportSize(PHONE);
  // The moment the commit window of task 2 is open, so that its page has a live countdown on it.
  await page.clock.install({ time: new Date(Number((AT.commit - 20n * SECOND) / 1_000_000n)) });
  await routeApi(page);
  await routeWalletManifest(page);

  for (const [route, loaded] of Object.entries(ROUTES)) {
    await page.goto(route);
    await loaded(page);

    const { client, ...scroll } = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    // The page has to fit the room it has: the screen, less the width of a scrollbar where one takes
    // any (headed Chrome on Linux or Windows), which is what `clientWidth` is.
    const room = Math.min(PHONE.width, client);
    expect(scroll.page, `${route}: the page is wider than the screen`).toBeLessThanOrEqual(room);
    expect(scroll.body, `${route}: the body is wider than the screen`).toBeLessThanOrEqual(room);
  }
});

test("keyboard_focus_is_visible", async ({ page }) => {
  await routeApi(page);
  await page.goto("/tasks");
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

  await page.goto("/tasks");
  await expect(page.locator("main").getByRole("status")).toContainText("Loading");
  await page.clock.fastForward(20_000);

  const error = page.getByTestId("error-state");
  await expect(error).toContainText("too long");
  await expect(page.locator("main").getByRole("status")).toHaveCount(0);

  // Retry from the keyboard while the API is still silent. The error and its button stay on the
  // page, and the button keeps the focus: a browser drops it from a button that goes away.
  const retry = error.getByRole("button");
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(retry).toHaveText("Retrying…");
  await expect(retry).toBeFocused();
  await expect(page.locator("main").getByRole("status")).toHaveCount(0);

  await page.clock.fastForward(20_000);
  await expect(retry).toHaveText("Retry");
  await expect(retry).toBeFocused();

  // The API is back: the next try loads the board.
  silent = false;
  await retry.click();
  await expect(page.getByTestId("task-card")).toHaveCount(TASKS.length);
  await expect(error).toHaveCount(0);
});

test("board_filters_by_phase_and_tag_and_leads_to_the_task_page", async ({ page }) => {
  await routeApi(page);
  await page.goto("/tasks");
  await expect(page.getByTestId("task-card")).toHaveCount(TASKS.length);

  // No fixture task is settled.
  await page.getByRole("button", { name: "Settled" }).click();
  await expect(page.getByText("No tasks match these filters.")).toBeVisible();
  await page.getByRole("button", { name: "All" }).click();
  await expect(page.getByTestId("task-card")).toHaveCount(TASKS.length);

  // A tag, typed and sent with the Enter key.
  await page.getByRole("textbox", { name: "Tag" }).fill("Regex");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("task-card")).toHaveCount(1);
  await expect(card(page, REGEX_TITLE)).toBeVisible();
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByTestId("task-card")).toHaveCount(TASKS.length);

  // The title of a card is the way to its page.
  await page.getByRole("link", { name: REGEX_TITLE }).click();
  await expect(page).toHaveURL(/\/tasks\/2$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(REGEX_TITLE);
});

test("board_holds_the_cards_place_while_it_loads_and_its_shapes_keep_still_with_reduced_motion", async ({
  page,
}) => {
  await routeApi(page);
  // The board's read waits until it is let go (registered after the fixture, so asked first).
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`${API_URL}/v1/tasks*`, async (route) => {
    await held;
    await route.fallback();
  });

  await page.goto("/tasks");
  await expect(page.locator("main").getByRole("status")).toContainText("Loading tasks");
  // Three cards' shapes where the cards will be, hidden from a screen reader; they shimmer.
  const shapes = page.locator('main ul[aria-hidden="true"] > li');
  await expect(shapes).toHaveCount(3);
  const shimmer = shapes.first().locator(".skeleton").first();
  expect(await shimmer.evaluate((element) => getComputedStyle(element).animationName)).toBe(
    "skeleton",
  );
  const shape = await shapes.first().boundingBox();

  release();
  const firstCard = page.getByTestId("task-card").first();
  await expect(firstCard).toBeVisible();
  await expect(page.locator("main").getByRole("status")).toHaveCount(0);
  // The first card is where its shape was: nothing moved when the tasks landed.
  const loaded = await firstCard.boundingBox();
  expect(loaded?.x).toBeCloseTo(shape?.x ?? -1, 0);
  expect(loaded?.y).toBeCloseTo(shape?.y ?? -1, 0);
  expect(loaded?.width).toBeCloseTo(shape?.width ?? -1, 0);

  // With reduced motion the shapes are there, and still.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.unroute(`${API_URL}/v1/tasks*`);
  await page.route(`${API_URL}/v1/tasks*`, () => new Promise(() => {}));
  await page.reload();
  await expect(shapes).toHaveCount(3);
  expect(await shimmer.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
});

test("a_cut_raw_amount_copies_as_the_one_whole_number", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  // A phone, where the community task's 39-figure reward is cut in the middle on its card.
  await page.setViewportSize(PHONE);
  await routeApi(page);
  await page.goto("/tasks");
  const reward = page.getByTestId("card-raw-reward");
  await expect(reward.getByTestId("raw-head")).toBeVisible();
  const MAX = "340282366920938463463374607431768211455";

  // The person selects the whole line of the number, and copies it.
  await reward.getByTestId("raw-head").evaluate((head) => {
    const line = head.parentElement?.parentElement as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(line);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(MAX);
  await page.keyboard.press("ControlOrMeta+C");
  // What lands on the clipboard is the number once, whole: not the screen reader's copy as well,
  // and not cut in two by a line break.
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(MAX);
});
