import { KeyPair } from "near-api-js";
import { expect, test } from "vitest";
import { x402BuyerOf } from "../src/x402";

// A payment package that is installed but does not load (here, a dependency of it is missing) is
// named with its cause, not reported as "not installed".
test("a_payment_package_that_does_not_load_says_why", async () => {
  const env = {
    TENDER_X402_ENABLED: "1",
    TENDER_X402_PAYER_ACCOUNT: "payer.testnet",
    TENDER_X402_PAYER_PRIVATE_KEY: KeyPair.fromRandom("ed25519").toString(),
    TENDER_X402_TOKEN: "token.testnet",
    TENDER_X402_MAX_PRICE: "1000",
    TENDER_X402_TOTAL_BUDGET: "2000",
    TENDER_X402_ALLOWED_ORIGINS: "https://provider.example",
  };
  const config = {
    network: "testnet" as const,
    signer: { accountId: "worker.testnet", privateKey: "unrelated-work-key" },
    stateDir: "/tmp/tender-x402-load",
    rpcUrl: "https://rpc.testnet.example",
  };
  const chain = { viewAccessKey: async () => ({ permission: "FullAccess" as const }) };
  const broken = new Error("Cannot find package '@x402/near' imported from payments/src/index.ts");
  const failure = await x402BuyerOf(env, config, chain, () => Promise.reject(broken)).catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(
    "x402 needs the optional payment package @tender/payments, which did not load: Cannot find package '@x402/near' imported from payments/src/index.ts",
  );
  expect((failure as Error).cause).toBe(broken);
});
