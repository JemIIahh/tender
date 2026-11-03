import { Hono } from "hono";
import { withinDeadline } from "../deadline";
import type { ApiDeps } from "../deps";
import type { ErrorBody, HealthResponse } from "../format";
import { RETRY_SOON } from "../limits";

/**
 * How long the chain has to give its final height, in milliseconds. The RPC client retries a node
 * that does not answer for minutes, which no monitor waits for.
 */
const FINAL_HEIGHT_DEADLINE_MS = 5_000;

/**
 * `GET /v1/health`: whether the API can read the database and the chain, and how far the index is
 * behind. A monitor reads `lag_blocks`; the API stays `ok` while the indexer catches up.
 *
 * The index is the cursor of this deployment, `<network>:<contractId>` as the indexer keeps it
 * (`startIndexer`). A database serves one contract deploy, and the services refuse one that holds
 * another's, but the cursor of another deploy would not say how far this one is.
 *
 * The chain has 5 seconds (`options.deadlineMs`, for tests) to give its final height. A chain that
 * fails or does not answer in time is a 503 with `Retry-After: 5`.
 */
export function healthRoutes(deps: ApiDeps, options: { deadlineMs?: number } = {}): Hono {
  const deadlineMs = options.deadlineMs ?? FINAL_HEIGHT_DEADLINE_MS;
  const app = new Hono();

  app.get("/health", async (c) => {
    // None before the first block.
    const [row] = await deps.db.query<{ height: string }>(
      "select height::text as height from chain_cursor where source = $1",
      [`${deps.network}:${deps.contractId}`],
    );
    const indexed = BigInt(row?.height ?? "0");

    let final: bigint;
    try {
      // Called as a method, because a `TenderClient` reads its own fields.
      final = await withinDeadline(deadlineMs, deps.client.finalHeight());
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
