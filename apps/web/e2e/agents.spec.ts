import { expect, type Page, test } from "@playwright/test";
import { SIGN_IN_MESSAGE } from "@tender/shared";
import {
  AGENTS,
  ALICE,
  JUDGE,
  OTHER_TOKEN,
  routeAgents,
  routeTelegram,
  TELEGRAM_BOT,
  WIDE,
} from "./agentsApi";
import { REGEX_TITLE, routeApi, TEAM_LABEL } from "./fixtures";
import { installSigningWallet } from "./signingWallet";
import { STUB_WALLET_NAME } from "./walletStub";

// The agent directory, an agent's page, the verifier record on a task page and the Telegram page,
// against the fixture API (e2e/fixtures.ts, e2e/agentsApi.ts) and a wallet that announces itself
// the way an extension does (e2e/signingWallet.ts). 06-T1b runs the same pages on a local chain,
// with the services started with `TELEGRAM_BOT_USERNAME=tender_test_bot`.

const cards = (page: Page) => page.getByTestId("agent-card");
const card = (page: Page, name: string) =>
  cards(page).filter({ has: page.getByRole("heading", { name }) });
const tagFilter = (page: Page) => page.getByRole("navigation", { name: "Filter by tag" });

test("agents_directory_shows_team_badge", async ({ page }) => {
  await routeApi(page);
  await routeAgents(page);
  await page.goto("/agents");

  await expect(cards(page)).toHaveCount(AGENTS.length);

  // The agents the team runs carry the label; the others do not.
  for (const name of ["Tender Judge", "Tender Scout"]) {
    await expect(card(page, name).getByTestId("team-badge")).toHaveText(TEAM_LABEL);
  }
  for (const name of ["Alice Extractor", "Carol Research"]) {
    await expect(card(page, name).getByTestId("team-badge")).toHaveCount(0);
  }

  // A card: the account, the provider, the counts, and what was earned, a token at a time.
  const alice = card(page, "Alice Extractor");
  await expect(alice).toContainText(ALICE);
  await expect(alice.getByTestId("asp")).toHaveText("provider.testnet");
  await expect(alice.getByTestId("entries")).toHaveText("5");
  await expect(alice.getByTestId("reveals")).toHaveText("4");
  await expect(alice.getByTestId("wins")).toHaveText("2");
  await expect(alice.getByTestId("earned").getByTestId("amount")).toHaveText([
    "2.50 tUSDC",
    `7 ${OTHER_TOKEN}`,
  ]);
  // An agent with no provider says so; one that won nothing says that.
  await expect(card(page, "Carol Research").getByTestId("asp")).toHaveText("none");
  await expect(card(page, "Tender Judge").getByTestId("earned")).toHaveText("Nothing yet");

  // The verifier record: how many times the agent picked, and voided after reveals.
  const judge = card(page, "Tender Judge");
  await expect(judge.getByTestId("picks-made")).toHaveText("12");
  await expect(judge.getByTestId("voids-after-reveals")).toHaveText("1");
});

test("agents_directory_filters_by_tag_and_a_filtered_view_can_be_linked", async ({ page }) => {
  await routeApi(page);
  await routeAgents(page);
  await page.goto("/agents");
  await expect(cards(page)).toHaveCount(AGENTS.length);

  // The tags are the ones the agents list.
  await expect(tagFilter(page).getByRole("link", { name: "All" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  for (const tag of ["coding", "extraction", "judge", "research", "summaries"]) {
    await expect(tagFilter(page).getByRole("link", { name: tag, exact: true })).toBeVisible();
  }

  await tagFilter(page).getByRole("link", { name: "research", exact: true }).click();
  await expect(page).toHaveURL(/\/agents\?tag=research$/);
  await expect(cards(page)).toHaveCount(2);
  await expect(card(page, "Carol Research")).toBeVisible();
  await expect(card(page, "Tender Scout")).toBeVisible();
  await expect(
    tagFilter(page).getByRole("link", { name: "research", exact: true }),
  ).toHaveAttribute("aria-current", "true");

  // The address is the view: it loads as it was.
  await page.goto("/agents?tag=extraction");
  await expect(cards(page)).toHaveCount(1);
  await expect(card(page, "Alice Extractor")).toBeVisible();

  // A tag nobody has is said so, and All shows everyone again.
  await page.goto("/agents?tag=unheard-of");
  await expect(page.getByTestId("no-agents")).toHaveText("No agent has the tag unheard-of.");
  await tagFilter(page).getByRole("link", { name: "All" }).click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(cards(page)).toHaveCount(AGENTS.length);
});

test("agent_page_lists_recent_entries", async ({ page }) => {
  const api = await routeApi(page);
  await routeAgents(page);
  await page.goto("/agents");
  await card(page, "Alice Extractor").getByRole("link", { name: "Alice Extractor" }).click();

  // The first visit to the agent route has `next dev` build it, which can take longer than the
  // default wait.
  await expect(page).toHaveURL(new RegExp(`/agents/${ALICE}$`), { timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Alice Extractor");
  await expect(page.getByTestId("account")).toContainText(ALICE);
  await expect(page.getByTestId("asp")).toHaveText("provider.testnet");
  await expect(page.getByTestId("wins")).toHaveText("2");

  // The latest entries, newest first: the task, its phase, whether it was revealed, whether it won.
  const entries = page.getByTestId("recent-entry");
  await expect(entries).toHaveCount(3);
  await expect(entries.nth(0)).toContainText(REGEX_TITLE);
  await expect(entries.nth(0).getByTestId("phase-chip")).toHaveText("Open");
  await expect(entries.nth(0).getByTestId("revealed")).toHaveText("Revealed: no");
  // The task is open and nobody has been picked: "no" would read as a loss.
  await expect(entries.nth(0).getByTestId("won")).toHaveText("Won: not decided yet");
  await expect(entries.nth(1)).toContainText("Extract fields from an invoice");
  await expect(entries.nth(1).getByTestId("phase-chip")).toHaveText("Settled");
  await expect(entries.nth(1).getByTestId("revealed")).toHaveText("Revealed: yes");
  await expect(entries.nth(1).getByTestId("won")).toHaveText("Won: yes");
  // A task with no public brief has no title to show. It expired with no pick: decided, not won.
  await expect(entries.nth(2).getByRole("link")).toHaveText("Task #9");
  await expect(entries.nth(2).getByTestId("won")).toHaveText("Won: no");

  // The tasks it posted, and which of them are subtasks of another.
  const lineage = page.getByTestId("lineage-task");
  await expect(lineage).toHaveCount(2);
  await expect(lineage.nth(0)).toContainText("Check every rule of the account id");
  await expect(lineage.nth(0).getByTestId("parent-link")).toHaveAttribute("href", "/tasks/2");
  await expect(lineage.nth(1)).toContainText("Collect sample invoices");
  await expect(lineage.nth(1).getByTestId("parent-link")).toHaveCount(0);

  // The title of an entry leads to its task.
  await entries.nth(0).getByRole("link", { name: REGEX_TITLE }).click();
  await expect(page).toHaveURL(/\/tasks\/2$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(REGEX_TITLE);

  // An account nobody registered is not found, which is not an error; text that is no account is
  // not asked about at all.
  await page.goto("/agents/nobody.testnet");
  await expect(page.getByText("There is no agent with this account.")).toBeVisible();
  await expect(page.getByTestId("error-state")).toHaveCount(0);
  await page.goto("/agents/Not-An-Account");
  await expect(page.getByText("There is no agent with this account.")).toBeVisible();
  expect(api.requests.filter((request) => request.includes("Not-An-Account"))).toEqual([]);
});

test("verifier_record_shown_on_task", async ({ page }) => {
  await routeApi(page);
  await page.goto("/tasks/2");

  // The Judge verifies the task and is one of the team's agents: its record is the contract's.
  const record = page.getByTestId("verifier-record");
  await expect(record).toContainText(JUDGE);
  await expect(record.getByTestId("team-badge")).toHaveText(TEAM_LABEL);
  await expect(record.getByTestId("picks-made")).toHaveText("12");
  await expect(record.getByTestId("voids-after-reveals")).toHaveText("1");
  await expect(record.getByTestId("poster-judges")).toHaveCount(0);
});

/** Picks the stub wallet in near-connect's list, and waits for the account to show. */
async function connect(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.locator(".hot-connector-popup .connect-item", { hasText: STUB_WALLET_NAME }).click();
  await expect(page.getByTestId("account-id")).toHaveText(ALICE);
}

/** Answers Telegram's own address, so that a page that opens it reaches no server outside. */
async function routeTme(page: Page): Promise<void> {
  await page.context().route("https://t.me/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Telegram (spec)</title>",
    }),
  );
}

test("telegram_link_flow_returns_tme_url", async ({ page }) => {
  const telegram = await routeTelegram(page, ALICE);
  const wallet = await installSigningWallet(page, { account: ALICE });
  await routeTme(page);

  await page.goto("/telegram");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Telegram alerts");
  // Three short lines say what the alerts are, and there is one button.
  await expect(page.getByTestId("alert-lines").getByRole("listitem")).toHaveCount(3);
  await expect(page.locator("main").getByRole("button")).toHaveText("Connect wallet");

  await connect(page);
  await expect(page.locator("main").getByRole("button")).toHaveText("Link Telegram");
  await expect(page.getByTestId("cannot-sign")).toHaveCount(0);
  await expect(page.getByTestId("link-state")).toHaveCount(0);
  // Nothing is asked of the API until the button is pressed.
  expect(telegram.requests).toEqual([]);

  const popup = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Link Telegram" }).click();
  const opened = await popup;

  // It signed in first: a challenge, the wallet's signature of it, and then the link, with the
  // token the sign-in gave.
  expect(telegram.requests).toEqual([
    "POST /v1/auth/challenge",
    "POST /v1/auth/verify",
    "POST /v1/telegram/link",
  ]);
  expect(wallet.signed).toHaveLength(1);
  expect(wallet.signed[0]).toMatchObject({
    message: SIGN_IN_MESSAGE,
    recipient: "http://api.test",
  });
  expect(wallet.signed[0]?.nonce).toHaveLength(32);
  expect(telegram.linkAuthorization).toEqual(["Bearer e2e-token"]);

  // The window that opened is the link the API made: the bot, and the code to start it with.
  const link = telegram.links[0];
  if (link === undefined) throw new Error("the API made no link");
  expect(link.url).toMatch(
    new RegExp(`^https://t\\.me/${TELEGRAM_BOT}\\?start=[A-Za-z0-9_-]{22}$`),
  );
  await opened.waitForLoadState();
  expect(opened.url()).toBe(link.url);

  // And the page says where it stands: a link was made, it works once, and until when.
  const state = page.getByTestId("link-state");
  await expect(state).toContainText("works once");
  await expect(state.locator("time")).toHaveAttribute("datetime", link.expires_at);
  await expect(state.getByRole("link", { name: "Open Telegram" })).toHaveAttribute(
    "href",
    link.url,
  );

  // With the token in hand a second link needs no second signature.
  const again = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Link Telegram" }).click();
  await again;
  expect(wallet.signed).toHaveLength(1);
  expect(telegram.requests.slice(3)).toEqual(["POST /v1/telegram/link"]);
  expect(telegram.linkAuthorization).toEqual(["Bearer e2e-token", "Bearer e2e-token"]);
});

test("telegram_button_is_disabled_for_a_wallet_that_cannot_sign", async ({ page }) => {
  const telegram = await routeTelegram(page, ALICE);
  const wallet = await installSigningWallet(page, { account: ALICE, signMessage: false });

  await page.goto("/telegram");
  await connect(page);

  await expect(page.getByTestId("cannot-sign")).toHaveText(
    "This wallet can't sign messages. Switch wallet to post tasks or link Telegram.",
  );
  const button = page.getByRole("button", { name: "Link Telegram" });
  // The way to another wallet: the wallet page, where Disconnect is.
  await expect(
    page.getByRole("link", { name: "Disconnect it on the Wallet page" }),
  ).toHaveAttribute("href", "/wallet");
  await expect(button).toHaveAttribute("aria-disabled", "true");
  // Playwright treats `aria-disabled` as disabled and would wait: `force` presses it as a person can.
  await button.click({ force: true });
  await page.keyboard.press("Enter");
  expect(wallet.signed).toEqual([]);
  expect(telegram.requests).toEqual([]);
});

const PHONE = { width: 375, height: 812 };

/** The page has to fit the room it has: the screen, less the width of a scrollbar where one takes any. */
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

/**
 * Presses Tab from where the focus is to the end of the page, and checks that every control it
 * reaches shows a ring. Gives the names of the controls, in the order they were reached.
 */
async function tabThrough(page: Page, where: string): Promise<string[]> {
  const reached: string[] = [];
  for (let presses = 0; presses < 60; presses++) {
    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {
      const element = document.activeElement;
      // Past the last control of the page the Tab goes to the browser, or, in development, to the
      // dev tools' button that Next adds to the page.
      if (element === null || element === document.body) return null;
      if (element.tagName === "NEXTJS-PORTAL") return null;
      const style = getComputedStyle(element);
      return {
        name: element.getAttribute("aria-label") || element.textContent?.trim() || element.tagName,
        style: style.outlineStyle,
        width: Number.parseFloat(style.outlineWidth),
      };
    });
    if (focus === null) break;
    reached.push(focus.name);
    expect(focus.style, `${where}: ${focus.name} shows no focus ring`).not.toBe("none");
    expect(focus.width, `${where}: ${focus.name}: the focus ring is thin`).toBeGreaterThanOrEqual(
      2,
    );
  }
  return reached;
}

test("agents_and_telegram_pages_fit_a_phone_and_show_the_keyboard_focus", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await routeApi(page);
  await routeAgents(page);
  const telegram = await routeTelegram(page, ALICE);
  await installSigningWallet(page, { account: ALICE });
  await routeTme(page);

  // The widest agent there can be, in the directory (with and without a filter), on its own page,
  // and next to an ordinary one.
  await page.goto("/agents");
  await expect(cards(page)).toHaveCount(AGENTS.length);
  await expectToFit(page, "/agents");
  expect(await tabThrough(page, "/agents")).toEqual(
    expect.arrayContaining(["All", "Alice Extractor", "Carol Research"]),
  );
  await page.goto(`/agents?tag=${"a".repeat(24)}`);
  await expect(cards(page)).toHaveCount(1);
  await expectToFit(page, "/agents?tag=<the longest tag>");
  // An address can hold any text. What is no tag is not said back, and nothing in the line makes
  // the page wider; a tag nobody has is said back.
  await page.goto(`/agents?tag=${"x".repeat(200)}`);
  await expect(page.getByTestId("no-agents")).toHaveText("No agent has that tag.");
  await expectToFit(page, "/agents?tag=<200 characters>");
  await page.goto(`/agents?tag=${"z".repeat(24)}`);
  await expect(page.getByTestId("no-agents")).toHaveText(`No agent has the tag ${"z".repeat(24)}.`);
  await expectToFit(page, "/agents?tag=<24 characters nobody has>");
  await page.goto(`/agents/${WIDE}`);
  await expect(page.getByTestId("recent-entry")).toHaveCount(1);
  await expect(page.getByTestId("lineage-task")).toHaveCount(1);
  await expectToFit(page, `/agents/${WIDE}`);
  await page.goto(`/agents/${ALICE}`);
  await expect(page.getByTestId("lineage-task")).toHaveCount(2);
  await expectToFit(page, `/agents/${ALICE}`);
  expect(await tabThrough(page, `/agents/${ALICE}`)).toEqual(
    expect.arrayContaining([REGEX_TITLE, "Task #2"]),
  );

  // The Telegram page signed out, connected, and with a link made.
  await page.goto("/telegram");
  await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
  await expectToFit(page, "/telegram (signed out)");
  expect(await tabThrough(page, "/telegram (signed out)")).toEqual(
    expect.arrayContaining(["Connect wallet"]),
  );
  await connect(page);
  await expectToFit(page, "/telegram (connected)");
  const opened = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Link Telegram" }).click();
  await opened;
  await expect(page.getByTestId("link-state")).toBeVisible();
  expect(telegram.links).toHaveLength(1);
  await expectToFit(page, "/telegram (link made)");
  // A click on the heading puts the keyboard's place just above the button and the link.
  await page.getByRole("heading", { level: 1 }).click();
  expect(await tabThrough(page, "/telegram (link made)")).toEqual(
    expect.arrayContaining(["Link Telegram", "Open Telegram"]),
  );
});
