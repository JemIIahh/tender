import { Hono } from "hono";
import { cors } from "hono/cors";
import { requireAuth } from "./auth";
import type { ApiDeps } from "./deps";
import { type ErrorBody, handleError, toOrigin } from "./format";
import { mountMcp } from "./mcp";
import { agentRoutes } from "./routes/agents";
import { authRoutes } from "./routes/auth";
import { blobRoutes } from "./routes/blobs";
import { entryRoutes } from "./routes/entries";
import { healthRoutes } from "./routes/health";
import { questionRoutes } from "./routes/questions";
import { serviceRoutes } from "./routes/services";
import { startRoutes } from "./routes/start";
import { taskRoutes } from "./routes/tasks";
import { telegramRoutes } from "./routes/telegram";
import { eventRoutes } from "./sse";

/** The request headers a browser may send to the API: sign-in, JSON bodies, and SSE resumption. */
const ALLOWED_HEADERS = ["Authorization", "Content-Type", "Last-Event-ID"];

/**
 * The response headers browser code may read, beyond the few that any response allows: how long to
 * wait before asking again, when the event stream has no room.
 */
const EXPOSED_HEADERS = ["Retry-After"];

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
      exposeHeaders: EXPOSED_HEADERS,
      maxAge: 600,
    }),
  );

  app.route("/v1", healthRoutes(deps));
  app.route("/v1", taskRoutes(deps));
  app.route("/v1", agentRoutes(deps));
  app.route("/v1", entryRoutes(deps));
  app.route("/v1", authRoutes(deps));
  // One sign-in middleware for every route that needs an account, so that its record of which
  // keys it has checked lately is shared.
  const signedIn = requireAuth(deps);
  app.route("/v1", blobRoutes(deps, signedIn));
  app.route("/v1", startRoutes(deps, signedIn));
  app.route("/v1", questionRoutes(deps, signedIn));
  app.route("/v1", serviceRoutes(deps, signedIn));
  app.route("/v1", telegramRoutes(deps, signedIn));
  app.route("/v1", eventRoutes(deps));

  // Not under /v1: the MCP clients are not browsers, so the CORS block above does not apply.
  mountMcp(app, deps);

  app.notFound((c) => {
    const body: ErrorBody = { error: "not_found", message: "no such route" };
    return c.json(body, 404);
  });

  app.onError(handleError);

  return app;
}
