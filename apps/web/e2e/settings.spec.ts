import { expect, test } from "@playwright/test";
import { OWNER } from "./accountApi";
import { openParity, pageFits } from "./parityApi";

// Settings in a browser: the connected account, the sidebar's state kept across a load (the head's
// script draws it before the page's code runs), the network to copy, and the phone.

test("settings_show_the_account_keep_the_sidebar_and_copy_the_network", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openParity(page, "/my-tasks", { connect: true });
  await expect(page.getByRole("tab", { name: /To pick/ })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Settings" })
    .click();
  await expect(page).toHaveURL("/settings", { timeout: 20_000 });
  await expect(page.getByTestId("settings-wallet")).toHaveText(OWNER);
  // Signed in, with no API session yet: the two are told apart.
  await expect(page.getByTestId("settings-session")).toContainText("None.");

  await page.getByRole("radio", { name: /Icons only/ }).check();
  await expect(page.locator("html")).toHaveAttribute("data-sidebar", "rail");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-sidebar", "rail");
  await expect(page.getByRole("radio", { name: /Icons only/ })).toBeChecked();
  await page.getByRole("radio", { name: /Full/ }).check();
  await expect(page.locator("html")).not.toHaveAttribute("data-sidebar", "rail");

  const network = page.getByTestId("settings-network");
  await expect(network.getByTestId("settings-value")).toHaveText([
    "NEAR testnet",
    "tender.tender-team.testnet",
    "http://rpc.test",
    "http://api.test",
  ]);
  await network.getByRole("button", { name: "Copy contract" }).click();
  await expect(network.getByRole("button", { name: "Copy contract" })).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "tender.tender-team.testnet",
  );
  expect(await pageFits(page)).toBe(0);
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await pageFits(page)).toBe(0);
});
