import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Service } from "@tender/shared";
import { afterEach, expect, test, vi } from "vitest";
import { createDataQualityHandler } from "../src/services/data-quality-http";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

test("unpaid requests get 402; bad input cannot reach verification or settlement", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "tender-utility-http-"));
  directories.push(stateDirectory);
  const services = Object.fromEntries(
    ["csv-audit", "duplicate-records"].map((slug, index) => [
      slug,
      {
        id: String(index + 1),
        title: slug,
        token: "usdc.testnet",
        price: "1000",
        payment_mode: "x402",
        output_format: "json",
        available: true,
        status: "active",
        x402: {
          endpoint: `https://utility.example/${slug}`,
          network: "near:testnet",
          pay_to: "quality.testnet",
          max_timeout_seconds: 60,
        },
      } as Service,
    ]),
  );
  const facilitator = { verify: vi.fn(), settle: vi.fn() };
  const handler = createDataQualityHandler({
    services,
    stateDirectory,
    facilitator,
    allowedBrowserOrigins: ["https://tendeer.vercel.app"],
  });
  const url = "https://utility.example/csv-audit";
  const unpaid = await handler(new Request(url, { method: "POST" }));
  expect(unpaid.status).toBe(402);
  expect(unpaid.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
  const invalid = await handler(
    new Request(url, {
      method: "POST",
      headers: { "PAYMENT-SIGNATURE": "invalid", origin: "https://tendeer.vercel.app" },
      body: JSON.stringify({ csv: 'id\n"unfinished' }),
    }),
  );
  expect(invalid.status).toBe(400);
  expect(invalid.headers.get("access-control-allow-origin")).toBe("https://tendeer.vercel.app");
  expect(facilitator.verify).not.toHaveBeenCalled();
  expect(facilitator.settle).not.toHaveBeenCalled();
  const oversized = await handler(
    new Request(url, {
      method: "POST",
      headers: { "PAYMENT-SIGNATURE": "invalid", origin: "https://tendeer.vercel.app" },
      body: "x".repeat(131_073),
    }),
  );
  expect(oversized.status).toBe(413);
  expect((await handler(new Request(`${url}?changed=1`, { method: "POST" }))).status).toBe(404);
});
