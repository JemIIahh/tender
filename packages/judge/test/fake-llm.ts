import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";

// A fake OpenAI-compatible server for the `rubric` kind's tests, and for anything else that needs a
// model to answer: it listens on 127.0.0.1 on a port the system chooses, records every request it
// gets, and answers each as a handler says. The real `openai` client talks to it, so the requests
// and replies are the real wire format. No test reaches a real model.
//
// It serves `POST /v1/chat/completions` for any path under the base URL it is given, and does not
// check the key.

/** The body of a chat completion request, as far as the Judge's tests read it. */
export interface ChatBody {
  model?: string;
  messages?: { role: string; content: string }[];
  temperature?: number;
  stream?: boolean;
  response_format?: { type: string };
  max_tokens?: number;
}

/** A request the fake received. */
export interface LlmRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  /** The JSON body; empty when the request had none. */
  body: ChatBody;
  /** The content of the request's user message, or an empty string. */
  user: string;
}

/**
 * What the fake answers a request with:
 *
 * - `{ json }`: status 200 (or `status`) and that JSON;
 * - `{ text }`: that text as the body, which a client cannot parse as JSON;
 * - `"stall"`: nothing, ever: the request hangs until the fake closes.
 *
 * `headers` are added to the answer, such as `retry-after-ms: 1` to make a client's retry quick.
 */
export type LlmReply =
  | { status?: number; headers?: Record<string, string>; json?: unknown; text?: string }
  | "stall";

/** Answers a request. `nth` counts the requests so far, this one included, from 1. */
export type LlmHandler = (request: LlmRequest, nth: number) => LlmReply | Promise<LlmReply>;

export interface FakeLlm {
  /** `http://127.0.0.1:{port}/v1`: the base URL to give the client. */
  baseUrl: string;
  /** Every request received, in order. */
  requests: LlmRequest[];
  /** Answers the requests from now on with `handler`. */
  handle(handler: LlmHandler): void;
  /** Stops listening, ends every connection and waits for them to end. It can be called twice. */
  close(): Promise<void>;
}

/**
 * Starts a fake model server that answers with `handler`, and stops it when the test ends. With
 * no handler it answers every request 404.
 */
export async function startFakeLlm(
  handler: LlmHandler = () => ({ status: 404 }),
): Promise<FakeLlm> {
  let current = handler;
  const requests: LlmRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    // A client that gives up closes the socket; there is nobody to tell.
    res.on("error", () => undefined);
    req.on("end", () => {
      void (async () => {
        let body: ChatBody = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatBody;
        } catch {
          // Not JSON: the body stays empty.
        }
        const request: LlmRequest = {
          method: req.method ?? "",
          path: new URL(req.url ?? "/", "http://fake").pathname,
          headers: req.headers,
          body,
          user: body.messages?.find((message) => message.role === "user")?.content ?? "",
        };
        requests.push(request);
        const reply = await current(request, requests.length);
        if (reply === "stall") return;
        const headers = { "content-type": "application/json", ...reply.headers };
        if (reply.text !== undefined) headers["content-type"] = "text/plain";
        res.writeHead(reply.status ?? 200, headers);
        res.end(reply.text ?? JSON.stringify(reply.json ?? {}));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  let closed: Promise<void> | undefined;
  const close = () => {
    closed ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Without this, a request that stalls, or a connection the client keeps alive, would keep the
      // server from ever closing.
      server.closeAllConnections();
    });
    return closed;
  };
  onTestFinished(close);
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    handle(next) {
      current = next;
    },
    close,
  };
}

/** A chat completion whose one choice says `content`, as an OpenAI-compatible server sends it. */
export function completion(content: string, finishReason = "stop"): unknown {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

/** The criteria of the rubric a request asks about: the lines of its user message that are JSON. */
export function criteriaOf(request: LlmRequest): { criterion: string; weight: number }[] {
  return request.user
    .split("\n")
    .filter((line) => line.startsWith('{"criterion":'))
    .map((line) => JSON.parse(line) as { criterion: string; weight: number });
}

/** The entry a request asks about: the text between its entry tags. */
export function entryOf(request: LlmRequest): string {
  const start = request.user.indexOf("<entry>\n") + "<entry>\n".length;
  return request.user.slice(start, request.user.lastIndexOf("\n</entry>"));
}

/**
 * The JSON text of a grader's reply to `request`: each criterion of its rubric scored by `scoreOf`
 * (one number for all, or a function of the criterion and the entry), each with a reason that
 * names its criterion and score.
 */
export function gradeJson(
  request: LlmRequest,
  scoreOf: number | ((criterion: string, entry: string) => number),
  addressesGrader = false,
): string {
  const entry = entryOf(request);
  const scores = criteriaOf(request).map(({ criterion }) => {
    const score = typeof scoreOf === "number" ? scoreOf : scoreOf(criterion, entry);
    return { criterion, score, reason: `${criterion} earned ${score}` };
  });
  return JSON.stringify({ scores, addresses_grader: addressesGrader });
}

/** A reply that grades `request` as `gradeJson` does. */
export function graded(
  request: LlmRequest,
  scoreOf: number | ((criterion: string, entry: string) => number),
  addressesGrader = false,
): LlmReply {
  return { json: completion(gradeJson(request, scoreOf, addressesGrader)) };
}
