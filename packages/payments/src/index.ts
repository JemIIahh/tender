import type { Service } from "@tender/shared";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentRequired } from "@x402/core/types";
import {
  type BuyerState,
  type CorePurchaseOptions,
  digest,
  limitedJson,
  type PaidResult,
  paymentTerms,
  purchaseWithStore,
} from "./client";
import { lockedState } from "./store";

export { HTTPFacilitatorClient } from "@x402/core/server";
export { createClientNearSigner } from "@x402/near";
export type { PaidResult } from "./client";

export interface PurchaseOptions extends Omit<CorePurchaseOptions, "store"> {
  /** Durable private ledger for this payer and token. Never reset to retry a payment. */
  budgetFile: string;
}
export function purchaseX402Service(
  service: Service,
  input: unknown,
  options: PurchaseOptions,
): Promise<PaidResult> {
  return purchaseWithStore(service, input, {
    ...options,
    store: (run) => lockedState<BuyerState>(options.budgetFile, run),
  });
}
const LIMIT = 262_144;

interface SellerRecord {
  fingerprint: string;
  paymentHash: string;
  result?: PaidResult;
}
interface SellerState {
  version: 1;
  requests: Record<string, SellerRecord>;
  payments: Record<string, string>;
}

export interface PaidServiceOptions {
  service: Service;
  /** Hosted facilitator for services. No payer or relayer private key belongs here. */
  facilitator: Pick<FacilitatorClient, "verify" | "settle">;
  stateFile: string;
  respond(input: unknown): Promise<unknown>;
  allowLocalHttp?: boolean;
  /** Browser sites allowed to read this ASP's challenge and paid response. No wildcard. */
  allowedBrowserOrigins?: readonly string[];
}

/** ASP-owned POST endpoint. It returns no resource until settlement succeeds. */
export function createX402ServiceHandler(
  options: PaidServiceOptions,
): (request: Request) => Promise<Response> {
  const expected = paymentTerms(options.service, options.allowLocalHttp);
  const endpoint = options.service.x402?.endpoint ?? "";
  const challenge: PaymentRequired = {
    x402Version: 2,
    resource: { url: endpoint, description: options.service.title, mimeType: "application/json" },
    accepts: [expected],
  };
  const required = () =>
    Response.json(
      { error: "payment_required" },
      {
        status: 402,
        headers: {
          "PAYMENT-REQUIRED": encodePaymentRequiredHeader(challenge),
          "cache-control": "no-store",
        },
      },
    );
  const handle = async (request: Request) => {
    if (request.method !== "POST" || request.url !== endpoint)
      return Response.json({ error: "not_found" }, { status: 404 });
    const header = request.headers.get("PAYMENT-SIGNATURE");
    if (!header) return required();
    const id = request.headers.get("idempotency-key") ?? digest(header);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || header.length > 32_768)
      return Response.json({ error: "bad_request" }, { status: 400 });
    try {
      const input = await limitedJson(new Response(request.body));
      const payload = decodePaymentSignatureHeader(header);
      if (
        payload.x402Version !== 2 ||
        digest(payload.accepted) !== digest(expected) ||
        payload.resource?.url !== endpoint
      )
        return required();
      const paymentHash = digest(payload);
      const fingerprint = digest({ input, expected, endpoint });
      return (await lockedState<SellerState>(options.stateFile, async (read, save) => {
        const state = (await read()) ?? { version: 1, requests: {}, payments: {} };
        if (state.version !== 1) throw new Error("Unknown payment state version.");
        const old = Object.hasOwn(state.requests, `r_${id}`)
          ? state.requests[`r_${id}`]
          : undefined;
        if (old) {
          if (old.fingerprint !== fingerprint || old.paymentHash !== paymentHash)
            return Response.json({ error: "idempotency_conflict" }, { status: 409 });
          if (old.result) return paidResponse(old.result);
          return Response.json({ error: "payment_outcome_needs_review" }, { status: 409 });
        }
        if (Object.hasOwn(state.payments, paymentHash))
          return Response.json({ error: "authorization_already_used" }, { status: 409 });
        const verified = await options.facilitator.verify(payload, expected);
        if (!verified.isValid) return required();
        // Produce and bound the response before charging. Failed work never reaches settlement.
        const body = await options.respond(input);
        const bytes = JSON.stringify(body);
        if (bytes === undefined || Buffer.byteLength(bytes) > LIMIT)
          throw new Error("Invalid service response.");
        const record: SellerRecord = { fingerprint, paymentHash };
        state.requests[`r_${id}`] = record;
        state.payments[paymentHash] = id;
        await save(state); // Write BEFORE settlement. An interrupted charge is never repeated.
        const settlement = await options.facilitator.settle(payload, expected);
        if (!settlement.success)
          return Response.json({ error: "settlement_failed" }, { status: 502 });
        record.result = { body, settlement };
        await save(state);
        return paidResponse(record.result);
      })) as Response;
    } catch {
      return Response.json({ error: "payment_request_failed" }, { status: 503 });
    }
  };
  return async (request) => {
    const origin = request.headers.get("origin");
    const allowed = origin !== null && (options.allowedBrowserOrigins ?? []).includes(origin);
    if (origin && !allowed) return Response.json({ error: "origin_not_allowed" }, { status: 403 });
    const response =
      request.method === "OPTIONS" && request.url === endpoint && allowed
        ? new Response(null, { status: 204 })
        : await handle(request);
    if (allowed && origin) {
      response.headers.set("access-control-allow-origin", origin);
      response.headers.set("vary", "Origin");
      response.headers.set("access-control-allow-methods", "POST, OPTIONS");
      response.headers.set(
        "access-control-allow-headers",
        "Content-Type, Idempotency-Key, PAYMENT-SIGNATURE",
      );
      response.headers.set("access-control-expose-headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE");
    }
    return response;
  };
}

function paidResponse(result: PaidResult): Response {
  return Response.json(result.body, {
    headers: {
      "PAYMENT-RESPONSE": encodePaymentResponseHeader(result.settlement),
      "cache-control": "no-store",
    },
  });
}

export {
  createReferenceTestnetFacilitator,
  REFERENCE_TESTNET_URL,
  REFERENCE_TESTNET_USDC,
} from "./facilitator";
export { lockedState } from "./store";
