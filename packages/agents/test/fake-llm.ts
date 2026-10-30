import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for an OpenAI-compatible model server (NEAR AI Cloud is one): `POST /v1/chat/completions`
// on a port the system picks, on the loopback address. It records every request it gets, and answers
// each from a script, so a test says what the "model" says and then reads what the solver sent. No
// test of the agents calls a real model: the owner's key is not for tests, and spends credits.

/** One request as the fake received it. */
export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  /** The JSON body, as parsed; undefined when it was no JSON object. */
  body: Record<string, unknown> | undefined;
}

/**
 * What the fake answers with:
 *
 * - a string: a completion whose message is that text and which finished with `stop`;
 * - `{ content, finishReason }`: the same, with the message (null for none) and the reason the
 *   model stopped, such as `length` (null to leave it out, as some servers do);
 * - `{ status, body }`: an HTTP failure, with an error body;
 * - `{ raw }`: a 200 whose JSON is `raw`, for an answer that is no chat completion;
 * - `"hang"`: no answer at all, the connection left open;
 * - `"stall"`: the status line, the headers and the start of a body, and then nothing, the
 *   connection left open: a server that fell silent in the middle of its answer.
 */
export type FakeReply =
  | string
  | { content: string | null; finishReason?: string | null }
  | { status: number; body?: unknown }
  | { raw: unknown }
  | "hang"
  | "stall";

export interface FakeLlm {
  /** What to give the solver as its base URL: `http://127.0.0.1:<port>/v1`. */
  baseUrl: string;
  /** Every request, in the order they arrived. */
  requests: RecordedRequest[];
  /**
   * Resolves once `count` requests whose answer the fake never finished have been dropped by their
   * client, and rejects after 5 seconds if they have not been: a cancelled call closes its connection.
   */
  dropped(count?: number): Promise<void>;
  stop(): Promise<void>;
}

/** Reads the whole body of a request. */
function bodyOf(request: AsyncIterable<Buffer>): Promise<string> {
  return (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  })();
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function completion(model: unknown, content: string | null, finishReason: string | null) {
  return {
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: 1_700_000_000,
    model: typeof model === "string" ? model : "unknown",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

/**
 * Starts the fake. `script` is the list of replies, one for each request in turn; once it runs out
 * the last one is given again, so a one-reply script answers every request alike.
 */
export async function startFakeLlm(script: FakeReply | FakeReply[]): Promise<FakeLlm> {
  const replies = Array.isArray(script) ? script : [script];
  const requests: RecordedRequest[] = [];
  let droppedCount = 0;
  const waiting: Array<{ count: number; resolve: () => void }> = [];

  const server: Server = createServer((request, response) => {
    void (async () => {
      const text = await bodyOf(request);
      const recorded: RecordedRequest = {
        method: request.method ?? "",
        path: request.url ?? "",
        headers: request.headers,
        body: parseObject(text),
      };
      requests.push(recorded);

      // A client that gives up closes the connection before the response is complete.
      response.on("close", () => {
        if (response.writableFinished) return;
        droppedCount += 1;
        for (const wait of waiting) if (droppedCount >= wait.count) wait.resolve();
      });

      if (recorded.method !== "POST" || recorded.path !== "/v1/chat/completions") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "no such route", type: "not_found" } }));
        return;
      }

      const reply = replies[Math.min(requests.length, replies.length) - 1] ?? "";
      if (reply === "hang") return;
      if (reply === "stall") {
        // No content-length, so the body is open-ended: the client has a 200 and waits for the rest.
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"id":"chatcmpl-fake","object":"chat.completion","choices":[');
        return;
      }
      let status = 200;
      let payload: unknown;
      if (typeof reply === "string") payload = completion(recorded.body?.model, reply, "stop");
      else if ("status" in reply) {
        status = reply.status;
        payload = reply.body ?? { error: { message: "failed", type: "server_error" } };
      } else if ("raw" in reply) payload = reply.raw;
      else {
        const reason = "finishReason" in reply ? reply.finishReason : "stop";
        payload = completion(recorded.body?.model, reply.content, reason ?? null);
      }
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    dropped(count = 1) {
      if (droppedCount >= count) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`${count} unanswered request(s) were not dropped within 5 s`));
        }, 5_000);
        waiting.push({
          count,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });
    },
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
