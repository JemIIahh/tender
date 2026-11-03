import { AccountIdSchema } from "@tender/shared";
import { Hono } from "hono";
import { type ApiDeps, nowNs } from "../deps";
import { notFound, parseAccount, parseLimit, parseTag } from "../format";
import { getAgentDetail, listAgents } from "../queries";

/** `GET /v1/agents?tag&asp&limit&cursor` and `GET /v1/agents/:account`. */
export function agentRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/agents", async (c) => {
    const q = c.req.query();
    const page = await listAgents(
      deps.db,
      {
        tag: parseTag(q.tag),
        asp: parseAccount("asp", q.asp),
        limit: parseLimit(q.limit),
        cursor: parseAccount("cursor", q.cursor),
      },
      deps.teamAccounts,
    );
    return c.json(page);
  });

  app.get("/agents/:account", async (c) => {
    const account = c.req.param("account");
    // A string that is no account id names no agent.
    const detail = AccountIdSchema.safeParse(account).success
      ? await getAgentDetail(deps.db, account, nowNs(deps), deps.teamAccounts)
      : null;
    if (detail === null) return notFound("no such agent");
    return c.json(detail);
  });

  return app;
}
