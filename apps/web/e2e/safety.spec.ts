import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { routeApi } from "./fixtures";
import { ANALYST, DELEGATE_KEY, DORA, LEAD, routeSafetyAgents, routeSafetyNode } from "./safetyApi";

// The Safety section of an agent's page (section 04), against the fixture API and a fixture RPC node
// (e2e/safetyApi.ts): an agent the team runs with a model (the runner's defaults), a team agent that
// is not named so (the lead, with a delegate key), and an agent the team does not run. At a phone's
// width and a desktop's, with no sideways scroll.
//
// With SAFETY_SHOTS set to a directory, the section of each is also saved there as a screenshot at
// 375 and 1440 px wide.

const SIZES = [
  { width: 375, height: 812 },
  { width: 1440, height: 900 },
] as const;

const SHOTS = process.env.SAFETY_SHOTS;

async function open(page: Page, account: string): Promise<Locator> {
  await routeApi(page);
  await routeSafetyAgents(page);
  await routeSafetyNode(page);
  // The first visit to the agent route has `next dev` build it, which can take a while.
  await page.goto(`/agents/${account}`, { timeout: 60_000 });
  const section = page.getByRole("region", { name: "Safety" });
  await expect(section).toBeVisible({ timeout: 30_000 });
  return section;
}

/** The page fits the width it has: no sideways scroll. */
async function expectToFit(page: Page, width: number, where: string): Promise<void> {
  const { client, ...scroll } = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    page: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  const room = Math.min(width, client);
  expect(scroll.page, `${where}: the page is wider than the screen`).toBeLessThanOrEqual(room);
  expect(scroll.body, `${where}: the body is wider than the screen`).toBeLessThanOrEqual(room);
}

async function shoot(page: Page, section: Locator, name: string, width: number): Promise<void> {
  if (SHOTS === undefined || SHOTS === "") return;
  mkdirSync(SHOTS, { recursive: true });
  // The sticky header and the dev server's badge would sit over the section in the picture.
  await page.addStyleTag({
    content: "header.sticky { position: static !important } nextjs-portal { display: none }",
  });
  await section.scrollIntoViewIfNeeded();
  await section.screenshot({ path: join(SHOTS, `${width}-${name}.png`), animations: "disabled" });
}

for (const size of SIZES) {
  test(`safety_section_of_a_team_agent_run_with_a_model_at_${size.width}`, async ({ page }) => {
    await page.setViewportSize(size);
    const section = await open(page, ANALYST);

    // The contract's lines, the keys NEAR holds it to, and the runner's defaults, each tagged.
    await expect(section.getByTestId("safety-vault")).toContainText(
      "Spends only from its own vault",
    );
    await expect(section.getByTestId("safety-bond")).toContainText("1.00 tUSDC");
    await expect(section.getByTestId("safety-bond")).toContainText(
      "Claimable at least 14 days after it leaves, at today’s cooldown.",
    );
    await expect(section.getByTestId("safety-delegates")).toContainText("None");
    await expect(section.getByTestId("safety-keys")).toContainText(
      "1 full-access key · 1 limited to Tender",
    );
    await expect(section.getByTestId("safety-keys").getByTestId("enforced-by")).toHaveText(
      "Enforced by NEAR",
    );
    await expect(section.getByTestId("safety-runner-defaults")).toContainText(
      "Tender can’t see the flags it runs with.",
    );
    await expect(section.getByTestId("safety-daily-entries")).toContainText(
      "Tasks and hirer-checked hires a day",
    );
    await expect(section.getByTestId("safety-daily-entries")).toContainText("At most 20");
    await expect(section.getByTestId("safety-daily-hires")).toContainText("At most 50");
    await expect(section.getByTestId("safety-hiring")).toContainText(
      "A hire through Tender pays at most its reward, held in escrow.",
    );
    await expect(section.getByTestId("safety-hiring")).toContainText(
      "x402 purchases are paid directly. The contract doesn\u2019t limit them.",
    );
    await expect(section.getByTestId("safety-verifiers")).toContainText(
      "Hires through Tender: the checker its service names.",
    );
    await expect(section.getByTestId("safety-verifiers").getByTestId("enforced-by")).toHaveText(
      "Default of the team\u2019s runner",
    );

    await expectToFit(page, size.width, `${ANALYST} at ${size.width}`);
    await shoot(page, section, "team-model-agent", size.width);
  });

  test(`safety_section_of_a_team_agent_not_named_as_run_with_a_model_at_${size.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    const section = await open(page, LEAD);

    await expect(section.getByTestId("safety-runner-team")).toHaveText(
      "The team runs it. Its runner’s settings aren’t shown here.",
    );
    await expect(section.getByTestId("safety-daily-entries")).toHaveCount(0);
    // Its hiring key, found among its own keys, with its caps and what it spent.
    const key = section.getByTestId("safety-delegate");
    await expect(key).toContainText("2.00 tUSDC a post or top-up, 6.00 tUSDC in all");
    await expect(key).toContainText("Spent 6.00 tUSDC");
    await expect(key.getByTitle(DELEGATE_KEY)).toHaveText("ed25519:4YDb…XvyF");
    await expect(section.getByTestId("safety-keys")).toContainText(
      "1 full-access key · 2 limited to Tender",
    );

    await expectToFit(page, size.width, `${LEAD} at ${size.width}`);
    await shoot(page, section, "team-lead", size.width);
  });

  test(`safety_section_of_an_agent_the_team_does_not_run_at_${size.width}`, async ({ page }) => {
    await page.setViewportSize(size);
    const section = await open(page, DORA);

    await expect(section.getByTestId("safety-runner-unknown")).toHaveText(
      "Its owner’s runner sets which tasks it takes. Tender can’t see those settings.",
    );
    await expect(section.getByTestId("safety-daily-entries")).toHaveCount(0);
    await expect(section.getByTestId("safety-delegates")).toContainText("None");
    await expect(section.getByTestId("safety-bond")).toContainText("1.00 tUSDC");
    await expect(section.getByTestId("safety-keys")).toContainText(
      "1 full-access key · 1 limited to Tender",
    );
    // Dora lists an x402 API: the Hiring line says it is paid outside the contract.
    await expect(section.getByTestId("safety-hiring")).toContainText("It lists an x402 API.");

    await expectToFit(page, size.width, `${DORA} at ${size.width}`);
    await shoot(page, section, "other-agent", size.width);
  });
}
