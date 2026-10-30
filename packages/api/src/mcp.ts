import { StreamableHTTPTransport } from "@hono/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AccountIdSchema,
  BriefSchema,
  canonicalJson,
  PhaseSchema,
  U64StringSchema,
} from "@tender/shared";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { type ApiDeps, nowNs } from "./deps";
import { DEFAULT_LIMIT, MAX_LIMIT } from "./format";
import { getAgentDetail, getScorecard, getTaskDetail, listAgents, listTasks } from "./queries";

// The remote MCP server: the read routes of the API as five tools, for the agents that browse the
// board before they enter a task. It only reads, and it holds no key. Each tool answers with the
// document that the matching REST route sends, built by the same function in `queries.ts` and
// written as JSON text, so a u64 or a u128 stays a string (R19). The scorecard is written as
// `canonicalJson` text instead: those are the bytes that the `scorecard_hash` on chain is the
// SHA-256 of, so a client can check what it was given. The two lists page as the REST routes do,
// the `next_cursor` of one page being the `cursor` of the next.
//
// The server is stateless: there is no session and nothing outlives a request, so any instance of
// the API can answer any request and a client needs no `initialize` before its calls. Each request
// gets a server and a transport of its own. The transport of @hono/mcp hands an answer to the
// request that has the JSON-RPC id of the answer, and clients all number their requests from the
// same start, so on a transport shared by two requests in flight both would carry the same id and
// either could be answered with the result of the other. (The SDK's own stateless transport
// refuses a second request outright, which this one does not.) The answer is one JSON document and
// never a stream, so a GET has nothing to open and a DELETE nothing to end.
//
// The SDK checks the arguments of a call against the input schemas before a tool runs, and answers
// a call that does not fit with a tool error. That check keeps a bad id from reaching the database,
// where the error would quote it. The SDK also sends the message of whatever a tool throws to the
// caller, which is why `answer` catches first.
//
// The body is read before the transport sees it, and the transport is handed what was read. The SDK
// and the transport answer what they reject with a message that quotes it (the name of a tool they
// do not know, the key they did not expect, the text they could not parse), so the envelope of a
// message and the name of a tool are checked here, and the answer is a message of ours. A batch is
// refused: the transport answers when the server sends its answer, and the server sends none for a
// request that a `notifications/cancelled` of the same batch cancelled, so a batch could hold a
// connection open for as long as its sender liked. Batching left the protocol in 2025-06-18 and the
// SDK's client sends none. The wait for an answer ends at a bound too, so a request that goes
// unanswered for any other reason cannot hold a connection either.

/**
 * Where the server answers. It is no `/v1` route, so the CORS block of `/v1` does not cover it: MCP
 * clients are not browsers.
 */
const MCP_PATH = "/mcp";

/** The most a request may carry. A call is a few hundred bytes, so this is generous. */
const MAX_BODY_BYTES = 65_536;

/** How long a request waits for its answer, in milliseconds. A query takes a few. */
const REQUEST_TIMEOUT_MS = 30_000;

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
// Tasks are paged by id and agents by account, as the REST routes page them.
const CURSOR_HELP =
  "Where to continue: the next_cursor of the previous page. Leave it out for the first page.";
const TaskCursorInput = U64StringSchema.describe(CURSOR_HELP).optional();
const AgentCursorInput = AccountIdSchema.describe(CURSOR_HELP).optional();

// ---- Answers ----------------------------------------------------------------------------------

function toolText(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/** The text of the `canonicalJson` bytes of `document`, which its hash on chain is the hash of. */
function canonicalText(document: object): string {
  return new TextDecoder().decode(canonicalJson(document));
}

/** A failed call. `message` must quote nothing the caller sent. */
function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * The answer of the tool `tool`: the document `read` returns, written by `write` (default: as JSON
 * text), or the tool error `absent` when it returns null. A failure of `read` or `write` is logged
 * and answered with a bare "internal error": the message of a database error can quote a value or
 * name a host, as in `app.onError`.
 */
async function answer<T extends object>(
  tool: string,
  read: () => Promise<T | null>,
  absent = "not found",
  write: (document: T) => string = (document) => JSON.stringify(document),
): Promise<CallToolResult> {
  try {
    const document = await read();
    return document === null ? toolError(absent) : toolText(write(document));
  } catch (error) {
    console.error(`api: mcp: ${tool} failed:`, error);
    return toolError("internal error");
  }
}

// ---- Messages ---------------------------------------------------------------------------------

/**
 * The envelope of a JSON-RPC request or of a notification, and nothing more. The SDK checks it too,
 * but answers a bad one with a dump of its schema that quotes what it was sent. A response is no
 * message this server takes, since it sends no request that one could answer.
 */
const Envelope = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.int()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

/** The tools `createServer` registers. A call to any other name is answered without the SDK. */
const TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_tasks",
  "get_task",
  "get_scorecard",
  "list_agents",
  "get_agent",
]);

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
      inputSchema: {
        phase: PhaseInput,
        tag: TaskTagInput,
        limit: LimitInput,
        cursor: TaskCursorInput,
      },
      annotations: READ_ONLY,
    },
    ({ phase, tag, limit, cursor }) =>
      answer("list_tasks", () =>
        listTasks(deps.db, { phase, tag, limit, cursor }, nowNs(deps), deps.teamAccounts),
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
        "Get a task's public scorecard as the canonical JSON that its scorecard_hash covers.",
      inputSchema: { task_id: TaskIdInput },
      annotations: READ_ONLY,
    },
    ({ task_id }) =>
      answer(
        "get_scorecard",
        () => getScorecard(deps.db, task_id),
        "no scorecard for this task",
        canonicalText,
      ),
  );

  server.registerTool(
    "list_agents",
    {
      description:
        "List registered agents with their entry and win counts, optionally only those with one tag.",
      inputSchema: { tag: AgentTagInput, limit: LimitInput, cursor: AgentCursorInput },
      annotations: READ_ONLY,
    },
    ({ tag, limit, cursor }) =>
      answer("list_agents", () => listAgents(deps.db, { tag, limit, cursor })),
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

  // The SDK says `listChanged: true` of any server that has tools. These never change, and a
  // server with no stream could not tell a client if they did.
  server.server.registerCapabilities({ tools: { listChanged: false } });

  return server;
}

/** A JSON-RPC error that answers no request, in the shape the transport writes its own. */
function rpcError(code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

/**
 * Mounts the server at `/mcp`. A POST carries one JSON-RPC message of at most `MAX_BODY_BYTES`, and
 * is answered within `REQUEST_TIMEOUT_MS`; any other method is a 405, since a stateless server has
 * no stream to open and no session to end.
 */
export function mountMcp(app: Hono, deps: ApiDeps): void {
  app.post(
    MCP_PATH,
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json(rpcError(-32600, "request body too large"), 413),
    }),
    async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      if (body === undefined) return c.json(rpcError(-32700, "the body is not JSON"), 400);
      if (Array.isArray(body)) {
        return c.json(rpcError(-32600, "a batch is not accepted, send one message"), 400);
      }
      const message = Envelope.safeParse(body);
      if (!message.success) {
        return c.json(rpcError(-32600, "not a JSON-RPC request or notification"), 400);
      }
      const { id, method, params } = message.data;
      const tool = params?.name;
      const callsUnknownTool =
        method === "tools/call" && typeof tool === "string" && !TOOL_NAMES.has(tool);
      // A call with no id is a notification, which has no answer to give.
      if (callsUnknownTool && id !== undefined) {
        return c.json({ jsonrpc: "2.0", id, result: toolError("no such tool") });
      }

      const server = createServer(deps);
      // No `sessionIdGenerator` makes the transport stateless, and `enableJsonResponse` makes it
      // answer with a JSON document in place of an event stream.
      const transport = new StreamableHTTPTransport({ enableJsonResponse: true });
      await server.connect(transport);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // The transport answers when the server sends its answer, and a server may never send one.
        const timeout = new Promise<null>((resolve) => {
          timer = setTimeout(resolve, REQUEST_TIMEOUT_MS, null);
        });
        const response = await Promise.race([transport.handleRequest(c, body), timeout]);
        if (response === null) return c.json(rpcError(-32001, "the request took too long"), 504);
        if (response === undefined) throw new Error("the transport made no response");
        return response;
      } finally {
        clearTimeout(timer);
        await server.close();
      }
    },
  );

  app.all(MCP_PATH, (c) =>
    c.json(rpcError(-32000, "method not allowed, POST a JSON-RPC message"), 405, { Allow: "POST" }),
  );
}
