import { Hono } from "hono";
import { type ApiDeps, nowNs } from "../deps";
import { badRequest, parseAccount } from "../format";
import { listEntriesByAccount } from "../queries";

/** `GET /v1/entries?account=`: every entry of one account, with the task each one is in. */
export function entryRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/entries", async (c) => {
    const account = parseAccount("account", c.req.query("account"));
    if (account === undefined) return badRequest("account is required");
    return c.json(await listEntriesByAccount(deps.db, account, nowNs(deps)));
  });

  return app;
}
