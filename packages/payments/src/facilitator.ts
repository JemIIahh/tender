import { HTTPFacilitatorClient } from "@x402/core/server";

export const REFERENCE_TESTNET_URL = "https://test.x402.mikedotexe.com";
export const REFERENCE_TESTNET_USDC =
  "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";

/** ASP-server credential only. The operator separately approves this environment and recipient. */
export function createReferenceTestnetFacilitator(apiKey: string): HTTPFacilitatorClient {
  if (!apiKey || /\s/.test(apiKey))
    throw new Error("A valid server-side facilitator key is required.");
  return new HTTPFacilitatorClient({
    url: REFERENCE_TESTNET_URL,
    timeoutMs: 15000,
    createAuthHeaders: async () => ({
      verify: { "X-API-Key": apiKey },
      settle: { "X-API-Key": apiKey },
      supported: {},
    }),
  });
}
