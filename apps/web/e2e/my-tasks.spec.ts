import { expect, test } from "@playwright/test";
import { OWNER } from "./accountApi";
import { openParity, pageFits } from "./parityApi";

// My tasks in a browser, against the fixture API and alice's wallet: what she has to pick, with its
// count, what she posted with the next step on each, her hires, and the phone.

const PHONE = { width: 375, height: 812 };

test("my_tasks_lists_what_to_pick_what_was_posted_and_the_hires_with_their_next_step", async ({
  page,
}) => {
  const { parity } = await openParity(page, "/my-tasks", { connect: true });

  // To pick comes first, with its count: task 2, which alice verifies, in its judge window.
  const pickTab = page.getByRole("tab", { name: /To pick/ });
  await expect(pickTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("pick-count")).toHaveText("1 to pick");
  const toPick = page.getByTestId("to-pick").getByTestId("my-task");
  await expect(toPick).toHaveCount(1);
  await expect(toPick.getByTestId("next-step")).toHaveAccessibleName("Pick the winners of task #2");
  expect(parity.requests).toContain(`GET /v1/tasks?phase=judging&verifier=${OWNER}&limit=50`);

  // Posted: alice's four tasks, each with what she can do next, or nothing.
  await page.getByRole("tab", { name: "Posted" }).click();
  await expect(page).toHaveURL("/my-tasks?tab=posted");
  const posted = page.getByTestId("posted").getByTestId("my-task");
  await expect(posted).toHaveCount(4);
  await expect(posted.nth(0).getByTestId("next-step")).toHaveAttribute("data-step", "refund");
  await expect(posted.nth(1).getByTestId("next-step")).toHaveCount(0);
  await expect(posted.nth(3).getByTestId("next-step")).toHaveAttribute("data-step", "top-up");
  expect(await pageFits(page)).toBe(0);

  // Hires: read with the hire filter.
  await page.getByRole("tab", { name: "Hires" }).click();
  await expect(page.getByTestId("hires").getByTestId("my-task")).toHaveText(
    /Hire: Summarise a filing/,
  );
  expect(parity.requests).toContain(`GET /v1/tasks?poster=${OWNER}&hire=true&limit=50`);

  await page.setViewportSize(PHONE);
  expect(await pageFits(page)).toBe(0);

  // A step opens the task's page, which holds the task.
  await page.getByRole("tab", { name: /To pick/ }).click();
  await page.getByRole("link", { name: "Pick the winners of task #2" }).click();
  await expect(page).toHaveURL("/tasks/2", { timeout: 20_000 });
});

test("my_tasks_asks_a_visitor_to_connect", async ({ page }) => {
  await openParity(page, "/my-tasks");
  await expect(page.getByRole("heading", { name: "Connect your wallet" })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
});
