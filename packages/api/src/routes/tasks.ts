import { Hono } from "hono";
import { type ApiDeps, nowNs } from "../deps";
import {
  badRequest,
  notFound,
  param,
  parseAccount,
  parseLimit,
  parsePhase,
  parseTag,
  parseU64,
} from "../format";
import { getTaskDetail, listTasks } from "../queries";

/** `hire`: "true" filters, nothing (or an empty value) does not, and anything else is refused. */
function parseHire(raw: string | undefined): boolean | undefined {
  const value = param(raw);
  if (value === undefined) return undefined;
  if (value !== "true") return badRequest("hire must be true");
  return true;
}

/**
 * `GET /v1/tasks?phase&tag&poster&verifier&parent&invited&hire&limit&cursor` and
 * `GET /v1/tasks/:id`. The phase of every task is worked out at the time of the request, so a task
 * that has passed a deadline since the indexer last saw an event is already in its next phase.
 * `hire=true` keeps the hires of a service only (`isHireTask` of `@tender/shared`); any other
 * value of it is a 400.
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
        hire: parseHire(q.hire),
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
