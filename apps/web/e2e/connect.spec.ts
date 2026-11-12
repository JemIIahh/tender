import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { connectFingerprint, implicitAccountOf } from "@tender/shared";
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
import { pickStubWallet } from "./walletStub";

// "Connect your agent" in a real browser, against the fixture API, a fixture node and an injected
// wallet that signs in and sends batches: a name, a code, the agent attaching its key (the spec
// does what the agent would), the fingerprint, ONE approval for the account, its storage and its
// bond, and the ticks as the agent registers. At a laptop's width and a phone's. Then a wallet that
// blocks the new account, and the separate account that every wallet sends.
//
// With CONNECT_SHOTS set to a directory, the states of the separate account are also saved there as
// screenshots at 375 and 1440 px wide.

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

async function openConnected(
  page: Page,
  chain: AccountChain = chainOf(),
  walletOptions: { refuseNewAccounts?: boolean } = {},
) {
  await routeApi(page);
  await routeAccount(page);
  const api = await routeConnect(page, OWNER);
  await routeAccountNode(page, chain);
  const wallet = await installAccountWallet(page, { account: OWNER, chain, ...walletOptions });
  await page.goto("/my-agents/new");
  await page.locator("main").getByRole("button", { name: "Sign in" }).click();
  await pickStubWallet(page);
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
  // The account, its NEAR, its setup code, and the call that adds the agent's key: no AddKey.
  expect(wallet.sent[0]?.actions.map((action) => action.type)).toEqual([
    "CreateAccount",
    "Transfer",
    "DeployContract",
    "FunctionCall",
  ]);
  expect(wallet.sent[0]?.actions[3]?.params).toEqual({
    methodName: "setup",
    args: { public_key: AGENT_PUBLIC_KEY },
    gas: "30000000000000",
    deposit: "0",
  });
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

const SHOTS = process.env.CONNECT_SHOTS;

/** Saves the connect section as `name`, at a phone's width and a desktop's. */
async function shoot(page: Page, name: string, testId = "connect-step-3"): Promise<void> {
  if (SHOTS === undefined || SHOTS === "") return;
  mkdirSync(SHOTS, { recursive: true });
  // The sticky header and the dev server's badge would sit over the section in the picture.
  await page.addStyleTag({
    content: "header.sticky { position: static !important } nextjs-portal { display: none }",
  });
  const part = page.getByTestId(testId);
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await part.scrollIntoViewIfNeeded();
    await part.screenshot({ path: join(SHOTS, `${width}-${name}.png`), animations: "disabled" });
  }
  await page.setViewportSize({ width: 1280, height: 720 });
}

test("a_wallet_that_blocks_the_new_account_gets_one_button_for_a_separate_account", async ({
  page,
}) => {
  const { api, chain, wallet } = await openConnected(page, chainOf(), { refuseNewAccounts: true });
  const implicit = implicitAccountOf(AGENT_PUBLIC_KEY) ?? "";
  await page.getByTestId("connect-step-1").getByLabel("Account name").fill("writer");
  await expect(page.getByTestId("connect-name-state")).toHaveText(`${AGENT} is free.`);
  await page.getByRole("button", { name: "Get a connect code" }).click();
  await expect(page.getByTestId("connect-command")).toBeVisible();
  agentAttaches(api, AGENT_PUBLIC_KEY);
  await expect(page.getByTestId("connect-ready")).toHaveText(`Your agent is ready: ${AGENT}`);
  await expect(page.getByTestId("connect-bond")).toHaveText("5.00 tUSDC");

  // The wallet blocks the transaction that sets up the account: nothing is sent.
  await page.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByTestId("connect-send-error")).toHaveText(
    "Your wallet didn't create the account. Nothing was paid. Press Create agent to try again.",
  );
  const offer = page.getByTestId("connect-implicit-offer");
  await expect(offer).toContainText(
    "This agent is its own account, so Tender's directory won't list it under you as its provider.",
  );
  await expect(offer.getByRole("button")).toHaveText([
    "Use a separate account instead (works with every wallet)",
  ]);
  expect(wallet.sent).toEqual([]);
  await expectToFit(page, "offer");
  await shoot(page, "blocked-offer");

  // One press: the choice is recorded, and ONE approval sends NEAR to the agent's own account, its
  // storage and its bond.
  await offer.getByRole("button", { name: "Use a separate account instead" }).click();
  await expect(page.getByTestId("tick-funded")).toHaveAttribute("data-state", "done");
  expect(api.requests).toContain("POST /v1/connect/codes/Q0RFRkdISUpLTE1OT1BRUg/implicit");
  expect(wallet.sent.map((tx) => tx.receiverId)).toEqual([implicit, CONTRACT, TOKEN]);
  expect(wallet.sent[0]?.actions).toEqual([
    { type: "Transfer", params: { deposit: "500000000000000000000000" } },
  ]);
  expect(chain.accounts.get(implicit)).toEqual([AGENT_PUBLIC_KEY]);
  expect(chain.vault?.get(implicit)).toBe(5_000_000n);
  await expect(page.getByTestId("connect-ready")).toHaveText(`Your agent is ready: ${implicit}`);
  await expect(page.getByTestId("connect-implicit")).toHaveText(
    "This agent is its own account, so Tender's directory won't list it under you as its provider.",
  );
  await expectToFit(page, "separate account");
  await shoot(page, "separate-account");
  await shoot(page, "separate-account-ticks", "connect-step-4");

  agentRegisters(api);
  await expect(page.getByTestId("tick-active")).toHaveAttribute("data-state", "done");
  await expect(page.getByTestId("connect-active")).toContainText(implicit);
  await shoot(page, "separate-account-active", "connect-step-4");

  // My agents lists it as set up by the person, and not linked on chain.
  await page.getByTestId("connect-active").getByRole("link", { name: "Back to My agents" }).click();
  const list = page.getByTestId("implicit-agents");
  await expect(list).toContainText("Set up by you, not linked on chain");
  await expect(list.getByTestId("implicit-agent")).toContainText(implicit);
  await expect(list.getByTestId("implicit-agent")).toContainText("Active");
  await expectToFit(page, "my agents");
  await shoot(page, "my-agents-separate", "implicit-agents");
  await page.setViewportSize(PHONE);
  await expectToFit(page, "my agents (phone)");
});

test("money_already_on_the_sub_account_is_said_and_no_separate_account_is_offered", async ({
  page,
}) => {
  // The network fails the account; this wallet goes on, and the storage and the bond reach Tender
  // for the sub-account, which does not exist.
  const chain = chainOf();
  chain.failCreates = 1;
  const { api, wallet } = await openConnected(page, chain);
  await page.getByTestId("connect-step-1").getByLabel("Account name").fill("writer");
  await expect(page.getByTestId("connect-name-state")).toHaveText(`${AGENT} is free.`);
  await page.getByRole("button", { name: "Get a connect code" }).click();
  await expect(page.getByTestId("connect-command")).toBeVisible();
  agentAttaches(api, AGENT_PUBLIC_KEY);
  await page.getByRole("button", { name: "Create agent" }).click();

  await expect(page.getByTestId("connect-implicit-held")).toHaveText(
    `Your bond and storage are waiting for ${AGENT}; they stay there until that account is created. Finish with a wallet that allows the setup step.`,
  );
  await expect(page.getByTestId("connect-implicit-offer")).toHaveCount(0);
  expect(chain.vault?.get(AGENT)).toBe(5_000_000n);
  expect(wallet.sent.map((tx) => tx.receiverId)).toEqual([AGENT, CONTRACT, TOKEN]);
  await expectToFit(page, "held");
  await shoot(page, "held-on-sub-account");

  // Tender's record then says the separate account (a lying API, or another tab): the page says
  // where the money is, and Create agent pays nothing.
  if (api.code !== null) api.code.kind = "implicit";
  await expect(page.getByTestId("connect-other-held")).toHaveText(
    `Your bond and storage are waiting for ${AGENT}; they stay there until that account is created. Finish with a wallet that allows the setup step.`,
  );
  await expect(page.getByRole("button", { name: "Create agent" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  // A press anyway (Playwright waits for an aria-disabled button, so the click is forced).
  await page.getByRole("button", { name: "Create agent" }).click({ force: true });
  expect(wallet.sent.map((tx) => tx.receiverId)).toEqual([AGENT, CONTRACT, TOKEN]);
  await expectToFit(page, "other held");
  await shoot(page, "held-after-switch");
});

test("a_strangers_storage_on_the_sub_account_is_noted_and_the_separate_account_still_offered", async ({
  page,
}) => {
  const chain = chainOf();
  chain.storage?.add(AGENT);
  const { api, wallet } = await openConnected(page, chain, { refuseNewAccounts: true });
  await page.getByTestId("connect-step-1").getByLabel("Account name").fill("writer");
  await expect(page.getByTestId("connect-name-state")).toHaveText(`${AGENT} is free.`);
  await page.getByRole("button", { name: "Get a connect code" }).click();
  await expect(page.getByTestId("connect-command")).toBeVisible();
  agentAttaches(api, AGENT_PUBLIC_KEY);
  await page.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByTestId("connect-storage-note")).toHaveText(
    `Some storage is already paid for ${AGENT}; it stays with that account.`,
  );
  await expect(page.getByTestId("connect-implicit-offer")).toBeVisible();
  await expect(page.getByTestId("connect-implicit-held")).toHaveCount(0);
  expect(wallet.sent).toEqual([]);
  await expectToFit(page, "storage note");
  await shoot(page, "storage-note");
});
