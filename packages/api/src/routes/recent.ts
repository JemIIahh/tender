import { type RecentEvent, type RecentEventsResponse, TenderEventSchema } from "@tender/shared";
import { Hono } from "hono";
import type { ApiDeps } from "../deps";
import { badRequest, param, parseLimit } from "../format";

/** The names of the contract's events, which are the ones this route lists. */
const CONTRACT_EVENTS: readonly string[] = TenderEventSchema.options.map(
  (option) => option.shape.event.value,
);

/** `event`: names of the contract's events, comma-separated; none, or empty, is every one. */
function parseEvents(raw: string | undefined): string[] {
  const value = param(raw);
  if (value === undefined) return [...CONTRACT_EVENTS];
  const names = value.split(",");
  if (names.some((name) => !CONTRACT_EVENTS.includes(name))) {
    return badRequest("event must be names of the contract's events, separated by commas");
  }
  return [...new Set(names)];
}

/**
 * `GET /v1/events/recent?limit&event`: the newest of the contract's events the indexer stored,
 * newest first, `limit` of them (20 by default, 50 at most), as a page reads them once before it
 * follows the stream (`GET /v1/events`). Each is the stream's message with its id, the chain time
 * of its block, and the token of the task it is about. The question board's events, which share the
 * table, are not listed. `newest` is the newest stored id of any kind, which the page opens the
 * stream after (`?since=`). It reads the `events` and `tasks` tables and nothing else.
 */
export function recentEventRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/events/recent", async (c) => {
    const q = c.req.query();
    const limit = parseLimit(q.limit);
    const names = parseEvents(q.event);
    // `e.id` in `order by`: the bare name is the output column, which is text.
    const [events, newest] = await Promise.all([
      deps.db.query<RecentEvent>(
        `select e.id::text as id, e.event, e.data, e.height::text as height,
                e.task_id::text as task_id, e.block_ts::text as block_ts, t.token
           from events e
           left join tasks t on t.id = e.task_id
          where e.event = any($1::text[])
          order by e.id desc
          limit $2::int`,
        [names, limit],
      ),
      deps.db.query<{ max: string }>("select coalesce(max(id), 0)::text as max from events"),
    ]);
    const body: RecentEventsResponse = { events, newest: newest[0]?.max ?? "0" };
    return c.json(body);
  });

  return app;
}
