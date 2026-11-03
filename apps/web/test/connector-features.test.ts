import { NearConnector } from "@hot-labs/near-connect";
import { expect, test } from "vitest";
import { connectorOptions } from "../lib/wallet";

// The real library, given the options the app gives it. `wallet.test.ts` replaces the library with a
// double to see what the app asks for; this sees what the ask does.

/** A connector with no wallet list to fetch, and the wallets a test says it has found. */
function connectorWith(network: "mainnet" | "testnet", features: Record<string, boolean>[]) {
  const connector = new NearConnector({
    ...connectorOptions(network),
    manifest: { wallets: [], version: "1.0.0" },
  });
  connector.wallets = features.map(
    (set, i) =>
      ({
        manifest: { id: `wallet-${i}`, features: { mainnet: true, testnet: true, ...set } },
      }) as unknown as NearConnector["wallets"][number],
  );
  return connector;
}

test("a_wallet_that_cannot_send_a_batch_is_not_offered_in_the_picker", () => {
  for (const network of ["mainnet", "testnet"] as const) {
    const connector = connectorWith(network, [
      { signAndSendTransactions: true, signMessage: true },
      { signAndSendTransactions: false, signMessage: true },
      {},
    ]);

    expect(
      connector.availableWallets.map(({ manifest }) => manifest.id),
      network,
    ).toEqual(["wallet-0"]);
  }
});

test("a_wallet_that_cannot_sign_a_message_is_still_offered_if_it_can_send_a_batch", () => {
  const connector = connectorWith("testnet", [
    { signAndSendTransactions: true, signMessage: false },
  ]);

  expect(connector.availableWallets).toHaveLength(1);
});
