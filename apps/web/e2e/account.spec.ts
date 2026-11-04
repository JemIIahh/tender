import { expect, type Page, test } from "@playwright/test";
import {
  type AccountChain,
  AGENT_PUBLIC_KEY,
  AGENT_SECRET_KEY,
  installAccountWallet,
  LONG,
  OWNER,
  routeAccount,
  routeAccountNode,
  SCOUT,
} from "./accountApi";
import { routeApi } from "./fixtures";
import { STUB_WALLET_NAME } from "./walletStub";

// The account pages against the fixture API, a fixture node and an injected wallet that can make
// accounts: My agents, Add an agent (through to the agent registering itself) and Earnings, in a
// real browser, at a laptop's width and a phone's.

/** The fixture tasks are created at this moment; two minutes in, the open ones are in their window. */
const OPEN_AT = new Date(Number(1_793_307_169_820_229_000n / 1_000_000n) + 120_000);
const PHONE = { width: 375, height: 812 };

const chainOf = (): AccountChain => ({
  accounts: new Map([[OWNER, []]]),
  config: {
    owner: "tender-team.testnet",
    agent_bond: { token: "tusdc.tender-team.testnet", amount: "5000000" },
  },
});

async function openConnected(page: Page, path: string, options: { bonds?: boolean } = {}) {
  await page.clock.install({ time: OPEN_AT });
  await routeApi(page);
  const api = await routeAccount(page, options);
  const chain = chainOf();
  await routeAccountNode(page, chain);
  const wallet = await installAccountWallet(page, { account: OWNER, chain });
  await page.goto(path);
  await page.locator("main").getByRole("button", { name: "Connect wallet" }).click();
  await page.locator(".hot-connector-popup .connect-item", { hasText: STUB_WALLET_NAME }).click();
  return { api, chain, wallet };
}

async function expectToFit(page: Page, where: string): Promise<void> {
  const { client, scroll } = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(scroll, `${where}: the page is wider than the screen`).toBeLessThanOrEqual(client);
}

test("my_agents_lists_the_account_and_the_agents_under_it_and_fits_a_phone", async ({ page }) => {
  await openConnected(page, "/my-agents", { bonds: true });

  const rows = page.getByTestId("my-agent");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0).getByTestId("my-agent-account")).toHaveText(OWNER);
  await expect(rows.nth(0).getByTestId("this-account")).toBeVisible();
  await expect(rows.filter({ hasText: SCOUT }).getByTestId("status")).toHaveText("Status: Active");
  await expect(rows.filter({ hasText: LONG }).getByTestId("status")).toHaveText(
    "Status: Unregistering",
  );
  await expect(page.getByTestId("stat-agents")).toContainText("This account and 3 under it");
  await expect(page.getByTestId("stat-bonds")).toBeVisible();
  // No call to retire an agent or claim a bond exists yet, so no button offers one.
  await expect(page.getByRole("button", { name: /retire|claim/i })).toHaveCount(0);
  await expectToFit(page, "/my-agents");

  await page.setViewportSize(PHONE);
  await expectToFit(page, "/my-agents (phone)");

  await rows.nth(0).getByRole("link", { name: "Alice Extractor" }).click();
  // The first visit to an agent's page compiles it in `next dev`: give it the time.
  await expect(page).toHaveURL(`/agents/${OWNER}`, { timeout: 20_000 });
});

test("add_agent_makes_the_account_in_one_transaction_and_watches_the_agent_register", async ({
  page,
}) => {
  const { api, wallet } = await openConnected(page, "/my-agents/new");
  const key = page.getByLabel("The public key it printed");

  // A private key pasted by mistake is cleared at once.
  await key.fill(AGENT_SECRET_KEY);
  await expect(key).toHaveValue("");
  await expect(page.getByTestId("key-error")).toContainText("private key");

  await key.fill(AGENT_PUBLIC_KEY);
  await page.getByLabel("Account name").fill("scout2");
  await expect(page.getByTestId("name-state")).toHaveText(`scout2.${OWNER} is free.`);
  expect(wallet.sent).toEqual([]);

  await page.getByRole("button", { name: `Create scout2.${OWNER}` }).click();

  await expect(page.getByTestId("step-2")).toHaveAttribute("data-done", "true");
  expect(wallet.sent).toEqual([
    {
      receiverId: `scout2.${OWNER}`,
      actions: [
        { type: "CreateAccount" },
        { type: "Transfer", params: { deposit: "500000000000000000000000" } },
        {
          type: "AddKey",
          params: { publicKey: AGENT_PUBLIC_KEY, accessKey: { permission: "FullAccess" } },
        },
      ],
    },
  ]);
  await expect(page.getByTestId("bond-terms")).toContainText("Registering locks 5.00 tUSDC");
  await expect(page.getByTestId("watching")).toBeVisible();

  // The agent runs `pnpm agent:register` where it runs; the index lists it.
  api.registered.add(`scout2.${OWNER}`);
  await page.clock.runFor(5_000);
  await expect(page.getByTestId("registered")).toContainText(`scout2.${OWNER} is in the directory`);
  await expect(page.getByTestId("step-3")).toHaveAttribute("data-done", "true");
  expect(wallet.sent).toHaveLength(1);

  await page.setViewportSize(PHONE);
  await expectToFit(page, "/my-agents/new (phone)");
});

test("earnings_shows_the_wins_fees_and_net_and_where_posted_rewards_went", async ({ page }) => {
  await openConnected(page, "/earnings");

  await expect(page.getByTestId("stat-gross")).toContainText("5.00 tUSDC");
  await expect(page.getByTestId("stat-fees")).toContainText("0.25 tUSDC");
  await expect(page.getByTestId("stat-net")).toContainText("4.75 tUSDC");
  await expect(page.getByTestId("stat-pending")).toContainText("2");

  await page.getByRole("tab", { name: "Transactions" }).click();
  await expect(page).toHaveURL("/earnings?tab=transactions");
  await expect(page.getByTestId("transaction")).toHaveCount(5);

  await page.getByRole("tab", { name: "As a poster" }).click();
  await expect(page.getByTestId("posted-state")).toHaveText([
    "Due back to its funders in full",
    "Refunded to its funders in full",
    "Paid to the winners, less the platform fee",
    "Locked in escrow",
  ]);
  await expectToFit(page, "/earnings?tab=poster");

  await page.setViewportSize(PHONE);
  await expectToFit(page, "/earnings?tab=poster (phone)");
  await page.getByRole("tab", { name: "Transactions" }).click();
  await expectToFit(page, "/earnings?tab=transactions (phone)");
});
