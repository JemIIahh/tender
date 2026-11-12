import { expect, type Page, test } from "@playwright/test";
import { OWNER } from "./accountApi";
import { routeApi, TASKS } from "./fixtures";
import { openParity, pageFits } from "./parityApi";
import { pickStubWallet } from "./walletStub";

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

/**
 * The hero art's own pixels (its canvas, as a data URL), and whether anything is drawn on it yet.
 * Not a screenshot of its box: the box also holds the headline, the typed code and the ticker,
 * which change on their own (the ticker's figures land whenever the API answers), so a screenshot
 * can change while the art holds still.
 */
function artPixels(page: Page): Promise<{ drawn: boolean; pixels: string }> {
  return page.getByTestId("art-hero").evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    const { data } =
      context?.getImageData(0, 0, canvas.width, canvas.height) ?? new ImageData(1, 1);
    // The art is drawn on a clear canvas: any pixel that is not clear is the art.
    const drawn = data.some((value, index) => index % 4 === 3 && value !== 0);
    return { drawn, pixels: canvas.toDataURL() };
  });
}

/** Lets the page draw `frames` frames and `ms` pass, whichever is longer, however busy it is. */
function framesPass(page: Page, frames: number, ms: number): Promise<void> {
  return page.evaluate(
    ([count, least]) =>
      new Promise<void>((done) => {
        const start = performance.now();
        let seen = 0;
        const step = () => {
          seen += 1;
          if (seen >= count && performance.now() - start >= least) done();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    [frames, ms] as const,
  );
}

test("landing_art_moves_and_holds_still_with_reduced_motion", async ({ page }) => {
  // It waits for real frames, as many as a busy machine takes to draw: three times the time.
  test.slow();
  await routeApi(page);
  const art = page.getByTestId("art-hero");

  // The art's code comes after the page (components/landing/DitherArt.tsx): its first frame is
  // waited for, however long a busy machine takes, and only then is it watched.
  await page.goto("/");
  await expect(art).toBeVisible();
  await expect.poll(async () => (await artPixels(page)).drawn, { timeout: 30_000 }).toBe(true);
  const before = (await artPixels(page)).pixels;
  await expect
    .poll(async () => (await artPixels(page)).pixels, {
      message: "the art should move",
      timeout: 10_000,
    })
    .not.toBe(before);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(art).toBeVisible();
  await expect.poll(async () => (await artPixels(page)).drawn, { timeout: 30_000 }).toBe(true);
  const still = (await artPixels(page)).pixels;
  // Room for dozens of frames of the show, which plays 24 a second: with reduced motion, none.
  await framesPass(page, 60, 1500);
  expect((await artPixels(page)).pixels, "the art should hold still").toBe(still);
});

test("landing_top_bar_launches_the_market_and_shows_no_account_even_when_connected", async ({
  page,
}) => {
  // Not connected: Launch market and the app's main areas, and no Connect wallet.
  await openParity(page, "/");
  const bar = page.getByRole("banner").first();
  await expect(bar.getByRole("link", { name: "Launch market" })).toHaveAttribute("href", "/tasks");
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link")).toHaveText([
    "Tasks",
    "Agents",
    "Services",
    "How it works",
  ]);
  await expect(bar.getByRole("link", { name: /Connect/ })).toHaveCount(0);
  await expect(bar.getByRole("link", { name: OWNER })).toHaveCount(0);

  // Connected in the app, then the landing, loaded afresh and reached from the app: still Launch
  // market alone. The account is the app's to show.
  await page.getByRole("link", { name: "Launch market" }).click();
  await expect(page).toHaveURL(/\/tasks$/, { timeout: 20_000 });
  await page.goto("/my-tasks");
  await page.locator("main").getByRole("button", { name: "Connect wallet" }).click();
  await pickStubWallet(page);
  await expect(page.getByRole("banner").getByRole("link", { name: OWNER })).toBeVisible();
  for (const reach of ["load", "wordmark"] as const) {
    if (reach === "load") await page.goto("/");
    else {
      await page.goto("/my-tasks");
      await page.getByRole("link", { name: "Tender" }).first().click();
      await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
    }
    const top = page.getByRole("banner").first();
    await expect(top.getByRole("link", { name: "Launch market" })).toBeVisible();
    await expect(top.getByRole("link", { name: OWNER })).toHaveCount(0);
    await expect(top.getByRole("link", { name: /Connect/ })).toHaveCount(0);
  }
  expect(await pageFits(page)).toBe(0);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(
    page.getByRole("banner").first().getByRole("link", { name: "Launch market" }),
  ).toBeVisible();
  expect(await pageFits(page)).toBe(0);
});
