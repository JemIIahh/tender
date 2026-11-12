import { expect, test } from "@playwright/test";
import { SIGN_IN_MESSAGE } from "@tender/shared";
import { loadRun } from "./run";

// The Telegram page against the real API: the dev wallet signs in the way a wallet does (a NEP-413
// message that the API checks against the account's keys on the chain), the API makes a link for
// the bot of the run, and the page opens it. Telegram itself is never reached: the services have
// no bot token, and the address of Telegram is answered here.

test("telegram_link_flow_returns_tme_url", async ({ page }) => {
  const run = loadRun();
  await page.context().route("https://t.me/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Telegram (spec)</title>",
    }),
  );
  /** The sign-in and the link, as the page sent them to the API. */
  const sent: Array<{ route: string; authorization?: string; body: unknown }> = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (request.url().startsWith(run.apiUrl) && /^\/v1\/(auth|telegram)\//.test(pathname)) {
      sent.push({
        route: `${request.method()} ${pathname}`,
        authorization: request.headers().authorization,
        body: request.postData() === null ? undefined : request.postDataJSON(),
      });
    }
  });

  await page.goto("/telegram");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Telegram alerts");
  const button = page.locator("main").getByRole("button");
  await expect(button).toHaveText("Sign in");
  // The dev wallet has no picker: it connects at once.
  await button.click();
  await expect(page.getByTestId("account-id")).toHaveText(run.dev);
  await expect(button).toHaveText("Link Telegram");
  // Nothing is asked of the API until the button is pressed.
  expect(sent).toEqual([]);

  const popup = page.waitForEvent("popup", { timeout: 20_000 });
  await button.click();
  const opened = await popup;
  await opened.waitForLoadState();

  // It signed in first: a challenge, the wallet's signature of it, and then the link, with the
  // token the sign-in gave.
  expect(
    sent.map(({ route }) => route),
    "the page's requests to the API",
  ).toEqual(["POST /v1/auth/challenge", "POST /v1/auth/verify", "POST /v1/telegram/link"]);
  expect(sent[1]?.body).toMatchObject({
    account_id: run.dev,
    message: SIGN_IN_MESSAGE,
    recipient: run.apiUrl,
  });
  expect(sent[2]?.authorization).toMatch(/^Bearer \S+$/);

  // The window that opened is the link the API made: the bot, and the code to start it with.
  expect(opened.url()).toMatch(
    new RegExp(`^https://t\\.me/${run.botUsername}\\?start=[A-Za-z0-9_-]{22}$`),
  );

  // And the page says where it stands: a link was made, it works once, and until when.
  const state = page.getByTestId("link-state");
  await expect(state).toContainText("works once");
  await expect(state.getByRole("link", { name: "Open Telegram" })).toHaveAttribute(
    "href",
    opened.url(),
  );

  // With the token in hand a second link needs no second signature.
  const again = page.waitForEvent("popup", { timeout: 20_000 });
  await button.click();
  await again;
  expect(sent.slice(3).map(({ route }) => route)).toEqual(["POST /v1/telegram/link"]);
  expect(sent[3]?.authorization).toBe(sent[2]?.authorization);
});
