import type { TenderClient } from "@tender/client";
import { KeyPair } from "near-api-js";
import { expect, test, vi } from "vitest";
import { describeFailure, secretsOf } from "../src/config";
import { x402BuyerOf, x402SecretsOf } from "../src/x402";

const moduleState = vi.hoisted(() => ({
  loads: 0,
  make: vi.fn(() => ({ createSignedDelegateAction: async () => "test-only" })),
}));
vi.mock("@tender/payments", () => {
  moduleState.loads++;
  return { createClientNearSigner: moduleState.make };
});
const pair = KeyPair.fromRandom("ed25519");
const key = pair.toString();
const publicKey = pair.getPublicKey().toString();
type AccessKey = Awaited<ReturnType<TenderClient["viewAccessKey"]>>;
/** A chain whose every account holds `access` for every key, and the lookups it was asked for. */
function chainWith(access: AccessKey) {
  return { viewAccessKey: vi.fn<TenderClient["viewAccessKey"]>(async () => access) };
}
const fullAccess = chainWith({ permission: "FullAccess" });
type LoadPayments = NonNullable<Parameters<typeof x402BuyerOf>[3]>;
/**
 * A loader of the payment package that counts its calls. The module mock above counts only the
 * first load in this file, so a test that must see "not loaded" passes one of these.
 */
function paymentsLoader() {
  return vi.fn<LoadPayments>(
    async () =>
      ({ createClientNearSigner: moduleState.make }) as unknown as Awaited<
        ReturnType<LoadPayments>
      >,
  );
}
const config = {
  network: "testnet" as const,
  signer: { accountId: "worker.testnet", privateKey: "unrelated-work-key" },
  stateDir: "/tmp/tender-x402-config",
  rpcUrl: "https://rpc.testnet.example",
};
const caps = {
  TENDER_X402_ENABLED: "1",
  TENDER_X402_PAYER_ACCOUNT: "payer.testnet",
  TENDER_X402_PAYER_PRIVATE_KEY: key,
  TENDER_X402_TOKEN: "token.testnet",
  TENDER_X402_MAX_PRICE: "1000",
  TENDER_X402_TOTAL_BUDGET: "2000",
  TENDER_X402_ALLOWED_ORIGINS: "https://asp.example",
};
test("disabled x402 loads no payment library and asks the chain nothing", async () => {
  const chain = chainWith({ permission: "FullAccess" });
  const load = paymentsLoader();
  expect(await x402BuyerOf({}, config, chain, load)).toBeUndefined();
  expect(await x402BuyerOf({ TENDER_X402_ENABLED: "" }, config, chain, load)).toBeUndefined();
  expect(await x402BuyerOf({ TENDER_X402_ENABLED: "0" }, config, chain, load)).toBeUndefined();
  expect(load).not.toHaveBeenCalled();
  expect(chain.viewAccessKey).not.toHaveBeenCalled();
  // The same loader is called once x402 is on and the payer checks out.
  expect((await x402BuyerOf(caps, config, chain, load))?.payer).toBe("payer.testnet");
  expect(load).toHaveBeenCalledTimes(1);
});
test("a dedicated payer works with an unrelated scoped work key", async () => {
  const chain = chainWith({ permission: "FullAccess" });
  const buyer = await x402BuyerOf({ ...caps, TENDER_X402_ALLOW_AGENT_PAYER: "" }, config, chain);
  expect(buyer?.payer).toBe("payer.testnet");
  // The chain was asked about the payer's own key, on the payer's account.
  expect(chain.viewAccessKey).toHaveBeenCalledExactlyOnceWith("payer.testnet", publicKey);
  expect(moduleState.make).toHaveBeenCalledWith(
    expect.objectContaining({ accountId: "payer.testnet", secretKey: key }),
  );
});
test("the agent account is refused as payer without an explicit owner override", async () => {
  const same = { ...caps, TENDER_X402_PAYER_ACCOUNT: config.signer.accountId };
  await expect(x402BuyerOf(same, config, fullAccess)).rejects.toThrow("separate from the agent");
  expect(
    (await x402BuyerOf({ ...same, TENDER_X402_ALLOW_AGENT_PAYER: "1" }, config, fullAccess))?.payer,
  ).toBe(config.signer.accountId);
});
test("the account the agent is under is refused as payer without the same override", async () => {
  const agent = { ...config, signer: { ...config.signer, accountId: "worker.acme.testnet" } };
  for (const parent of ["acme.testnet", "testnet"]) {
    const env = { ...caps, TENDER_X402_PAYER_ACCOUNT: parent };
    await expect(x402BuyerOf(env, agent, fullAccess)).rejects.toThrow("such as its parent");
    expect(
      (await x402BuyerOf({ ...env, TENDER_X402_ALLOW_AGENT_PAYER: "1" }, agent, fullAccess))?.payer,
    ).toBe(parent);
  }
  // A name that only ends alike is another account: `cme.testnet` is not above `worker.acme.testnet`.
  const other = { ...caps, TENDER_X402_PAYER_ACCOUNT: "cme.testnet" };
  expect((await x402BuyerOf(other, agent, fullAccess))?.payer).toBe("cme.testnet");
});
test("a payer key the chain does not list as the payer's full-access key fails at start", async () => {
  const load = paymentsLoader();
  await expect(x402BuyerOf(caps, config, chainWith(null), load)).rejects.toThrow(
    "is not a key of TENDER_X402_PAYER_ACCOUNT on the chain",
  );
  const limited = chainWith({
    permission: { FunctionCall: { receiver_id: "token.testnet", method_names: [] } },
  });
  await expect(x402BuyerOf(caps, config, limited, load)).rejects.toThrow(
    "must be a full-access key of TENDER_X402_PAYER_ACCOUNT",
  );
  // An RPC that fails is no answer, never read as a good key.
  const down = { viewAccessKey: vi.fn().mockRejectedValue(new Error("fetch failed")) };
  await expect(x402BuyerOf(caps, config, down, load)).rejects.toThrow("fetch failed");
  // None of them got as far as loading the payment package.
  expect(load).not.toHaveBeenCalled();
});
test("the payer's key is among the secrets a start-up failure is scrubbed of", () => {
  const bare = key.slice("ed25519:".length);
  expect(x402SecretsOf(caps)).toEqual([key, bare]);
  expect(x402SecretsOf({})).toEqual([]);
  const secrets = [...secretsOf(config), ...x402SecretsOf(caps)];
  const line = describeFailure(new Error(`could not sign with ${key} (${bare})`), secrets);
  expect(line).not.toContain(bare);
});
test("missing payer, non-testnet, invalid limits and unapproved origins fail closed", async () => {
  const chain = fullAccess;
  await expect(
    x402BuyerOf({ ...caps, TENDER_X402_PAYER_PRIVATE_KEY: "" }, config, chain),
  ).rejects.toThrow("dedicated");
  await expect(x402BuyerOf(caps, { ...config, network: "sandbox" }, chain)).rejects.toThrow(
    "testnet",
  );
  await expect(
    x402BuyerOf({ ...caps, TENDER_X402_TOTAL_BUDGET: "" }, config, chain),
  ).rejects.toThrow("positive atomic");
  await expect(
    x402BuyerOf({ ...caps, TENDER_X402_MAX_PRICE: "2001" }, config, chain),
  ).rejects.toThrow("positive atomic");
  await expect(
    x402BuyerOf({ ...caps, TENDER_X402_ALLOWED_ORIGINS: "http://localhost" }, config, chain),
  ).rejects.toThrow("HTTPS origins");
});
