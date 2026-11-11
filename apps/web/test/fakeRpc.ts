import type { DelegateView } from "@tender/shared";

// A NEAR RPC node for the unit tests of an agent's Safety section, which reads three things from the
// chain: the account's keys (`view_access_key_list`), the contract's config (`get_config`, for the
// bond's cooldown) and a delegate key's record (`get_delegate`). It answers as a node does,
// "does not exist" included, from `FakeChain`. The RPC URL is the one vitest.config.ts sets.

export const RPC_ORIGIN = "http://rpc.test";

/** A key as `view_access_key_list` lists it. */
export interface RawKey {
  public_key: string;
  access_key: {
    nonce: number;
    permission:
      | "FullAccess"
      | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } };
  };
}

export function fullAccess(publicKey: string): RawKey {
  return { public_key: publicKey, access_key: { nonce: 1, permission: "FullAccess" } };
}

export function functionCall(publicKey: string, receiver: string, methods: string[]): RawKey {
  return {
    public_key: publicKey,
    access_key: {
      nonce: 1,
      permission: {
        FunctionCall: { allowance: null, receiver_id: receiver, method_names: methods },
      },
    },
  };
}

export interface FakeChain {
  /** Each account's keys. An account that is not here does not exist. */
  keys?: Record<string, RawKey[]>;
  /** The contract's config view. */
  config?: Record<string, unknown>;
  /** Delegate records, by `<account> <public key>`. */
  delegates?: Record<string, DelegateView>;
  /** Reads the node fails with a server error. */
  fail?: ReadonlySet<"view_access_key_list" | "get_config" | "get_delegate">;
  /**
   * A block the node does not have: `view_access_key_list` is answered with `UNKNOWN_BLOCK`, an
   * "unknown" that does not mean the account is missing.
   */
  unknownBlock?: boolean;
}

/** What the node was asked, as `view_access_key_list <account>` or `<method> <args>`. */
export type RpcCalls = string[];

const answer = (id: unknown, value: object) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, ...value }), { status: 200 });

const fault = (id: unknown) =>
  answer(id, { error: { name: "HANDLER_ERROR", cause: { name: "INTERNAL_ERROR" }, data: "down" } });

/** The node's answer to one JSON-RPC request, from `chain`. */
export function rpcAnswer(body: string, chain: FakeChain, calls: RpcCalls): Response {
  const request = JSON.parse(body) as { id: unknown; params: Record<string, string> };
  const { id, params } = request;
  if (params.request_type === "view_access_key_list") {
    const account = params.account_id ?? "";
    calls.push(`view_access_key_list ${account}`);
    if (chain.fail?.has("view_access_key_list")) return fault(id);
    if (chain.unknownBlock === true) {
      return answer(id, {
        error: {
          name: "HANDLER_ERROR",
          cause: { name: "UNKNOWN_BLOCK", info: {} },
          code: -32000,
          message: "Server error",
          data: "DB Not Found Error: BLOCK HEIGHT: 100",
        },
      });
    }
    const keys = chain.keys?.[account];
    if (keys === undefined) {
      return answer(id, {
        error: {
          name: "HANDLER_ERROR",
          cause: { name: "UNKNOWN_ACCOUNT", info: {} },
          data: `account ${account} does not exist while viewing`,
        },
      });
    }
    return answer(id, { result: { keys, block_height: 100 } });
  }
  if (params.request_type === "call_function") {
    const method = params.method_name ?? "";
    const args = Buffer.from(params.args_base64 ?? "", "base64").toString();
    calls.push(`${method} ${args}`);
    if (chain.fail?.has(method as "get_config" | "get_delegate")) return fault(id);
    let value: unknown;
    if (method === "get_config") value = chain.config ?? {};
    else if (method === "get_delegate") {
      const { account_id, public_key } = JSON.parse(args) as Record<string, string>;
      value = chain.delegates?.[`${account_id} ${public_key}`] ?? null;
    } else return fault(id);
    const bytes = [...new TextEncoder().encode(JSON.stringify(value))];
    return answer(id, { result: { result: bytes, logs: [], block_height: 100 } });
  }
  return fault(id);
}
