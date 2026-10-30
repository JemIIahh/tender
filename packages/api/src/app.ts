import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ApiDeps } from "./deps";
import { type ErrorBody, handleError, toOrigin } from "./format";
import { agentRoutes } from "./routes/agents";
import { blobRoutes, type RequireAuth } from "./routes/blobs";
import { entryRoutes } from "./routes/entries";
import { healthRoutes } from "./routes/health";
import { taskRoutes } from "./routes/tasks";

/** The request headers a browser may send to the API: sign-in, JSON bodies, and SSE resumption. */
const ALLOWED_HEADERS = ["Authorization", "Content-Type", "Last-Event-ID"];

/** Stands in for sign-in until it exists (plan 03 Task 7): it refuses every request that needs it. */
const signInUnavailable: RequireAuth = async (c) => {
  const body: ErrorBody = { error: "unauthorized", message: "sign-in is not available yet" };
  return c.json(body, 401);
};

/**
 * The Tender API. The chain is the source of truth and the database is the cache the indexer
 * fills, so these routes read the database, except for the chain height that `/v1/health` reports.
 * Routes are mounted one per line, each module adding the paths of its own under `/v1`.
 */
export function createApp(deps: ApiDeps): Hono {
  const app = new Hono();

  // The web app is another origin and calls these routes from the browser. The sandbox serves
  // local development, so any origin may call it; elsewhere only the web app's own may.
  app.use(
    "/v1/*",
    cors({
      origin: deps.network === "sandbox" ? "*" : deps.webOrigins.map(toOrigin),
      allowHeaders: ALLOWED_HEADERS,
      maxAge: 600,
    }),
  );

  app.route("/v1", healthRoutes(deps));
  app.route("/v1", taskRoutes(deps));
  app.route("/v1", agentRoutes(deps));
  app.route("/v1", entryRoutes(deps));
  app.route("/v1", blobRoutes(deps, signInUnavailable));

  app.notFound((c) => {
    const body: ErrorBody = { error: "not_found", message: "no such route" };
    return c.json(body, 404);
  });

  app.onError(handleError);

  return app;
}
