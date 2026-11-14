import "./lib/node-check";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApiClient,
  registerLocalAgent,
  type Signer,
  startLocalChain,
  TenderClient,
  toTxResult,
} from "@tender/client";
import { createStateStore } from "@tender/mcp";
import {
  BriefSchema,
  canonicalJson,
  DelegateViewSchema,
  HIRER_ACCEPTS_CRITERIA,
  ScorecardSchema,
  sha256Hex,
} from "@tender/shared";
import { Account, actions, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { AgentMemory, agentTick } from "../packages/agents/src/runner";
import { planAssistedImport } from "../packages/agents/src/services/assistance-planner";
import { auditCsv, findDuplicateRecords } from "../packages/agents/src/services/data-quality";
import { utilityRequest } from "../packages/agents/src/services/escrow";
import { createEscrowAssistedSolver } from "../packages/agents/src/services/escrow-assistance";
import type { Solver } from "../packages/agents/src/types";
import { startServices } from "./serve";

/** Local chain only. The setup's owner keys never reach a worker or the coordinator. */
async function demo() {
  const directory = await mkdtemp(join(tmpdir(), "tender-escrow-assistance-"));
  console.log("Starting isolated local NEAR chain and services.");
  const chain = await startLocalChain({ minWindowSecs: 5 });
  let services: Awaited<ReturnType<typeof startServices>> | undefined;
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
          .map((s) => s.accountId)
          .join(","),
      },
      { deploymentsDir: join(directory, "deployments"), log: () => {} },
    );
    const client = (signer?: Signer) =>
      new TenderClient({
        network: "sandbox",
        contractId: chain.contractId,
        rpcUrl: chain.rpcUrl,
        ...(signer ? { signer } : {}),
      });
    const api = (signer?: Signer) =>
      new ApiClient({ baseUrl: services?.publicUrl ?? "", ...(signer ? { signer } : {}) });
    const { alice, bob, poster } = chain.accounts;
    // Indexing starts at the current head, so register only after its process has started.
    await registerLocalAgent(chain, "alice", ["import-readiness"]);
    await registerLocalAgent(chain, "bob", ["csv-audit", "duplicate-records"]);
    async function scoped(owner: Signer, methods: string[]) {
      const key = KeyPair.fromRandom("ed25519");
      toTxResult(
        await new Account(
          owner.accountId,
          new JsonRpcProvider({ url: chain.rpcUrl }),
          owner.privateKey as KeyPairString,
        ).signAndSendTransaction({
          receiverId: owner.accountId,
          actions: [
            actions.addFunctionCallAccessKey(
              key.getPublicKey(),
              chain.contractId,
              methods,
              10n ** 23n,
            ),
          ],
          waitUntil: "FINAL",
          throwOnFailure: false,
        }),
        chain.contractId,
      );
      return { accountId: owner.accountId, privateKey: key.toString() };
    }
    const workKey = await scoped(alice, ["commit", "reveal"]);
    const spendingKey = await scoped(alice, ["post_task"]);
    const acceptanceKey = await scoped(alice, ["pick"]);
    const specialistKey = await scoped(bob, ["commit", "reveal"]);
    const worker = client(workKey);
    const spender = client(spendingKey);
    const acceptor = client(acceptanceKey);
    await client(alice).storageDeposit(2n * 10n ** 23n);
    await client(alice).deposit(chain.tokenId, 200000n);
    await client(alice).addDelegate(spender.publicKey as string, chain.tokenId, 100000n, 200000n);
    const until = async (label: string, check: () => Promise<boolean>, timeout = 45000) => {
      const end = Date.now() + timeout;
      while (!(await check())) {
        if (Date.now() > end) throw new Error(`Timed out: ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    };
    await until(
      "specialist registration indexed",
      async () => (await api().getAgent(bob.accountId))?.agent.status === "active",
    );
    const listings = [];
    for (const capability of ["csv-audit", "duplicate-records"]) {
      const { service } = await api(bob).createService({
        agent: bob.accountId,
        title: capability,
        description: "Deterministic test service run by the Tender team.",
        category: "data",
        tags: [capability],
        output_format: "json",
        token: chain.tokenId,
        price: "100000",
        payment_mode: "escrow",
        verification: { kind: "hirer" },
        commit_secs: 25,
        reveal_secs: 25,
        pick_secs: 45,
      });
      listings.push({ capability, service });
    }
    const before = await client().balanceOf(alice.accountId, chain.tokenId);
    const beforeSpecialist = await client().balanceOf(bob.accountId, chain.tokenId);
    const beforeTreasury = await client().balanceOf(
      chain.accounts.treasury.accountId,
      chain.tokenId,
    );
    const csv = "invoice,quantity\nINV-1,2\nINV-2,\nINV-1,3\n";
    const brief = BriefSchema.parse({
      version: 1,
      title: "Review an invoice import before posting inventory",
      summary: "Tender team local exercise: identify blank quantities and repeated invoice IDs.",
      instructions: JSON.stringify({
        operation: "import-readiness",
        csv,
        required_columns: ["invoice", "quantity"],
        key_columns: ["invoice"],
      }),
      category: "data",
      tags: ["import-readiness"],
      output: { format: "json", max_bytes: 16384 },
    });
    const stored = await api(poster).uploadBlob({
      kind: "brief",
      bytes: canonicalJson(brief),
      contentType: "application/json",
    });
    await api(poster).uploadBlob({
      kind: "criteria",
      bytes: canonicalJson(HIRER_ACCEPTS_CRITERIA),
      contentType: "application/json",
    });
    await client(poster).deposit(chain.tokenId, 1000000n);
    const { taskId } = await client(poster).postTask({
      token: chain.tokenId,
      reward: 1000000n,
      briefUri: stored.uri,
      briefHash: sha256Hex(canonicalJson(brief)),
      criteriaHash: sha256Hex(canonicalJson(HIRER_ACCEPTS_CRITERIA)),
      verifier: poster.accountId,
      commitSecs: 160,
      revealSecs: 25,
      pickSecs: 45,
      fallbackSecs: 15,
      maxWinners: 1,
      invited: [],
    });
    const state = createStateStore(join(directory, "planner-drafts"));
    const options = {
      worker,
      spender,
      acceptor,
      api: api(workKey),
      state,
      journalDir: join(directory, "assistance"),
      token: chain.tokenId,
      posters: [poster.accountId],
      verifiers: [poster.accountId],
      minProfit: 10000n,
      hireSecs: 10,
      marginSecs: 15,
      plan: planAssistedImport,
      services: listings.map(({ capability, service }) => ({
        capability,
        serviceId: service.id,
        agent: service.agent,
        provider: service.provider,
        maxPrice: 100000n,
      })),
    };
    let assisted = createEscrowAssistedSolver(options);
    const memory = new AgentMemory();
    const specialistMemory = new AgentMemory();
    const specialistState = createStateStore(join(directory, "specialist-drafts"));
    const specialist: Solver = {
      name: "Tender team specialist",
      scripted: true,
      async solve(ctx) {
        const request = utilityRequest(ctx.brief.instructions);
        if (request?.operation === "csv-audit") return canonicalJson(auditCsv(request.input));
        if (request?.operation === "duplicate-records")
          return canonicalJson(findDuplicateRecords(request.input));
        return null;
      },
    };
    const plannerTick = () =>
      agentTick({
        name: "Assisted Import Planner",
        client: worker,
        api: api(workKey),
        state,
        memory,
        tags: ["import-readiness"],
        solver: assisted,
        policy: { verifiers: [poster.accountId] },
        log: () => {},
      });
    const specialistTick = () =>
      agentTick({
        name: "Data Check",
        client: client(specialistKey),
        api: api(specialistKey),
        state: specialistState,
        memory: specialistMemory,
        tags: ["csv-audit", "duplicate-records"],
        solver: specialist,
        policy: { verifiers: [alice.accountId] },
        log: () => {},
      });
    console.log(`Parent task ${taskId}: planner identifies two missing capabilities.`);
    await until("placeholder and child hires", async () => {
      await plannerTick();
      await assisted.tick();
      return (await assisted.jobs())[0]?.children.length === 2;
    });
    // Simulate a coordinator restart after payment. Its durable journal is the only recovery input.
    assisted = createEscrowAssistedSolver(options);
    await until(
      "services settled and composed answer committed",
      async () => {
        await specialistTick();
        await assisted.tick();
        const job = (await assisted.jobs())[0];
        if (job?.status === "abandoned") throw new Error(job.reason);
        return job?.status === "done";
      },
      110000,
    );
    const jobs = await assisted.jobs();
    assert.equal(jobs[0]?.children.length, 2);
    const caps = DelegateViewSchema.parse(
      await worker.view(chain.contractId, "get_delegate", {
        account_id: alice.accountId,
        public_key: spender.publicKey,
      }),
    );
    assert.equal(caps.spent, "200000");
    const parent = await worker.getTask(taskId);
    assert.ok(parent);
    await assert.rejects(
      spender.postTask(
        {
          token: chain.tokenId,
          reward: 1n,
          briefUri: stored.uri,
          briefHash: parent.brief_hash,
          criteriaHash: parent.criteria_hash,
          commitSecs: 5,
          revealSecs: 5,
          pickSecs: 5,
          fallbackSecs: 5,
          maxWinners: 1,
          invited: [],
        },
        { delegate: true },
      ),
      /E_AUTH/,
    );
    console.log(
      "Two escrow services paid once, result checks passed, restart recovered; contract rejected further spending.",
    );
    await until(
      "parent answer revealed",
      async () => {
        await plannerTick();
        return !!(await worker.getEntry(taskId, alice.accountId))?.content_hash;
      },
      180000,
    );
    const entry = await worker.getEntry(taskId, alice.accountId);
    assert.ok(entry?.content_hash);
    await until(
      "parent answer blob available",
      async () => (await api().getBlob(entry.content_hash as string)) !== null,
    );
    const bytes = await api().getBlob(entry.content_hash);
    assert.ok(bytes);
    assert.equal(sha256Hex(bytes), entry.content_hash);
    const report = JSON.parse(new TextDecoder().decode(bytes));
    // Independent expected facts from this three-row fixture, not another call to the planner.
    assert.equal(report.audit.record_count, 3);
    assert.equal(report.audit.blank_required_cell_count, 1);
    assert.equal(report.duplicates.duplicate_group_count, 1);
    assert.equal(report.duplicates.redundant_record_count, 1);
    assert.equal(report.decision, "review_required");
    await until(
      "parent pick window",
      async () => (await worker.blockTimestampNs()) >= BigInt(parent.reveal_deadline),
    );
    const winners = [{ account: alice.accountId, bps: 10000 }];
    const scorecard = canonicalJson(
      ScorecardSchema.parse({
        version: 1,
        task_id: String(taskId),
        verifier: poster.accountId,
        kind: HIRER_ACCEPTS_CRITERIA.kind,
        criteria_hash: parent.criteria_hash,
        heldout_commitment: null,
        heldout: null,
        tie_break: "score desc, committed_at_block asc, account asc",
        entries: [
          {
            account: alice.accountId,
            content_hash: entry.content_hash,
            uri: entry.uri,
            committed_at_block: entry.committed_at_block,
            score: 100,
            passed: true,
            reasons: ["Matched the team's independently asserted invoice-import facts."],
          },
        ],
        winners,
        generated_at: new Date().toISOString(),
        judge: { software: "tender-assistance-demo/1", model: null },
      }),
    );
    const card = await api(poster).uploadBlob({
      kind: "scorecard",
      bytes: scorecard,
      contentType: "application/json",
    });
    await client(poster).pick(taskId, winners, sha256Hex(scorecard), card.uri);
    assert.equal(
      await worker.balanceOf(alice.accountId, chain.tokenId),
      before - 200000n + 950000n,
    );
    assert.equal(await worker.balanceOf(bob.accountId, chain.tokenId), beforeSpecialist + 190000n);
    assert.equal(
      await worker.balanceOf(chain.accounts.treasury.accountId, chain.tokenId),
      beforeTreasury + 60000n,
    );
    await client(alice).withdraw(chain.tokenId, 950000n);
    console.log(
      "Balances verified: parent reward 1.00; services 0.20; total fees 0.06; planner net 0.75; specialist 0.19. NEAR gas separate.",
    );
  } finally {
    await services?.stop();
    await chain.stop();
    await rm(directory, { recursive: true, force: true });
  }
}
await demo();
console.log("ESCROW ASSISTANCE OK (local NEAR chain; scoped keys; no AI calls)");
