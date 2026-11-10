import { expect, type Page, test } from "@playwright/test";
import { ALICE, OTHER_TOKEN, PROVIDER, routeAgents, WIDE, WIDE_PROVIDER } from "./agentsApi";
import { routeApi } from "./fixtures";

// The provider (ASP) pages against the fixture API (e2e/agentsApi.ts): the directory groups the
// agents the API lists by their provider, a provider's page lists the agents under it, and an
// agent card's provider leads there. The fixtures have two providers: provider.testnet, which
// runs Alice, and an account of two labels and 64 characters that runs the widest agent.

const cards = (page: Page) => page.getByTestId("provider-card");

test("providers_directory_groups_the_agents_and_leads_to_a_provider_s_page", async ({ page }) => {
  await routeApi(page);
  await routeAgents(page);
  await page.goto("/providers");

  // A tab of Browse agents: its head, the tab marked, and a section of its own.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Browse agents. Hire one that fits.",
  );
  await expect(
    page.getByRole("navigation", { name: "Browse" }).getByRole("link", { name: "Providers" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 2, name: "Providers" })).toBeVisible();
  await expect(cards(page)).toHaveCount(2);
  const provider = cards(page).filter({ has: page.getByRole("link", { name: PROVIDER }) });
  await expect(provider.getByTestId("provider-agents")).toHaveText("1");
  await expect(provider.getByTestId("entries")).toHaveText("5");
  await expect(provider.getByTestId("wins")).toHaveText("2");
  // A token at a time: never one sum of two tokens.
  await expect(provider.getByTestId("earned").getByTestId("amount")).toHaveText([
    "2.50 tUSDC",
    `7 ${OTHER_TOKEN}`,
  ]);
  await expect(provider.getByTestId("provider-agent")).toHaveText([ALICE]);

  // The whole card is the link: a click in its middle, on its figures, follows it.
  await provider.click();
  // `next dev` compiles a page the first time it is opened, which can take a while.
  await expect(page).toHaveURL(new RegExp(`/providers/${PROVIDER.replace(".", "\\.")}$`), {
    timeout: 20_000,
  });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(PROVIDER);
  await expect(page.getByTestId("agent-card")).toHaveCount(1);
  await expect(page.getByTestId("stat-agents")).toContainText("1");
  await expect(page.getByTestId("stat-earned").getByTestId("amount")).toHaveText([
    "2.50 tUSDC",
    `7 ${OTHER_TOKEN}`,
  ]);

  await page
    .getByRole("navigation", { name: "Breadcrumbs" })
    .getByRole("link", { name: "Providers" })
    .click();
  await expect(page).toHaveURL(/\/providers$/, { timeout: 20_000 });
});

test("agent_page_s_provider_is_a_link_that_a_click_reaches", async ({ page }) => {
  await routeApi(page);
  await routeAgents(page);
  await page.goto("/agents");

  // The card leads to the agent's page, whose strip names its provider, a link to the provider.
  await page
    .getByTestId("agent-card")
    .filter({ has: page.getByRole("heading", { name: "Alice Extractor" }) })
    .click();
  await expect(page).toHaveURL(new RegExp(`/agents/${ALICE}$`), { timeout: 20_000 });
  await page.getByTestId("asp").getByRole("link", { name: PROVIDER }).click();
  // `next dev` compiles a page the first time it is opened, which can take a while.
  await expect(page).toHaveURL(new RegExp(`/providers/${PROVIDER.replace(".", "\\.")}$`), {
    timeout: 20_000,
  });
  await expect(page.getByTestId("agent-card")).toHaveCount(1);
});

test("providers_pages_fit_a_phone_with_the_widest_data", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await routeApi(page);
  await routeAgents(page);
  const fits = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );

  await page.goto("/providers");
  await expect(cards(page)).toHaveCount(2);
  expect(await fits()).toBe(0);

  // The widest agent's provider: an account of two labels and 64 characters, one place to break.
  await page.goto(`/providers/${WIDE_PROVIDER}`);
  await expect(page.getByTestId("agent-card")).toHaveCount(1);
  await expect(page.getByTestId("agent-card")).toContainText(WIDE);
  expect(await fits()).toBe(0);
});
