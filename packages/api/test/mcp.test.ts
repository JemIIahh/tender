import { StreamableHTTPTransport } from "@hono/mcp";
import { type ServerType, serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResultSchema, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { putBlob } from "@tender/db";
import { applyBlock } from "@tender/indexer";
import {
  blockOf,
  eventLine,
  FIXTURE_ACCOUNTS,
  FIXTURE_BRIEF,
  FIXTURE_BRIEF_HASH,
  FIXTURE_OPTIONS,
  fixtureData,
} from "@tender/indexer/testing";
import { canonicalJson, PhaseSchema, type Scorecard, sha256Hex } from "@tender/shared";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import {
  type AgentDetailResponse,
  type ApiDeps,
  createApp,
  type ListAgentsResponse,
  type ListTasksResponse,
  type TaskDetailResponse,
} from "../src/index";
import { seedLifecycle, testDeps } from "./helpers";

// The remote MCP server, tried the way an agent uses it: an SDK client over HTTP against the app
// served on an ephemeral port, and a few raw requests for what a client hides. The board is built
// once and only read, by the indexer's captured events as in read.test.ts. The tools answer with
// the documents of the REST routes, so those are what most tests compare them to.

const { poster, judge, alice } = FIXTURE_ACCOUNTS;

/** The task of the board that has a public scorecard. */
const SCORECARD_TASK = "3";

/** The winners of the captured `picked` event, as a scorecard names them: account and share. */
const PICKED_WINNERS = fixtureData("picked").winners.map(({ account, bps }) => ({ account, bps }));

let deps: ApiDeps;

beforeAll(async () => {
  deps = await testDeps();
  await seedBoard();
});

afterAll(() => deps.db.close());

/**
 * The lifecycle's task 1 and two more, read at `TEST_NOW`:
 *
 * | id | phase   | tags                    | scorecard                    |
 * | -- | ------- | ----------------------- | ---------------------------- |
 * | 1  | settled | extraction, regex, json | none: its blob is not stored |
 * | 2  | open    | coding, rust            | none                         |
 * | 3  | settled | extraction, regex, json | public                       |
 */
async function seedBoard(): Promise<void> {
  await seedLifecycle(deps.db);
  const coding = await putBlob(deps.db, {
    kind: "brief",
    contentType: "application/json",
    bytes: canonicalJson({
      ...FIXTURE_BRIEF,
      title: "Fix the parser",
      category: "coding",
      tags: ["coding", "rust"],
    }),
    isPublic: true,
  });
  const scorecard: Scorecard = {
    version: 1,
    task_id: SCORECARD_TASK,
    verifier: judge,
    kind: "exact",
    criteria_hash: sha256Hex("criteria"),
    heldout_commitment: null,
    heldout: null,
    tie_break: "score desc, committed_at_block asc, account asc",
    entries: [
      {
        account: alice,
        content_hash: sha256Hex("alice work"),
        uri: "ipfs://alice-work",
        committed_at_block: "65",
        score: 100,
        passed: true,
        reasons: ["matches the expected value", "naïve ✓ but exact"],
      },
    ],
    // What the pick of the task paid: a scorecard is shown only beside its own payout.
    winners: PICKED_WINNERS,
    generated_at: "2026-10-30T10:00:00Z",
    judge: { software: "tender-judge/1", model: null },
  };
  const scorecardHash = await putBlob(deps.db, {
    kind: "scorecard",
    contentType: "application/json",
    bytes: canonicalJson(scorecard),
    isPublic: true,
  });
  // The captured deadlines put a new task in its commit window at `TEST_NOW`, so task 2 is open.
  // The lifecycle's blocks end at height 90.
  await applyBlock(
    deps.db,
    blockOf(100n, [
      eventLine("task_created", { id: "2", brief_hash: coding }),
      eventLine("task_created", { id: SCORECARD_TASK, brief_hash: FIXTURE_BRIEF_HASH }),
      eventLine("picked", { task_id: SCORECARD_TASK, scorecard_hash: scorecardHash }),
    ]),
    FIXTURE_OPTIONS,
  );
}

// ---- Serving and calling ----------------------------------------------------------------------

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  // A test that fails halfway leaves its fake timers and its spies behind.
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Serves `app` on an ephemeral port of the loopback interface. */
function listen(app: Hono): Promise<{ server: ServerType; url: string }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) =>
      resolve({ server, url: `http://127.0.0.1:${info.port}` }),
    );
  });
}

function stop(server: ServerType): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    if ("closeAllConnections" in server) server.closeAllConnections();
  });
}

/** A client of `app`, which is served on an ephemeral port. Both are closed after the test. */
async function connect(app: Hono = createApp(deps)): Promise<Client> {
  const { server, url } = await listen(app);
  const client = new Client({ name: "mcp-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  cleanups.push(async () => {
    await client.close();
    await stop(server);
  });
  return client;
}

interface Reply {
  isError: boolean;
  text: string;
}

/** The answer of a tool: its one text block, and whether the tool says it failed. */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Reply> {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
  expect(result.content, `content of ${name}`).toHaveLength(1);
  const [block] = result.content;
  expect(block?.type, `content of ${name}`).toBe("text");
  return { isError: result.isError === true, text: block?.type === "text" ? block.text : "" };
}

/** The JSON a tool answered with. */
function documentOf<T>(reply: Reply): T {
  expect(reply.isError, reply.text).toBe(false);
  return JSON.parse(reply.text) as T;
}

/** Every page of a list tool, each asked for with the `next_cursor` of the one before. */
async function pagesOf<T extends { next_cursor: string | null }>(
  client: Client,
  tool: string,
  args: Record<string, unknown>,
): Promise<T[]> {
  const pages: T[] = [];
  let cursor: string | null = null;
  do {
    const page: T = documentOf<T>(
      await call(client, tool, cursor === null ? args : { ...args, cursor }),
    );
    pages.push(page);
    cursor = page.next_cursor;
    // The board is a few rows, so a walk that goes on is a cursor that does not move.
    expect(pages.length, `pages of ${tool}`).toBeLessThanOrEqual(10);
  } while (cursor !== null);
  return pages;
}

// Raw requests, for what the client hides: the headers, the status codes and the session.
const rpc = (method: string, params: Record<string, unknown> = {}, id = 1): string =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });

const post = async (
  app: Hono,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> =>
  app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body,
  });

/**
 * `promise`, or a failure if it has not settled after `ms`: for a request that may go unanswered.
 */
function within<T>(ms: number, promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// ---- Tests ------------------------------------------------------------------------------------

test("mcp_lists_tools_and_calls_list_tasks", async () => {
  const client = await connect();

  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name).sort()).toEqual(
    ["get_agent", "get_scorecard", "get_task", "list_agents", "list_tasks"].sort(),
  );
  // The inputs of the brief, nothing else; and what a client can know of each from its schema.
  const inputs = Object.fromEntries(
    tools.map((tool) => [tool.name, Object.keys(tool.inputSchema.properties ?? {}).sort()]),
  );
  expect(inputs).toEqual({
    list_tasks: ["cursor", "limit", "phase", "tag"],
    get_task: ["task_id"],
    get_scorecard: ["task_id"],
    list_agents: ["cursor", "limit", "tag"],
    get_agent: ["account"],
  });
  const listTasks = tools.find((tool) => tool.name === "list_tasks");
  expect(listTasks?.inputSchema.properties).toMatchObject({
    phase: { enum: PhaseSchema.options },
    limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
  });
  expect(listTasks?.inputSchema.required ?? []).toEqual([]);
  const listAgents = tools.find((tool) => tool.name === "list_agents");
  expect(listAgents?.inputSchema.properties).toMatchObject({
    limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
  });
  expect(listAgents?.inputSchema.required ?? []).toEqual([]);
  for (const name of ["get_task", "get_scorecard"]) {
    expect(tools.find((tool) => tool.name === name)?.inputSchema.required).toEqual(["task_id"]);
  }
  expect(tools.find((tool) => tool.name === "get_agent")?.inputSchema.required).toEqual([
    "account",
  ]);
  // Every tool only reads, and says so in one plain sentence an agent can choose it by.
  for (const tool of tools) {
    expect(tool.annotations?.readOnlyHint, `${tool.name} is read-only`).toBe(true);
    expect(tool.description, `description of ${tool.name}`).toMatch(/^[^.\n]+\.$/);
  }

  const { tasks, next_cursor } = documentOf<ListTasksResponse>(await call(client, "list_tasks"));
  expect(tasks.map((task) => task.id)).toEqual(["3", "2", "1"]);
  expect(next_cursor).toBeNull();
  expect(tasks.find((task) => task.id === "1")).toMatchObject({
    title: "Extract invoice totals",
    phase: "settled",
  });
});

test("bad_input_is_a_tool_error", async () => {
  const client = await connect();
  const query = vi.spyOn(deps.db, "query");
  try {
    const bad: Array<[tool: string, args: Record<string, unknown>, field: string]> = [
      // The two of the ruling, then a bad value of every other input.
      ["get_task", { task_id: "abc" }, "task_id"],
      ["get_agent", { account: "UPPER" }, "account"],
      ["get_task", { task_id: "007" }, "task_id"],
      ["get_task", { task_id: "18446744073709551616" }, "task_id"],
      ["get_task", { task_id: 7 }, "task_id"],
      ["get_task", {}, "task_id"],
      ["get_scorecard", { task_id: "-1" }, "task_id"],
      ["get_scorecard", { task_id: "1 or 1=1" }, "task_id"],
      ["get_agent", { account: "a".repeat(65) }, "account"],
      ["list_tasks", { phase: "nonsense" }, "phase"],
      ["list_tasks", { tag: "Not A Tag" }, "tag"],
      ["list_tasks", { tag: "x".repeat(25) }, "tag"],
      ["list_tasks", { limit: 0 }, "limit"],
      ["list_tasks", { limit: 51 }, "limit"],
      ["list_tasks", { limit: 1.5 }, "limit"],
      ["list_tasks", { limit: "twenty" }, "limit"],
      ["list_tasks", { cursor: "007" }, "cursor"],
      ["list_tasks", { cursor: "18446744073709551616" }, "cursor"],
      ["list_tasks", { cursor: "1; drop table tasks" }, "cursor"],
      ["list_tasks", { cursor: 3 }, "cursor"],
      ["list_agents", { tag: "Not A Tag" }, "tag"],
      ["list_agents", { limit: 0 }, "limit"],
      ["list_agents", { limit: 51 }, "limit"],
      ["list_agents", { cursor: "UPPER" }, "cursor"],
      ["list_agents", { cursor: "a".repeat(65) }, "cursor"],
    ];
    for (const [tool, args, field] of bad) {
      const reply = await call(client, tool, args);
      const what = `${tool} ${JSON.stringify(args)}`;
      expect(reply.isError, what).toBe(true);
      // A short message that names the argument at fault and quotes nothing the caller sent.
      expect(reply.text, what).toContain(field);
      expect(reply.text.length, what).toBeLessThan(300);
      for (const value of Object.values(args)) {
        if (typeof value === "string") expect(reply.text, what).not.toContain(value);
      }
    }
    // Every input was checked before the database was asked anything.
    expect(query).not.toHaveBeenCalled();

    // The server is no worse for it.
    const { tasks } = documentOf<ListTasksResponse>(await call(client, "list_tasks"));
    expect(tasks).toHaveLength(3);
    expect(query).toHaveBeenCalled();
  } finally {
    query.mockRestore();
  }
});

test("tools_return_the_documents_of_the_rest_routes", async () => {
  // The poster is the team's, so a tool that forgets the team accounts is caught. The clock is the
  // one of the deps: at the wall clock's time every task is long past its deadlines.
  const app = createApp({ ...deps, teamAccounts: [poster] });
  const client = await connect(app);
  const rest = async (path: string): Promise<string> => {
    const res = await app.request(path);
    expect(res.status, path).toBe(200);
    return res.text();
  };

  const cases: Array<[tool: string, args: Record<string, unknown>, path: string]> = [
    ["list_tasks", {}, "/v1/tasks"],
    ["list_tasks", { phase: "open" }, "/v1/tasks?phase=open"],
    [
      "list_tasks",
      { phase: "settled", tag: "extraction" },
      "/v1/tasks?phase=settled&tag=extraction",
    ],
    ["list_tasks", { limit: 1 }, "/v1/tasks?limit=1"],
    ["list_tasks", { limit: 1, cursor: "3" }, "/v1/tasks?limit=1&cursor=3"],
    ["get_task", { task_id: SCORECARD_TASK }, `/v1/tasks/${SCORECARD_TASK}`],
    ["get_task", { task_id: "2" }, "/v1/tasks/2"],
    ["list_agents", {}, "/v1/agents"],
    ["list_agents", { tag: "regex" }, "/v1/agents?tag=regex"],
    ["list_agents", { tag: "nothing" }, "/v1/agents?tag=nothing"],
    ["list_agents", { limit: 2 }, "/v1/agents?limit=2"],
    ["list_agents", { limit: 2, cursor: alice }, `/v1/agents?limit=2&cursor=${alice}`],
    ["get_agent", { account: alice }, `/v1/agents/${alice}`],
  ];
  for (const [tool, args, path] of cases) {
    const reply = await call(client, tool, args);
    expect(reply.isError, `${tool} ${path}`).toBe(false);
    // The very text, so that no number went through a JS number on the way (R19).
    expect(reply.text, `${tool} ${path}`).toBe(await rest(path));
  }

  const filtered = documentOf<ListTasksResponse>(await call(client, "list_tasks", { tag: "rust" }));
  expect(filtered.tasks.map((task) => task.id)).toEqual(["2"]);
  const first = documentOf<ListTasksResponse>(await call(client, "list_tasks", { limit: 1 }));
  expect(first).toMatchObject({ tasks: [{ id: "3", is_team_poster: true }], next_cursor: "3" });
  expect(typeof first.tasks[0]?.reward).toBe("string");
  // The lifecycle's agents are all registered with the same tags, so only a tag that none has
  // shows that the filter reaches the query.
  const everyone = documentOf<ListAgentsResponse>(await call(client, "list_agents"));
  expect(everyone.agents).toHaveLength(3);
  const nobody = documentOf<ListAgentsResponse>(
    await call(client, "list_agents", { tag: "nothing" }),
  );
  expect(nobody).toEqual({ agents: [], next_cursor: null });

  // A scorecard is the document of the task's own page: both are what `getScorecard` returns. Its
  // text is not the page's, since a scorecard is written in canonical form (the next test).
  const detail = JSON.parse(await rest(`/v1/tasks/${SCORECARD_TASK}`)) as TaskDetailResponse;
  expect(detail.scorecard).toMatchObject({ task_id: SCORECARD_TASK, winners: PICKED_WINNERS });
  const scorecard = await call(client, "get_scorecard", { task_id: SCORECARD_TASK });
  expect(documentOf<Scorecard>(scorecard)).toEqual(detail.scorecard);
});

test("list_tasks_and_list_agents_page_by_cursor", async () => {
  const client = await connect();
  const taskIds = (page: ListTasksResponse): string[] => page.tasks.map((task) => task.id);
  const accounts = (page: ListAgentsResponse): string[] =>
    page.agents.map((agent) => agent.account);

  // Two to a page: the second page starts where the first ended, and no row is on both.
  const tasks1 = documentOf<ListTasksResponse>(await call(client, "list_tasks", { limit: 2 }));
  expect(taskIds(tasks1)).toEqual(["3", "2"]);
  expect(tasks1.next_cursor).toBe("2");
  const tasks2 = documentOf<ListTasksResponse>(
    await call(client, "list_tasks", { limit: 2, cursor: tasks1.next_cursor }),
  );
  expect(taskIds(tasks2)).toEqual(["1"]);
  expect(tasks2.next_cursor).toBeNull();

  const everyone = accounts(documentOf<ListAgentsResponse>(await call(client, "list_agents")));
  expect(everyone).toHaveLength(3);
  const agents1 = documentOf<ListAgentsResponse>(await call(client, "list_agents", { limit: 2 }));
  expect(accounts(agents1)).toEqual(everyone.slice(0, 2));
  expect(agents1.next_cursor).toBe(everyone[1]);
  const agents2 = documentOf<ListAgentsResponse>(
    await call(client, "list_agents", { limit: 2, cursor: agents1.next_cursor }),
  );
  expect(accounts(agents2)).toEqual(everyone.slice(2));
  expect(agents2.next_cursor).toBeNull();

  // Whatever the size of a page, the pages together are the list, each row once.
  for (const limit of [1, 2, 3]) {
    const taskPages = await pagesOf<ListTasksResponse>(client, "list_tasks", { limit });
    expect(taskPages.flatMap(taskIds), `tasks, ${limit} to a page`).toEqual(["3", "2", "1"]);
    const agentPages = await pagesOf<ListAgentsResponse>(client, "list_agents", { limit });
    expect(agentPages.flatMap(accounts), `agents, ${limit} to a page`).toEqual(everyone);
  }

  // A cursor past the last row is an empty page and not an error.
  expect(documentOf(await call(client, "list_tasks", { cursor: "1" }))).toEqual({
    tasks: [],
    next_cursor: null,
  });
  expect(documentOf(await call(client, "list_agents", { cursor: "zzzz" }))).toEqual({
    agents: [],
    next_cursor: null,
  });
});

test("get_scorecard_returns_the_bytes_its_hash_covers", async () => {
  const app = createApp(deps);
  const client = await connect(app);

  // The chain keeps the SHA-256 of the scorecard's bytes, and the task's page shows it.
  const res = await app.request(`/v1/tasks/${SCORECARD_TASK}`);
  const { task } = (await res.json()) as TaskDetailResponse;
  if (task.outcome?.kind !== "picked") throw new Error(`task ${SCORECARD_TASK} was not picked`);

  const reply = await call(client, "get_scorecard", { task_id: SCORECARD_TASK });
  expect(reply.isError, reply.text).toBe(false);
  expect(sha256Hex(reply.text)).toBe(task.outcome.scorecard_hash);
  // They are the canonical bytes (sorted keys, no whitespace) of a document that holds characters
  // outside ASCII, so the text has been through UTF-8 and back unchanged.
  expect(reply.text).toContain("naïve ✓");
  const parsed: unknown = JSON.parse(reply.text);
  expect(new TextDecoder().decode(canonicalJson(parsed))).toBe(reply.text);
});

test("a_missing_task_agent_or_scorecard_is_a_tool_error", async () => {
  const client = await connect();
  expect(await call(client, "get_task", { task_id: "999" })).toEqual({
    isError: true,
    text: "no such task",
  });
  expect(await call(client, "get_agent", { account: "nobody.test.near" })).toEqual({
    isError: true,
    text: "no such agent",
  });
  // Task 1 is settled but its scorecard blob is not stored, task 2 has no pick, task 999 is none.
  for (const task_id of ["1", "2", "999"]) {
    expect(await call(client, "get_scorecard", { task_id })).toEqual({
      isError: true,
      text: "no scorecard for this task",
    });
  }
  // Nothing in the index is not an error for a list.
  const none = documentOf<ListTasksResponse>(await call(client, "list_tasks", { tag: "nothing" }));
  expect(none).toEqual({ tasks: [], next_cursor: null });
});

test("internal_errors_are_tool_errors_without_details", async () => {
  const client = await connect();
  const query = vi
    .spyOn(deps.db, "query")
    .mockRejectedValue(new Error("relation tasks is broken, password=secret"));
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["list_tasks", {}],
      ["get_task", { task_id: "1" }],
      ["get_scorecard", { task_id: "1" }],
      ["list_agents", {}],
      ["get_agent", { account: alice }],
    ];
    for (const [tool, args] of calls) {
      expect(await call(client, tool, args), tool).toEqual({
        isError: true,
        text: "internal error",
      });
    }
    expect(log).toHaveBeenCalledTimes(calls.length);
  } finally {
    log.mockRestore();
    query.mockRestore();
  }
});

test("concurrent_requests_do_not_share_a_server", async () => {
  // Every client numbers its requests from the same start, so requests in flight together carry
  // the same JSON-RPC id. A server or a transport shared between them would answer one with the
  // result of another, or leave one without an answer.
  const app = createApp(deps);
  const asks: Array<[tool: string, args: Record<string, unknown>]> = [
    ["get_task", { task_id: "1" }],
    ["get_task", { task_id: "2" }],
    ["get_task", { task_id: SCORECARD_TASK }],
    ["get_agent", { account: alice }],
    ["list_tasks", { phase: "open" }],
    ["list_agents", {}],
  ];
  const answers = await Promise.all(
    asks.map(async ([name, args]) => {
      const res = await post(app, rpc("tools/call", { name, arguments: args }));
      expect(res.status, name).toBe(200);
      const body = (await res.json()) as { id: number; result: { content: [{ text: string }] } };
      expect(body.id, name).toBe(1);
      return JSON.parse(body.result.content[0].text) as unknown;
    }),
  );
  const [one, two, three, agent, open, agents] = answers as [
    TaskDetailResponse,
    TaskDetailResponse,
    TaskDetailResponse,
    AgentDetailResponse,
    ListTasksResponse,
    ListAgentsResponse,
  ];
  expect([one.task.id, two.task.id, three.task.id]).toEqual(["1", "2", SCORECARD_TASK]);
  expect(agent.agent.account).toBe(alice);
  expect(open.tasks.map((task) => task.id)).toEqual(["2"]);
  expect(agents.agents).toHaveLength(3);
});

test("mcp_is_stateless_and_answers_post_only", async () => {
  const app = createApp(deps);

  // No session: nothing is kept between requests, so a request needs no `initialize` before it.
  const init = await post(
    app,
    rpc("initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "raw", version: "1.0.0" },
    }),
  );
  expect(init.status).toBe(200);
  expect(init.headers.get("mcp-session-id")).toBeNull();
  // The tools never change, and with no stream there is no way to tell a client that they did.
  expect(await init.json()).toMatchObject({
    result: {
      serverInfo: { name: "tender-remote", version: "1.0.0" },
      capabilities: { tools: { listChanged: false } },
    },
  });

  const listed = await post(app, rpc("tools/list"));
  expect(listed.status).toBe(200);
  expect(listed.headers.get("mcp-session-id")).toBeNull();
  const body = (await listed.json()) as { result: { tools: unknown[] } };
  expect(body.result.tools).toHaveLength(5);

  // A notification is accepted and answered with nothing.
  const initialized = await post(
    app,
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  );
  expect(initialized.status).toBe(202);

  // There is no stream to open and no session to end.
  for (const method of ["GET", "DELETE", "PUT"]) {
    const res = await app.request("/mcp", { method });
    expect(res.status, method).toBe(405);
    expect(res.headers.get("allow"), method).toBe("POST");
  }
});

test("mcp_refuses_a_body_over_64_kib", async () => {
  const app = createApp(deps);
  const callWithPad = (size: number): string => {
    const base = rpc("tools/call", { name: "list_tasks", arguments: { tag: "" } }).length;
    return rpc("tools/call", {
      name: "list_tasks",
      arguments: { tag: "x".repeat(size - base) },
    });
  };
  const atLimit = callWithPad(65_536);
  const overLimit = callWithPad(65_537);
  expect(atLimit.length).toBe(65_536);
  expect(overLimit.length).toBe(65_537);

  // Over the limit is turned away before it is parsed; at the limit it is a request like another,
  // which fails on its tag and not on its size.
  const over = await post(app, overLimit);
  expect(over.status).toBe(413);
  expect(await over.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32600 }, id: null });
  const at = await post(app, atLimit);
  expect(at.status).toBe(200);
  expect(await at.json()).toMatchObject({ result: { isError: true } });

  // The same over a socket, where the size comes in a Content-Length header.
  const { server, url } = await listen(app);
  cleanups.push(() => stop(server));
  for (const [body, status] of [
    [overLimit, 413],
    [atLimit, 200],
  ] as const) {
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body,
    });
    expect(res.status).toBe(status);
    await res.arrayBuffer();
  }
});

test("mcp_refuses_every_batch", async () => {
  const app = createApp(deps);
  const getTask = (id: number) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "get_task", arguments: { task_id: "1" } },
  });
  const cancel = (requestId: number) => ({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId },
  });

  // A request and the cancellation of it in one POST is never answered by the transport, which
  // answers when the server sends an answer, and the server sends none for a cancelled request. A
  // client could hold a connection open for as long as it liked. Batching is no part of the
  // protocol since 2025-06-18 and the SDK's client never sends one, so none is accepted.
  const query = vi.spyOn(deps.db, "query");
  try {
    const batches: Array<[what: string, batch: unknown[]]> = [
      [
        "a request and its cancellation",
        [{ jsonrpc: "2.0", id: 1, method: "tools/list" }, cancel(1)],
      ],
      ["a call and its cancellation", [getTask(1), cancel(1)]],
      ["a batch of one", [getTask(1)]],
      ["two calls", [getTask(1), getTask(2)]],
      ["eleven calls", Array.from({ length: 11 }, (_, i) => getTask(i + 1))],
      ["no message", []],
    ];
    for (const [what, batch] of batches) {
      const res = await within(2_000, post(app, JSON.stringify(batch)), what);
      expect(res.status, what).toBe(400);
      expect(await res.json(), what).toEqual({
        jsonrpc: "2.0",
        error: { code: -32600, message: "a batch is not accepted, send one message" },
        id: null,
      });
    }
    // Refused whole: not even the call that comes before its cancellation is run.
    expect(query).not.toHaveBeenCalled();
  } finally {
    query.mockRestore();
  }

  // The same over a socket, where a connection that is not answered stays open.
  const { server, url } = await listen(app);
  cleanups.push(() => stop(server));
  const overSocket = await within(
    2_000,
    fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify([getTask(1), cancel(1)]),
    }),
    "a call and its cancellation, over a socket",
  );
  expect(overSocket.status).toBe(400);
  await overSocket.arrayBuffer();

  // One message is no batch. A cancellation on its own has nothing to cancel in a server with no
  // session, and is accepted and ignored.
  const listed = await post(app, rpc("tools/list"));
  expect(listed.status).toBe(200);
  const cancelled = await within(2_000, post(app, JSON.stringify(cancel(1))), "a cancellation");
  expect(cancelled.status).toBe(202);
});

test("mcp_gives_up_on_a_request_the_transport_never_answers", async () => {
  // The transport answers a request when the server sends its answer, and the server may never
  // send one. The wait is bounded at 30 s: then the handler says so and closes what it opened.
  const app = createApp(deps);
  let reach: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  vi.spyOn(StreamableHTTPTransport.prototype, "handleRequest").mockImplementation(() => {
    reach();
    return new Promise<Response | undefined>(() => undefined);
  });
  const close = vi.spyOn(McpServer.prototype, "close");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

  let answered = false;
  const pending = post(app, rpc("tools/list")).then((res) => {
    answered = true;
    return res;
  });
  await reached;

  // Not a moment before the bound.
  await vi.advanceTimersByTimeAsync(29_999);
  expect(answered).toBe(false);
  expect(close).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  const res = await pending;
  expect(res.status).toBe(504);
  expect(await res.json()).toEqual({
    jsonrpc: "2.0",
    error: { code: -32001, message: "the request took too long" },
    id: null,
  });
  expect(close).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("mcp_leaves_no_timer_behind_an_answer", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const res = await post(createApp(deps), rpc("tools/list"));
  expect(res.status).toBe(200);
  // The bound on the wait began with the request and ended with its answer.
  expect(vi.getTimerCount()).toBe(0);
});

test("mcp_echoes_nothing_the_caller_sent", async () => {
  const app = createApp(deps);
  const send = async (body: string): Promise<{ status: number; text: string }> => {
    const res = await post(app, body);
    return { status: res.status, text: await res.text() };
  };
  const message = (extra: Record<string, unknown>): string =>
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", ...extra });
  // The same request written with two canaries of different lengths: an answer that does not
  // change with the canary holds no part of it, not its text and not its length.
  const canaries = ["CANARY_a1b2c3", "CANARY_d4e5f6g7h8"] as const;
  const unchanged = async (what: string, body: (canary: string) => string) => {
    const [first, second] = [await send(body(canaries[0])), await send(body(canaries[1]))];
    expect(first, what).toEqual(second);
    expect(first.text, what).not.toContain("CANARY_");
    return first;
  };

  // A tool that does not exist is a tool error of ours, as it is to a client of the SDK.
  const unknown = await unchanged("an unknown tool", (canary) =>
    rpc("tools/call", { name: canary, arguments: { [canary]: canary } }),
  );
  expect(unknown.status).toBe(200);
  expect(JSON.parse(unknown.text)).toEqual({
    jsonrpc: "2.0",
    id: 1,
    result: { isError: true, content: [{ type: "text", text: "no such tool" }] },
  });
  const client = await connect(app);
  expect(await call(client, canaries[0], {})).toEqual({ isError: true, text: "no such tool" });
  // Sent as a notification it has no answer to give, and is accepted like any other.
  const silent = await send(
    JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: canaries[0] } }),
  );
  expect(silent.status).toBe(202);

  // What is no message: the answer is one fixed error. The SDK and the transport would dump their
  // schema and quote the key, the text or the value that they did not like. (V8 quotes the start
  // of a text that is not JSON when its first character is wrong.)
  const refusals: Array<[what: string, body: (canary: string) => string, code: number]> = [
    ["a text that is not JSON", (canary) => `hello ${canary}`, -32700],
    ["no body", () => "", -32700],
    ["an unknown key", (canary) => message({ [canary]: 1 }), -32600],
    ["a version that is not 2.0", (canary) => message({ jsonrpc: canary }), -32600],
    ["a method that is no string", (canary) => message({ method: { [canary]: 1 } }), -32600],
    ["an id that is no string or integer", (canary) => message({ id: { [canary]: 1 } }), -32600],
    ["params that are no object", (canary) => message({ params: canary }), -32600],
    [
      "a response in place of a request",
      (canary) => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { [canary]: 1 } }),
      -32600,
    ],
    ["a body that is a string", (canary) => JSON.stringify(canary), -32600],
  ];
  for (const [what, body, code] of refusals) {
    const refused = await unchanged(what, body);
    expect(refused.status, what).toBe(400);
    // No `data`: the error is a code and a message.
    expect(JSON.parse(refused.text), what).toEqual({
      jsonrpc: "2.0",
      error: { code, message: expect.any(String) },
      id: null,
    });
  }
  for (const body of ["null", "5", "true", "[]"]) {
    const refused = await send(body);
    expect(refused.status, body).toBe(400);
    expect(JSON.parse(refused.text), body).toMatchObject({ error: { code: -32600 }, id: null });
  }

  // What the SDK answers by itself has none of it either: a method it does not know, and the keys
  // it does not know in the params and in the arguments of a call, which it drops.
  const method = await unchanged("an unknown method", (canary) => message({ method: canary }));
  expect(JSON.parse(method.text)).toEqual({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32601, message: "Method not found" },
  });
  const params = await unchanged("an unknown key in the params", (canary) =>
    rpc("tools/call", { name: "get_task", arguments: { task_id: "1" }, [canary]: 1 }),
  );
  const args = await unchanged("an unknown key in the arguments", (canary) =>
    rpc("tools/call", { name: "get_task", arguments: { task_id: "1", [canary]: 1 } }),
  );
  for (const answer of [params, args]) {
    expect(JSON.parse(answer.text).result.isError ?? false).toBe(false);
  }
});

test("every_listed_tool_is_known_to_the_handler", async () => {
  // The handler answers a call to a name that is not one of the server's tools itself, from a
  // list of the names, so the list has to hold every tool that `tools/list` shows.
  const client = await connect();
  const { tools } = await client.listTools();
  expect(tools.length).toBeGreaterThan(0);
  for (const { name } of tools) {
    expect((await call(client, name, {})).text, name).not.toBe("no such tool");
  }
});

test("mcp_is_outside_the_cors_block", async () => {
  const app = createApp(deps);
  const origin = "https://app.example";

  // The sandbox lets every origin call /v1; /mcp is for MCP clients, which are not browsers.
  const health = await app.request("/v1/health", { headers: { origin } });
  expect(health.headers.get("access-control-allow-origin")).toBe("*");

  const answer = await post(app, rpc("tools/list"), { origin });
  expect(answer.status).toBe(200);
  expect(answer.headers.get("access-control-allow-origin")).toBeNull();

  const preflight = await app.request("/mcp", {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": "POST" },
  });
  expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
});
