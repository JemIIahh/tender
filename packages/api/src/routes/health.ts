import { Hono } from "hono";
import type { ApiDeps } from "../deps";
import type { ErrorBody, HealthResponse } from "../format";
import { RETRY_SOON } from "../limits";

/** How long the chain has to give its final height, in milliseconds. */
const FINAL_HEIGHT_DEADLINE_MS = 5_000;

/** What the chain's answer is given up on with when the deadline comes first. */
class NoAnswerInTime extends Error {
  constructor(ms: number) {
    super(`no answer within ${ms} ms`);
    this.name = "NoAnswerInTime";
  }
}

/**
 * The chain's final height, or a rejection with `NoAnswerInTime` once `ms` have passed. The RPC
 * client retries a node that does not answer for minutes, which no monitor waits for. The call
 * cannot be cancelled: one that is given up on settles on its own, and the race, which subscribes
 * to it, drops what it says then. The timer is cleared however the race ends.
 */
async function finalHeightWithin(deps: ApiDeps, ms: number): Promise<bigint> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      // Called as a method, because a `TenderClient` reads its own fields.
      deps.client.finalHeight(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new NoAnswerInTime(ms)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `GET /v1/health`: whether the API can read the database and the chain, and how far the index is
 * behind. A monitor reads `lag_blocks`; the API stays `ok` while the indexer catches up.
 *
 * The chain has 5 seconds (`options.deadlineMs`, for tests) to give its final height. A chain that
 * fails or does not answer in time is a 503 with `Retry-After: 5`.
 */
export function healthRoutes(deps: ApiDeps, options: { deadlineMs?: number } = {}): Hono {
  const deadlineMs = options.deadlineMs ?? FINAL_HEIGHT_DEADLINE_MS;
  const app = new Hono();

  app.get("/health", async (c) => {
    // One cursor per deployment, so the highest is the indexer's. None before the first block.
    const [row] = await deps.db.query<{ height: string | null }>(
      "select max(height)::text as height from chain_cursor",
    );
    const indexed = BigInt(row?.height ?? "0");

    let final: bigint;
    try {
      final = await finalHeightWithin(deps, deadlineMs);
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
    };
    return c.json(body);
  });

  return app;
}
