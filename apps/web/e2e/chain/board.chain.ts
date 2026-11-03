import { expect, test } from "@playwright/test";
import { TEAM_LABEL } from "../fixtures";
import { cardTitled } from "./cards";
import { loadRun } from "./run";

// The board against the services of the run: the two seeds the setup posted on the local chain,
// read back through the indexer and the API, with the titles of their briefs.

test("board_renders_seeded_tasks", async ({ page }) => {
  const run = loadRun();
  await page.goto("/");

  for (const { slug, title } of run.seeds) {
    const card = cardTitled(page, title);
    await expect(card, `the card of the seed ${slug} ("${title}")`).toBeVisible();
    // The label is on the poster's line, where a reader looks for who is behind the task. The
    // services count the account that posted the seeds as the team's.
    await expect(
      card.getByTestId("poster").getByText(TEAM_LABEL, { exact: true }),
      `the team badge on the poster of the seed ${slug}`,
    ).toBeVisible();
    await expect(card.getByTestId("poster"), `the poster of the seed ${slug}`).toContainText(
      run.poster,
    );
  }
});
