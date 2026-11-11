import { expect, test } from "@playwright/test";
import { SIGN_IN_MESSAGE, sha256Hex } from "@tender/shared";
import { FakeChain } from "../test/fakeChain";
import { API_URL, routeApi } from "./fixtures";
import { installInjectedWallet } from "./injectedWallet";
import { routePostApi } from "./postApi";
import { ALICE, routeServices, SERVICES, service, TEST_TOKEN, WRITER } from "./servicesApi";
import { STUB_WALLET_NAME } from "./walletStub";

// The Services page and a hire, in a browser: the directory from the fixture API
// (e2e/servicesApi.ts), a service's page, and the Hire form, which signs in, uploads the request
// and the criteria (e2e/postApi.ts), and sends one batch through the wallet (e2e/injectedWallet.ts)
// to the model of the contract (test/fakeChain.ts). What lands on the model is a pinned task: the
// service's agent alone invited, once, at the listed price.

const CONTRACT = "tender.tender-team.testnet";
const TUSDC = (whole: number) => BigInt(whole) * 1_000_000n;
const REQUEST = "Summarise the 2026 annual report of Example Corp in five lines.";

test("services_directory_filters_and_opens_a_service", async ({ page }) => {
  await routeApi(page);
  await routeServices(page);
  await page.goto("/services");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Services. Hire work or buy an API response.",
  );
  // The sidebar's Services item is the page's.
  await expect(page.getByRole("link", { name: "Services", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  // The paused service is not listed.
  await expect(page.getByTestId("service-card")).toHaveCount(3);
  // No row of tags: a tag of an older link still narrows the list, and Clear takes it off.
  await expect(page.getByRole("navigation", { name: "Filter by tag" })).toHaveCount(0);
  await page.goto("/services?tag=extraction");
  await expect(page.getByTestId("service-card")).toHaveCount(1);
  await page.getByRole("link", { name: "Clear", exact: true }).click();
  await expect(page).toHaveURL(/\/services$/);
  await expect(page.getByTestId("service-card")).toHaveCount(3);

  await page.getByLabel("Search services").fill("annual report");
  await expect(page.getByTestId("service-card")).toHaveCount(1);
  await expect(page).toHaveURL(/q=annual\+report/);

  await page.getByRole("link", { name: "Summarise a public filing", exact: true }).click();
  // The first visit to a page compiles it, in the dev server the suite runs on.
  await expect(page).toHaveURL(/\/services\/3$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Summarise a public filing");
  await expect(page.getByTestId("hire-price")).toHaveText("2.50 tUSDC");
  await expect(page.getByTestId("record-wins")).toHaveText("9");

  // A paused service has its page, and no form.
  await page.goto("/services/5");
  await expect(page.getByTestId("hire-blocked")).toContainText("paused");
});

test("hire_end_to_end", async ({ page }) => {
  // Alice holds 50 test USDC, 1 of them in her vault: the other 1.50 go in first.
  const chain = new FakeChain(CONTRACT, [{ token: TEST_TOKEN, minReward: TUSDC(1) }]);
  chain.give(TEST_TOKEN, ALICE, TUSDC(50));
  chain.fundVault(ALICE, TEST_TOKEN, TUSDC(1));
  await routeApi(page);
  const wallet = await installInjectedWallet(page, { account: ALICE, chain });
  const api = await routePostApi(page, chain);
  await routeServices(page);

  await page.goto("/services/3#hire");
  const hire = page.locator("#hire");
  await hire.getByRole("button", { name: "Connect wallet" }).click();
  await page.locator(".hot-connector-popup .connect-item", { hasText: STUB_WALLET_NAME }).click();
  await expect(hire.getByTestId("hire-plan")).toContainText(
    "1.50 tUSDC goes from your wallet into your vault first.",
  );
  // Nothing has been sent anywhere yet.
  expect(api.requests).toEqual([]);
  expect(wallet.sent).toEqual([]);

  await hire.getByLabel("Your request").fill(REQUEST);
  await hire.getByRole("button", { name: "Hire for 2.50 tUSDC" }).click();
  await expect(hire.getByTestId("hire-done")).toContainText("Hired.");

  // Signed in once, then the brief and the criteria went up, before the wallet was asked to send.
  expect(api.requests).toEqual([
    "POST /v1/auth/challenge",
    "POST /v1/auth/verify",
    "POST /v1/blobs",
    "POST /v1/blobs",
  ]);
  expect(wallet.signed[0]).toMatchObject({ message: SIGN_IN_MESSAGE, recipient: API_URL });
  const [brief, criteria] = api.blobs;
  expect(brief?.kind).toBe("brief");
  expect(JSON.parse(brief?.text ?? "{}").instructions.startsWith(REQUEST)).toBe(true);
  expect(criteria?.kind).toBe("criteria");

  // One batch: the deposit, then the post.
  expect(wallet.sent).toHaveLength(1);
  const batch = wallet.sent[0]?.transactions ?? [];
  expect(batch.map(({ receiverId }) => receiverId)).toEqual([TEST_TOKEN, CONTRACT]);
  expect(batch[1]?.actions[0]).toMatchObject({ params: { methodName: "post_task", deposit: "1" } });

  // On the chain: a task that only the agent may enter, once, at the price, with the hirer as
  // its verifier, pinned to what was uploaded.
  expect(chain.tasks.get(1n)).toMatchObject({
    poster: ALICE,
    token: TEST_TOKEN,
    reward: 2_500_000n,
    verifier: ALICE,
    invited: [WRITER],
    maxEntries: 1,
    maxWinners: 1,
    briefHash: brief?.sha256,
    criteriaHash: sha256Hex(criteria?.bytes ?? new Uint8Array()),
  });

  await hire.getByRole("link", { name: "Open task #1" }).click();
  await expect(page).toHaveURL(/\/tasks\/1$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Hire: Summarise a public filing",
  );
});

for (const width of [375, 1440]) {
  // An x402 service is bought by agents through the MCP server, not in the browser: its card says
  // View API, and its page says how agents buy it where an escrow service has its hire form. The
  // escrow card and page next to it are as they were.
  test(`x402_service_at_${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await routeApi(page);
    const paid = service({
      id: "9",
      payment_mode: "x402",
      title: "Tender team inventory API",
      output_format: "json",
      price: "1000",
      verification: { kind: "none" },
      commit_secs: 0,
      reveal_secs: 0,
      pick_secs: 0,
      x402: {
        endpoint: "https://asp.example/inventory",
        network: "near:testnet",
        pay_to: ALICE,
        max_timeout_seconds: 60,
      },
    });
    await routeServices(page, [paid, ...SERVICES]);
    await page.goto("/services");
    const card = page.getByTestId("service-card").filter({ hasText: "Tender team inventory API" });
    await expect(card.getByTestId("service-checked")).toHaveText("x402 paid API");
    await expect(card).toContainText("/ call");
    await expect(card).toContainText("Answers at once");
    await expect(
      page.getByRole("link", { name: "View API: Tender team inventory API" }),
    ).toHaveAttribute("href", "/services/9#hire");
    await expect(
      page.getByRole("link", { name: "Use API: Tender team inventory API" }),
    ).toHaveCount(0);
    // The escrow card beside it still hires.
    await expect(
      page.getByRole("link", { name: "Hire: Summarise a public filing" }),
    ).toHaveAttribute("href", "/services/3#hire");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`x402-directory-${width}.png`),
      fullPage: true,
    });

    await page.goto("/services/9");
    await expect(page.getByRole("heading", { name: "x402 paid API" })).toBeVisible({
      timeout: 20_000,
    });
    const panel = page.locator("#hire");
    await expect(panel.getByTestId("api-price")).toHaveText("0.001 tUSDC / call · NEAR testnet");
    await expect(panel.getByTestId("api-notice")).toHaveText(
      "Agents buy this API through Tender's MCP server, with the purchase_service tool. Each call pays the price directly to the account below. Tender doesn't hold the payment or judge the answer.",
    );
    await expect(panel.getByTestId("api-origin")).toHaveText("https://asp.example");
    await expect(panel).toContainText(ALICE);
    await expect(panel.getByRole("link", { name: "Set up the MCP server" })).toHaveAttribute(
      "href",
      "https://github.com/JemIIahh/tender/blob/main/docs/MCP.md",
    );
    // Nothing to sign or buy here: no hire form, no wallet, no request box.
    await expect(panel.getByRole("button")).toHaveCount(0);
    await expect(panel.getByRole("textbox")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Hire/ })).toHaveCount(0);
    // The agent and its provider, as on any service.
    await expect(page.getByTestId("service-agent")).toBeVisible();
    await expect(page.getByText("Provider (ASP)")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`x402-service-${width}.png`),
      fullPage: true,
    });

    await page.goto("/services/3");
    await expect(page.locator("#hire").getByRole("button", { name: "Connect wallet" })).toBeVisible(
      { timeout: 20_000 },
    );
    await expect(page.getByTestId("hire-price")).toHaveText("2.50 tUSDC");
    await page.screenshot({
      path: testInfo.outputPath(`escrow-service-${width}.png`),
      fullPage: true,
    });
  });
}
