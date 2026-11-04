import { expect, type Page, test } from "@playwright/test";
import { routeApi } from "./fixtures";

// The sidebar's rail (components/AppShell.tsx, lib/sidebar.ts) in a browser: what jsdom cannot
// show. Its width, the words that fade, the wordmark that moves to the top bar, the choice kept
// across a load and drawn before the page's code runs, the shortcut, the tooltips, and the phone,
// where there is no rail.

const sidebar = (page: Page) => page.locator("aside");
/** The toggle, whose name stays "Sidebar"; `aria-expanded` says whether the sidebar is wide. */
const toggle = (page: Page) => page.getByRole("button", { name: "Sidebar", exact: true });
const nav = (page: Page) => page.getByRole("navigation", { name: "Main" });
const width = async (page: Page) => (await sidebar(page).boundingBox())?.width ?? 0;

/** The sidebar's width once its change is over: 15rem wide, 4rem as the rail. */
async function settledWidth(page: Page, expected: number) {
  await expect.poll(() => width(page)).toBeCloseTo(expected, 0);
}

test("sidebar_becomes_a_rail_and_back_and_the_mark_moves_to_the_top_bar", async ({ page }) => {
  await routeApi(page);
  await page.goto("/tasks");
  await settledWidth(page, 240);
  const barMark = page.getByTestId("bar-wordmark");
  const sideMark = page.getByTestId("side-wordmark");
  await expect(barMark).toBeHidden();
  await expect(sideMark).toBeVisible();
  await expect(nav(page).getByText("Browse agents")).toBeVisible();

  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await toggle(page).click();
  await settledWidth(page, 64);
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  // The mark is in the top bar now, and the sidebar's is put away.
  await expect(barMark).toBeVisible();
  await expect(sideMark).toBeHidden();
  // Every link is still there, as an icon the size of the rail, the page you are on still marked.
  const links = nav(page).getByRole("link");
  await expect(links).toHaveCount(15);
  for (const link of await links.all()) {
    const box = await link.boundingBox();
    expect(box?.width).toBeCloseTo(40, 0);
  }
  await expect(nav(page).getByRole("link", { name: "Marketplace" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  // The words are faded out.
  await expect
    .poll(() =>
      nav(page)
        .getByText("Browse agents")
        .evaluate((element) => getComputedStyle(element).opacity),
    )
    .toBe("0");
  // Nothing in the sidebar is wider than the rail, so nothing can scroll it sideways.
  expect(await sidebar(page).evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(
    0,
  );

  await toggle(page).click();
  await settledWidth(page, 240);
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(barMark).toBeHidden();
  await expect(sideMark).toBeVisible();
});

test("sidebar_rail_is_kept_and_drawn_before_the_page_s_code_runs", async ({ page }) => {
  await routeApi(page);
  await page.goto("/tasks");
  await toggle(page).click();
  await settledWidth(page, 64);

  await page.reload();
  await settledWidth(page, 64);
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");

  // The page as the server sends it, with none of the app's code run: only the script in the head.
  // It is already the rail, so the first frame a visitor sees is the rail, and not the wide sidebar
  // that the code would then narrow.
  await page.route("**/_next/static/**/*.js", (route) => route.abort());
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.dataset.sidebar)).toBe("rail");
  expect(await width(page)).toBeCloseTo(64, 0);
});

test("sidebar_shortcut_toggles_it_but_not_from_a_text_field", async ({ page }) => {
  await routeApi(page);
  await page.goto("/tasks");
  await settledWidth(page, 240);

  await page.keyboard.press("Control+b");
  await settledWidth(page, 64);
  await page.keyboard.press("Meta+b");
  await settledWidth(page, 240);

  // In the board's tag field, ⌘B is the field's.
  const field = page.getByRole("textbox").first();
  await field.focus();
  await page.keyboard.press("Control+b");
  await page.keyboard.press("Meta+b");
  await page.waitForTimeout(400);
  expect(await width(page)).toBeCloseTo(240, 0);
  await expect(field).toBeFocused();
});

test("sidebar_shortcut_is_left_to_editable_text", async ({ page }) => {
  await routeApi(page);
  await page.goto("/tasks");
  await settledWidth(page, 240);

  // No page has editable text of its own yet: a box of it goes on the page, as a rich editor would
  // put one, with a line in it. Whatever the page does with ⌘B, the window hears last.
  await page.evaluate(() => {
    const box = document.createElement("div");
    box.contentEditable = "true";
    box.dataset.testid = "editable";
    box.innerHTML = "<p>A note, <span>in a line of its own</span></p>";
    document.querySelector("main")?.append(box);
    const taken: boolean[] = [];
    (window as unknown as { taken: boolean[] }).taken = taken;
    window.addEventListener("keydown", (event) => {
      if (event.key.toLowerCase() === "b") taken.push(event.defaultPrevented);
    });
  });
  const editable = page.getByTestId("editable");
  await editable.locator("span").click();
  await page.keyboard.press("Control+b");
  await page.keyboard.press("Meta+b");
  await page.waitForTimeout(400);
  // The sidebar stays as it was, the focus stays in the text, and the page took neither press.
  expect(await width(page)).toBeCloseTo(240, 0);
  await expect(editable).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { taken: boolean[] }).taken)).toEqual([
    false,
    false,
  ]);

  // Out of the text, the shortcut is the page's again.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Control+b");
  await settledWidth(page, 64);
});

test("sidebar_rail_names_each_icon_in_a_tooltip_beside_it", async ({ page }) => {
  await routeApi(page);
  await page.goto("/tasks");
  const button = toggle(page);
  await button.hover();
  const tip = page.getByTestId("sidebar-tip");
  // The tooltip's words say what a press does, and follow the sidebar; the name does not change.
  await expect(tip).toHaveText(/^Hide sidebar(⌘B|Ctrl\+B)$/);

  await button.click();
  await settledWidth(page, 64);
  await expect(tip).toHaveText(/^Show sidebar/);

  const providers = nav(page).getByRole("link", { name: "Providers" });
  await providers.hover();
  await expect(tip).toHaveText("Providers");
  // Beside the icon, outside the rail, and not cut off by it.
  const [link, box] = await Promise.all([providers.boundingBox(), tip.boundingBox()]);
  expect(box?.x ?? 0).toBeGreaterThan(64);
  const middle = (link?.y ?? 0) + (link?.height ?? 0) / 2;
  expect(Math.abs((box?.y ?? 0) + (box?.height ?? 0) / 2 - middle)).toBeLessThan(2);

  await page.keyboard.press("Escape");
  await expect(tip).toBeHidden();
});

test("sidebar_change_is_instant_with_reduced_motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await routeApi(page);
  await page.goto("/tasks");
  // Nothing in the shell is animated: the width, the fading parts and the words of the links.
  const animated = await page.evaluate(() =>
    [
      document.querySelector(".app"),
      document.querySelector('[data-testid="side-wordmark"]'),
      document.querySelector('nav[aria-label="Main"] a span'),
    ].map((element) => getComputedStyle(element as Element).transitionProperty),
  );
  expect(animated).toEqual(["none", "none", "none"]);
});

test("sidebar_on_a_phone_is_the_menu_and_has_no_rail", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await routeApi(page);
  await page.goto("/tasks");
  await expect(toggle(page)).toBeHidden();

  await page.keyboard.press("Meta+b");
  await page.keyboard.press("Control+b");
  expect(await page.evaluate(() => document.documentElement.dataset.sidebar)).toBeUndefined();

  // The menu, with every page by its words.
  await page.getByRole("button", { name: "Menu" }).click();
  await expect(nav(page).getByText("Providers")).toBeVisible();
  await expect(nav(page).getByText("Add an agent")).toBeVisible();
});
