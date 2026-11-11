import { afterEach, expect, test, vi } from "vitest";
import { accessKeysOf, accountExists, accountKeyState, RpcError } from "../lib/rpc";
import { rejection } from "./support";

// `accountExists`, `accountKeyState` and `accessKeysOf` over a fake node: what a node answers for an
// account and a key that are there, and for ones that are not, in the words of a current node and an
// older one.

interface Query {
  request_type: string;
  account_id: string;
  public_key?: string;
  finality: string;
}

const KEY = `ed25519:${"1".repeat(44)}`;

afterEach(() => {
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A node that answers each query with `answer`, and notes the queries. */
function fakeNode(answer: (query: Query) => Response): Query[] {
  const queries: Query[] = [];
  vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
    expect(String(url)).toBe("http://rpc.test");
    const body = JSON.parse(String(init?.body));
    expect(body.method).toBe("query");
    queries.push(body.params);
    return answer(body.params);
  });
  return queries;
}

const unknown = (name: string, data: string) =>
  json({
    jsonrpc: "2.0",
    id: "tender-web",
    error: {
      name: "HANDLER_ERROR",
      cause: { name, info: {} },
      code: -32000,
      message: "Server error",
      data,
    },
  });

const account = () =>
  json({ jsonrpc: "2.0", id: "tender-web", result: { amount: "1", storage_usage: 182 } });

test("an_account_that_exists_is_one_and_a_missing_one_is_not", async () => {
  const queries = fakeNode((query) =>
    query.account_id === "alice.testnet"
      ? account()
      : unknown("UNKNOWN_ACCOUNT", `account ${query.account_id} does not exist while viewing`),
  );
  expect(await accountExists("alice.testnet")).toBe(true);
  expect(await accountExists("nobody.alice.testnet")).toBe(false);
  expect(queries).toEqual([
    { request_type: "view_account", account_id: "alice.testnet", finality: "final" },
    { request_type: "view_account", account_id: "nobody.alice.testnet", finality: "final" },
  ]);
});

test("an_older_node_that_says_does_not_exist_in_words_is_read_the_same", async () => {
  fakeNode(() =>
    json({
      jsonrpc: "2.0",
      id: "x",
      error: {
        code: -32000,
        message: "Server error",
        data: "account x does not exist while viewing",
      },
    }),
  );
  expect(await accountExists("x.testnet")).toBe(false);
  fakeNode(() =>
    json({
      jsonrpc: "2.0",
      id: "x",
      result: { error: "account x does not exist while viewing", logs: [] },
    }),
  );
  expect(await accountExists("x.testnet")).toBe(false);
});

test("any_other_answer_of_the_node_is_an_error_and_not_a_missing_account", async () => {
  fakeNode(() =>
    json({
      jsonrpc: "2.0",
      id: "x",
      error: { name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR" } },
    }),
  );
  const timeout = await rejection(accountExists("alice.testnet"));
  expect(timeout).toBeInstanceOf(RpcError);
  expect(timeout.message).toContain("TIMEOUT_ERROR");

  fakeNode(() => new Response("bad gateway", { status: 502 }));
  expect((await rejection(accountExists("alice.testnet"))).message).toBe(
    "the RPC node answered with status 502",
  );

  fakeNode(() => json({ jsonrpc: "2.0", id: "x" }));
  expect(await rejection(accountExists("alice.testnet"))).toBeInstanceOf(RpcError);
});

test("the_key_state_tells_a_missing_account_from_one_without_the_key_and_one_with_it", async () => {
  const chain = new Map<string, { key: string; permission: unknown }[]>([
    ["scout.alice.testnet", [{ key: KEY, permission: "FullAccess" }]],
    ["other.alice.testnet", [{ key: "ed25519:other", permission: "FullAccess" }]],
    [
      "limited.alice.testnet",
      [{ key: KEY, permission: { FunctionCall: { receiver_id: "x", method_names: [] } } }],
    ],
  ]);
  const queries = fakeNode((query) => {
    const keys = chain.get(query.account_id);
    if (keys === undefined) return unknown("UNKNOWN_ACCOUNT", "does not exist while viewing");
    if (query.request_type === "view_account") return account();
    const found = keys.find(({ key }) => key === query.public_key);
    return found === undefined
      ? unknown("UNKNOWN_ACCESS_KEY", `access key ${query.public_key} does not exist while viewing`)
      : json({ jsonrpc: "2.0", id: "x", result: { nonce: 0, permission: found.permission } });
  });

  expect(await accountKeyState("free.alice.testnet", KEY)).toBe("missing");
  // A missing account is not asked about its keys.
  expect(queries).toHaveLength(1);
  expect(await accountKeyState("scout.alice.testnet", KEY)).toBe("has-key");
  expect(queries.at(-1)).toEqual({
    request_type: "view_access_key",
    account_id: "scout.alice.testnet",
    public_key: KEY,
    finality: "final",
  });
  expect(await accountKeyState("other.alice.testnet", KEY)).toBe("other-keys");
  // The key with a function-call permission only is not the full access the agent needs.
  expect(await accountKeyState("limited.alice.testnet", KEY)).toBe("other-keys");
});

test("the_keys_of_an_account_are_null_only_when_the_node_says_the_account_does_not_exist", async () => {
  const list = json({
    jsonrpc: "2.0",
    id: "x",
    result: {
      keys: [
        { public_key: KEY, access_key: { nonce: 1, permission: "FullAccess" } },
        {
          public_key: "ed25519:runner",
          access_key: {
            nonce: 1,
            permission: {
              FunctionCall: {
                allowance: null,
                receiver_id: "tender.testnet",
                method_names: ["commit", "reveal"],
              },
            },
          },
        },
      ],
      block_height: 9,
    },
  });
  const queries = fakeNode(() => list.clone());
  expect(await accessKeysOf("alice.testnet")).toEqual([
    { publicKey: KEY, kind: "full_access" },
    {
      publicKey: "ed25519:runner",
      kind: "function_call",
      receiver: "tender.testnet",
      methods: ["commit", "reveal"],
    },
  ]);
  expect(queries).toEqual([
    { request_type: "view_access_key_list", account_id: "alice.testnet", finality: "final" },
  ]);

  // The account is not there: by name, and in an older node's words.
  fakeNode(() => unknown("UNKNOWN_ACCOUNT", "account nobody.testnet does not exist while viewing"));
  expect(await accessKeysOf("nobody.testnet")).toBeNull();
  fakeNode(() =>
    json({
      jsonrpc: "2.0",
      id: "x",
      error: {
        code: -32000,
        message: "Server error",
        data: "account x does not exist while viewing",
      },
    }),
  );
  expect(await accessKeysOf("x.testnet")).toBeNull();

  // Any other "unknown" is a read that failed, not an account with no keys.
  fakeNode(() => unknown("UNKNOWN_BLOCK", "DB Not Found Error: BLOCK HEIGHT: 12"));
  const error = await rejection(accessKeysOf("alice.testnet"));
  expect(error).toBeInstanceOf(RpcError);
  expect(error.message).toContain("UNKNOWN_BLOCK");

  // A list with an entry that is no key is not counted.
  fakeNode(() =>
    json({ jsonrpc: "2.0", id: "x", result: { keys: [{ public_key: KEY }], block_height: 9 } }),
  );
  expect(await rejection(accessKeysOf("alice.testnet"))).toBeInstanceOf(RpcError);
});
