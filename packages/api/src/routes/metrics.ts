import type { MetricsResponse } from "@tender/shared";
import { Hono } from "hono";
import { type ApiDeps, nowNs } from "../deps";
import { getMetrics } from "../queries";

/**
 * `GET /v1/metrics`: the platform's figures, every one counted from the index at the time of the
 * request (`MetricsResponseSchema` in `@tender/shared` says what each is). It reads and changes
 * nothing else, and takes no query: a few counts and sums over the tables the indexer keeps.
 */
export function metricsRoutes(deps: ApiDeps): Hono {
  const app = new Hono();
  const readers = { teamAccounts: deps.teamAccounts, judgeAccount: deps.judgeAccount ?? null };

  app.get("/metrics", async (c) => {
    const body: MetricsResponse = await getMetrics(deps.db, nowNs(deps), readers);
    return c.json(body);
  });

  return app;
}
