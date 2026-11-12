import { expect, type Page, test } from "@playwright/test";
import { FakeChain } from "../test/fakeChain";
import { installWallet, pickStubWallet } from "./walletStub";

// The wallet page in a browser, against a model of the contract and its token (test/fakeChain.ts)
// and a wallet that announces itself the way an extension does (e2e/walletStub.ts). The page
// finds the wallet through near-connect, so the picker, the connection and the batches it sends
// are the real ones; what the contract does with them is the model's. The page needs nothing from
// the API.

// The contract is the one the web server is built for (playwright.config.ts). tusdc.* is the test
// USDC of the app's token list: six decimals, symbol tUSDC.
const CONTRACT = "tender.tender-team.testnet";
const TOKEN = "tusdc.tender-team.testnet";
const ALICE = "alice.testnet";
const TUSDC = (whole: number) => BigInt(whole) * 1_000_000n;

const section = (page: Page, title: string) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: title, exact: true }) });

const row = (page: Page) => page.getByTestId("token-row").filter({ hasText: TOKEN });

/** Opens the page, picks the wallet in near-connect's list, and waits for the account to show. */
async function connect(page: Page): Promise<void> {
  await page.goto("/wallet");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await pickStubWallet(page);
  await expect(page.getByTestId("account-id")).toHaveText(ALICE);
}

/** What the model holds in Tender's vault for ALICE, by token. */
const vaultOf = (chain: FakeChain) =>
  Object.fromEntries(
    (
      chain.view(CONTRACT, "balances_of", { account_id: ALICE }) as Array<{
        token: string;
        amount: string;
      }>
    ).map(({ token, amount }) => [token, amount]),
  );

test("register_deposit_withdraw_round_trip", async ({ page }) => {
  const chain = new FakeChain(CONTRACT, [{ token: TOKEN }]);
  chain.give(TOKEN, ALICE, TUSDC(50));
  const wallet = await installWallet(page, chain, { account: ALICE });

  // Signed out, the page offers the one thing there is to do.
  await page.goto("/wallet");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Wallet");
  await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
  await expect(page.getByTestId("account-id")).toHaveCount(0);

  await page.getByRole("button", { name: "Connect wallet" }).click();
  await pickStubWallet(page);
  await expect(page.getByTestId("account-id")).toHaveText(ALICE);
  await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();

  // The account has nothing with Tender: the wallet holds the tokens, the vault is empty, and
  // there is nowhere to put anything until the account is set up.
  await expect(row(page).getByTestId("wallet-balance")).toHaveText("50.00 tUSDC");
  await expect(row(page).getByTestId("vault-balance")).toHaveText("0.00 tUSDC");
  await expect(section(page, "Add funds").getByTestId("form-unavailable")).toHaveText(
    "Set up your account first.",
  );

  // Register: 0.05 NEAR for storage, one transaction to Tender.
  await page.getByRole("button", { name: "Set up account" }).click();
  await expect(page.getByTestId("notice")).toHaveText(
    "Your account is set up. 0.05 NEAR is deposited for storage.",
  );
  await expect(page.getByTestId("storage-total")).toHaveText("0.05 NEAR");
  expect(wallet.sent).toHaveLength(1);
  expect(wallet.sent[0]?.transactions.map((t) => t.receiverId)).toEqual([CONTRACT]);
  expect(wallet.sent[0]?.transactions[0]?.actions[0]).toMatchObject({
    type: "FunctionCall",
    params: { methodName: "storage_deposit", deposit: "50000000000000000000000" },
  });

  // Deposit: 20 of the 50, from the wallet into the vault.
  const add = section(page, "Add funds");
  await add.getByLabel("Amount").fill("20");
  await add.getByRole("button", { name: "Add funds" }).click();
  await expect(page.getByTestId("notice")).toHaveText("Added 20.00 tUSDC to your vault.");
  await expect(row(page).getByTestId("vault-balance")).toHaveText("20.00 tUSDC");
  await expect(row(page).getByTestId("wallet-balance")).toHaveText("30.00 tUSDC");
  expect(vaultOf(chain)).toEqual({ [TOKEN]: TUSDC(20).toString() });

  // Withdraw: 5 of the 20 back. The token already knows the account, so it is one transaction.
  const take = section(page, "Withdraw");
  await take.getByLabel("Amount").fill("5");
  await take.getByRole("button", { name: "Withdraw" }).click();
  await expect(page.getByTestId("notice")).toHaveText("Withdrew 5.00 tUSDC to your wallet.");
  await expect(row(page).getByTestId("vault-balance")).toHaveText("15.00 tUSDC");
  await expect(row(page).getByTestId("wallet-balance")).toHaveText("35.00 tUSDC");
  expect(vaultOf(chain)).toEqual({ [TOKEN]: TUSDC(15).toString() });
  expect(wallet.sent.at(-1)?.transactions.map((t) => t.receiverId)).toEqual([CONTRACT]);

  // An amount the vault does not hold is refused where it is typed, and nothing is sent.
  const batches = wallet.sent.length;
  await take.getByLabel("Amount").fill("16");
  await take.getByRole("button", { name: "Withdraw" }).click();
  await expect(take.getByTestId("amount-error")).toHaveText(
    "That's more than you have in the vault.",
  );
  expect(wallet.sent).toHaveLength(batches);

  // What is left of the storage deposit comes back too.
  await page.getByRole("button", { name: "Withdraw unused storage" }).click();
  await expect(page.getByTestId("notice")).toHaveText("Took back your unused storage.");
  await expect(page.getByTestId("storage-available")).toHaveText("0.00 NEAR");

  // Disconnecting leaves the connect button, with nothing of the account on the page.
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
  await expect(page.getByTestId("token-row")).toHaveCount(0);
});

test("withdraw_registers_the_account_at_the_token_first", async ({ page }) => {
  // The vault holds 100 tUSDC for ALICE, whom the token has not registered: a token pays only an
  // account it knows, so the page puts the registration in front of the withdrawal.
  const chain = new FakeChain(CONTRACT, [{ token: TOKEN }]);
  chain.fundVault(ALICE, TOKEN, TUSDC(100));
  chain.give(TOKEN, CONTRACT, TUSDC(100));
  const wallet = await installWallet(page, chain, { account: ALICE });

  await connect(page);
  await expect(row(page).getByTestId("vault-balance")).toHaveText("100.00 tUSDC");
  await expect(row(page).getByTestId("wallet-balance")).toHaveText("0.00 tUSDC");

  const take = section(page, "Withdraw");
  await take.getByLabel("Amount").fill("40");
  await take.getByRole("button", { name: "Withdraw" }).click();

  await expect(page.getByTestId("notice")).toHaveText("Withdrew 40.00 tUSDC to your wallet.");
  await expect(row(page).getByTestId("wallet-balance")).toHaveText("40.00 tUSDC");
  await expect(row(page).getByTestId("vault-balance")).toHaveText("60.00 tUSDC");

  // One approval, two transactions in this order: the token's registration, then the withdrawal.
  expect(wallet.sent).toHaveLength(1);
  const [registration, withdrawal] = wallet.sent[0]?.transactions ?? [];
  expect(registration?.receiverId).toBe(TOKEN);
  expect(registration?.actions.map((a) => a.params.methodName)).toEqual(["storage_deposit"]);
  expect(registration?.actions[0]?.params.args).toMatchObject({ account_id: ALICE });
  expect(withdrawal?.receiverId).toBe(CONTRACT);
  expect(withdrawal?.actions.map((a) => a.params.methodName)).toEqual(["withdraw"]);
  expect(vaultOf(chain)).toEqual({ [TOKEN]: TUSDC(60).toString() });
});

test("get_test_tusdc_registers_the_account_and_mints_in_one_approval", async ({ page }) => {
  // The build is for testnet (playwright.config.ts), where the page offers free test tokens. The
  // token has not registered ALICE, so the registration goes in front of the mint: one approval,
  // one transaction, to the token.
  const chain = new FakeChain(CONTRACT, [{ token: TOKEN }]);
  const wallet = await installWallet(page, chain, { account: ALICE });

  await connect(page);
  await expect(row(page).getByTestId("wallet-balance")).toHaveText("0.00 tUSDC");
  const faucet = page.getByTestId("faucet");
  await expect(faucet).toContainText("Free test tokens with no value");
  await expect(faucet).toContainText("Testnet only");

  await faucet.getByRole("button", { name: "Get test tUSDC" }).click();

  await expect(faucet.getByTestId("notice")).toHaveText(
    "Added 20.00 tUSDC to your wallet. They are free test tokens with no value.",
  );
  await expect(row(page).getByTestId("wallet-balance")).toHaveText("20.00 tUSDC");
  expect(wallet.sent).toHaveLength(1);
  expect(wallet.sent[0]?.transactions.map((t) => t.receiverId)).toEqual([TOKEN]);
  expect(wallet.sent[0]?.transactions[0]?.actions.map((a) => a.params.methodName)).toEqual([
    "storage_deposit",
    "mint",
  ]);
  expect(wallet.sent[0]?.transactions[0]?.actions[1]?.params.args).toEqual({
    account_id: ALICE,
    amount: TUSDC(20).toString(),
  });

  // The account is registered now, so a second press is the mint alone.
  await faucet.getByRole("button", { name: "Get test tUSDC" }).click();
  await expect(row(page).getByTestId("wallet-balance")).toHaveText("40.00 tUSDC");
  expect(wallet.sent[1]?.transactions[0]?.actions.map((a) => a.params.methodName)).toEqual([
    "mint",
  ]);
});

test("wallet_that_cannot_sign_messages_says_so_and_still_moves_funds", async ({ page }) => {
  const chain = new FakeChain(CONTRACT, [{ token: TOKEN }]);
  chain.fundVault(ALICE, TOKEN, TUSDC(10));
  chain.give(TOKEN, ALICE, TUSDC(1));
  await installWallet(page, chain, { account: ALICE, signMessage: false });

  await connect(page);

  await expect(page.getByTestId("cannot-sign")).toHaveText(
    "This wallet can't sign messages. Switch wallet to post tasks or link Telegram.",
  );
  // What the wallet can't do is the signing of messages. Sending transactions is another thing.
  const add = section(page, "Add funds");
  await add.getByLabel("Amount").fill("1");
  await add.getByRole("button", { name: "Add funds" }).click();
  await expect(page.getByTestId("notice")).toHaveText("Added 1.00 tUSDC to your vault.");
  await expect(row(page).getByTestId("vault-balance")).toHaveText("11.00 tUSDC");
});

test("wallet_page_fits_a_phone_and_shows_the_keyboard_focus", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const chain = new FakeChain(CONTRACT, [{ token: TOKEN }]);
  chain.fundVault(ALICE, TOKEN, TUSDC(10));
  chain.give(TOKEN, ALICE, TUSDC(1));
  await installWallet(page, chain, { account: ALICE });
  await connect(page);
  await expect(row(page)).toBeVisible();

  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    page: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  const room = Math.min(375, widths.client);
  expect(widths.page).toBeLessThanOrEqual(room);
  expect(widths.body).toBeLessThanOrEqual(room);

  // Every control the keyboard reaches shows where it is.
  const reached: string[] = [];
  for (let presses = 0; presses < 40; presses++) {
    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {
      const element = document.activeElement;
      // Past the last control of the page the Tab goes to the browser, or, in development, to
      // the dev tools' button that Next adds to the page.
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
    expect(focus.style, `${focus.name} shows no focus ring`).not.toBe("none");
    expect(focus.width, `${focus.name}: the focus ring is thin`).toBeGreaterThanOrEqual(2);
  }
  expect(reached).toEqual(expect.arrayContaining(["Disconnect", "Add funds", "Withdraw"]));
});

test("a_disconnect_in_one_tab_signs_the_other_tab_out", async ({ context, page }) => {
  // The wallet's session is the browser's: a second tab of the site finds the wallet the first
  // connected. The tabs tell each other when a session ends, so the second does not go on showing
  // an account the wallet has signed out of.
  const chain = new FakeChain(CONTRACT, [{ token: TOKEN }]);
  chain.give(TOKEN, ALICE, TUSDC(5));
  await installWallet(page, chain, { account: ALICE });
  await connect(page);
  await expect(row(page).getByTestId("wallet-balance")).toHaveText("5.00 tUSDC");

  const other = await context.newPage();
  await installWallet(other, chain, { account: ALICE });
  await other.goto("/wallet");
  await expect(other.getByTestId("account-id")).toHaveText(ALICE);
  await expect(row(other).getByTestId("wallet-balance")).toHaveText("5.00 tUSDC");

  await page.getByRole("button", { name: "Disconnect" }).click();

  await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
  await expect(other.getByRole("button", { name: "Connect wallet" })).toBeVisible();
  await expect(other.getByTestId("account-id")).toHaveCount(0);
  await expect(other.getByTestId("token-row")).toHaveCount(0);
});
