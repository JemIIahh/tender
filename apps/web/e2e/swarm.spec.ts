import { expect, type Page, test } from "@playwright/test";
import { LEAD, SWARM } from "../test/tasks";
import { routeApi, TEAM_LABEL } from "./fixtures";

// The swarm tree on the task page (plan 06 Task 7), against the fixture API's copy of the swarm
// demo's lineage (scripts/swarm-demo.ts, plan 07 Task 3; test/tasks.ts `swarmLineage`): the team's
// poster posted the parent for 10.00 tUSDC, the lead entered it and posted three subtasks of 2.00
// from its own vault, alice and bob won them, and the Judge paid the lead 9.50 for the parent.
// The demo itself takes about five minutes on a local chain; see the report's ruling.

const tree = (page: Page) => page.getByTestId("swarm-tree");
const node = (page: Page, id: string) =>
  tree(page).locator(`[data-testid="tree-node"][data-task-id="${id}"]`);
const card = (page: Page, id: string) => node(page, id).getByTestId("tree-card").first();

test("swarm_tree_shows_children_and_margin", async ({ page }) => {
  await routeApi(page);
  await page.goto(`/tasks/${SWARM.parent}`);

  // The parent, and under it its three subtasks, each linked.
  await expect(tree(page).getByTestId("tree-node")).toHaveCount(4);
  await expect(tree(page).getByTestId("child-link")).toHaveText(
    SWARM.children.map((id) => `Task #${id}`),
  );
  await expect(card(page, SWARM.parent).getByText("This task")).toBeVisible();
  await expect(card(page, SWARM.parent).getByTestId("tree-reward")).toHaveText("10.00 tUSDC");
  await expect(card(page, SWARM.parent).getByTestId("tree-winner")).toHaveText(`Won by${LEAD}`);

  // Each subtask: its phase, its reward, its winner, and who posted it, with the team's label.
  const winners = ["alice.testnet", "bob.testnet", "alice.testnet"];
  for (const [i, id] of SWARM.children.entries()) {
    await expect(card(page, id).getByTestId("phase-chip")).toHaveText("Settled");
    await expect(card(page, id).getByTestId("tree-reward")).toHaveText("2.00 tUSDC");
    await expect(card(page, id).getByTestId("tree-winner")).toHaveText(`Won by${winners[i]}`);
    const poster = card(page, id).getByTestId("tree-poster");
    await expect(poster).toContainText(LEAD);
    await expect(poster.getByTestId("team-badge")).toHaveText(TEAM_LABEL);
  }

  // The lead's margin: what the parent paid it, less what its subtasks cost it.
  const margin = tree(page).getByTestId("lead-margin");
  await expect(margin).toContainText(LEAD);
  await expect(margin.getByTestId("margin-value")).toHaveText("+3.50 tUSDC");
  await expect(margin.getByTestId("margin-paid")).toHaveText("9.50 tUSDC");
  await expect(margin.getByTestId("margin-spent")).toHaveText("−6.00 tUSDC");

  // A subtask's page: the same lineage from below, this task marked, the parent linked.
  await tree(page).getByTestId("child-link").nth(1).click();
  await expect(page).toHaveURL(/\/tasks\/22$/);
  await expect(page.getByTestId("parent-link")).toHaveAttribute("href", `/tasks/${SWARM.parent}`);
  await expect(card(page, "22").getByText("This task")).toBeVisible();
  await expect(tree(page).getByTestId("tree-link").first()).toHaveAttribute(
    "href",
    `/tasks/${SWARM.parent}`,
  );
  await expect(tree(page).getByTestId("margin-value")).toHaveText("+3.50 tUSDC");
});

test("swarm_tree_fits_a_phone", async ({ page }) => {
  const phone = { width: 375, height: 812 };
  await page.setViewportSize(phone);
  await routeApi(page);
  await page.goto("/tasks/21");
  await expect(tree(page).getByTestId("margin-value")).toHaveText("+3.50 tUSDC");

  const { client, ...scroll } = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    page: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  const room = Math.min(phone.width, client);
  expect(scroll.page, "the page is wider than the screen").toBeLessThanOrEqual(room);
  expect(scroll.body, "the body is wider than the screen").toBeLessThanOrEqual(room);
});
