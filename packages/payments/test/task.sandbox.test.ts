import { expect, test } from "vitest";
import { runServiceAssistedTaskExample } from "../example/task";

test("a worker completes an open task by buying its missing capability from an ASP via x402", {
  timeout: 240_000,
}, async () => {
  const result = await runServiceAssistedTaskExample(() => {});
  expect(result).toMatchObject({
    passed: true,
    score: 100,
    serviceCost: "100000",
    fee: "50000",
    workerPayout: "950000",
    workerNet: "850000",
    charges: 1,
    lookups: 1,
    aiCalls: 0,
  });
});
