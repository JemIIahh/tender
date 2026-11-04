import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ApiClient,
  type LocalChain,
  registerLocalAgent,
  type Signer,
  startLocalChain,
  TenderClient,
} from "@tender/client";
import { sha256Hex } from "@tender/shared";
import { KeyPair, type KeyPairString } from "near-api-js";
import { afterAll, beforeAll, expect, test } from "vitest";
import { delegateAgentCommand } from "../../../scripts/agent";
import { type Services, startServices } from "../../../scripts/serve";
// The runner is `@tender/agents`', which depends on this package, so it is reached by its path, as
// the scripts are.
import { AgentMemory, agentTick } from "../../agents/src/runner";
import type { Solver } from "../../agents/src/types";
import { detectKeyAccess } from "../src/keys";
import { createMcpServer } from "../src/server";
import { createStateStore } from "../src/state";

// Agents hiring agents, end to end on a local chain with the real services (the API, the indexer,
// the index in an in-memory PGlite):
//
// 1. bob, a registered agent with a bond, is his own provider and lists a service, signed in to the
//    API with his key;
// 2. alice, an agent with a delegate key that may spend 3 tUSDC a task, finds it with
//    `list_services` and hires it with `hire_agent`, through an MCP server that holds only that key;
// 3. bob's runner, with `hires` on, finds the pinned task that invites him, hands the request to its
//    solver, commits, and reveals once the reveal window opens, with nobody to say yes;
// 4. alice, the verifier of a hire the hirer accepts, reads the delivery and picks it with
//    `pick_winners` through a server that holds her full-access key (a delegate key never picks);
// 5. the contract pays bob the price less the platform fee, takes the fee to the treasury, and the
//    index shows bob's win and his earnings on the service's record.

const PRICE = 2_000_000n;
/** The local chain's fee, 500 basis points (`FEE_BPS` in packages/client/src/local.ts). */
const FEE_BPS = 500n;
const REQUEST = "Summarise the 2026 annual filing of Example Corp in three short lines.";
const DELIVERY = "Revenue rose 12%.\nMargins held.\nNo new debt.";

let chain: LocalChain;
let services: Services;
let reader: TenderClient;
let work: string;
const serviceLines: string[] = [];
const runnerLines: string[] = [];

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "tender-services-sandbox-"));
  chain = await startLocalChain({ minWindowSecs: 5 });
  reader = new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
  });
  // The indexer starts at the chain's final height, so bob registers after it, and is indexed.
  services = await startServices(
    {
      TENDER_NETWORK: chain.network,
      TENDER_CONTRACT: chain.contractId,
      NEAR_RPC_URL: chain.rpcUrl,
      DATABASE_URL: "pglite:memory",
      API_PORT: "0",
      INDEXER_POLL_MS: "100",
    },
    { deploymentsDir: join(work, "deployments"), log: (line) => serviceLines.push(line) },
  );
}, 180_000);

afterAll(async () => {
  await Promise.allSettled(closers.map((close) => close()));
  await services?.stop();
  await chain?.stop();
  if (work) await rm(work, { recursive: true, force: true });
});

const closers: Array<() => Promise<void>> = [];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(what: string, check: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const giveUpAt = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > giveUpAt) throw new Error(`timed out waiting until ${what}`);
    await sleep(250);
  }
}

const apiAs = (signer?: Signer) =>
  new ApiClient({ baseUrl: services.publicUrl, ...(signer !== undefined && { signer }) });
const clientAs = (signer: Signer) =>
  new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
    signer,
  });

/** An MCP server for `signer`, in this process, and a client that calls its tools. */
async function mcpFor(signer: Signer, stateDir: string) {
  const client = clientAs(signer);
  const publicKey = KeyPair.fromString(signer.privateKey as KeyPairString)
    .getPublicKey()
    .toString();
  const key = await detectKeyAccess(client, signer.accountId, publicKey);
  const server = createMcpServer({
    client,
    api: apiAs(signer),
    state: createStateStore(stateDir),
    network: chain.network,
    contractId: chain.contractId,
    accountId: signer.accountId,
    keyKind: key.kind,
    keyMethods: key.methods,
    publicKey,
    defaultToken: chain.tokenId,
  });
  const mcp = new Client({ name: "test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), mcp.connect(clientSide)]);
  closers.push(() => mcp.close());
  return {
    keyKind: key.kind,
    async call(name: string, args: Record<string, unknown>): Promise<unknown> {
      const result = await mcp.callTool({ name, arguments: args });
      const [block] = result.content as Array<{ type: string; text: string }>;
      const text = block?.text ?? "";
      if (result.isError === true) throw new Error(`${name} failed: ${text}`);
      return JSON.parse(text);
    },
  };
}

test("an_agent_hires_another_through_a_service_and_the_contract_pays_it_less_the_fee", {
  timeout: 420_000,
}, async () => {
  const { alice, bob, treasury } = chain.accounts;

  // ---- 1. bob registers, with the bond, and lists a service of his own ----
  await registerLocalAgent(chain, "bob", ["research"]);
  const bobApi = apiAs(bob);
  await until("the index holds bob as an active agent with a bond", async () => {
    const agent = (await bobApi.getAgent(bob.accountId))?.agent;
    return agent?.status === "active" && agent.bond_amount != null;
  });
  const { service } = await bobApi.createService({
    agent: bob.accountId,
    title: "Summarise a filing",
    description: "Reads a public filing and returns three short lines on it.",
    tags: ["research", "filings"],
    category: "research",
    output_format: "text",
    token: chain.tokenId,
    price: PRICE.toString(),
    commit_secs: 30,
    reveal_secs: 15,
    pick_secs: 30,
    verification: { kind: "hirer" },
  });
  expect(service).toMatchObject({ provider: bob.accountId, agent: bob.accountId, available: true });
  expect(service.agent_record).toMatchObject({ account: bob.accountId, wins: 0, entries: 0 });

  // ---- 2. alice: a vault, a delegate key with caps, and a server that holds only that key ----
  const aliceFull = clientAs(alice);
  await aliceFull.deposit(chain.tokenId, 5_000_000n);
  const keys = join(work, "keys");
  await mkdir(keys, { recursive: true });
  await writeFile(
    join(keys, "alice.json"),
    JSON.stringify({
      version: 1,
      name: "alice",
      network: "sandbox",
      account: alice.accountId,
      publicKey: KeyPair.fromString(alice.privateKey as KeyPairString)
        .getPublicKey()
        .toString(),
      privateKey: alice.privateKey,
    }),
    { mode: 0o600 },
  );
  await delegateAgentCommand({
    dir: keys,
    log: () => undefined,
    env: {
      TENDER_NETWORK: "sandbox",
      TENDER_CONTRACT: chain.contractId,
      NEAR_RPC_URL: chain.rpcUrl,
    },
    repoDir: keys,
    name: "alice",
    perTask: "3",
    total: "3",
    allowance: "0.5",
  });
  const delegateFile = JSON.parse(await readFile(join(keys, "alice.delegate.json"), "utf8")) as {
    privateKey: string;
  };
  const aliceDelegate = await mcpFor(
    { accountId: alice.accountId, privateKey: delegateFile.privateKey },
    join(work, "state", "alice-delegate"),
  );
  expect(aliceDelegate.keyKind).toBe("function_call");

  const listed = (await aliceDelegate.call("list_services", { query: "filing" })) as {
    services: Array<{ id: string; price: string; agent: string; available: boolean }>;
  };
  expect(listed.services).toEqual([
    expect.objectContaining({ id: service.id, price: PRICE.toString(), agent: bob.accountId }),
  ]);
  const vaultBefore = await reader.balanceOf(alice.accountId, chain.tokenId);
  const hired = (await aliceDelegate.call("hire_agent", {
    service_id: service.id,
    request: REQUEST,
    max_price: PRICE.toString(),
  })) as { task_id: string; verifier: string };
  expect(hired.verifier).toBe(alice.accountId);
  const taskId = BigInt(hired.task_id);

  // The task on chain is a pinned one for bob alone, at the price, escrowed out of alice's vault
  // and counted against her delegate key's caps.
  const task = await reader.getTask(taskId);
  expect(task).toMatchObject({
    poster: alice.accountId,
    verifier: alice.accountId,
    reward: PRICE.toString(),
    invited: [bob.accountId],
    max_entries: 1,
    max_winners: 1,
  });
  expect(await reader.balanceOf(alice.accountId, chain.tokenId)).toBe(vaultBefore - PRICE);
  const caps = (await reader.view(chain.contractId, "get_delegate", {
    account_id: alice.accountId,
    public_key: KeyPair.fromString(delegateFile.privateKey as KeyPairString)
      .getPublicKey()
      .toString(),
  })) as { spent: string };
  expect(caps.spent).toBe(PRICE.toString());

  // ---- 3. bob's runner takes the hire, with nobody to say yes ----
  const asked: string[] = [];
  const solver: Solver = {
    name: "filing-writer",
    scripted: false,
    async solve(ctx) {
      asked.push(ctx.brief.instructions);
      return new TextEncoder().encode(DELIVERY);
    },
  };
  const bobClient = clientAs(bob);
  const memory = new AgentMemory();
  const state = createStateStore(join(work, "state", "bob"));
  // Tags of no task: the hire is found because it invites bob, and for no other reason.
  const tick = () =>
    agentTick({
      name: "bob",
      client: bobClient,
      api: bobApi,
      state,
      tags: ["nothing-tagged-this"],
      hires: true,
      solver,
      log: (line) => runnerLines.push(line),
      memory,
    });
  await until("bob's runner commits to the hire", async () => {
    await tick();
    return (await reader.getEntry(taskId, bob.accountId)) !== null;
  });
  expect(asked).toHaveLength(1);
  expect(asked[0]?.startsWith(REQUEST)).toBe(true);
  expect(asked[0]).toContain(`This task hires service ${service.id} on Tender`);

  await until(
    "bob's runner reveals the delivery",
    async () => {
      await tick();
      return (await reader.getEntry(taskId, bob.accountId))?.content_hash === sha256Hex(DELIVERY);
    },
    120_000,
  );

  // ---- 4. alice reads the delivery and picks it, with her full-access key ----
  const revealDeadline = BigInt(task?.reveal_deadline ?? "0");
  await until(
    "the reveal window is over",
    async () => (await reader.blockTimestampNs()) >= revealDeadline,
    90_000,
  );
  const aliceApi = apiAs();
  await until("the index shows the reveal", async () => {
    const detail = await aliceApi.getTask(taskId);
    return (
      detail?.entries.some((entry) => entry.account === bob.accountId && entry.revealed) === true
    );
  });
  const detail = await aliceApi.getTask(taskId);
  const entry = detail?.entries.find((one) => one.account === bob.accountId);
  if (
    detail === null ||
    detail === undefined ||
    entry?.uri == null ||
    entry.content_hash === null
  ) {
    throw new Error("no revealed entry");
  }
  const delivered = await aliceApi.getBlob(entry.content_hash);
  expect(new TextDecoder().decode(delivered ?? new Uint8Array())).toBe(DELIVERY);

  const onChain = await reader.getEntry(taskId, bob.accountId);
  const aliceFullMcp = await mcpFor(alice, join(work, "state", "alice-full"));
  const bobBefore = await reader.balanceOf(bob.accountId, chain.tokenId);
  const treasuryBefore = await reader.balanceOf(treasury.accountId, chain.tokenId);
  await aliceFullMcp.call("pick_winners", {
    task_id: hired.task_id,
    winners: [{ account: bob.accountId, bps: 10_000 }],
    scorecard: {
      version: 1,
      task_id: hired.task_id,
      verifier: alice.accountId,
      kind: detail.criteria?.kind ?? "rubric",
      criteria_hash: detail.task.criteria_hash,
      heldout_commitment: null,
      heldout: null,
      tie_break: "score desc, committed_at_block asc, account asc",
      entries: [
        {
          account: bob.accountId,
          content_hash: entry.content_hash,
          uri: entry.uri,
          committed_at_block: onChain?.committed_at_block ?? "0",
          score: 100,
          passed: true,
          reasons: ["the hirer accepts the delivery"],
        },
      ],
      winners: [{ account: bob.accountId, bps: 10_000 }],
      generated_at: new Date().toISOString(),
      judge: { software: "hirer-review/1", model: null },
    },
  });

  // ---- 5. the money: the price less the fee to bob, the fee to the treasury ----
  const fee = (PRICE * FEE_BPS) / 10_000n;
  expect(await reader.balanceOf(bob.accountId, chain.tokenId)).toBe(bobBefore + PRICE - fee);
  expect(await reader.balanceOf(treasury.accountId, chain.tokenId)).toBe(treasuryBefore + fee);
  expect(PRICE - fee).toBe(1_900_000n);
  const settled = await reader.getTask(taskId);
  expect(settled?.outcome).toMatchObject({
    kind: "picked",
    fee: fee.toString(),
    winners: [{ account: bob.accountId, bps: 10_000, amount: (PRICE - fee).toString() }],
  });

  // The service's record is the index's: bob's win and his earnings, as the contract counts them.
  await until("the index shows bob's win on the service", async () => {
    const record = (await aliceApi.getService(BigInt(service.id)))?.service.agent_record;
    return record?.wins === 1;
  });
  const after = (await aliceApi.getService(BigInt(service.id)))?.service.agent_record;
  expect(after).toMatchObject({
    wins: 1,
    entries: 1,
    reveals: 1,
    earned: { [chain.tokenId]: (PRICE - fee).toString() },
  });
  expect(runnerLines.some((line) => line.startsWith("ERROR"))).toBe(false);
});
