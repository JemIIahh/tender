import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePaymentRequiredHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import type { ClientNearSigner } from "@x402/near";
import { afterEach, expect, test, vi } from "vitest";
import { createX402ServiceHandler, type PurchaseOptions, purchaseX402Service } from "../src/index";
import { apiService } from "./helpers";

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function setup() {
  const folder = await mkdtemp(join(tmpdir(), "tender-x402-unit-"));
  folders.push(folder);
  const service = apiService();
  const sign = vi.fn(async () => "unit-test-only-delegate");
  const signer: ClientNearSigner = { createSignedDelegateAction: sign };
  const verify = vi.fn(async () => ({ isValid: true, payer: "buyer.testnet" }));
  const settle = vi.fn(async () => ({
    success: true,
    network: "near:testnet" as const,
    transaction: "unit-test-only-receipt",
    payer: "buyer.testnet",
  }));
  const respond = vi.fn(async () => ({ answer: 12 }));
  const handler = createX402ServiceHandler({
    service,
    facilitator: { verify, settle },
    respond,
    stateFile: join(folder, "seller.json"),
  });
  const transport: typeof fetch = async (url, init) => handler(new Request(url, init));
  const options: PurchaseOptions = {
    payer: "buyer.testnet",
    asset: service.token,
    signer,
    requestId: "purchase-1",
    maxPrice: "1000",
    totalBudget: "1500",
    budgetFile: join(folder, "buyer.json"),
    allowedOrigins: ["https://asp.example"],
    fetch: transport,
  };
  return { folder, service, sign, verify, settle, respond, handler, options, transport };
}

test("402, authorization, settlement, response and a restarted buyer reuse one charge", async () => {
  const s = await setup();
  const unpaid = await s.handler(new Request(s.service.x402?.endpoint ?? "", { method: "POST" }));
  expect(unpaid.status).toBe(402);
  expect(s.respond).not.toHaveBeenCalled();
  expect(s.settle).not.toHaveBeenCalled();
  const result = await purchaseX402Service(s.service, { boxes: 3 }, s.options);
  expect(result.body).toEqual({ answer: 12 });
  expect((await purchaseX402Service(s.service, { boxes: 3 }, { ...s.options })).settlement).toEqual(
    result.settlement,
  );
  expect(s.sign).toHaveBeenCalledTimes(1);
  expect(s.settle).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await readFile(s.options.budgetFile, "utf8")).reserved).toBe("1000");
  await expect(
    purchaseX402Service(s.service, {}, { ...s.options, requestId: "purchase-2" }),
  ).rejects.toThrow("budget exhausted");
});

test("a lost paid response retries the exact authorization and receives the saved delivery", async () => {
  const s = await setup();
  let lost = false;
  const flaky: typeof fetch = async (url, init) => {
    const reply = await s.transport(url, init);
    if (new Headers(init?.headers).has("PAYMENT-SIGNATURE") && !lost) {
      lost = true;
      throw new Error("connection lost after settlement");
    }
    return reply;
  };
  await expect(purchaseX402Service(s.service, {}, { ...s.options, fetch: flaky })).rejects.toThrow(
    "connection lost",
  );
  expect((await purchaseX402Service(s.service, {}, s.options)).body).toEqual({ answer: 12 });
  expect(s.sign).toHaveBeenCalledTimes(1);
  expect(s.settle).toHaveBeenCalledTimes(1);
  expect(s.respond).toHaveBeenCalledTimes(1);
});

test("changed amount, recipient, asset, network, timeout or resource is refused before signing", async () => {
  for (const change of [
    { amount: "1001" },
    { payTo: "stranger.testnet" },
    { asset: "other.testnet" },
    { network: "near:mainnet" },
    { maxTimeoutSeconds: 300 },
  ]) {
    const s = await setup();
    const changed: typeof fetch = async (url, init) => {
      const r = await s.transport(url, init);
      const c = decodePaymentRequiredHeader(r.headers.get("PAYMENT-REQUIRED") ?? "");
      Object.assign(c.accepts[0] ?? {}, change);
      return new Response(null, {
        status: 402,
        headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(c) },
      });
    };
    await expect(
      purchaseX402Service(s.service, {}, { ...s.options, fetch: changed }),
    ).rejects.toThrow("approved service terms");
    expect(s.sign).not.toHaveBeenCalled();
    expect(s.settle).not.toHaveBeenCalled();
  }
});

test("per-call cap, approved origins, paused services, escrow mode and changed id inputs fail closed", async () => {
  const s = await setup();
  await expect(
    purchaseX402Service(s.service, {}, { ...s.options, maxPrice: "999" }),
  ).rejects.toThrow("per-call");
  await expect(
    purchaseX402Service(s.service, {}, { ...s.options, allowedOrigins: [] }),
  ).rejects.toThrow("origin");
  await expect(
    purchaseX402Service({ ...s.service, available: false }, {}, s.options),
  ).rejects.toThrow("unavailable");
  await expect(
    purchaseX402Service({ ...s.service, payment_mode: "escrow" }, {}, s.options),
  ).rejects.toThrow("escrow");
  await expect(
    purchaseX402Service({ ...s.service, token: "different.testnet" }, {}, s.options),
  ).rejects.toThrow("approved payment budget");
  expect(s.sign).not.toHaveBeenCalled();
  await purchaseX402Service(s.service, {}, s.options);
  await expect(purchaseX402Service(s.service, { changed: true }, s.options)).rejects.toThrow(
    "different terms or input",
  );
  await expect(
    purchaseX402Service(s.service, {}, { ...s.options, totalBudget: "9000" }),
  ).rejects.toThrow("limit changed");
});

test("settlement failures and interrupted charges do not disclose the resource or authorize another charge", async () => {
  const s = await setup();
  s.settle.mockRejectedValueOnce(new Error("uncertain settlement"));
  await expect(purchaseX402Service(s.service, {}, s.options)).rejects.toThrow(
    "Paid request failed",
  );
  await expect(purchaseX402Service(s.service, {}, s.options)).rejects.toThrow(
    "Paid request failed",
  );
  expect(s.settle).toHaveBeenCalledTimes(1);
  expect(s.sign).toHaveBeenCalledTimes(1);
});

test("concurrent buyers cannot race past the shared budget", async () => {
  const s = await setup();
  const results = await Promise.allSettled([
    purchaseX402Service(s.service, {}, s.options),
    purchaseX402Service(s.service, {}, { ...s.options, requestId: "purchase-2" }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(s.settle).toHaveBeenCalledTimes(1);
});

test("a failed provider computation never settles", async () => {
  const s = await setup();
  s.respond.mockRejectedValueOnce(new Error("provider unavailable"));
  await expect(purchaseX402Service(s.service, {}, s.options)).rejects.toThrow(
    "Paid request failed",
  );
  expect(s.settle).not.toHaveBeenCalled();
});

test("CORS exposes challenges and receipts only to the provider's explicitly approved sites", async () => {
  const s = await setup();
  const handler = createX402ServiceHandler({
    service: s.service,
    facilitator: { verify: s.verify, settle: s.settle },
    respond: s.respond,
    stateFile: join(s.folder, "cors.json"),
    allowedBrowserOrigins: ["https://app.provider.example"],
  });
  const preflight = await handler(
    new Request(s.service.x402?.endpoint ?? "", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.provider.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "payment-signature,idempotency-key,content-type",
      },
    }),
  );
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("https://app.provider.example");
  expect(preflight.headers.get("access-control-expose-headers")).toContain("PAYMENT-RESPONSE");
  const denied = await handler(
    new Request(s.service.x402?.endpoint ?? "", {
      method: "POST",
      headers: { origin: "https://stranger.example" },
    }),
  );
  expect(denied.status).toBe(403);
  expect(denied.headers.has("access-control-allow-origin")).toBe(false);
  const challenge = await handler(
    new Request(s.service.x402?.endpoint ?? "", {
      method: "POST",
      headers: { origin: "https://app.provider.example" },
    }),
  );
  expect(challenge.status).toBe(402);
  expect(challenge.headers.get("access-control-expose-headers")).toContain("PAYMENT-REQUIRED");
  expect(s.sign).not.toHaveBeenCalled();
  expect(s.settle).not.toHaveBeenCalled();
});
