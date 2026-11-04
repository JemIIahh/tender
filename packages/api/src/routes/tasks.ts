import { Hono } from "hono";
import { type ApiDeps, nowNs } from "../deps";
import { notFound, parseAccount, parseLimit, parsePhase, parseTag, parseU64 } from "../format";
import { getTaskDetail, listTasks } from "../queries";

/**
 * `GET /v1/tasks?phase&tag&poster&verifier&parent&invited&limit&cursor` and `GET /v1/tasks/:id`. The
 * phase of every task is worked out at the time of the request, so a task that has passed a
 * deadline since the indexer last saw an event is already in its next phase.
 */
export function taskRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/tasks", async (c) => {
    const q = c.req.query();
    const page = await listTasks(
      deps.db,
      {
        phase: parsePhase(q.phase),
        tag: parseTag(q.tag),
        poster: parseAccount("poster", q.poster),
        verifier: parseAccount("verifier", q.verifier),
        parent: parseU64("parent", q.parent),
        invited: parseAccount("invited", q.invited),
        limit: parseLimit(q.limit),
        cursor: parseU64("cursor", q.cursor),
      },
      nowNs(deps),
      deps.teamAccounts,
    );
    return c.json(page);
  });

  app.get("/tasks/:id", async (c) => {
    // An id that is no u64 names no task, so it is a 404 like any other unknown id.
    const detail = await getTaskDetail(deps.db, c.req.param("id"), nowNs(deps), deps.teamAccounts);
    if (detail === null) return notFound("no such task");
    return c.json(detail);
  });

  return app;
}
