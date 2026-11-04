import { expect, type Page, test } from "@playwright/test";
import { connectFingerprint } from "@tender/shared";
import {
  type AccountChain,
  AGENT_PUBLIC_KEY,
  agentAttaches,
  agentContests,
  agentRegisters,
  CONNECT_CODE,
  installAccountWallet,
  OWNER,
  routeAccount,
  routeAccountNode,
  routeConnect,
} from "./accountApi";
import { API_URL, routeApi } from "./fixtures";
import { STUB_WALLET_NAME } from "./walletStub";

// "Connect your agent" in a real browser, against the fixture API, a fixture node and an injected
// wallet that signs in and sends batches: a name, a code, the agent attaching its key (the spec
// does what the agent would), the fingerprint, ONE approval for the account, its storage and its
// bond, and the ticks as the agent registers. At a laptop's width and a phone's.

const PHONE = { width: 375, height: 812 };
const TOKEN = "tusdc.tender-team.testnet";
const CONTRACT = "tender.tender-team.testnet";
const AGENT = `writer.${OWNER}`;

const chainOf = (): AccountChain => ({
  accounts: new Map([[OWNER, []]]),
  config: {
    owner: "tender-team.testnet",
    agent_bond_token: TOKEN,
    agent_bond_amount: "5000000",
    agent_bond_cooldown_secs: "604800",
  },
  storage: new Set(),
  vault: new Map(),
  wallet: new Map([[OWNER, 20_000_000n]]),
});

async function openConnected(page: Page, chain: AccountChain = chainOf()) {
  await routeApi(page);
  await routeAccount(page);
  const api = await routeConnect(page, OWNER);
  await routeAccountNode(page, chain);
  const wallet = await installAccountWallet(page, { account: OWNER, chain });
  await page.goto("/my-agents/new");
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

test("connect_an_agent_with_one_paste_and_one_approval_and_watch_it_tick_to_active", async ({
  page,
}) => {
  const { api, chain, wallet } = await openConnected(page);
  const step = (n: number) => page.getByTestId(`connect-step-${n}`);

  await step(1).getByLabel("Account name").fill("writer");
  await expect(page.getByTestId("connect-name-state")).toHaveText(`${AGENT} is free.`);
  await step(1).getByRole("button", { name: "Get a connect code" }).click();

  // One paste: the command with the code and the API, or the sentence for the MCP server.
  await expect(page.getByTestId("connect-command")).toHaveText(
    `$ pnpm agent:connect ${CONNECT_CODE} --api ${API_URL}`,
  );
  await expect(page.getByTestId("connect-sentence")).toHaveText(
    `Connect to Tender with code ${CONNECT_CODE}`,
  );
  await expect(page.getByTestId("connect-waiting")).toContainText("Waiting for your agent");
  expect(api.bodies).toEqual([{ name: "writer" }]);
  expect(wallet.sent).toEqual([]);
  await expectToFit(page, "code");

  // The agent runs it where it runs, and attaches its public key.
  agentAttaches(api, AGENT_PUBLIC_KEY);
  await expect(page.getByTestId("connect-ready")).toHaveText(`Your agent is ready: ${AGENT}`);
  await expect(page.getByTestId("connect-fingerprint")).toHaveText(
    connectFingerprint(AGENT_PUBLIC_KEY),
  );
  await expect(page.getByTestId("connect-warning")).toContainText("someone else has this code");
  await expect(page.getByTestId("connect-bond")).toHaveText("5.00 tUSDC");

  await page.getByRole("button", { name: "Create agent" }).click();

  // ONE approval: the account with the agent's key, its storage, its bond into its vault.
  await expect(page.getByTestId("tick-funded")).toHaveAttribute("data-state", "done");
  expect(wallet.sent.map((tx) => tx.receiverId)).toEqual([AGENT, CONTRACT, TOKEN]);
  expect(wallet.sent[0]?.actions).toEqual([
    { type: "CreateAccount" },
    { type: "Transfer", params: { deposit: "500000000000000000000000" } },
    {
      type: "AddKey",
      params: { publicKey: AGENT_PUBLIC_KEY, accessKey: { permission: "FullAccess" } },
    },
  ]);
  expect(wallet.sent[2]?.actions[0]?.params).toMatchObject({
    methodName: "ft_transfer_call",
    args: { receiver_id: CONTRACT, amount: "5000000", msg: `{"for":"${AGENT}"}` },
  });
  expect(chain.vault?.get(AGENT)).toBe(5_000_000n);
  await expect(page.getByTestId("tick-created")).toHaveAttribute("data-state", "done");
  await expect(page.getByTestId("tick-registered")).toHaveAttribute("data-state", "working");

  // The agent registers itself with its own key; the index lists it.
  agentRegisters(api);
  await expect(page.getByTestId("tick-active")).toHaveAttribute("data-state", "done");
  await expect(page.getByTestId("connect-active")).toContainText("Your agent is active.");
  expect(wallet.sent).toHaveLength(3);
  await expectToFit(page, "active");

  await page.setViewportSize(PHONE);
  await expectToFit(page, "active (phone)");
});

test("a_wallet_short_of_the_bond_is_told_and_a_failed_bond_is_paid_with_fund_agent", async ({
  page,
}) => {
  const chain = chainOf();
  chain.wallet?.set(OWNER, 2_000_000n);
  const { api, wallet } = await openConnected(page, chain);
  await page.getByTestId("connect-step-1").getByLabel("Account name").fill("writer");
  await expect(page.getByTestId("connect-name-state")).toHaveText(`${AGENT} is free.`);
  await page.getByRole("button", { name: "Get a connect code" }).click();
  await expect(page.getByTestId("connect-command")).toBeVisible();
  agentAttaches(api, AGENT_PUBLIC_KEY);

  await expect(page.getByTestId("connect-short")).toContainText(
    "Your wallet holds 2.00 tUSDC, and the bond is 5.00 tUSDC.",
  );
  await expect(page.getByRole("button", { name: "Create agent" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );

  // The tokens arrive; the bond's transaction still fails once, after the account is made.
  chain.wallet?.set(OWNER, 20_000_000n);
  chain.failDeposits = 1;
  await page.getByTestId("connect-short").getByRole("button", { name: "Check again" }).click();
  await expect(page.getByTestId("connect-short")).toHaveCount(0);
  await page.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByTestId("tick-funded")).toHaveAttribute("data-state", "wrong");
  await expect(page.getByTestId("connect-fund-error")).toContainText("press Fund agent");

  await page.getByRole("button", { name: "Fund agent" }).click();
  await expect(page.getByTestId("tick-funded")).toHaveAttribute("data-state", "done");
  // The second approval sent only the bond: the storage was in place.
  expect(wallet.sent.map((tx) => tx.receiverId)).toEqual([AGENT, CONTRACT, TOKEN, TOKEN]);
  await page.setViewportSize(PHONE);
  await expectToFit(page, "fund agent (phone)");
});

test("a_contested_code_is_refused_and_an_agent_you_started_is_finished_with_fund_agent", async ({
  page,
}) => {
  const chain = chainOf();
  const { api, wallet } = await openConnected(page, chain);
  await page.getByTestId("connect-step-1").getByLabel("Account name").fill("writer");
  await expect(page.getByTestId("connect-name-state")).toHaveText(`${AGENT} is free.`);
  await page.getByRole("button", { name: "Get a connect code" }).click();
  await expect(page.getByTestId("connect-command")).toBeVisible();
  agentAttaches(api, AGENT_PUBLIC_KEY);
  await expect(page.getByRole("button", { name: "Create agent" })).toBeVisible();

  // A second key tried the code: the page refuses it.
  agentContests(api);
  await expect(page.getByTestId("connect-contested")).toContainText(
    "Two different keys tried this code: someone else has it. Start over.",
  );
  await expect(page.getByRole("button", { name: "Create agent" })).toHaveCount(0);
  await page.getByTestId("connect-contested").getByRole("button", { name: "Start over" }).click();

  // An agent started earlier: its account exists with its key and its storage, and no bond.
  chain.accounts.set(AGENT, [AGENT_PUBLIC_KEY]);
  chain.storage?.add(AGENT);
  await page.getByTestId("connect-step-1").getByLabel("Account name").fill("");
  await page.getByTestId("connect-step-1").getByLabel("Account name").fill("writer");
  await expect(page.getByTestId("connect-name-state")).toHaveText(`${AGENT} already exists.`);
  await page.getByRole("button", { name: "Finish this agent" }).click();
  await expect(page.getByTestId("connect-finish-keys")).toContainText(
    connectFingerprint(AGENT_PUBLIC_KEY),
  );
  await expect(page.getByTestId("tick-funded")).toHaveAttribute("data-state", "wrong");
  await page.getByRole("button", { name: "Fund agent" }).click();
  await expect(page.getByTestId("tick-funded")).toHaveAttribute("data-state", "done");
  expect(wallet.sent.map((tx) => tx.receiverId)).toEqual([TOKEN]);
  expect(api.made).toBe(1);
  await page.setViewportSize(PHONE);
  await expectToFit(page, "finish (phone)");
});
