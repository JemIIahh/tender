import { StreamableHTTPTransport } from "@hono/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AccountIdSchema, BriefSchema, PhaseSchema, U64StringSchema } from "@tender/shared";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { type ApiDeps, nowNs } from "./deps";
import { DEFAULT_LIMIT, MAX_LIMIT } from "./format";
import { getAgentDetail, getScorecard, getTaskDetail, listAgents, listTasks } from "./queries";

// The remote MCP server: the read routes of the API as five tools, for the agents that browse the
// board before they enter a task. It only reads, and it holds no key. Each tool answers with the
// document that the matching REST route sends, built by the same function in `queries.ts` and
// written as JSON text, so a u64 or a u128 stays a string (R19).
//
// The server is stateless: there is no session and nothing outlives a request, so any instance of
// the API can answer any request and a client needs no `initialize` before its calls. Each request
// gets a server and a transport of its own, because a stateless transport cannot be shared. Clients
// all number their requests from the same start, so two requests in flight carry the same JSON-RPC
// id, and the SDK's own transport refuses a second request ("Stateless transport cannot be reused
// across requests"). The answer is one JSON document and never a stream, so a GET has nothing to
// open and a DELETE nothing to end.
//
// The SDK checks the arguments of a call against the input schemas before a tool runs, and answers
// a call that does not fit with a tool error. That check keeps a bad id from reaching the database,
// where the error would quote it. The SDK also sends the message of whatever a tool throws to the
// caller, which is why `answer` catches first.

/**
 * Where the server answers. It is no `/v1` route, so the CORS block of `/v1` does not cover it: MCP
 * clients are not browsers.
 */
const MCP_PATH = "/mcp";

/** The most a request may carry. A call is a few hundred bytes, so this is generous. */
const MAX_BODY_BYTES = 65_536;

// ---- Inputs -----------------------------------------------------------------------------------

// Each field is the rule the REST routes apply to the same value, as a schema: a client reads it
// in the tool's input schema and the SDK enforces it. The messages of these schemas quote nothing,
// because the message of a rejected call goes back to the caller as it is.

const TaskIdInput = U64StringSchema.describe(
  'The id of a task: a whole number written as text, such as "12".',
);
const AccountInput = AccountIdSchema.describe('A NEAR account id, such as "alice.near".');
const PhaseInput = PhaseSchema.describe(
  'Only tasks in this phase. "open" tasks are still taking entries.',
).optional();
// A tag as a brief or a profile writes one: 1 to 24 characters from `a-z`, `0-9` and `-`.
const TagInput = BriefSchema.shape.tags.element;
const TaskTagInput = TagInput.describe(
  'Only tasks whose brief has this tag, such as "coding".',
).optional();
const AgentTagInput = TagInput.describe(
  'Only agents whose profile has this tag, such as "coding".',
).optional();
const LimitInput = z
  .int()
  .min(1)
  .max(MAX_LIMIT)
  .default(DEFAULT_LIMIT)
  .describe(`How many to return, from 1 to ${MAX_LIMIT}.`);

// ---- Answers ----------------------------------------------------------------------------------

function toolJson(document: object): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(document) }] };
}

/** A failed call. `message` must quote nothing the caller sent. */
function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * The answer of the tool `tool`: the document `read` returns, as JSON text, or the tool error
 * `absent` when it returns null. A failure of `read` is logged and answered with a bare "internal
 * error": the message of a database error can quote a value or name a host, as in `app.onError`.
 */
async function answer(
  tool: string,
  read: () => Promise<object | null>,
  absent = "not found",
): Promise<CallToolResult> {
  try {
    const document = await read();
    return document === null ? toolError(absent) : toolJson(document);
  } catch (error) {
    console.error(`api: mcp: ${tool} failed:`, error);
    return toolError("internal error");
  }
}

// ---- Server -----------------------------------------------------------------------------------

/** What every tool says of itself: it only reads. */
const READ_ONLY = { readOnlyHint: true };

/** The server of one request. It reads the database of `deps` and nothing else. */
function createServer(deps: ApiDeps): McpServer {
  const server = new McpServer({ name: "tender-remote", version: "1.0.0" });

  server.registerTool(
    "list_tasks",
    {
      description: "List tasks, newest first, optionally only those in one phase or with one tag.",
      inputSchema: { phase: PhaseInput, tag: TaskTagInput, limit: LimitInput },
      annotations: READ_ONLY,
    },
    ({ phase, tag, limit }) =>
      answer("list_tasks", () =>
        listTasks(deps.db, { phase, tag, limit }, nowNs(deps), deps.teamAccounts),
      ),
  );

  server.registerTool(
    "get_task",
    {
      description:
        "Get one task with its brief, criteria, entries, funders, child tasks and scorecard.",
      inputSchema: { task_id: TaskIdInput },
      annotations: READ_ONLY,
    },
    ({ task_id }) =>
      answer(
        "get_task",
        () => getTaskDetail(deps.db, task_id, nowNs(deps), deps.teamAccounts),
        "no such task",
      ),
  );

  server.registerTool(
    "get_scorecard",
    {
      description:
        "Get the public scorecard a task was settled with: each entry's score and the winners.",
      inputSchema: { task_id: TaskIdInput },
      annotations: READ_ONLY,
    },
    ({ task_id }) =>
      answer("get_scorecard", () => getScorecard(deps.db, task_id), "no scorecard for this task"),
  );

  server.registerTool(
    "list_agents",
    {
      description:
        "List registered agents with their entry and win counts, optionally only those with one tag.",
      inputSchema: { tag: AgentTagInput },
      annotations: READ_ONLY,
    },
    ({ tag }) => answer("list_agents", () => listAgents(deps.db, { tag, limit: DEFAULT_LIMIT })),
  );

  server.registerTool(
    "get_agent",
    {
      description: "Get one registered agent by its NEAR account id, with its latest entries.",
      inputSchema: { account: AccountInput },
      annotations: READ_ONLY,
    },
    ({ account }) =>
      answer("get_agent", () => getAgentDetail(deps.db, account, nowNs(deps)), "no such agent"),
  );

  return server;
}

/** A JSON-RPC error that answers no request, in the shape the transport writes its own. */
function rpcError(code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

/**
 * Mounts the server at `/mcp`. A POST carries a JSON-RPC message of at most `MAX_BODY_BYTES`; any
 * other method is a 405, since a stateless server has no stream to open and no session to end.
 */
export function mountMcp(app: Hono, deps: ApiDeps): void {
  app.post(
    MCP_PATH,
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json(rpcError(-32600, "request body too large"), 413),
    }),
    async (c) => {
      const server = createServer(deps);
      // No `sessionIdGenerator` makes the transport stateless, and `enableJsonResponse` makes it
      // answer with a JSON document in place of an event stream.
      const transport = new StreamableHTTPTransport({ enableJsonResponse: true });
      await server.connect(transport);
      try {
        const response = await transport.handleRequest(c);
        if (response === undefined) throw new Error("the transport made no response");
        return response;
      } finally {
        await server.close();
      }
    },
  );

  app.all(MCP_PATH, (c) =>
    c.json(rpcError(-32000, "method not allowed, POST a JSON-RPC message"), 405, { Allow: "POST" }),
  );
}
