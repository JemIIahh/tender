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
 * Calls the view `method` of `contractId` with `args` on the configured RPC node, at the last
 * final block: what it returns cannot be undone, as for `TenderClient.view`. The result is the
 * JSON the contract returned, unchecked; a caller that needs it to be right parses it with the
 * schemas of `@tender/shared`. A call that returns nothing gives `undefined`. A bigint in `args`
 * is sent as a decimal string.
 *
 * Throws an `RpcError` for an answer that is an error or is not a view's result. A request that
 * fails before there is an answer, or gets none in time (a `TimeoutError`), is thrown as it came.
 */
export async function view<T>(contractId: string, method: string, args: object = {}): Promise<T> {
  const request = {
    jsonrpc: "2.0",
    id: "tender-web",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
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
