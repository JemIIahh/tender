import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";
import { FakeChain, FakeNode } from "../../test/fakeChain";
import { API_URL, RPC_URL, routeApi } from "../fixtures";
import {
  installWallet,
  LISTED_WALLETS,
  pickStubWallet,
  routeWalletManifest,
  STUB_WALLET_NAME,
} from "../walletStub";

// The email and Google login in a browser, in a build with a Privy app id (playwright.privy.config.ts),
// with Privy's kit replaced by the stand-in in e2e/privy/kit.tsx: Connect's one window at a phone's
// width and a laptop's (the email field, Google, and the NEAR wallets near-connect lists, as rows),
// a wallet's row that connects it with no second window, the email login's code step, the Google
// login's trip away from the page and back, and a login that gets its new account ready: its
// balance read from the node, the gas gift asked of the API (`POST /v1/gas-gift`, answered here:
// the route is another lane's), the node read again until the NEAR is there, and the wallet page
// saying who holds the key.
//
// With PRIVY_SHOTS set to a directory, the window, the code step, "Getting your account ready…", a
// refused gift, a gift whose send failed, and the wallet page of a login are saved there at 375 and
// 1440 px wide.

const CONTRACT = "tender.tender-team.testnet";
const TOKEN = "tusdc.tender-team.testnet";
/** The implicit account the stand-in's login has, as Privy's NEAR wallet's address. */
const ACCOUNT = "7c1f0b9a52e4d38c6a0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6e5f4a3";
const ALICE = "alice.testnet";
const GIFT = 100_000_000_000_000_000_000_000n;
const PHONE = { width: 375, height: 812 };
const LAPTOP = { width: 1440, height: 900 };
const SHOTS = process.env.PRIVY_SHOTS;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

/** Saves the page as `name` at both widths, and checks it does not scroll sideways at either. */
async function shoot(page: Page, name: string): Promise<void> {
  for (const [width, size] of [
    ["375", PHONE],
    ["1440", LAPTOP],
  ] as const) {
    await page.setViewportSize(size);
    // Two frames, so that what is captured is the page laid out at this width.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${name} at ${width}`).toBeLessThanOrEqual(0);
    if (SHOTS !== undefined && SHOTS !== "") {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `${name}-${width}.png`) });
    }
  }
}

interface Login {
  /** The `POST /v1/gas-gift` requests, as `Bearer <token> <account_id>`. */
  gifts: string[];
  /** Lets the gift land: the API answers, and the node has the NEAR. */
  land(): void;
}

/**
 * A world for a login as `login`: the fixture API, the node (a model of the contract, and
 * `view_account` for the login's account: nothing until the gift lands), and a gift route that
 * holds its answer until `land`, or answers `refuse` with that refusal.
 */
async function loginWorld(
  page: Page,
  options: {
    login?: "email" | "google";
    refuse?: string;
    refuseStatus?: number;
    oauth?: "deny";
    oauthDelayMs?: number;
  } = {},
): Promise<Login> {
  await routeApi(page);
  await routeWalletManifest(page, LISTED_WALLETS);
  const node = new FakeNode(new FakeChain(CONTRACT, [{ token: TOKEN }]));
  let landed = false;
  let release: () => void = () => {};
  const arrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gifts: string[] = [];

  await page.route(`${RPC_URL}/**`, async (route: Route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const body = request.postDataJSON() as {
      id: unknown;
      method: string;
      params: { request_type?: string; account_id?: string };
    };
    if (body.params.request_type === "view_account") {
      const result =
        landed && body.params.account_id === ACCOUNT
          ? { result: { amount: GIFT.toString(), locked: "0", block_height: 100 } }
          : { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" }, data: "" } };
      return route.fulfill({
        status: 200,
        headers: CORS,
        json: { jsonrpc: "2.0", id: body.id, ...result },
      });
    }
    return route.fulfill({
      status: 200,
      headers: CORS,
      json: { jsonrpc: "2.0", id: body.id, ...node.handle(body) },
    });
  });

  await page.route(`${API_URL}/v1/gas-gift`, async (route: Route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const { account_id: account } = request.postDataJSON() as { account_id: string };
    gifts.push(`${request.headers().authorization} ${account}`);
    if (options.refuse !== undefined) {
      return route.fulfill({
        status: options.refuseStatus ?? 503,
        headers: CORS,
        json: { error: options.refuse, message: "the gas gift can't be sent" },
      });
    }
    await arrived;
    landed = true;
    return route.fulfill({
      status: 200,
      headers: CORS,
      json: { status: "sent", amount: GIFT.toString(), tx_hash: "gifthash" },
    });
  });

  await page.addInitScript(
    (stub) => {
      (window as unknown as { __tenderPrivyStub: unknown }).__tenderPrivyStub = stub;
    },
    {
      address: ACCOUNT,
      login: options.login ?? "email",
      ...(options.oauth === undefined ? {} : { oauth: options.oauth }),
      ...(options.oauthDelayMs === undefined ? {} : { oauthDelayMs: options.oauthDelayMs }),
    },
  );
  return { gifts, land: () => release() };
}

const connectWindow = (page: Page) => page.getByRole("dialog");

/** Presses Sign in on the wallet page, and waits for the window's wallets. */
async function openWindow(page: Page): Promise<void> {
  await page.locator("main").getByRole("button", { name: "Sign in" }).click();
  await expect(connectWindow(page).getByRole("button", { name: /Birch Wallet/ })).toBeVisible();
}

/** Logs in by email in the window: the address, Submit, then the code. */
async function emailLogin(page: Page, code = "123456"): Promise<void> {
  await connectWindow(page).getByLabel("Email address").fill("ada@example.com");
  await connectWindow(page).getByRole("button", { name: "Submit" }).click();
  await expect(connectWindow(page).getByLabel("Code")).toBeFocused();
  await connectWindow(page).getByLabel("Code").fill(code);
}

test("the_window_offers_email_google_and_the_near_wallets_at_both_widths", async ({ page }) => {
  await loginWorld(page);
  for (const size of [PHONE, LAPTOP]) {
    await page.setViewportSize(size);
    await page.goto("/wallet");
    await openWindow(page);
    const panel = connectWindow(page);
    await expect(panel.getByRole("heading")).toHaveText("Log in or sign up");
    await expect(panel.getByLabel("Email address")).toBeFocused();
    await expect(panel.getByRole("button", { name: "Submit" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Continue with Google" })).toBeVisible();
    await expect(panel.getByText("or use a NEAR wallet")).toBeVisible();
    // One row for each wallet near-connect lists, with its site.
    await expect(panel.getByTestId("wallet-row")).toHaveText([
      "Ash Walletwallet.ash.test",
      "Birch Walletbirch.test",
    ]);
    await expect(
      panel.getByText("Email and Google login by Privy.", { exact: false }),
    ).toBeVisible();
    // The whole window is on the screen: on a phone, the width less a 16px gutter each side.
    const box = await panel.boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(16);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(size.width - 16);
    if (size === PHONE) expect(box?.width).toBe(size.width - 32);
    else expect(box?.width).toBe(360);
    await page.keyboard.press("Escape");
    await expect(connectWindow(page)).toHaveCount(0);
  }
  await openWindow(page);
  await shoot(page, "window");
});

test("the_bar_s_sign_in_opens_the_window_where_you_are_and_you_stay_there", async ({ page }) => {
  await routeApi(page);
  await installWallet(page, new FakeChain(CONTRACT, [{ token: TOKEN }]), { account: ALICE });
  await page.addInitScript(() => {
    (window as unknown as { __tenderPrivyStub: unknown }).__tenderPrivyStub = {
      address: "0".repeat(64),
      login: "email",
    };
  });
  const bar = page.getByRole("banner");
  for (const size of [PHONE, LAPTOP]) {
    await page.setViewportSize(size);
    await page.goto("/tasks");
    // A button, not a link: no page of its own.
    await expect(bar.getByRole("link", { name: "Sign in" })).toHaveCount(0);
    await bar.getByRole("button", { name: "Sign in" }).click();
    await expect(connectWindow(page).getByRole("heading")).toHaveText("Log in or sign up");
    await expect(connectWindow(page).getByLabel("Email address")).toBeFocused();
    expect(new URL(page.url()).pathname).toBe("/tasks");
    // The bar keeps Post task and the network's pill (its name is for screen readers on a phone).
    await expect(bar.getByRole("link", { name: "Post task" })).toBeVisible();
    await expect(bar.getByText("Testnet")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(connectWindow(page)).toHaveCount(0);
    // The focus goes back to the bar's button.
    await expect(bar.getByRole("button", { name: "Sign in" })).toBeFocused();
  }

  // The bar as it is: Post task, the network's pill, and Sign in.
  await shoot(page, "bar");

  // Signed in from the bar: still on the same page, and the bar names the account.
  await bar.getByRole("button", { name: "Sign in" }).click();
  await expect(connectWindow(page).getByTestId("wallet-row")).toHaveCount(1);
  await shoot(page, "bar-sign-in");
  await pickStubWallet(page);
  await expect(connectWindow(page)).toHaveCount(0);
  await expect(bar.getByRole("link", { name: ALICE })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Sign in" })).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/tasks");
  await shoot(page, "bar-signed-in");
});

test("a_wallet_row_connects_that_wallet_with_no_second_window", async ({ page }) => {
  await routeApi(page);
  await installWallet(page, new FakeChain(CONTRACT, [{ token: TOKEN }]), { account: ALICE });
  await page.addInitScript(() => {
    (window as unknown as { __tenderPrivyStub: unknown }).__tenderPrivyStub = {
      address: "0".repeat(64),
      login: "email",
    };
  });
  await page.goto("/wallet");
  await page.locator("main").getByRole("button", { name: "Sign in" }).click();
  await pickStubWallet(page);
  await expect(connectWindow(page)).toHaveCount(0);
  await expect(page.getByTestId("account-id")).toHaveText(ALICE);
  // near-connect's own list never opened.
  await expect(page.locator(".hot-connector-popup")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
  await expect(page.getByTestId("key-holder")).toHaveCount(0);

  // Next time, the window marks the wallet used last.
  await page.getByRole("button", { name: "Disconnect" }).click();
  await page.locator("main").getByRole("button", { name: "Sign in" }).click();
  await expect(
    connectWindow(page).getByRole("button", { name: STUB_WALLET_NAME }).getByTestId("last-used"),
  ).toHaveText("Last used");
});

test("the_code_step_says_a_wrong_code_and_back_keeps_the_address", async ({ page }) => {
  await loginWorld(page);
  await page.setViewportSize(LAPTOP);
  await page.goto("/wallet");
  await openWindow(page);

  // A wrong code: one plain line, and the field is ready for the next.
  await emailLogin(page, "000000");
  await expect(connectWindow(page).getByRole("alert")).toHaveText(
    "That code is wrong or has expired.",
  );
  await expect(connectWindow(page).getByLabel("Code")).toHaveValue("");
  await expect(connectWindow(page).getByRole("heading")).toHaveText("Check your email");
  await expect(connectWindow(page).getByText("Enter the code sent to")).toHaveText(
    "Enter the code sent to ada@example.com",
  );
  await shoot(page, "code-wrong");
  await connectWindow(page).getByRole("button", { name: "Back" }).click();
  await expect(connectWindow(page).getByLabel("Email address")).toHaveValue("ada@example.com");
  await connectWindow(page).getByRole("button", { name: "Submit" }).click();
  await expect(connectWindow(page).getByLabel("Code")).toBeFocused();
  await shoot(page, "code");
});

test("an_email_login_takes_its_code_gets_its_account_ready_and_the_wallet_page_says_who_holds_the_key", async ({
  page,
}) => {
  const world = await loginWorld(page);
  await page.setViewportSize(LAPTOP);
  await page.goto("/wallet");
  await openWindow(page);
  await emailLogin(page);

  // The new account has no NEAR: Tender is asked for some, with the login's token.
  await expect(connectWindow(page).getByTestId("account-preparing")).toHaveText(
    "Getting your account ready…",
  );
  await expect.poll(() => world.gifts).toEqual([`Bearer e2e-login-token ${ACCOUNT}`]);
  await shoot(page, "preparing");

  world.land();
  await expect(connectWindow(page)).toHaveCount(0);
  await expect(page.getByTestId("login-label")).toHaveText("Email login");
  await expect(page.getByTestId("account-id")).toHaveText(
    `${ACCOUNT.slice(0, 8)}…${ACCOUNT.slice(-8)}`,
  );
  await expect(page.getByTestId("key-holder")).toHaveText(
    "Privy keeps this account's key; you unlock it by logging in.",
  );
  await expect(page.getByRole("button", { name: "Export key" })).toBeVisible();
  await expect(page.getByTestId("pill-login")).toHaveText("Email login");
  await page.setViewportSize(LAPTOP);
  await expect(page.getByRole("button", { name: "Set up account" })).toBeVisible();
  await shoot(page, "wallet-login");

  // "Add an agent": the login's account is implicit, so the agent gets its own key's account.
  await page.goto("/my-agents/new");
  await expect(page.getByTestId("implicit-owner")).toHaveText(
    "Your account's name has no room for accounts under it, so your agent gets an account made from its own key.",
  );
  await expect(page.getByLabel("Account name")).toHaveCount(0);
  await shoot(page, "add-agent-login");
  await page.goto("/wallet");

  // A reload takes the login up again, with no window and no second gift.
  await page.reload();
  await expect(page.getByTestId("login-label")).toHaveText("Email login");
  await expect(connectWindow(page)).toHaveCount(0);
  expect(world.gifts).toHaveLength(1);

  // Log out ends both: the page offers Connect again, a reload finds no login, and the window
  // marks the email row as the way used last.
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.locator("main").getByRole("button", { name: "Sign in" })).toBeVisible();
  await page.reload();
  await openWindow(page);
  await expect(connectWindow(page).locator("form").getByTestId("last-used")).toHaveText(
    "Last used",
  );
});

test("a_google_login_leaves_and_comes_back_and_a_refused_gift_says_so_with_the_faucet", async ({
  page,
}) => {
  const world = await loginWorld(page, {
    login: "google",
    refuse: "gift_off",
    oauthDelayMs: 2500,
  });
  await page.setViewportSize(PHONE);
  await page.goto("/wallet");
  await openWindow(page);
  await connectWindow(page).getByRole("button", { name: "Continue with Google" }).click();

  // Back on the page it left, the window says the Google sign-in is being finished...
  await expect(connectWindow(page).getByTestId("google-finishing")).toHaveText(
    "Finishing your Google sign-in…",
  );
  await shoot(page, "google-finishing");

  // ...and, with Privy's parameters taken off the address, the login ends and the account is got
  // ready: here, Tender won't send.
  await expect(connectWindow(page).getByTestId("account-stuck")).toHaveText(
    "Tender isn't sending NEAR for fees right now.",
  );
  await expect(page).toHaveURL(/\/wallet$/);
  expect(world.gifts).toEqual([`Bearer e2e-login-token ${ACCOUNT}`]);
  const faucet = connectWindow(page).getByRole("link", { name: "Open the faucet" });
  await expect(faucet).toHaveAttribute("href", "https://near-faucet.io/");
  await expect(connectWindow(page).getByTestId("stuck-account")).toHaveAttribute("title", ACCOUNT);
  await expect(connectWindow(page).getByRole("button", { name: "Copy account" })).toBeVisible();
  await shoot(page, "stuck");

  // The person is logged in all the same, as a Google login; the account waits for its NEAR.
  await connectWindow(page).getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("login-label")).toHaveText("Google login");
});

test("a_google_sign_in_turned_down_says_so_in_the_window_with_every_way_still_there", async ({
  page,
}) => {
  const world = await loginWorld(page, { login: "google", oauth: "deny" });
  await page.setViewportSize(LAPTOP);
  await page.goto("/wallet");
  await openWindow(page);
  await connectWindow(page).getByRole("button", { name: "Continue with Google" }).click();

  // Back from "Google" with no login: the window opens again, says so, and offers every way.
  await expect(connectWindow(page).getByRole("alert")).toHaveText(
    "Google sign-in didn't finish. Try again or use email.",
  );
  await expect(page).toHaveURL(/\/wallet$/);
  await expect(connectWindow(page).getByLabel("Email address")).toBeVisible();
  await expect(
    connectWindow(page).getByRole("button", { name: "Continue with Google" }),
  ).toBeVisible();
  await expect(connectWindow(page).getByTestId("wallet-row")).toHaveCount(2);
  expect(world.gifts).toEqual([]);
  await shoot(page, "google-didnt-finish");

  // Closed, the page offers Sign in, signed in as nobody.
  await page.keyboard.press("Escape");
  await expect(page.locator("main").getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("a_gift_whose_send_failed_offers_try_again_first_and_the_faucet_second", async ({ page }) => {
  await loginWorld(page, { refuse: "transfer_failed", refuseStatus: 502 });
  await page.setViewportSize(PHONE);
  await page.goto("/wallet");
  await openWindow(page);
  await emailLogin(page);

  await expect(connectWindow(page).getByTestId("account-stuck")).toHaveText(
    "Couldn't send yet. Try again in a moment.",
  );
  await expect(connectWindow(page).getByRole("button", { name: "Try again" })).toBeFocused();
  await expect(connectWindow(page).getByRole("link", { name: "Open the faucet" })).toBeVisible();
  await expect(connectWindow(page).getByTestId("stuck-account")).toHaveAttribute("title", ACCOUNT);
  await shoot(page, "stuck-retry");
});
