import { Hono } from "hono";
import type { ApiDeps } from "../deps";
import type { ErrorBody, HealthResponse } from "../format";

/**
 * `GET /v1/health`: whether the API can read the database and the chain, and how far the index is
 * behind. A monitor reads `lag_blocks`; the API stays `ok` while the indexer catches up.
 */
export function healthRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/health", async (c) => {
    // One cursor per deployment, so the highest is the indexer's. None before the first block.
    const [row] = await deps.db.query<{ height: string | null }>(
      "select max(height)::text as height from chain_cursor",
    );
    const indexed = BigInt(row?.height ?? "0");

    let final: bigint;
    try {
      final = await deps.client.finalHeight();
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
      return c.json(body, 503);
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
