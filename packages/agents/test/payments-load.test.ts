import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

// Importing `@tender/agents` loads no payment code. `@tender/payments`, and the x402 libraries it
// brings, load only when a service-assisted solver buys or a model budget reserves a request, so
// `demo-local`, `swarm-demo` and every other user of the index run without them.
const loads = vi.hoisted(() => ({ payments: 0 }));
vi.mock("@tender/payments", async (original) => {
  loads.payments += 1;
  return original();
});

test("the_index_loads_no_payment_code_until_a_model_budget_reserves_a_request", async () => {
  const agents = await import("../src/index");
  expect(loads.payments).toBe(0);

  const folder = await mkdtemp(join(tmpdir(), "tender-agents-load-"));
  try {
    const budget = agents.createModelCallBudget(join(folder, "model-budget.json"), 1);
    expect(loads.payments).toBe(0);
    expect(await budget.run("a".repeat(64), async () => "answer")).toBe("answer");
    expect(loads.payments).toBe(1);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
