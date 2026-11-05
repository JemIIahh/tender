import { Hono } from "hono";
import { withinDeadline } from "../deadline";
import { type ApiDeps, nowNs } from "../deps";
import type { ErrorBody, HealthResponse } from "../format";
import { clientKey, RETRY_SOON, rateLimit, rateLimitsOf } from "../limits";

/**
 * How long the chain has to give its final height, in milliseconds. The RPC client gives a read of
 * the node 30 s (`rpcTimeoutMs`, unless it is set) before it cancels it with `E_TIMEOUT`, which is
 * longer than a monitor waits.
 */
const FINAL_HEIGHT_DEADLINE_MS = 5_000;

/**
 * How long a read of the chain's final height is the answer, in nanoseconds of the API's clock: 2
 * seconds, about two blocks.
 */
export const FINAL_HEIGHT_CACHE_NS = 2n * 1_000_000_000n;

/**
 * `GET /v1/health`: whether the API can read the database and the chain, and how far the index is
 * behind. A monitor reads `lag_blocks`; the API stays `ok` while the indexer catches up. It also
 * reads `waiting_for_chain`, which is true while the services hold the indexer, the keeper and the
 * Judge back until the node can be asked or has caught up with the index (`deps.waitingForChain`):
 * `lag_blocks` is 0 for a node that is behind the index, so it cannot show that.
 *
 * The index is the cursor of this deployment, `<network>:<contractId>` as the indexer keeps it
 * (`startIndexer`). A database serves one contract deploy, and the services refuse one that holds
 * another's, but the cursor of another deploy would not say how far this one is.
 *
 * The chain has 5 seconds (`options.deadlineMs`, for tests) to give its final height. A chain that
 * fails or does not answer in time is a 503 with `Retry-After: 5`.
 *
 * The route is public and asks for no sign-in, and its read of the chain goes to the RPC node the
 * Judge and the keeper use. So the read is shared: one starts at most every `FINAL_HEIGHT_CACHE_NS`
 * (2 s), counted from when the last one started, and every request in that time gets its answer,
 * the requests that come while it is under way included, and a failure as well (the next window
 * asks again). A clock that went back starts a read at once. The height a monitor sees is at most 2
 * seconds old, plus the time the read took. Each client address is also held to `limits.health`
 * requests a minute (`clientKey`), past which the answer is a 429 with `Retry-After`.
 */
export function healthRoutes(deps: ApiDeps, options: { deadlineMs?: number } = {}): Hono {
  const deadlineMs = options.deadlineMs ?? FINAL_HEIGHT_DEADLINE_MS;
  const app = new Hono();
  let kept: { at: bigint; height: Promise<bigint> } | null = null;

  /** The final height of the chain, read at most once in each window and shared by its requests. */
  const finalHeight = (): Promise<bigint> => {
    const now = nowNs(deps);
    const entry = kept;
    if (entry !== null && now >= entry.at && now - entry.at < FINAL_HEIGHT_CACHE_NS) {
      return entry.height;
    }
    // Called as a method, because a `TenderClient` reads its own fields.
    const height = deps.client.finalHeight();
    // Each request waits on it with a deadline of its own; one that has given up leaves no
    // rejection unhandled.
    height.catch(() => undefined);
    kept = { at: now, height };
    return height;
  };

  app.get(
    "/health",
    rateLimit(rateLimitsOf(deps.rateLimits).health, (c) =>
      clientKey(c, deps.trustedProxyHops ?? 0),
    ),
    async (c) => {
      const waiting = deps.waitingForChain?.() === true;
      // None before the first block.
      const [row] = await deps.db.query<{ height: string }>(
        "select height::text as height from chain_cursor where source = $1",
        [`${deps.network}:${deps.contractId}`],
      );
      const indexed = BigInt(row?.height ?? "0");

      let final: bigint;
      try {
        final = await withinDeadline(deadlineMs, finalHeight());
      } catch (error) {
        // Only the kind of error is logged: the text of an RPC error can name an endpoint with a key.
        console.error(
          `api: health: the final height is unavailable (${error instanceof Error ? error.name : typeof error})`,
        );
        const body: ErrorBody & Record<string, unknown> = {
          ok: false,
          error: "chain_unavailable",
          message: "the final block height of the chain could not be read",
          network: deps.network,
          contract: deps.contractId,
          indexed_height: indexed.toString(),
          waiting_for_chain: waiting,
        };
        return c.json(body, 503, RETRY_SOON);
      }

      const body: HealthResponse = {
        ok: true,
        network: deps.network,
        contract: deps.contractId,
        indexed_height: indexed.toString(),
        chain_final_height: final.toString(),
        lag_blocks: (final > indexed ? final - indexed : 0n).toString(),
        waiting_for_chain: waiting,
      };
      return c.json(body);
    },
  );

  return app;
}
