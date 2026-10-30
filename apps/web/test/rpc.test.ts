import { afterEach, expect, test, vi } from "vitest";
import { RpcError, view } from "../lib/rpc";
import { rejection } from "./support";

// `view` over a fake `fetch`. vitest.config.ts gives the config an RPC URL of http://rpc.test.

const RPC_URL = "http://rpc.test";

interface Sent {
  url: unknown;
  init: RequestInit | undefined;
  body: {
    jsonrpc: string;
    id: string;
    method: string;
    params: Record<string, unknown>;
  };
}

/** Answers the next call with `answer`, and notes what was asked. */
function fakeRpc(answer: Response | Error): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
    sent.push({ url, init, body: JSON.parse(String(init?.body)) });
    if (answer instanceof Error) throw answer;
    return answer.clone();
  });
  return sent;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** What the node sends for a call that ran: the bytes the contract returned. */
const returned = (value: string) => ({
  jsonrpc: "2.0",
  id: "tender-web",
  result: { result: [...new TextEncoder().encode(value)], logs: [], block_height: 9 },
});

const fromBase64 = (text: string) => atob(text);

afterEach(() => {
  vi.unstubAllGlobals();
});

test("view_posts_call_function_at_final_finality", async () => {
  const sent = fakeRpc(json(returned('{"ok":true}')));

  await view("tender.testnet", "get_task", { task_id: "7" });

  expect(sent).toHaveLength(1);
  const [call] = sent;
  expect(call?.url).toBe(RPC_URL);
  expect(call?.init?.method).toBe("POST");
  expect(new Headers(call?.init?.headers).get("content-type")).toBe("application/json");
  expect(call?.body).toMatchObject({
    jsonrpc: "2.0",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
      account_id: "tender.testnet",
      method_name: "get_task",
    },
  });
  expect(fromBase64(String(call?.body.params.args_base64))).toBe('{"task_id":"7"}');
});

test("view_sends_an_empty_object_when_it_has_no_args", async () => {
  const sent = fakeRpc(json(returned("1")));

  await view("tender.testnet", "task_count");

  expect(sent[0]?.body.params.args_base64).toBe(btoa("{}"));
});

test("view_encodes_args_as_utf8", async () => {
  const sent = fakeRpc(json(returned("null")));

  await view("tender.testnet", "get_agent", { account_id: "é→日本" });

  const bytes = Uint8Array.from(fromBase64(String(sent[0]?.body.params.args_base64)), (c) =>
    c.charCodeAt(0),
  );
  expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({ account_id: "é→日本" });
});

test("view_decodes_the_result_bytes_as_json", async () => {
  fakeRpc(json(returned('{"total":"1000000","available":"250000"}')));
  expect(await view("tender.testnet", "storage_balance_of", { account_id: "a.near" })).toEqual({
    total: "1000000",
    available: "250000",
  });

  fakeRpc(json(returned("null")));
  expect(await view("tender.testnet", "get_task", { task_id: "99" })).toBeNull();

  fakeRpc(json(returned('"123456789012345678901234567890"')));
  expect(await view("tender.testnet", "balance_of", { account_id: "a.near" })).toBe(
    "123456789012345678901234567890",
  );

  // Text outside ASCII comes back as the text, not as its bytes.
  fakeRpc(json(returned('{"name":"Zoë 日本"}')));
  expect(await view("tender.testnet", "get_agent", {})).toEqual({ name: "Zoë 日本" });
});

test("view_gives_undefined_for_a_call_that_returns_nothing", async () => {
  fakeRpc(json(returned("")));
  expect(await view("tender.testnet", "ping")).toBeUndefined();
});

test("view_throws_when_the_contract_call_fails", async () => {
  fakeRpc(
    json({
      jsonrpc: "2.0",
      id: "tender-web",
      result: {
        error: "wasm execution failed with error: FunctionCallError(HostError(GuestPanic",
        logs: [],
      },
    }),
  );

  const error = await rejection(view("tender.testnet", "get_task", { task_id: "x" }));
  expect(error).toBeInstanceOf(RpcError);
  expect(error.message).toContain("GuestPanic");
});

test("view_throws_when_the_node_answers_with_an_error", async () => {
  fakeRpc(
    json({
      jsonrpc: "2.0",
      id: "tender-web",
      error: {
        name: "HANDLER_ERROR",
        cause: { name: "UNKNOWN_BLOCK", info: {} },
        code: -32000,
        message: "Server error",
        data: "DB Not Found Error: BLOCK HEIGHT: 12",
      },
    }),
  );

  const error = await rejection(view("tender.testnet", "get_config"));
  expect(error).toBeInstanceOf(RpcError);
  expect(error.message).toContain("UNKNOWN_BLOCK");
  expect(error.message).toContain("DB Not Found Error");
});

test("view_throws_on_a_failed_http_request", async () => {
  fakeRpc(new Response("Too Many Requests", { status: 429 }));

  const error = await rejection(view("tender.testnet", "get_config"));
  expect(error).toBeInstanceOf(RpcError);
  expect(error.message).toContain("429");
});

test("view_throws_on_an_answer_it_cannot_read", async () => {
  // Not JSON.
  fakeRpc(new Response("<html>bad gateway</html>", { status: 200 }));
  await expect(view("tender.testnet", "get_config")).rejects.toBeInstanceOf(RpcError);

  // JSON, but not a call_function answer.
  fakeRpc(json({ jsonrpc: "2.0", id: "tender-web", result: { block_height: 1 } }));
  await expect(view("tender.testnet", "get_config")).rejects.toBeInstanceOf(RpcError);

  // Bytes that are not JSON text.
  fakeRpc(json(returned("not json")));
  await expect(view("tender.testnet", "get_config")).rejects.toBeInstanceOf(RpcError);
});

test("view_lets_a_failed_fetch_through_as_it_came", async () => {
  const offline = new TypeError("Failed to fetch");
  fakeRpc(offline);

  await expect(view("tender.testnet", "get_config")).rejects.toBe(offline);
});

test("view_gives_up_when_the_node_does_not_answer", async () => {
  vi.stubGlobal("fetch", (_url: unknown, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  });
  vi.useFakeTimers();
  try {
    const pending = rejection(view("tender.testnet", "get_config"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await pending).name).toBe("TimeoutError");
  } finally {
    vi.useRealTimers();
  }
});
