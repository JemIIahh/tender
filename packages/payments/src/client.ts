import {
  AccountIdSchema,
  canonicalJson,
  type Service,
  sha256Hex,
  X402ServiceConfigSchema,
} from "@tender/shared";
import { x402Client } from "@x402/core/client";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import type { ClientNearSigner } from "@x402/near";
import { ExactNearScheme } from "@x402/near/exact/client";

export type BuyerStore = (
  run: (
    read: () => Promise<BuyerState | null>,
    save: (state: BuyerState) => Promise<void>,
  ) => Promise<unknown>,
) => Promise<unknown>;

const LIMIT = 262_144;
export const digest = (value: unknown) => sha256Hex(canonicalJson(value));
const positive = (value: string) => /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) > 0n;

export interface PaidResult {
  body: unknown;
  settlement: SettleResponse;
}

export function paymentTerms(service: Service, allowLocalHttp = false): PaymentRequirements {
  if (service.payment_mode !== "x402" || !service.x402)
    throw new Error("An x402 service is required; escrow hires use hire_agent.");
  if (service.output_format !== "json") throw new Error("x402 API responses must be JSON.");
  if (!service.available || service.status !== "active")
    throw new Error("The service is unavailable.");
  const config = X402ServiceConfigSchema.parse(service.x402);
  AccountIdSchema.parse(service.token);
  const url = new URL(config.endpoint);
  const local =
    url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(allowLocalHttp && local)) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(
      "The service endpoint must use HTTPS; local HTTP needs an explicit sandbox option.",
    );
  }
  if (config.network !== "near:testnet")
    throw new Error("Only NEAR testnet x402 payments are enabled.");
  if (!positive(service.price))
    throw new Error("The service price must be a positive atomic amount.");
  return {
    scheme: "exact",
    extra: {},
    network: config.network,
    asset: service.token,
    amount: service.price,
    payTo: config.pay_to,
    maxTimeoutSeconds: config.max_timeout_seconds,
  };
}

export async function limitedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing response body.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > LIMIT) throw new Error("Paid response exceeds the byte limit.");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new Error("Provider response is not valid JSON.");
    }
  } finally {
    await reader.cancel();
  }
}

interface BuyerRecord {
  fingerprint: string;
  amount: string;
  payload?: PaymentPayload;
  result?: PaidResult;
}
export interface BuyerState {
  version: 1;
  network: string;
  asset: string;
  payer: string;
  totalLimit: string;
  reserved: string;
  requests: Record<string, BuyerRecord>;
}

export interface CorePurchaseOptions {
  /** Stable across retries. Reusing it with different terms or input is refused. */
  requestId: string;
  payer: string;
  /** Owner-approved NEP-141 token account, not selected by a provider challenge. */
  asset: string;
  signer: ClientNearSigner;
  maxPrice: string;
  totalBudget: string;
  store: BuyerStore;
  /** Owner-approved endpoint origins. No ambient credentials or redirects are forwarded. */
  allowedOrigins: readonly string[];
  fetch?: typeof fetch;
  allowLocalHttp?: boolean;
}

/** Buys one JSON response. A retry reuses the same authorization and budget reservation. */
export async function purchaseWithStore(
  service: Service,
  input: unknown,
  options: CorePurchaseOptions,
): Promise<PaidResult> {
  const expected = paymentTerms(service, options.allowLocalHttp);
  if (expected.asset !== options.asset)
    throw new Error("Service token is outside the approved payment budget.");
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(options.requestId))
    throw new Error("Use a stable request id of 1 to 100 letters, digits, underscores or hyphens.");
  if (!positive(options.maxPrice) || !positive(options.totalBudget))
    throw new Error("Explicit positive per-call and total budgets are required.");
  if (BigInt(expected.amount) > BigInt(options.maxPrice))
    throw new Error("Service price exceeds the per-call limit.");
  const endpoint = service.x402?.endpoint ?? "";
  if (!options.allowedOrigins.includes(new URL(endpoint).origin))
    throw new Error("Service origin has not been approved.");
  const body = JSON.stringify(input);
  if (body === undefined || new TextEncoder().encode(body).byteLength > LIMIT)
    throw new Error("Expected a JSON request within the byte limit.");
  const fingerprint = digest({ endpoint, expected, body, payer: options.payer });
  const transport = options.fetch ?? fetch;
  const send = (payload?: PaymentPayload) =>
    transport(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        "content-type": "application/json",
        "idempotency-key": options.requestId,
        ...(payload ? { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) } : {}),
      },
      body,
    });
  return (await options.store(async (read, save) => {
    const state = (await read()) ?? {
      version: 1,
      network: expected.network,
      asset: expected.asset,
      payer: options.payer,
      totalLimit: options.totalBudget,
      reserved: "0",
      requests: {},
    };
    if (
      state.version !== 1 ||
      state.network !== expected.network ||
      state.asset !== expected.asset ||
      state.payer !== options.payer ||
      state.totalLimit !== options.totalBudget
    ) {
      throw new Error(
        "Payment budget identity or limit changed. Review the existing ledger before changing it.",
      );
    }
    if (!/^(0|[1-9][0-9]{0,39})$/.test(state.reserved) || !positive(state.totalLimit)) {
      throw new Error("Invalid payment ledger; review it before another purchase.");
    }
    let recordedTotal = 0n;
    for (const saved of Object.values(state.requests)) {
      if (!positive(saved.amount)) throw new Error("Invalid payment ledger reservation.");
      recordedTotal += BigInt(saved.amount);
    }
    if (recordedTotal !== BigInt(state.reserved) || recordedTotal > BigInt(state.totalLimit)) {
      throw new Error(
        "Payment ledger reservations disagree with the total; review before spending.",
      );
    }
    let record = Object.hasOwn(state.requests, `r_${options.requestId}`)
      ? state.requests[`r_${options.requestId}`]
      : undefined;
    if (record && record.fingerprint !== fingerprint)
      throw new Error("Request id already belongs to different terms or input.");
    if (record?.result) return record.result;
    if (record && !record.payload)
      throw new Error(
        "An earlier signing attempt has an uncertain outcome. Review it before another purchase.",
      );
    if (!record) {
      if (BigInt(state.reserved) + BigInt(expected.amount) > BigInt(state.totalLimit))
        throw new Error("Total payment budget exhausted.");
      const initial = await send();
      if (initial.status !== 402) {
        await initial.body?.cancel();
        throw new Error("Expected a 402 payment challenge; no authorization was signed.");
      }
      const header = initial.headers.get("PAYMENT-REQUIRED");
      await initial.body?.cancel();
      if (!header || header.length > 32_768)
        throw new Error("Missing or oversized payment challenge.");
      const challenge = decodePaymentRequiredHeader(header);
      if (
        challenge.x402Version !== 2 ||
        challenge.resource?.url !== endpoint ||
        challenge.accepts.length !== 1 ||
        digest(challenge.accepts[0]) !== digest(expected) ||
        (challenge.extensions && Object.keys(challenge.extensions).length > 0)
      ) {
        throw new Error("Payment challenge does not match the approved service terms.");
      }
      record = { fingerprint, amount: expected.amount };
      state.requests[`r_${options.requestId}`] = record;
      state.reserved = (BigInt(state.reserved) + BigInt(expected.amount)).toString();
      await save(state); // Reserve BEFORE signing, including crashes and uncertain responses.
      const client = x402Client.fromConfig({
        schemes: [{ network: "near:testnet", client: new ExactNearScheme(options.signer) }],
        spendControls: {
          allowedAssets: [
            {
              network: expected.network,
              asset: expected.asset,
              maxAmountPerPayment: options.maxPrice,
            },
          ],
        },
      });
      client.register("near:testnet", new ExactNearScheme(options.signer));
      record.payload = await client.createPaymentPayload(challenge);
      await save(state); // Retries send these exact bytes; they never sign another transfer.
    }
    const response = await send(record.payload);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        "Paid request failed. The reservation remains; retry only with the same request id.",
      );
    }
    const header = response.headers.get("PAYMENT-RESPONSE");
    if (!header || header.length > 32_768) {
      await response.body?.cancel();
      throw new Error("Settlement receipt is missing; the budget remains reserved.");
    }
    const settlement = decodePaymentResponseHeader(header);
    if (
      !settlement.success ||
      settlement.network !== expected.network ||
      settlement.payer !== options.payer ||
      !settlement.transaction
    ) {
      await response.body?.cancel();
      throw new Error("Settlement receipt did not confirm this payer and network.");
    }
    const result: PaidResult = { body: await limitedJson(response), settlement };
    record.result = result;
    await save(state);
    return result;
  })) as PaidResult;
}
