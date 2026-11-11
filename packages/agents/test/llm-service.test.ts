import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Service, TaskView } from "@tender/shared";
import { afterEach, expect, test, vi } from "vitest";
import { createLlmServiceSolver, type LlmServiceOptions } from "../src/solvers/llm-service";
import { createModelCallBudget } from "../src/solvers/model-budget";
import { ACCOUNT, contextOf, JUDGE, POSTER, TOKEN, taskSpec } from "./helpers";

const paid = vi.hoisted(() => vi.fn());
vi.mock("@tender/payments", async (original) => ({
  ...(await original<object>()),
  purchaseX402Service: paid,
}));
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function kit() {
  paid.mockReset().mockResolvedValue({ body: { units: 7 }, settlement: { success: true } });
  const folder = await mkdtemp(join(tmpdir(), "tender-model-budget-"));
  folders.push(folder);
  const ctx = contextOf(taskSpec({ id: 1 }));
  ctx.brief = {
    ...ctx.brief,
    instructions:
      "Return value_cents for inventory; unit price is 250. Use the private stock snapshot if needed.",
    output: { format: "json", max_bytes: 256 },
  };
  const task = {
    ...ctx.task,
    cleaned: 0,
    funders: [],
    commit_count: 0,
    reveal_count: 0,
  } as TaskView;
  const service: Service = {
    id: "1",
    provider: "asp.testnet",
    agent: "stock.asp.testnet",
    title: "Inventory lookup",
    description: "Private stock lookup by SKU",
    tags: ["stock"],
    category: "other",
    output_format: "json",
    token: TOKEN,
    price: "100000",
    payment_mode: "x402",
    x402: {
      endpoint: "https://asp.example/stock",
      network: "near:testnet",
      pay_to: "asp.testnet",
      max_timeout_seconds: 60,
    },
    commit_secs: 0,
    reveal_secs: 0,
    pick_secs: 0,
    verification: { kind: "none" },
    status: "active",
    available: true,
    is_team: true,
    created_at: "2026-11-10T00:00:00.000Z",
    updated_at: "2026-11-10T00:00:00.000Z",
    agent_record: null,
  };
  const responses: unknown[] = [
    { action: "purchase", service_id: "1", input: { sku: "MAPLE" } },
    { answer: { value_cents: 1750 } },
  ];
  const transport = vi.fn(async () =>
    Response.json({
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify(responses.shift()) } }],
    }),
  );
  const options: LlmServiceOptions = {
    name: "model buyer",
    chain: {
      contractId: "tender.testnet",
      getTask: async () => task,
      blockTimestampNs: async () => BigInt(task.commit_deadline) - 120000000000n,
    },
    api: {
      listServices: async () => ({ services: [service], next_cursor: null }),
      getService: async () => ({ service }),
    },
    buyer: {
      payer: ACCOUNT,
      asset: TOKEN,
      signer: { createSignedDelegateAction: async () => "unused" },
      budgetFile: join(folder, "payments.json"),
      totalBudget: "100000",
      allowedOrigins: ["https://asp.example"],
    },
    capabilities: { stock: { tag: "stock", providers: [service.provider], maxPrice: "100000" } },
    posters: [POSTER],
    verifiers: [JUDGE],
    minMargin: 800000n,
    minRunwayMs: 75000,
    llm: {
      baseUrl: "https://model.example/v1",
      apiKey: "unit-placeholder",
      model: "model-test",
      maxOutputTokens: 1000,
      timeoutMs: 5000,
      fetch: transport,
      budget: createModelCallBudget(join(folder, "model.json"), 2),
    },
  };
  return { folder, ctx, task, service, responses, transport, options };
}
test("the model chooses an approved service, receives the paid data, then composes an answer; restart uses its cached decisions", async () => {
  const k = await kit();
  const solver = createLlmServiceSolver(k.options);
  expect(solver.scripted).toBe(false);
  expect(new TextDecoder().decode((await solver.solve(k.ctx)) ?? undefined)).toBe(
    '{"value_cents":1750}',
  );
  expect(paid).toHaveBeenCalledWith(
    k.service,
    { sku: "MAPLE" },
    expect.objectContaining({ maxPrice: "100000" }),
  );
  expect(k.transport).toHaveBeenCalledTimes(2);
  await createLlmServiceSolver(k.options).solve(k.ctx);
  expect(k.transport).toHaveBeenCalledTimes(2);
});
test("an invented provider cannot trigger a payment or a second model request", async () => {
  const k = await kit();
  k.responses[0] = { action: "purchase", service_id: "999", input: {} };
  await expect(createLlmServiceSolver(k.options).solve(k.ctx)).rejects.toThrow(
    "outside the approved catalog",
  );
  expect(paid).not.toHaveBeenCalled();
  expect(k.transport).toHaveBeenCalledTimes(1);
});
test("closed tasks and untrusted posters are refused before inference", async () => {
  const k = await kit();
  k.task.poster = "stranger.testnet";
  expect(await createLlmServiceSolver(k.options).solve(k.ctx)).toBeNull();
  expect(k.transport).not.toHaveBeenCalled();
  expect(paid).not.toHaveBeenCalled();
});
test("a model can answer directly without purchasing", async () => {
  const k = await kit();
  k.responses[0] = { action: "answer", answer: { value_cents: 0 } };
  expect(
    new TextDecoder().decode((await createLlmServiceSolver(k.options).solve(k.ctx)) ?? undefined),
  ).toBe('{"value_cents":0}');
  expect(paid).not.toHaveBeenCalled();
  expect(k.transport).toHaveBeenCalledTimes(1);
});
test("ambiguous model failures reserve a call, fail closed after restart, and cannot reset the limit", async () => {
  const k = await kit();
  const file = join(k.folder, "uncertain.json");
  const send = vi.fn(async () => {
    throw new Error("lost response");
  });
  await expect(createModelCallBudget(file, 1).run("a".repeat(64), send)).rejects.toThrow(
    "lost response",
  );
  await expect(createModelCallBudget(file, 1).run("a".repeat(64), send)).rejects.toThrow(
    "uncertain",
  );
  await expect(createModelCallBudget(file, 1).run("b".repeat(64), send)).rejects.toThrow(
    "exhausted",
  );
  await expect(createModelCallBudget(file, 2).run("b".repeat(64), send)).rejects.toThrow("changed");
  expect(send).toHaveBeenCalledTimes(1);
});
