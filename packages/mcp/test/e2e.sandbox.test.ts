import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type LocalChain, type Signer, startLocalChain, TenderClient } from "@tender/client";
import { sha256Hex } from "@tender/shared";
import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import { addRoleKey } from "../../../scripts/keeper-key";
import { type Services, startServices } from "../../../scripts/serve";

// The Tender MCP server as an agent's owner runs it: the bin as a process of its own, spoken to
// over stdio by the SDK's client, against a local chain and the services (`pnpm serve`'s, with the
// index in an in-memory PGlite). The poster posts through its own server, with its full-access key.
// Alice enters through hers, with the function-call key that scripts/keeper-key.ts mints for an
// agent: it can call `commit` and `reveal` on Tender and nothing else.
//
// Every server gets an environment built here from nothing: the TENDER_* names and NEAR_RPC_URL
// that it needs, and PATH and a throw-away HOME. The parent's environment, a developer's secrets
// among it, never reaches one.

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = join(ROOT, "packages/mcp/bin/tender-mcp.ts");

/** The shortest window the chain takes: the plan's 5 s. */
const MIN_WINDOW_SECS = 5;
/** The task's commit and reveal windows. See the test for why they are not the minimum. */
const WINDOW_SECS = 15;
const REWARD = "1000000";

let chain: LocalChain;
let services: Services;
/** Reads the chain; it signs nothing. */
let reader: TenderClient;
/** Everything the test makes lives under this directory. */
let work: string;
/** The HOME of every server: an empty directory, so that nothing of the developer's is read. */
let home: string;
/** Where each account's server keeps its drafts. */
let stateDirs: Record<"poster" | "alice" | "bob", string>;
/** Alice's function-call key, as the key script wrote it. */
let aliceKey: Signer;
const serviceLines: string[] = [];

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "tender-mcp-e2e-"));
  home = join(work, "home");
  const keys = join(work, "keys");
  const deployments = join(work, "deployments");
  stateDirs = {
    poster: join(work, "state", "poster"),
    alice: join(work, "state", "alice"),
    bob: join(work, "state", "bob"),
  };
  await Promise.all(
    [home, keys, deployments, ...Object.values(stateDirs)].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );

  chain = await startLocalChain({ minWindowSecs: MIN_WINDOW_SECS });
  reader = new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
  });

  // No deployment record says where the indexer starts, so it starts at the chain's final height,
  // which is before the task is posted.
  services = await startServices(
    {
      TENDER_NETWORK: chain.network,
      TENDER_CONTRACT: chain.contractId,
      NEAR_RPC_URL: chain.rpcUrl,
      DATABASE_URL: "pglite:memory",
      API_PORT: "0",
      INDEXER_POLL_MS: "100",
    },
    { deploymentsDir: deployments, log: (line) => serviceLines.push(line) },
  );

  // Alice's key is the one the key script adds to an agent's account, read from the env file that
  // the script writes it to.
  const { alice } = chain.accounts;
  const envFile = join(keys, ".env.deploy.sandbox");
  await writeFile(
    envFile,
    [
      `TENDER_CONTRACT=${chain.contractId}`,
      `AGENT_ALICE_ACCOUNT=${alice.accountId}`,
      `AGENT_ALICE_FULL_ACCESS_KEY=${alice.privateKey}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await addRoleKey(
    "agent",
    { network: chain.network, rpcUrl: chain.rpcUrl, contractId: chain.contractId },
    { dir: keys, agent: "alice", log: () => undefined },
  );
  const { AGENT_ALICE_PRIVATE_KEY } = parseEnv(await readFile(envFile, "utf8"));
  if (AGENT_ALICE_PRIVATE_KEY === undefined) {
    throw new Error("the key script did not write AGENT_ALICE_PRIVATE_KEY");
  }
  aliceKey = { accountId: alice.accountId, privateKey: AGENT_ALICE_PRIVATE_KEY };
});

afterAll(async () => {
  await Promise.allSettled(servers.map((server) => server.client.close()));
  // A test that failed half way must not leave a server behind.
  for (const server of servers) if (server.isAlive()) process.kill(server.pid, "SIGKILL");
  await services?.stop();
  await chain?.stop();
  if (work) await rm(work, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits until `check` holds, looking every 200 ms, and fails the test after `ms`. */
async function until(what: string, check: () => Promise<boolean>, ms: number): Promise<void> {
  const giveUpAt = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > giveUpAt) throw new Error(`timed out waiting until ${what}`);
    await sleep(200);
  }
}

/**
 * Waits until the last final block is at or past `targetNs`, so that a transaction sent from then
 * on runs in a block that is: the contract counts a deadline by the block's time, not the clock's.
 */
function waitForChainTime(targetNs: bigint): Promise<void> {
  return until(
    `the chain's clock reaches ${targetNs}`,
    async () => (await reader.blockTimestampNs()) >= targetNs,
    60_000,
  );
}

// ---- The servers ------------------------------------------------------------------------------

/** A server process, and the client that drives it. */
interface Server {
  client: Client;
  pid: number;
  /** Whether the client has seen the process go. */
  isAlive: () => boolean;
  /** Resolves once the client has seen the process go. */
  closed: Promise<void>;
  /** All that the process has written to stderr so far. */
  stderr: () => string;
}

/** How to start a server: what to run, and which of the TENDER_* variables to give it. */
interface Launch {
  command: string;
  args: string[];
  /** All five of the required ones when left out. */
  variables?: readonly string[];
}

/**
 * `node --import tsx`, not the `pnpm` command of the docs: the process that a test kills must be
 * the server itself, and a kill of `pnpm` leaves the server running behind it.
 */
const DIRECT: Launch = { command: process.execPath, args: ["--import", "tsx", BIN] };

const servers: Server[] = [];

/** What a server is given: what it needs, and nothing of the parent's environment but PATH. */
function environmentOf(
  signer: Signer,
  stateDir: string,
  variables?: readonly string[],
): Record<string, string> {
  const tender: Record<string, string> = {
    TENDER_NETWORK: chain.network,
    TENDER_CONTRACT: chain.contractId,
    TENDER_API_URL: services.publicUrl,
    TENDER_ACCOUNT: signer.accountId,
    TENDER_PRIVATE_KEY: signer.privateKey,
  };
  const given: Record<string, string> = {};
  for (const name of variables ?? Object.keys(tender)) {
    const value = tender[name];
    if (value === undefined) throw new Error(`the test has no value for ${name}`);
    given[name] = value;
  }
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    NEAR_RPC_URL: chain.rpcUrl,
    TENDER_STATE_DIR: stateDir,
    ...given,
  };
}

/** Starts a server process and connects a client to it. */
async function startServer(
  signer: Signer,
  stateDir: string,
  launch: Launch = DIRECT,
): Promise<Server> {
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    cwd: ROOT,
    env: environmentOf(signer, stateDir, launch.variables),
    stderr: "pipe",
  });
  const written: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer | string) => written.push(String(chunk)));
  const client = new Client({ name: "tender-e2e", version: "1.0.0" });
  let alive = true;
  const closed = new Promise<void>((resolve) => {
    client.onclose = () => {
      alive = false;
      resolve();
    };
  });
  try {
    await client.connect(transport);
  } catch (error) {
    await client.close().catch(() => undefined);
    throw new Error(`the server did not start: ${written.join("").trim()}`, { cause: error });
  }
  if (transport.pid === null) throw new Error("the server has no pid");
  const server: Server = {
    client,
    pid: transport.pid,
    isAlive: () => alive,
    closed,
    stderr: () => written.join(""),
  };
  servers.push(server);
  return server;
}

/**
 * The launch that docs/MCP.md gives for Claude Code: the command and arguments of the `tender`
 * entry in its first `.mcp.json` snippet, and the variables that the entry names. A client fills
 * each `${NAME}` from the variable of that name, so the entry must map every name to itself. A
 * snippet that leaves out a variable the server needs makes the server refuse to start.
 */
async function launchOfDocs(): Promise<Launch> {
  const Entry = z.object({
    command: z.string(),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()),
  });
  const text = await readFile(join(ROOT, "docs/MCP.md"), "utf8");
  for (const snippet of text.matchAll(/```json\n([\s\S]*?)\n```/g)) {
    const config: unknown = JSON.parse(snippet[1] ?? "");
    const found = z.object({ mcpServers: z.object({ tender: Entry }) }).safeParse(config);
    if (!found.success) continue;
    const { command, args, env } = found.data.mcpServers.tender;
    for (const [name, value] of Object.entries(env)) {
      if (value !== `\${${name}}`) throw new Error(`docs/MCP.md gives ${name} the value ${value}`);
    }
    return { command, args, variables: Object.keys(env) };
  }
  throw new Error("docs/MCP.md has no .mcp.json snippet for the tender server");
}

/** A tool's answer, which is JSON text. A tool that failed throws, with the text it gave. */
async function call<T = unknown>(
  server: Server,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const result = await server.client.callTool({ name, arguments: args });
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  const text = first?.type === "text" ? first.text : "";
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text) as T;
}

/**
 * Ends the server the way a crash does: SIGKILL gives it no chance to close, flush or mark
 * anything. Resolves once the client has seen the process go.
 */
async function crash(server: Server): Promise<void> {
  process.kill(server.pid, "SIGKILL");
  await server.closed;
  expect(isRunning(server.pid)).toBe(false);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: there is such a process, and it is somebody else's.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ---- What the tools answer --------------------------------------------------------------------

interface OwnEntry {
  status: string;
  uri: string | null;
  content_hash: string | null;
  draft: { committed_at: string | null; revealed_uri: string | null } | null;
}

interface TaskAnswer {
  task: { reveal_count: number };
  own_entry: OwnEntry;
}

// ---- The tests --------------------------------------------------------------------------------

test("reveal_survives_restart", async () => {
  // Both servers are up before the task is posted, so that the time a process takes to start does
  // not come out of the commit window.
  const poster = await startServer(chain.accounts.poster, stateDirs.poster);
  const first = await startServer(aliceKey, stateDirs.alice);
  expect(await call(poster, "balance")).toMatchObject({
    account: chain.accounts.poster.accountId,
    key_kind: "full_access",
  });
  expect(await call(first, "balance")).toMatchObject({
    account: aliceKey.accountId,
    key_kind: "function_call",
  });

  // The poster funds its vault and posts a task, through its server. Alice's steps have to fit in
  // the commit window, and a new server has to start and reveal in the reveal window. The post
  // returns only once its block is final, a couple of seconds into the commit window, so 5 s
  // windows leave the commit little room and the reveal none; 15 s leave what a busy machine needs.
  await call(poster, "deposit", { amount: REWARD });
  const posted = await call<{ task_id: string; commit_deadline: string }>(poster, "post_task", {
    title: "The answer",
    summary: "Reply with the number 42.",
    instructions: "Reply with the number 42 and nothing else.",
    category: "other",
    tags: ["e2e"],
    output_format: "text",
    criteria: {
      version: 1,
      kind: "rubric",
      min_score: 50,
      split: "winner_take_all",
      has_heldout: false,
      rubric: [{ criterion: "The reply is the number 42", weight: 10 }],
    },
    reward: REWARD,
    commit_secs: WINDOW_SECS,
    reveal_secs: WINDOW_SECS,
    pick_secs: MIN_WINDOW_SECS,
    fallback_secs: MIN_WINDOW_SECS,
  });
  const taskId = posted.task_id;

  // Alice finds the task on the board, says that she has started, and commits to her answer.
  await until(
    "alice sees the task on the board",
    async () => {
      const board = await call<{ tasks: Array<{ id: string }> }>(first, "list_tasks");
      return board.tasks.some((task) => task.id === taskId);
    },
    30_000,
  );
  expect(await call(first, "start_task", { task_id: taskId })).toEqual({ working_count: 1 });
  const committed = await call<{
    commitment: string;
    content_hash: string;
    tx_hash: string | null;
    reveal_opens_at: string;
  }>(first, "commit_result", { task_id: taskId, content: "42" });
  expect(committed.content_hash).toBe(sha256Hex("42"));
  expect(committed.tx_hash).toEqual(expect.any(String));
  expect(committed.reveal_opens_at).toBe(posted.commit_deadline);
  // The chain holds the commitment and nothing of the answer.
  expect(await reader.getEntry(BigInt(taskId), aliceKey.accountId)).toMatchObject({
    commitment: committed.commitment,
    content_hash: null,
    uri: null,
  });

  // The crash. The server and everything it held in memory are gone; what is left is the draft in
  // the state directory, which holds the work and the salt.
  await crash(first);

  // The commit window ends, and a new server starts on the same state directory.
  const task = await reader.getTask(BigInt(taskId));
  if (task === null) throw new Error(`task ${taskId} is missing from the chain`);
  await waitForChainTime(BigInt(task.commit_deadline));
  const second = await startServer(aliceKey, stateDirs.alice);
  expect(second.pid).not.toBe(first.pid);

  // It knows the entry from the index and the draft from the disk, though it never committed.
  const entryOf = async () =>
    (await call<TaskAnswer>(second, "get_task", { task_id: taskId })).own_entry;
  await until(
    "the index lists alice's commit",
    async () => (await entryOf()).status === "committed",
    30_000,
  );
  expect((await entryOf()).draft).toMatchObject({
    committed_at: expect.any(String),
    revealed_uri: null,
  });

  // The reveal: the draft's work is uploaded, and the draft's salt opens the commitment on chain.
  const revealed = await call<{ uri: string; tx_hash: string | null }>(second, "reveal_result", {
    task_id: taskId,
  });
  expect(revealed.uri).toBe(`${services.publicUrl}/v1/blobs/${sha256Hex("42")}`);
  expect(revealed.tx_hash).toEqual(expect.any(String));
  await until(
    "the index shows alice revealed",
    async () => (await entryOf()).status === "revealed",
    30_000,
  );
  expect(await entryOf()).toMatchObject({
    status: "revealed",
    uri: revealed.uri,
    content_hash: sha256Hex("42"),
    draft: { revealed_uri: revealed.uri },
  });
  const after = await call<TaskAnswer>(second, "get_task", { task_id: taskId });
  expect(after.task.reveal_count).toBe(1);
  expect(await reader.getEntry(BigInt(taskId), aliceKey.accountId)).toMatchObject({
    commitment: committed.commitment,
    content_hash: sha256Hex("42"),
    uri: revealed.uri,
  });
  // The poster sees it too, from the outside.
  expect(await call(poster, "task_entries", { task_id: taskId })).toMatchObject({
    entries: [{ account: aliceKey.accountId, revealed: true, uri: revealed.uri }],
  });

  // The agent key does what the key script gave it, and no more (docs/MCP.md): the tools that move
  // money refuse before anything is sent, and the chain refuses a method that the key does not list.
  await expect(call(second, "deposit", { amount: "1" })).rejects.toThrow("NEEDS_FULL_ACCESS_KEY");
  await expect(
    call(second, "register_agent", { name: "alice", description: "Answers 42.", tags: ["e2e"] }),
  ).rejects.toThrow("Access key does not allow method register_agent");

  // Neither of alice's servers wrote the key anywhere, and the services logged no error.
  const keyBody = aliceKey.privateKey.slice("ed25519:".length);
  for (const server of [first, second]) {
    expect(server.stderr()).toContain(
      `tender-mcp: serving ${aliceKey.accountId} on sandbox (function_call key)`,
    );
    expect(server.stderr()).not.toContain(keyBody);
  }
  expect(poster.stderr()).not.toContain(chain.accounts.poster.privateKey.slice("ed25519:".length));
  expect(serviceLines.filter((line) => line.startsWith("ERROR"))).toEqual([]);
});

test("the_launch_in_the_docs_starts_the_server", async () => {
  // Bob has only the full-access key that the chain gave him, which is all this test needs.
  const server = await startServer(chain.accounts.bob, stateDirs.bob, await launchOfDocs());
  expect(await call(server, "balance")).toMatchObject({
    account: chain.accounts.bob.accountId,
    key_kind: "full_access",
  });
  const { tools } = await server.client.listTools();
  expect(tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(["list_tasks", "commit_result", "reveal_result", "post_task"]),
  );
  // Only the protocol went to stdout: the client read every line of it as a message. And the one
  // line on stderr is the server's own.
  expect(server.stderr()).toBe(
    `tender-mcp: serving ${chain.accounts.bob.accountId} on sandbox (full_access key)\n`,
  );
});
