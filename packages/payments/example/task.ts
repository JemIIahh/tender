import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import {
  ApiClient,
  registerLocalAgent,
  registerWithBond,
  type Signer,
  scriptedProfile,
  startLocalChain,
  TenderClient,
} from "@tender/client";
import { createStateStore } from "@tender/mcp";
import {
  type Brief,
  canonicalJson,
  mintCall,
  type PublicCriteria,
  randomSalt,
  sha256Hex,
  tokenStorageDepositCall,
} from "@tender/shared";
import { x402Facilitator } from "@x402/core/facilitator";
import { createFacilitatorNearSigner } from "@x402/near";
import { ExactNearScheme } from "@x402/near/exact/facilitator";
import { Account, actions, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { startServices } from "../../../scripts/serve";
// Development example only: avoids making the payment library depend on the runner.
import { AgentMemory, agentTick } from "../../agents/src/runner";
import {
  type CapabilityPlan,
  createServiceAssistedSolver,
  type ServiceAssistedSolverOptions,
} from "../../agents/src/solvers/service";
import type { Solver, TaskContext } from "../../agents/src/types";
import { createClientNearSigner, createX402ServiceHandler } from "../src/index";

interface InventoryRequest {
  operation: string;
  sku: string;
  snapshot: string;
  unit_price_cents: number;
  reorder_threshold: number;
  target_units: number;
}

function requestOf(ctx: TaskContext): InventoryRequest {
  const input = JSON.parse(ctx.brief.instructions) as InventoryRequest;
  assert.equal(input.operation, "stock-value-and-reorder");
  assert.equal(typeof input.sku, "string");
  assert.equal(typeof input.snapshot, "string");
  for (const value of [input.unit_price_cents, input.reorder_threshold, input.target_units]) {
    assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000);
  }
  return input;
}

/** The worker has arithmetic, but no warehouse database or private expected answer. */
async function planInventory(ctx: TaskContext): Promise<CapabilityPlan> {
  const request = requestOf(ctx);
  return {
    kind: "need_service",
    capability: "warehouse-stock",
    input: { sku: request.sku, snapshot: request.snapshot },
  };
}

async function finishInventory(
  ctx: TaskContext,
  _capability: string,
  response: unknown,
): Promise<Uint8Array> {
  const request = requestOf(ctx);
  const stock = response as { sku: string; snapshot: string; units: number };
  assert.equal(stock.sku, request.sku);
  assert.equal(stock.snapshot, request.snapshot);
  assert.ok(Number.isSafeInteger(stock.units) && stock.units >= 0 && stock.units <= 1_000_000);
  return canonicalJson({
    sku: request.sku,
    units: stock.units,
    value_cents: stock.units * request.unit_price_cents,
    reorder_units:
      stock.units < request.reorder_threshold ? Math.max(0, request.target_units - stock.units) : 0,
  });
}

export interface TaskExampleReview {
  directory: string;
  apiPort: number;
  webUrl: string;
  signal: AbortSignal;
  onReady(info: {
    taskId: string;
    serviceId: string;
    apiUrl: string;
    rpcUrl: string;
    contractId: string;
    report: unknown;
  }): Promise<void>;
}

/** One team-run open task that requires a paid capability before a worker can finish it. */
export async function runServiceAssistedTaskExample(
  log: (line: string) => void = console.log,
  options: {
    review?: TaskExampleReview;
    solverFactory?: (options: ServiceAssistedSolverOptions) => Solver;
    modelCalls?: () => number;
  } = {},
) {
  const work = await mkdtemp(join(tmpdir(), "tender-x402-task-"));
  const chain = await startLocalChain({ minWindowSecs: 5 });
  const databaseUrl = options.review
    ? `pglite:${join(options.review.directory, "db")}`
    : "pglite:memory";
  let services: Awaited<ReturnType<typeof startServices>> | undefined;
  let server: ReturnType<typeof serve> | undefined;
  const trace: string[] = [];
  const record = (line: string) => {
    trace.push(line);
    log(line);
  };
  try {
    const { alice: buyer, bob: asp, judge, poster, owner: relayer, treasury } = chain.accounts;
    const provider = new JsonRpcProvider({ url: chain.rpcUrl });
    const account = (signer: Signer) =>
      new Account(signer.accountId, provider, signer.privateKey as KeyPairString);
    const client = (signer?: Signer) =>
      new TenderClient({
        network: "sandbox",
        contractId: chain.contractId,
        rpcUrl: chain.rpcUrl,
        ...(signer ? { signer } : {}),
      });
    const reader = client();
    // Only this scoped key goes into the services process; the full judge key stays in this local harness.
    const judgeKey = KeyPair.fromRandom("ed25519");
    await account(judge).signAndSendTransaction({
      receiverId: judge.accountId,
      actions: [
        actions.addFunctionCallAccessKey(judgeKey.getPublicKey(), chain.contractId, [
          "pick",
          "pick_attested",
        ]),
      ],
    });
    services = await startServices(
      {
        TENDER_NETWORK: "sandbox",
        TENDER_CONTRACT: chain.contractId,
        NEAR_RPC_URL: chain.rpcUrl,
        DATABASE_URL: databaseUrl,
        API_PORT: "0",
        INDEXER_POLL_MS: "100",
        JUDGE_ACCOUNT: judge.accountId,
        JUDGE_PRIVATE_KEY: judgeKey.toString(),
        JUDGE_INTERVAL_MS: "250",
        TEAM_ACCOUNTS: [buyer.accountId, asp.accountId, poster.accountId, judge.accountId].join(
          ",",
        ),
      },
      { deploymentsDir: join(work, "deployments"), log: () => {} },
    );
    const apiFor = (signer?: Signer) =>
      new ApiClient({ baseUrl: services?.publicUrl ?? "", ...(signer ? { signer } : {}) });
    const buyerApi = apiFor(buyer);
    const posterApi = apiFor(poster);
    const aspApi = apiFor(asp);
    await registerLocalAgent(chain, "alice", ["inventory-plan"]);

    // A real ASP parent owns a separate specialist sub-account; the parent lists its service.
    const specialistKey = KeyPair.fromRandom("ed25519");
    const specialist: Signer = {
      accountId: `stock.${asp.accountId}`,
      privateKey: specialistKey.toString(),
    };
    await account(asp).signAndSendTransaction({
      receiverId: specialist.accountId,
      actions: [
        actions.createAccount(),
        actions.transfer(10n ** 24n),
        actions.addFullAccessKey(specialistKey.getPublicKey()),
      ],
    });
    const specialistClient = client(specialist);
    await specialistClient.send(tokenStorageDepositCall(chain.tokenId, specialist.accountId));
    await specialistClient.send(mintCall(chain.tokenId, specialist.accountId, 2_000_000n));
    await registerWithBond(
      specialistClient,
      scriptedProfile(
        "Tender team stock specialist",
        ["warehouse-stock"],
        "Programmed warehouse lookup run by the Tender team.",
      ),
      { approve: () => true, storageMargin: 10n ** 22n },
    );
    assert.equal((await reader.getAgent(specialist.accountId))?.asp, asp.accountId);

    let handler: (request: Request) => Promise<Response> = async () =>
      new Response(null, { status: 503 });
    let port = 0;
    await new Promise<void>((resolve) => {
      server = serve(
        { hostname: "127.0.0.1", port: 0, fetch: (request) => handler(request) },
        (address) => {
          port = address.port;
          resolve();
        },
      );
    });
    const endpoint = `http://127.0.0.1:${port}/warehouse-stock`;
    const until = async (label: string, check: () => Promise<boolean>, timeoutMs = 45_000) => {
      const end = Date.now() + timeoutMs;
      while (!(await check())) {
        if (Date.now() > end) throw new Error(`Timed out: ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    };
    await until(
      "registered worker and ASP specialist",
      async () =>
        (await buyerApi.getAgent(buyer.accountId))?.agent.status === "active" &&
        (await aspApi.getAgent(specialist.accountId))?.agent.asp === asp.accountId,
    );
    const rpcUrls = { "near:testnet": chain.rpcUrl };
    const paymentOptions = {
      payer: buyer.accountId,
      asset: chain.tokenId,
      signer: createClientNearSigner({
        accountId: buyer.accountId,
        secretKey: buyer.privateKey as `ed25519:${string}`,
        rpcUrls,
      }),
      totalBudget: "100000",
      budgetFile: join(work, "worker-payments.json"),
      allowedOrigins: [new URL(endpoint).origin],
      allowLocalHttp: true,
    };
    const solverOptions: ServiceAssistedSolverOptions = {
      name: "Tender team service-assisted inventory worker",
      scripted: true,
      chain: reader,
      api: buyerApi,
      buyer: paymentOptions,
      capabilities: {
        "warehouse-stock": {
          tag: "warehouse-stock",
          providers: [asp.accountId],
          maxPrice: "100000",
        },
      },
      posters: [poster.accountId],
      verifiers: [judge.accountId],
      minMargin: 800000n,
      minRunwayMs: 75000,
      plan: planInventory,
      complete: finishInventory,
      log: record,
    };
    const solver = createServiceAssistedSolver(solverOptions);

    // This snapshot exists only at the ASP. Its units are absent from the task and worker planner.
    const units = randomInt(5, 10);
    const request: InventoryRequest = {
      operation: "stock-value-and-reorder",
      sku: "SKU-MAPLE",
      snapshot: randomUUID(),
      unit_price_cents: 250,
      reorder_threshold: 10,
      target_units: 20,
    };
    const expected = {
      sku: request.sku,
      units,
      value_cents: units * 250,
      reorder_units: 20 - units,
    };
    const brief: Brief = {
      version: 1,
      title: "Tender team open task: stock valuation and reorder plan",
      summary:
        "Needs an authoritative warehouse snapshot unavailable to the worker. Local Tender team demonstration.",
      instructions: JSON.stringify(request),
      category: "data",
      tags: ["inventory-plan"],
      output: { format: "json", max_bytes: 4096 },
    };
    const criteria: PublicCriteria = {
      version: 1,
      kind: "json_schema",
      min_score: 100,
      split: "winner_take_all",
      has_heldout: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["sku", "units", "value_cents", "reorder_units"],
        properties: {
          sku: { type: "string", const: request.sku },
          units: { type: "integer", minimum: 0 },
          value_cents: {
            type: "integer",
            minimum: 0,
            description: "Stock count multiplied by unit_price_cents",
          },
          reorder_units: {
            type: "integer",
            minimum: 0,
            description:
              "If units are below reorder_threshold, target_units minus units; otherwise zero",
          },
        },
      },
    };
    const hidden = canonicalJson({
      salt: randomSalt(),
      json_schema: {
        assertions: Object.entries(expected).map(([key, value]) => ({
          path: `$.${key}`,
          equals: value,
        })),
      },
    });
    const hiddenHash = sha256Hex(hidden);
    const briefBytes = canonicalJson(brief);
    const criteriaBytes = canonicalJson(criteria);
    const stored = await posterApi.uploadBlob({
      kind: "brief",
      contentType: "application/json",
      bytes: briefBytes,
    });
    await posterApi.uploadBlob({
      kind: "criteria",
      contentType: "application/json",
      bytes: criteriaBytes,
    });
    await posterApi.uploadHeldout(hiddenHash, hidden);
    const posterClient = client(poster);
    await posterClient.deposit(chain.tokenId, 1_000_000n);
    const posted = await posterClient.postTask({
      token: chain.tokenId,
      reward: 1_000_000n,
      briefUri: stored.uri,
      briefHash: sha256Hex(briefBytes),
      criteriaHash: sha256Hex(criteriaBytes),
      heldoutCommitment: hiddenHash,
      verifier: judge.accountId,
      commitSecs: 120,
      revealSecs: 15,
      pickSecs: 90,
      fallbackSecs: 30,
      maxWinners: 1,
      invited: [],
    });
    const taskId = posted.taskId;
    record(`OPEN: task ${taskId}, reward 1.000000 test token; any registered agent may enter`);
    await until(
      "open task indexed and accepted by Judge",
      async () => (await buyerApi.getTask(taskId))?.task.judge_status === "accepted",
    );
    const context = await buyerApi.getTask(taskId);
    assert.ok(context?.brief && context.criteria);
    assert.equal(context.task.invited.length, 0);
    const ctx: TaskContext = {
      task: context.task,
      brief: context.brief,
      criteria: context.criteria,
    };
    assert.equal(await buyerApi.getBlob(hiddenHash), null);
    assert.equal((await planInventory(ctx)).kind, "need_service");
    assert.equal(await solver.solve(ctx), null); // No listed capability yet: no guess or free answer.
    await assert.rejects(() => readFile(paymentOptions.budgetFile), { code: "ENOENT" });

    const { service } = await aspApi.createService({
      agent: specialist.accountId,
      title: "Tender team authoritative warehouse stock lookup",
      description:
        "Returns a warehouse snapshot by SKU and snapshot id. Programmed API run by the Tender team.",
      tags: ["warehouse-stock"],
      category: "other",
      output_format: "json",
      token: chain.tokenId,
      price: "100000",
      payment_mode: "x402",
      x402: { endpoint, network: "near:testnet", pay_to: asp.accountId, max_timeout_seconds: 60 },
      verification: { kind: "none" },
      commit_secs: 0,
      reveal_secs: 0,
      pick_secs: 0,
    });
    assert.equal(service.provider, asp.accountId);
    assert.equal(service.agent_record?.asp, asp.accountId);
    record(
      `ASP: ${asp.accountId} lists specialist ${specialist.accountId}; price 0.100000 test token`,
    );
    const facilitator = new x402Facilitator().register(
      "near:testnet",
      new ExactNearScheme(
        createFacilitatorNearSigner({
          relayers: [
            { accountId: relayer.accountId, secretKey: relayer.privateKey as `ed25519:${string}` },
          ],
          rpcUrls,
        }),
      ),
    );
    let charges = 0;
    let lookups = 0;
    handler = createX402ServiceHandler({
      service,
      stateFile: join(work, "asp-receipts.json"),
      allowLocalHttp: true,
      facilitator: {
        verify: (payload, requirements) => facilitator.verify(payload, requirements),
        settle: (payload, requirements) => {
          charges += 1;
          return facilitator.settle(payload, requirements);
        },
      },
      async respond(input) {
        assert.deepEqual(input, { sku: request.sku, snapshot: request.snapshot });
        lookups += 1;
        return { sku: request.sku, snapshot: request.snapshot, units };
      },
    });
    const unpaid = await fetch(endpoint, { method: "POST" });
    assert.equal(unpaid.status, 402);
    assert.equal(lookups, 0);
    await unpaid.body?.cancel();
    const wallet = (id: string) => reader.ftBalanceOf(chain.tokenId, id);
    const before = {
      worker: await wallet(buyer.accountId),
      asp: await wallet(asp.accountId),
      treasury: await reader.balanceOf(treasury.accountId, chain.tokenId),
      workerVault: await reader.balanceOf(buyer.accountId, chain.tokenId),
    };
    const workerClient = client(buyer);
    const workerSolver = options.solverFactory?.(solverOptions) ?? solver;
    const memory = new AgentMemory();
    const state = createStateStore(join(work, "worker-drafts"));
    const tick = () =>
      agentTick({
        name: "Tender team inventory worker",
        client: workerClient,
        api: buyerApi,
        state,
        tags: ["inventory-plan"],
        solver: workerSolver,
        memory,
        policy: { verifiers: "judge", judgeAccount: judge.accountId },
        log: (line) => {
          if (!line.startsWith("DEBUG")) record(line);
        },
      });
    await until("worker uses the paid capability and commits", async () => {
      await tick();
      return (await reader.getEntry(taskId, buyer.accountId)) !== null;
    });
    assert.equal(charges, 1);
    assert.equal(lookups, 1);
    assert.equal(await wallet(buyer.accountId), before.worker - 100_000n);
    assert.equal(await wallet(asp.accountId), before.asp + 100_000n);
    // Restarting the solver recovers the same paid response from its ledger, without another charge.
    assert.deepEqual(
      JSON.parse(
        new TextDecoder().decode(
          (await createServiceAssistedSolver(solverOptions).solve(ctx)) ?? undefined,
        ),
      ),
      expected,
    );
    assert.equal(charges, 1);
    assert.equal(lookups, 1);
    await until(
      "worker reveals and Judge settles the original task",
      async () => {
        await tick();
        return (await reader.getTask(taskId))?.outcome?.kind === "picked";
      },
      150_000,
    );
    const settled = await reader.getTask(taskId);
    assert.ok(settled?.outcome?.kind === "picked");
    const fee = (1_000_000n * BigInt(settled.fee_bps)) / 10_000n;
    const reward = 1_000_000n - fee;
    assert.equal(reward, 950_000n);
    assert.equal(settled.outcome.winners[0]?.account, buyer.accountId);
    assert.equal(BigInt(settled.outcome.winners[0]?.amount ?? "0"), reward);
    assert.equal(await reader.balanceOf(treasury.accountId, chain.tokenId), before.treasury + fee);
    assert.equal(
      await reader.balanceOf(buyer.accountId, chain.tokenId),
      before.workerVault + reward,
    );
    await workerClient.withdraw(chain.tokenId, reward);
    assert.equal(await wallet(buyer.accountId), before.worker + 850_000n);
    assert.equal(await reader.balanceOf(buyer.accountId, chain.tokenId), before.workerVault);
    await until(
      "scorecard indexed",
      async () => (await buyerApi.getTask(taskId))?.scorecard != null,
    );
    const final = await buyerApi.getTask(taskId);
    assert.equal(
      final?.scorecard?.entries.find((entry) => entry.account === buyer.accountId)?.score,
      100,
    );
    assert.equal(final?.entries.find((entry) => entry.account === buyer.accountId)?.revealed, true);
    assert.equal((await reader.getTasks(0n, 50)).length, 1); // Paid API purchase created no extra task.
    record("DONE: original open task scored 100; worker withdrew 0.950000 test token");
    record(
      "MONEY: ASP +0.100000; Tender fee 0.050000; worker net +0.850000 test token (network gas separate)",
    );
    const report = {
      passed: true,
      taskId: taskId.toString(),
      serviceId: service.id,
      asp: asp.accountId,
      specialist: specialist.accountId,
      worker: buyer.accountId,
      reward: "1000000",
      serviceCost: "100000",
      fee: fee.toString(),
      workerPayout: reward.toString(),
      workerNet: "850000",
      score: 100,
      charges,
      lookups,
      trace,
      orchestration: options.solverFactory
        ? "LLM chooses an approved service and composes the final answer"
        : "programmed capability routing; no LLM",
      settlementNetwork: "real local NEAR node; no public testnet",
      aiCalls: options.modelCalls?.() ?? 0,
    };
    if (options.review) {
      const review = options.review;
      // Keep the actual test database and local node for inspection, with all signing loops off.
      await aspApi.updateService(BigInt(service.id), { status: "paused" });
      handler = async () => Response.json({ error: "review_only" }, { status: 503 });
      await services.stop();
      services = await startServices(
        {
          TENDER_NETWORK: "sandbox",
          TENDER_CONTRACT: chain.contractId,
          NEAR_RPC_URL: chain.rpcUrl,
          DATABASE_URL: databaseUrl,
          API_PORT: String(review.apiPort),
          PUBLIC_API_URL: `http://localhost:${review.apiPort}`,
          PUBLIC_WEB_URL: review.webUrl,
          INDEXER_POLL_MS: "1000",
          TEAM_ACCOUNTS: [buyer.accountId, asp.accountId, poster.accountId, judge.accountId].join(
            ",",
          ),
        },
        { deploymentsDir: join(work, "deployments"), log: () => {} },
      );
      record(
        "REVIEW: real task and service available; service paused, Judge and payment workers disabled",
      );
      await review.onReady({
        taskId: taskId.toString(),
        serviceId: service.id,
        apiUrl: services.publicUrl,
        rpcUrl: chain.rpcUrl,
        contractId: chain.contractId,
        report,
      });
      const stopped = new Promise<void>((resolve) => {
        if (review.signal.aborted) resolve();
        else review.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await Promise.race([
        stopped,
        services.failed.then(() => {
          throw new Error("Review API stopped unexpectedly");
        }),
      ]);
    }
    return report;
  } finally {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve())),
      );
    await services?.stop();
    await chain.stop();
    await rm(work, { recursive: true, force: true });
  }
}
