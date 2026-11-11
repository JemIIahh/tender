import type { Service, TaskView } from "@tender/shared";
import { expect, test, vi } from "vitest";
import {
  createServiceAssistedSolver,
  type ServiceAssistedSolverOptions,
} from "../src/solvers/service";
import { ACCOUNT, contextOf, JUDGE, POSTER, TOKEN, taskSpec } from "./helpers";

const paid = vi.hoisted(() => vi.fn());
vi.mock("@tender/payments", () => ({ purchaseX402Service: paid }));

function kit() {
  paid.mockReset().mockResolvedValue({ body: { units: 7 }, settlement: { success: true } });
  const ctx = contextOf(taskSpec({ id: 1, phase: "open", reward: "1000000" }));
  const task: TaskView = {
    ...ctx.task,
    phase: "open",
    cleaned: 0,
    funders: [],
    commit_count: 0,
    reveal_count: 0,
  };
  const offer: Service = {
    id: "1",
    provider: "provider.test.near",
    agent: "lookup.provider.test.near",
    title: "Stock API",
    description: "Stock lookup",
    tags: ["stock"],
    category: "other",
    output_format: "json",
    token: TOKEN,
    price: "100000",
    payment_mode: "x402",
    x402: {
      endpoint: "https://asp.example/stock",
      network: "near:testnet",
      pay_to: "provider.test.near",
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
  const listServices = vi.fn(async () => ({ services: [offer], next_cursor: null }));
  const getService = vi.fn(async () => ({ service: offer }));
  const complete = vi.fn(async () => new TextEncoder().encode('{"value":1750}'));
  const options: ServiceAssistedSolverOptions = {
    name: "capability-worker",
    scripted: true,
    chain: {
      contractId: "tender.test.near",
      getTask: vi.fn(async () => task),
      blockTimestampNs: async () => BigInt(task.commit_deadline) - 120_000_000_000n,
    },
    api: { listServices, getService },
    buyer: {
      payer: ACCOUNT,
      asset: TOKEN,
      signer: { createSignedDelegateAction: async () => "not-used" },
      totalBudget: "100000",
      budgetFile: "/tmp/not-used-by-mocked-purchase",
      allowedOrigins: ["https://asp.example"],
    },
    capabilities: { stock: { tag: "stock", providers: [offer.provider], maxPrice: "100000" } },
    posters: [POSTER],
    verifiers: [JUDGE],
    minMargin: 800000n,
    minRunwayMs: 75000,
    plan: async () => ({ kind: "need_service", capability: "stock", input: { sku: "maple" } }),
    complete,
  };
  return { ctx, task, offer, listServices, getService, complete, options };
}

test("a capability gap discovers and buys an approved service then composes the original answer", async () => {
  const k = kit();
  const solver = createServiceAssistedSolver(k.options);
  expect(new TextDecoder().decode((await solver.solve(k.ctx)) ?? undefined)).toBe('{"value":1750}');
  expect(k.listServices).toHaveBeenCalledWith(
    expect.objectContaining({ tag: "stock", token: TOKEN, maxPrice: 100000n }),
  );
  expect(k.complete).toHaveBeenCalledWith(k.ctx, "stock", { units: 7 });
  const firstId = paid.mock.calls[0]?.[2]?.requestId;
  await createServiceAssistedSolver(k.options).solve(k.ctx);
  expect(paid.mock.calls[1]?.[2]?.requestId).toBe(firstId);
});

test("an answerable task or an unknown capability never buys a service", async () => {
  const k = kit();
  const bytes = new Uint8Array([1]);
  const local = createServiceAssistedSolver({
    ...k.options,
    plan: async () => ({ kind: "answer", bytes }),
  });
  expect(await local.solve(k.ctx)).toBe(bytes);
  const unknown = createServiceAssistedSolver({
    ...k.options,
    plan: async () => ({ kind: "need_service", capability: "unapproved", input: {} }),
  });
  expect(await unknown.solve(k.ctx)).toBeNull();
  expect(k.listServices).not.toHaveBeenCalled();
  expect(paid).not.toHaveBeenCalled();
});

for (const reason of [
  "low_reward",
  "expired",
  "unapproved_poster",
  "unapproved_verifier",
  "wrong_token",
  "changed_brief",
  "multiple_winners",
  "short_runway",
] as const) {
  test(`no payment when the original task has ${reason}`, async () => {
    const k = kit();
    if (reason === "low_reward") k.task.reward = "100000";
    if (reason === "expired") k.task.phase = "expired";
    if (reason === "unapproved_poster") k.task.poster = "stranger.test.near";
    if (reason === "unapproved_verifier") k.task.verifier = "stranger.test.near";
    if (reason === "wrong_token") k.task.token = "other.test.near";
    if (reason === "changed_brief") k.task.brief_hash = "ab".repeat(32);
    if (reason === "multiple_winners") k.task.max_winners = 2;
    if (reason === "short_runway") k.options.minRunwayMs = 120001;
    expect(await createServiceAssistedSolver(k.options).solve(k.ctx)).toBeNull();
    expect(paid).not.toHaveBeenCalled();
  });
}

test("unapproved providers, expensive listings and changed terms cannot trigger a purchase", async () => {
  for (const problem of ["provider", "price", "mode", "changed", "task_closed"]) {
    const k = kit();
    if (problem === "provider") k.offer.provider = "stranger.test.near";
    if (problem === "price") k.offer.price = "100001";
    if (problem === "mode") k.offer.payment_mode = "escrow";
    if (problem === "changed")
      k.getService.mockImplementationOnce(async () => ({
        service: { ...k.offer, available: false },
      }));
    if (problem === "task_closed")
      k.getService.mockImplementationOnce(async () => {
        k.task.phase = "expired";
        return { service: k.offer };
      });
    expect(await createServiceAssistedSolver(k.options).solve(k.ctx)).toBeNull();
    expect(paid).not.toHaveBeenCalled();
  }
});
