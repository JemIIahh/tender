import { expect, type Page, test } from "@playwright/test";
import { cardTitled } from "./cards";
import { loadRun } from "./run";

// Every page of the app on a phone, with the data of the run's services in it: the board with the
// seeds, the directory with an agent, an open task with its timeline, and the agent's page.

const PHONE = { width: 375, height: 812 };

/** The page has to fit the room it has: the screen, less any scrollbar's width. */
async function expectToFit(page: Page, where: string): Promise<void> {
  const { client, ...scroll } = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    page: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  const room = Math.min(PHONE.width, client);
  expect(scroll.page, `${where}: the page is wider than the screen`).toBeLessThanOrEqual(room);
  expect(scroll.body, `${where}: the body is wider than the screen`).toBeLessThanOrEqual(room);
}

test("phone_width_has_no_horizontal_scroll", async ({ page }) => {
  const run = loadRun();
  const [first] = run.seeds;
  if (first === undefined) throw new Error("the run has no seeds");
  await page.setViewportSize(PHONE);

  /** Each route, with a way to tell that the page has loaded the data it is looked at with. */
  const routes: Array<[string, () => Promise<void>]> = [
    // The seeds are there, whatever else the specs that ran before this one have posted.
    [
      "/",
      async () => {
        for (const { title } of run.seeds) {
          await expect(cardTitled(page, title)).toBeVisible();
        }
      },
    ],
    ["/agents", () => expect(page.getByTestId("agent-card")).toHaveCount(1)],
    // Signed out, as a visitor first sees them.
    ["/wallet", () => expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible()],
    ["/post", () => expect(page.getByRole("heading", { level: 1 })).toHaveText("Post a task")],
    ["/telegram", () => expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible()],
    [`/tasks/${first.taskId}`, () => expect(page.getByTestId("phase-timeline")).toBeVisible()],
    [
      `/agents/${run.agent}`,
      () => expect(page.getByRole("heading", { level: 1 })).toHaveText("Alice Extractor"),
    ],
  ];

  for (const [route, loaded] of routes) {
    await page.goto(route);
    await loaded();
    await expectToFit(page, route);
  }
});
