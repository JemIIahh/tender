import type { MetricsResponse } from "@tender/shared";
import { Hono } from "hono";
import { type ApiDeps, nowNs } from "../deps";
import { getMetrics } from "../queries";

/** How long an answer is kept and given again, in nanoseconds of the API's clock: 15 seconds. */
export const METRICS_CACHE_NS = 15n * 1_000_000_000n;

/**
 * `GET /v1/metrics`: the platform's figures, counted from the index (`MetricsResponseSchema` in
 * `@tender/shared` says what each is). It reads and changes nothing else, and takes no query.
 *
 * The count runs a few aggregates over whole tables, and the route is public and asks for no
 * sign-in, so an answer is kept for `METRICS_CACHE_NS` and every request in that time gets it, the
 * requests that come while it is being counted included. So at most one count starts in any 15
 * seconds, counted from when the last one started, unless that count failed (a count that fails
 * is not kept, and the next request counts again at once) or the clock went back. A count that
 * takes longer than 15 seconds is still running when a request after them starts the next one, and
 * the two run side by side. The figures are at most 15 seconds old, plus the time their count
 * took.
 */
export function metricsRoutes(deps: ApiDeps): Hono {
  const app = new Hono();
  const readers = { teamAccounts: deps.teamAccounts, judgeAccount: deps.judgeAccount ?? null };
  let kept: { at: bigint; body: Promise<MetricsResponse> } | null = null;

  app.get("/metrics", async (c) => {
    const now = nowNs(deps);
    let entry = kept;
    // A clock that went back is not trusted to say the answer is fresh.
    if (entry === null || now - entry.at >= METRICS_CACHE_NS || now < entry.at) {
      const counting = getMetrics(deps.db, now, readers);
      const fresh = { at: now, body: counting };
      entry = fresh;
      kept = fresh;
      // A count that fails is not given to the next request.
      counting.catch(() => {
        if (kept === fresh) kept = null;
      });
    }
    const body: MetricsResponse = await entry.body;
    return c.json(body);
  });

  return app;
}
