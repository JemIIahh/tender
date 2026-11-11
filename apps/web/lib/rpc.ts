import { toBase64 } from "./base64";
import { config } from "./config";
import { withTimeout } from "./timeout";

/** How long a view may take before it is given up on. */
const TIMEOUT_MS = 15_000;

/** What went wrong with a view: the node said no, or its answer was not one a view gets. */
export class RpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcError";
  }
}

/**
 * A bigint in `args` goes out as a decimal string, as R19 writes a u64 or a u128 in the contract's
 * JSON. `JSON.stringify` alone throws on one.
 */
const bigintAsDecimal = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The text of an error the node sends in place of a result, with its cause and its details. */
function describeNodeError(error: unknown): string {
  const body = asRecord(error);
  const cause = asRecord(body?.cause);
  const parts = [cause?.name ?? body?.name ?? body?.message, body?.data]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(": ");
  return parts === "" ? "the RPC node sent an error" : `the RPC node sent an error: ${parts}`;
}

/** The bytes a call returned, from the node's answer. */
function returnedBytes(answer: unknown): number[] {
  const body = asRecord(answer);
  if (body?.error !== undefined) throw new RpcError(describeNodeError(body.error));
  const result = asRecord(body?.result);
  // A call that ran and failed (a panic, or an account with no contract) is a result with `error`.
  if (typeof result?.error === "string") throw new RpcError(result.error);
  const bytes = result?.result;
  if (!Array.isArray(bytes) || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new RpcError("the RPC node's answer holds no call result");
  }
  return bytes;
}

/**
 * Which block a read is made at: the last final one, whose answer cannot be undone, or the newest
 * (`optimistic`), for a read whose "nothing there" lets money move: it then sees what landed a
 * block or two ago.
 */
export type Finality = "final" | "optimistic";

/**
 * Calls the view `method` of `contractId` with `args` on the configured RPC node, at the last
 * final block: what it returns cannot be undone, as for `TenderClient.view`. The result is the
 * JSON the contract returned, unchecked; a caller that needs it to be right parses it with the
 * schemas of `@tender/shared`. A call that returns nothing gives `undefined`. A bigint in `args`
 * is sent as a decimal string.
 *
 * Throws an `RpcError` for an answer that is an error or is not a view's result. A request that
 * fails before there is an answer, or gets none in time (a `TimeoutError`), is thrown as it came.
 */
export async function view<T>(
  contractId: string,
  method: string,
  args: object = {},
  finality: Finality = "final",
): Promise<T> {
  const request = {
    jsonrpc: "2.0",
    id: "tender-web",
    method: "query",
    params: {
      request_type: "call_function",
      finality,
      account_id: contractId,
      method_name: method,
      args_base64: toBase64(new TextEncoder().encode(JSON.stringify(args, bigintAsDecimal))),
    },
  };

  const { ok, status, text } = await withTimeout(TIMEOUT_MS, async (signal) => {
    const res = await fetch(config.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  });
  if (!ok) throw new RpcError(`the RPC node answered with status ${status}`);

  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch {
    throw new RpcError("the RPC node's answer is not JSON");
  }

  const bytes = Uint8Array.from(returnedBytes(answer));
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RpcError(`${method} returned bytes that are not UTF-8 text`);
  }
  if (json === "") return undefined as T;
  try {
    return JSON.parse(json) as T;
  } catch {
    throw new RpcError(`${method} returned text that is not JSON`);
  }
}

// ---- Accounts and their keys --------------------------------------------------------------------

/**
 * A `query` of the node at the last final block: its `result`, or the name of the error it gave in
 * its place (`UNKNOWN_ACCOUNT`, `UNKNOWN_ACCESS_KEY`...), which is how a node says "there is none".
 * An older node says so in words only, in `data` or in the result's `error`, and those are read too.
 */
async function query(
  params: Record<string, string>,
  finality: Finality = "final",
): Promise<{ result: Record<string, unknown> } | { missing: string }> {
  const request = {
    jsonrpc: "2.0",
    id: "tender-web",
    method: "query",
    params: { ...params, finality },
  };
  const { ok, status, text } = await withTimeout(TIMEOUT_MS, async (signal) => {
    const res = await fetch(config.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  });
  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch {
    throw new RpcError(
      ok ? "the RPC node's answer is not JSON" : `the RPC node answered with status ${status}`,
    );
  }
  const body = asRecord(answer);
  const error = asRecord(body?.error);
  if (error !== undefined) {
    const cause = asRecord(error.cause);
    const name = typeof cause?.name === "string" ? cause.name : "";
    const words = `${String(error.data ?? "")} ${String(error.message ?? "")}`;
    if (name.startsWith("UNKNOWN_") || /does not exist/.test(words)) return { missing: name };
    throw new RpcError(describeNodeError(error));
  }
  if (!ok) throw new RpcError(`the RPC node answered with status ${status}`);
  const result = asRecord(body?.result);
  if (result === undefined) throw new RpcError("the RPC node's answer holds no result");
  if (typeof result.error === "string") {
    if (/does not exist/.test(result.error)) return { missing: "" };
    throw new RpcError(result.error);
  }
  return { result };
}

/** Whether `accountId` exists on the chain now (`view_account`). */
export async function accountExists(
  accountId: string,
  finality: Finality = "final",
): Promise<boolean> {
  const answer = await query({ request_type: "view_account", account_id: accountId }, finality);
  return "result" in answer;
}

/**
 * The NEAR that `accountId` holds now, in yoctoNEAR (`view_account`'s `amount`), or 0 when there is
 * no such account: an implicit account that no one has sent NEAR to yet is not on the chain. Only
 * the node's own word that the account does not exist is 0; any other failure throws.
 */
export async function nearBalanceOf(
  accountId: string,
  finality: Finality = "final",
): Promise<bigint> {
  const answer = await query({ request_type: "view_account", account_id: accountId }, finality);
  if ("missing" in answer) {
    if (answer.missing === "UNKNOWN_ACCOUNT" || answer.missing === "") return 0n;
    throw new RpcError(`view_account failed: the RPC node answered ${answer.missing}`);
  }
  const amount = answer.result.amount;
  if (typeof amount !== "string" || !/^\d{1,40}$/.test(amount)) {
    throw new RpcError("view_account returned no amount");
  }
  return BigInt(amount);
}

/**
 * What the chain says of `accountId` and `publicKey`: no such account, an account without that key,
 * or an account that has it as a full-access key, which is what "Add an agent" gives it.
 */
export async function accountKeyState(
  accountId: string,
  publicKey: string,
  finality: Finality = "final",
): Promise<"missing" | "other-keys" | "has-key"> {
  if (!(await accountExists(accountId, finality))) return "missing";
  const answer = await query(
    { request_type: "view_access_key", account_id: accountId, public_key: publicKey },
    finality,
  );
  if ("missing" in answer) return "other-keys";
  return answer.result.permission === "FullAccess" ? "has-key" : "other-keys";
}

/**
 * A key on an account, as `view_access_key_list` has it: a full-access key, or a function-call key,
 * which can call only `receiver`'s methods (`methods`; all of them when the list is empty) and can
 * attach no deposit.
 */
export type AccessKey =
  | { publicKey: string; kind: "full_access" }
  | { publicKey: string; kind: "function_call"; receiver: string; methods: string[] };

/** The key of one entry of `view_access_key_list`, or undefined if it is not one. */
function accessKeyOf(entry: unknown): AccessKey | undefined {
  const item = asRecord(entry);
  const publicKey = item?.public_key;
  if (typeof publicKey !== "string") return undefined;
  const permission = asRecord(item?.access_key)?.permission;
  if (permission === "FullAccess") return { publicKey, kind: "full_access" };
  const call = asRecord(asRecord(permission)?.FunctionCall);
  const receiver = call?.receiver_id;
  const methods = call?.method_names;
  if (typeof receiver !== "string" || !Array.isArray(methods)) return undefined;
  if (!methods.every((method): method is string => typeof method === "string")) return undefined;
  return { publicKey, kind: "function_call", receiver, methods };
}

/**
 * Every key of `accountId` (`view_access_key_list`), or null when there is no such account. Only
 * the node's own word that the account does not exist is null: `UNKNOWN_ACCOUNT`, or an older
 * node's "does not exist" in words. Any other "unknown" (`UNKNOWN_BLOCK`, when the node lacks the
 * block it was asked at) is a read that failed, and throws an `RpcError`, as does a list that holds
 * anything but keys: a count, or a "none", made of a list it could not read would be a guess.
 */
export async function accessKeysOf(accountId: string): Promise<AccessKey[] | null> {
  const answer = await query({ request_type: "view_access_key_list", account_id: accountId });
  if ("missing" in answer) {
    if (answer.missing === "UNKNOWN_ACCOUNT" || answer.missing === "") return null;
    throw new RpcError(`view_access_key_list failed: the RPC node answered ${answer.missing}`);
  }
  const keys = answer.result.keys;
  if (!Array.isArray(keys)) throw new RpcError("view_access_key_list returned no list of keys");
  return keys.map((entry) => {
    const key = accessKeyOf(entry);
    if (key === undefined) throw new RpcError("view_access_key_list returned a key it can't read");
    return key;
  });
}

/**
 * The full-access keys of `accountId` (`view_access_key_list`), as `ed25519:<base58>`, or null when
 * there is no such account. A function-call key is left out.
 */
export async function fullAccessKeysOf(accountId: string): Promise<string[] | null> {
  const answer = await query({ request_type: "view_access_key_list", account_id: accountId });
  if ("missing" in answer) return null;
  const keys = answer.result.keys;
  if (!Array.isArray(keys)) throw new RpcError("view_access_key_list returned no list of keys");
  return keys.flatMap((entry) => {
    const item = entry as { public_key?: unknown; access_key?: { permission?: unknown } };
    return typeof item.public_key === "string" && item.access_key?.permission === "FullAccess"
      ? [item.public_key]
      : [];
  });
}
