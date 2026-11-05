import { phaseAt, U64StringSchema } from "@tender/shared";
import { Hono } from "hono";
import type { AuthVariables, RequireAuth } from "../auth";
import { type ApiDeps, nowNs } from "../deps";
import { fail, notFound } from "../format";
import { rateLimit, rateLimitsOf } from "../limits";

/** `POST /v1/tasks/:id/start`. `working_count` is a JSON integer, as every count the index keeps. */
export interface StartResponse {
  ok: true;
  /** How many accounts have said they are working on the task, this one among them. */
  working_count: number;
}

/** What `phaseAt` needs of a task row: its deadlines, and whether it has an outcome. */
interface TaskWindows {
  commit_deadline: string;
  reveal_deadline: string;
  pick_deadline: string;
  fallback_deadline: string;
  settled: boolean;
}

/**
 * The working signal. `POST /v1/tasks/:id/start` (signed in) says that the account has started on
 * the task, for the board to show and the notifier to announce. It is unverified by design: no
 * entry is needed, and nothing on chain backs it.
 *
 * Only a task in its commit window can be started. The phase is `phaseAt`'s, the rule the read
 * routes work out in SQL, for the time of the request, so a task that has passed its commit
 * deadline since the indexer last saw an event is refused already. A task the index does not hold,
 * and an id that is no canonical u64, are a 404, like any other unknown task.
 *
 * It is idempotent. The first start of an account is the one that is kept, along with its
 * `started_at`, so asking again changes nothing and the notifier's announcement is not repeated.
 * Each account is held to `limits.start` requests a minute (30 unless `deps.rateLimits` says
 * otherwise), refused ones included, past which the answer is a 429 with `Retry-After`; the team's
 * accounts are not held to it.
 */
export function startRoutes(
  deps: ApiDeps,
  requireAuth: RequireAuth,
): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const team = new Set(deps.teamAccounts);
  // After sign-in, which is what says whose request it is.
  const perAccount = rateLimit<{ Variables: AuthVariables }>(
    rateLimitsOf(deps.rateLimits).start,
    (c) => c.var.account,
    (c) => team.has(c.var.account),
  );

  app.post("/tasks/:id/start", requireAuth, perAccount, async (c) => {
    const id = c.req.param("id");
    if (!U64StringSchema.safeParse(id).success) return notFound("no such task");

    const [task] = await deps.db.query<TaskWindows>(
      `select commit_deadline::text as commit_deadline,
              reveal_deadline::text as reveal_deadline,
              pick_deadline::text as pick_deadline,
              fallback_deadline::text as fallback_deadline,
              (outcome is not null) as settled
         from tasks
        where id = $1::numeric`,
      [id],
    );
    if (!task) return notFound("no such task");
    const phase = phaseAt(task, nowNs(deps));
    if (phase !== "open") {
      return fail(409, "not_open", `only an open task can be started, and this one is ${phase}`);
    }

    await deps.db.query(
      "insert into working (task_id, account) values ($1::numeric, $2) on conflict do nothing",
      [id, c.var.account],
    );
    const [count] = await deps.db.query<{ working_count: number }>(
      "select count(*)::int as working_count from working where task_id = $1::numeric",
      [id],
    );
    const body: StartResponse = { ok: true, working_count: count?.working_count ?? 0 };
    return c.json(body);
  });

  return app;
}
