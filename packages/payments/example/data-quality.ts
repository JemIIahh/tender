import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import {
  ApiClient,
  registerWithBond,
  type Signer,
  scriptedProfile,
  startLocalChain,
  TenderClient,
} from "@tender/client";
import { createStateStore } from "@tender/mcp";
import {
  type Brief,
  BriefSchema,
  canonicalJson,
  mintCall,
  type PublicCriteria,
  ScorecardSchema,
  sha256Hex,
  tokenStorageDepositCall,
} from "@tender/shared";
import { x402Facilitator } from "@x402/core/facilitator";
import { createFacilitatorNearSigner } from "@x402/near";
import { ExactNearScheme } from "@x402/near/exact/facilitator";
import { Account, actions, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { startServices } from "../../../scripts/serve";
import { AgentMemory, agentTick } from "../../agents/src/runner";
import { DATA_QUALITY_SERVICES, importReadiness } from "../../agents/src/services/data-quality";
import { createDataQualityHandler } from "../../agents/src/services/data-quality-http";
import { createImportPlannerSolver } from "../../agents/src/services/import-planner";
import { createClientNearSigner, purchaseX402Service } from "../src/index";

/** Real public-data workload, real local accounts/payments/task. Never reads .env or public RPC. */
export async function runDataQualityExample(log: (line: string) => void = console.log) {
  const work = await mkdtemp(join(tmpdir(), "tender-data-quality-"));
  const chain = await startLocalChain({ minWindowSecs: 5 });
  let services: Awaited<ReturnType<typeof startServices>> | undefined;
  let server: ReturnType<typeof serve> | undefined;
  try {
    services = await startServices(
      {
        TENDER_NETWORK: "sandbox",
        TENDER_CONTRACT: chain.contractId,
        NEAR_RPC_URL: chain.rpcUrl,
        DATABASE_URL: "pglite:memory",
        API_PORT: "0",
        INDEXER_POLL_MS: "100",
        TEAM_ACCOUNTS: Object.values(chain.accounts)
          .map((signer) => signer.accountId)
          .join(","),
      },
      { deploymentsDir: join(work, "deployments"), log: () => {} },
    );
    const { alice: worker, bob: asp, poster, owner: relayer } = chain.accounts;
    const client = (signer?: Signer) =>
      new TenderClient({
        network: "sandbox",
        contractId: chain.contractId,
        rpcUrl: chain.rpcUrl,
        ...(signer ? { signer } : {}),
      });
    const api = (signer?: Signer) =>
      new ApiClient({ baseUrl: services?.publicUrl ?? "", ...(signer ? { signer } : {}) });
    const reader = client();
    const provider = new JsonRpcProvider({ url: chain.rpcUrl });
    const key = KeyPair.fromRandom("ed25519");
    const specialist = { accountId: `data-check.${asp.accountId}`, privateKey: key.toString() };
    await new Account(
      asp.accountId,
      provider,
      asp.privateKey as KeyPairString,
    ).signAndSendTransaction({
      receiverId: specialist.accountId,
      actions: [
        actions.createAccount(),
        actions.transfer(10n ** 24n),
        actions.addFullAccessKey(key.getPublicKey()),
      ],
    });
    await client(specialist).send(tokenStorageDepositCall(chain.tokenId, specialist.accountId));
    await client(specialist).send(mintCall(chain.tokenId, specialist.accountId, 2_000_000n));
    for (const [signer, name, tags, description] of [
      [
        specialist,
        "Data Check",
        ["data-quality", "csv", "deduplication"],
        "CSV import audits and exact duplicate-record checks. Deterministic services run by the Tender team.",
      ],
      [
        worker,
        "Import Planner",
        ["import-readiness"],
        "Buys data checks and composes import-readiness reports. Programmed workflow run by the Tender team.",
      ],
    ] as const) {
      const profile = scriptedProfile(name, tags, description);
      const blob = await api(signer).uploadBlob({
        kind: "profile",
        contentType: "application/json",
        bytes: canonicalJson(profile.document),
      });
      await registerWithBond(
        client(signer),
        { ...profile, uri: blob.uri },
        { approve: () => true, storageMargin: 10n ** 22n },
      );
    }
    const until = async (label: string, check: () => Promise<boolean>, ms = 45_000) => {
      const end = Date.now() + ms;
      while (!(await check())) {
        if (Date.now() > end) throw new Error(`Timed out: ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    };
    await until(
      "named profiles indexed",
      async () =>
        (await api().getAgent(specialist.accountId))?.agent.name === "Data Check" &&
        (await api().getAgent(worker.accountId))?.agent.name === "Import Planner",
    );
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
    const origin = `http://127.0.0.1:${port}`;
    const listings = Object.fromEntries(
      await Promise.all(
        DATA_QUALITY_SERVICES.map(async (definition) => {
          const { service } = await api(asp).createService({
            agent: specialist.accountId,
            title: definition.title,
            description: definition.description,
            tags: [...definition.tags],
            category: "data",
            output_format: "json",
            token: chain.tokenId,
            price: "10000",
            payment_mode: "x402",
            x402: {
              endpoint: `${origin}/${definition.slug}`,
              network: "near:testnet",
              pay_to: asp.accountId,
              max_timeout_seconds: 60,
            },
            verification: { kind: "none" },
            commit_secs: 0,
            reveal_secs: 0,
            pick_secs: 0,
          });
          assert.equal(service.agent_record?.asp, asp.accountId);
          return [definition.slug, service] as const;
        }),
      ),
    );
    assert.equal((await api().listServices({ agent: specialist.accountId })).services.length, 2);
    const rpcUrls = { "near:testnet": chain.rpcUrl };
    const localFacilitator = new x402Facilitator().register(
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
    handler = createDataQualityHandler({
      services: listings,
      stateDirectory: join(work, "receipts"),
      allowLocalHttp: true,
      facilitator: {
        verify: (payload, terms) => localFacilitator.verify(payload, terms),
        settle: (payload, terms) => {
          charges++;
          return localFacilitator.settle(payload, terms);
        },
      },
    });
    for (const service of Object.values(listings)) {
      const unpaid = await fetch(service.x402?.endpoint ?? "", { method: "POST" });
      assert.equal(unpaid.status, 402);
      await unpaid.body?.cancel();
    }
    const csv = await readFile(
      new URL("../../agents/example/data/earthquake-import.csv", import.meta.url),
      "utf8",
    );
    const required = ["id", "time", "latitude", "longitude", "mag"];
    const request = {
      operation: "import-readiness",
      csv,
      required_columns: required,
      key_columns: ["id"],
    };
    const expected = importReadiness(csv, required, ["id"]);
    const brief: Brief = BriefSchema.parse({
      version: 1,
      title: "Audit earthquake observations before a dashboard import",
      summary:
        "Check 60 public USGS observations for required values, CSV structure and repeated event IDs. Return an import-readiness report. Tender team task.",
      instructions: JSON.stringify(request),
      category: "data",
      tags: ["import-readiness"],
      output: { format: "json", max_bytes: 16_384 },
    });
    const criteria: PublicCriteria = {
      version: 1,
      kind: "json_schema",
      min_score: 100,
      split: "winner_take_all",
      has_heldout: false,
      schema: {
        type: "object",
        required: ["audit", "duplicates", "decision", "scope"],
        properties: {
          audit: { type: "object" },
          duplicates: { type: "object" },
          decision: { enum: ["passes_requested_import_checks", "review_required"] },
          scope: { type: "string" },
        },
      },
    };
    const stored = await api(poster).uploadBlob({
      kind: "brief",
      contentType: "application/json",
      bytes: canonicalJson(brief),
    });
    await api(poster).uploadBlob({
      kind: "criteria",
      contentType: "application/json",
      bytes: canonicalJson(criteria),
    });
    await client(poster).deposit(chain.tokenId, 1_000_000n);
    const { taskId } = await client(poster).postTask({
      token: chain.tokenId,
      reward: 1_000_000n,
      briefUri: stored.uri,
      briefHash: sha256Hex(canonicalJson(brief)),
      criteriaHash: sha256Hex(canonicalJson(criteria)),
      verifier: poster.accountId,
      commitSecs: 60,
      revealSecs: 20,
      pickSecs: 30,
      fallbackSecs: 15,
      maxWinners: 1,
      invited: [],
    });
    log(`Posted task ${taskId}: ${brief.title}. Data Check offers two paid APIs.`);
    const buyerOptions = {
      payer: worker.accountId,
      asset: chain.tokenId,
      signer: createClientNearSigner({
        accountId: worker.accountId,
        secretKey: worker.privateKey as `ed25519:${string}`,
        rpcUrls,
      }),
      maxPrice: "10000",
      totalBudget: "20000",
      budgetFile: join(work, "buyer.json"),
      allowedOrigins: [origin],
      allowLocalHttp: true,
    };
    const beforeWorker = await reader.ftBalanceOf(chain.tokenId, worker.accountId);
    const beforeAsp = await reader.ftBalanceOf(chain.tokenId, asp.accountId);
    const solver = createImportPlannerSolver(async (slug, input, task) => {
      const listing = listings[slug];
      assert.ok(listing);
      return (
        await purchaseX402Service(listing, input, {
          ...buyerOptions,
          requestId: `import-${task}-${slug}`,
        })
      ).body;
    });
    const memory = new AgentMemory();
    const state = createStateStore(join(work, "drafts"));
    const tick = () =>
      agentTick({
        name: "Import Planner",
        client: client(worker),
        api: api(worker),
        state,
        memory,
        tags: ["import-readiness"],
        solver,
        policy: { verifiers: [poster.accountId] },
        log: () => {},
      });
    await until("worker commits report", async () => {
      await tick();
      return (await reader.getEntry(taskId, worker.accountId)) !== null;
    });
    assert.equal(charges, 2);
    log("Import Planner bought both checks and committed its report; waiting for reveal.");
    assert.equal(await reader.ftBalanceOf(chain.tokenId, asp.accountId), beforeAsp + 20_000n);
    await until(
      "worker reveals",
      async () => {
        await tick();
        return (await reader.getEntry(taskId, worker.accountId))?.content_hash != null;
      },
      90_000,
    );
    const entry = await reader.getEntry(taskId, worker.accountId);
    assert.ok(entry);
    await until(
      "revealed result indexed",
      async () => (await api().getBlob(entry.content_hash ?? "")) !== null,
    );
    const answer = await api().getBlob(entry.content_hash ?? "");
    assert.ok(answer);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(answer)), expected);
    await until(
      "pick window",
      async () => {
        const task = await reader.getTask(taskId);
        return !!task && (await reader.blockTimestampNs()) >= BigInt(task.reveal_deadline);
      },
      35_000,
    );
    const assessment = canonicalJson(
      ScorecardSchema.parse({
        version: 1,
        task_id: taskId.toString(),
        verifier: poster.accountId,
        kind: criteria.kind,
        criteria_hash: sha256Hex(canonicalJson(criteria)),
        heldout_commitment: null,
        heldout: null,
        tie_break: "score desc, committed_at_block asc, account asc",
        entries: [
          {
            account: worker.accountId,
            content_hash: entry.content_hash,
            uri: entry.uri,
            committed_at_block: entry.committed_at_block,
            score: 100,
            passed: true,
            reasons: [
              "Report matches the source snapshot's requested checks. Programmed comparison run by the Tender team.",
            ],
          },
        ],
        winners: [{ account: worker.accountId, bps: 10_000 }],
        generated_at: new Date().toISOString(),
        judge: { software: "tender-utility-check/1", model: null },
      }),
    );
    const assessmentBlob = await api(poster).uploadBlob({
      kind: "scorecard",
      contentType: "application/json",
      bytes: assessment,
    });
    await client(poster).pick(
      taskId,
      [{ account: worker.accountId, bps: 10_000 }],
      sha256Hex(assessment),
      assessmentBlob.uri,
    );
    await client(worker).withdraw(chain.tokenId, 950_000n);
    assert.equal(
      await reader.ftBalanceOf(chain.tokenId, worker.accountId),
      beforeWorker + 930_000n,
    );
    const context = await api(worker).getTask(taskId);
    assert.ok(context?.brief && context.criteria);
    await solver.solve({ task: context.task, brief: context.brief, criteria: context.criteria });
    assert.equal(charges, 2); // Saved receipts, no second charge.
    log(
      `Data Check: 2 listed services; Import Planner: task ${taskId}, ${expected.audit.record_count} real source records checked.`,
    );
    log(
      `Result: ${expected.decision}; ${expected.duplicates?.duplicate_group_count ?? 0} repeated-key groups.`,
    );
    log(
      "Payments: ASP +0.02; task fee 0.05; worker net +0.93 local test tokens. Two settlements; retry charged nothing.",
    );
    return {
      passed: true,
      network: "sandbox",
      sourceRecords: expected.audit.record_count,
      taskId: taskId.toString(),
      settlements: charges,
      report: expected,
    };
  } finally {
    if (server) {
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    await services?.stop();
    await chain.stop();
    await rm(work, { recursive: true, force: true });
  }
}
