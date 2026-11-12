import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";
import { FakeChain, FakeNode } from "../../test/fakeChain";
import { API_URL, RPC_URL, routeApi } from "../fixtures";
import { installWallet, routeWalletManifest, STUB_WALLET_NAME } from "../walletStub";

// The email and Google login in a browser, in a build with a Privy app id (playwright.privy.config.ts),
// with Privy's kit replaced by the stand-in in e2e/privy/kit.tsx: Connect's chooser at a phone's
// width and a laptop's, the NEAR wallets as the second choice (near-connect, as the first suite
// drives it), and a login that gets its new account ready: its balance read from the node, the gas
// gift asked of the API (`POST /v1/gas-gift`, answered here: the route is another lane's), the node
// read again until the NEAR is there, and the wallet page saying who holds the key.
//
// With PRIVY_SHOTS set to a directory, the chooser, "Getting your account ready…", a refused gift,
// a gift whose send failed, and the wallet page of a login are saved there at 375 and 1440 px wide.

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
  options: { login?: "email" | "google"; refuse?: string; refuseStatus?: number } = {},
): Promise<Login> {
  await routeApi(page);
  await routeWalletManifest(page);
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
    { address: ACCOUNT, login: options.login ?? "email" },
  );
  return { gifts, land: () => release() };
}

const chooser = (page: Page) => page.getByRole("dialog");

test("the_chooser_offers_the_login_first_and_a_near_wallet_second_at_both_widths", async ({
  page,
}) => {
  await loginWorld(page);
  for (const size of [PHONE, LAPTOP]) {
    await page.setViewportSize(size);
    await page.goto("/wallet");
    await page.locator("main").getByRole("button", { name: "Connect wallet" }).click();
    await expect(chooser(page).getByRole("heading")).toHaveText("Connect to Tender");
    await expect(
      chooser(page).getByRole("button", { name: "Continue with email or Google" }),
    ).toBeFocused();
    await expect(chooser(page).getByRole("button", { name: "Use a NEAR wallet" })).toBeVisible();
    // The whole chooser is on the screen, inside the page's gutters.
    const box = await chooser(page).boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(16);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(size.width - 16);
    await page.keyboard.press("Escape");
    await expect(chooser(page)).toHaveCount(0);
  }
  await page.locator("main").getByRole("button", { name: "Connect wallet" }).click();
  await shoot(page, "chooser");
});

test("use_a_near_wallet_opens_near_connect_as_connect_did_before", async ({ page }) => {
  await routeApi(page);
  await installWallet(page, new FakeChain(CONTRACT, [{ token: TOKEN }]), { account: ALICE });
  await page.addInitScript(() => {
    (window as unknown as { __tenderPrivyStub: unknown }).__tenderPrivyStub = {
      address: "0".repeat(64),
      login: "email",
    };
  });
  await page.goto("/wallet");
  await page.locator("main").getByRole("button", { name: "Connect wallet" }).click();
  await chooser(page).getByRole("button", { name: "Use a NEAR wallet" }).click();
  await expect(chooser(page)).toHaveCount(0);
  await page.locator(".hot-connector-popup .connect-item", { hasText: STUB_WALLET_NAME }).click();
  await expect(page.getByTestId("account-id")).toHaveText(ALICE);
  await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
  await expect(page.getByTestId("key-holder")).toHaveCount(0);
});

test("a_login_gets_its_account_ready_and_the_wallet_page_says_who_holds_the_key", async ({
  page,
}) => {
  const world = await loginWorld(page);
  await page.setViewportSize(LAPTOP);
  await page.goto("/wallet");
  await page.locator("main").getByRole("button", { name: "Connect wallet" }).click();
  await chooser(page).getByRole("button", { name: "Continue with email or Google" }).click();

  // The new account has no NEAR: Tender is asked for some, with the login's token.
  await expect(chooser(page).getByTestId("account-preparing")).toHaveText(
    "Getting your account ready…",
  );
  await expect.poll(() => world.gifts).toEqual([`Bearer e2e-login-token ${ACCOUNT}`]);
  await shoot(page, "preparing");

  world.land();
  await expect(chooser(page)).toHaveCount(0);
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

  // A reload takes the login up again, with no chooser and no second gift.
  await page.reload();
  await expect(page.getByTestId("login-label")).toHaveText("Email login");
  await expect(chooser(page)).toHaveCount(0);
  expect(world.gifts).toHaveLength(1);

  // Log out ends both: the page offers Connect again, and a reload finds no login.
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.locator("main").getByRole("button", { name: "Connect wallet" })).toBeVisible();
  await page.reload();
  await expect(page.locator("main").getByRole("button", { name: "Connect wallet" })).toBeVisible();
});

test("a_refused_gift_says_so_with_the_faucet_and_the_account_to_copy", async ({ page }) => {
  await loginWorld(page, { login: "google", refuse: "gift_off" });
  await page.setViewportSize(PHONE);
  await page.goto("/wallet");
  await page.locator("main").getByRole("button", { name: "Connect wallet" }).click();
  await chooser(page).getByRole("button", { name: "Continue with email or Google" }).click();

  await expect(chooser(page).getByTestId("account-stuck")).toHaveText(
    "Tender isn't sending NEAR for fees right now.",
  );
  const faucet = chooser(page).getByRole("link", { name: "Open the faucet" });
  await expect(faucet).toHaveAttribute("href", "https://near-faucet.io/");
  await expect(chooser(page).getByTestId("stuck-account")).toHaveAttribute("title", ACCOUNT);
  await expect(chooser(page).getByRole("button", { name: "Copy account" })).toBeVisible();
  await shoot(page, "stuck");

  // The person is logged in all the same, as a Google login; the account waits for its NEAR.
  await chooser(page).getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("login-label")).toHaveText("Google login");
});

test("a_gift_whose_send_failed_offers_try_again_first_and_the_faucet_second", async ({ page }) => {
  await loginWorld(page, { refuse: "transfer_failed", refuseStatus: 502 });
  await page.setViewportSize(PHONE);
  await page.goto("/wallet");
  await page.locator("main").getByRole("button", { name: "Connect wallet" }).click();
  await chooser(page).getByRole("button", { name: "Continue with email or Google" }).click();

  await expect(chooser(page).getByTestId("account-stuck")).toHaveText(
    "Couldn't send yet. Try again in a moment.",
  );
  await expect(chooser(page).getByRole("button", { name: "Try again" })).toBeFocused();
  await expect(chooser(page).getByRole("link", { name: "Open the faucet" })).toBeVisible();
  await expect(chooser(page).getByTestId("stuck-account")).toHaveAttribute("title", ACCOUNT);
  await shoot(page, "stuck-retry");
});
