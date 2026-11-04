import { insertService, type ServiceFields, updateService } from "@tender/db";
import {
  CreateServiceRequestSchema,
  canonicalJson,
  NETWORKS,
  SERVICES_PER_PROVIDER,
  type ServiceResponse,
  type ServiceTerms,
  serviceTermsProblem,
  U64StringSchema,
  U128StringSchema,
  UpdateServiceRequestSchema,
} from "@tender/shared";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import type { AuthVariables, RequireAuth } from "../auth";
import type { ApiDeps } from "../deps";
import {
  badRequest,
  type ErrorBody,
  fail,
  issuesOf,
  notFound,
  param,
  parseAccount,
  parseLimit,
  parseTag,
  parseU64,
  readJson,
} from "../format";
import { rateLimit, rateLimitsOf } from "../limits";
import { canTakeHires, getService, listServices } from "../queries";

// Services: what an agent service provider offers for hire (owner decision of 2026-11-04; the
// rules are in `@tender/shared`'s `services.ts`, the count limit in `@tender/db`'s `services.ts`).
//
//   GET  /v1/services?q&tag&provider&agent&token&max_price&status&limit&cursor   public, newest first
//   GET  /v1/services/:id                                                         public, any status
//   POST /v1/services                                                             the provider lists one
//   POST /v1/services/:id                                                         the provider changes,
//                                                                                 pauses or resumes one
//
// A write is signed in, as the provider: the account that the offering agent runs under. A listing
// is checked in this order, and the first fault is the answer:
//
//   401  not signed in; 429 over the account's route limit (`RateLimits.services`); 413
//        `payload_too_large` for a body over `MAX_BODY_BYTES`, refused as it arrives and never parsed;
//   404  (a change) no service has that id, or the id is no canonical u64;
//   403  (a change) `not_provider`: the service is another account's;
//   400  the body does not fit its schema, or breaks a rule that spans fields (`serviceTermsProblem`),
//        or a window is shorter than the network's shortest, or the Judge is named where this API
//        has none, or as the agent of a service it checks;
//   403  (a listing) `not_your_agent`: the agent is neither the signed-in account nor one of its
//        sub-accounts (the registry's `asp`);
//   409  `agent_not_active`: the agent is not an active registered agent that holds a bond. A pause
//        is never refused for it, and a change that leaves the service paused is not either;
//   409  `service_limit`: the provider keeps `SERVICES_PER_PROVIDER` services already.
//
// The words of a service are the provider's and are public: plain text, stored and returned as
// text. The read view carries the offering agent's record from the index, the contract's own counts,
// and never a figure of its own.

/**
 * The most bytes a write's body may have. The largest valid body is a Judge-checked service whose
 * criteria are a rubric of 20 points of 200 characters: some 6 KB of text, and three times that for
 * a writer that escapes every character. A criteria document of another kind can be longer, but a
 * service's is public and short; 16 KiB is the board's bound and is what a listing takes here too.
 */
const MAX_BODY_BYTES = 16_384;

/** The largest id a `bigserial` row has. */
const MAX_ROW_ID = 2n ** 63n - 1n;

/** The longest search a listing takes, in characters. */
const MAX_QUERY_CHARS = 80;

interface StoredRow {
  provider: string;
  agent: string;
  title: string;
  description: string;
  tags: string[];
  category: ServiceTerms["category"];
  output_format: ServiceTerms["output_format"];
  token: string;
  price: string;
  commit_secs: number;
  reveal_secs: number;
  pick_secs: number;
  verifier: "hirer" | "judge";
  criteria: string | null;
  status: "active" | "paused";
}

/** What the database stores of `terms`: the criteria as their canonical JSON text. */
function fieldsOf(terms: ServiceTerms, status: "active" | "paused"): ServiceFields {
  const { verification } = terms;
  return {
    title: terms.title,
    description: terms.description,
    tags: terms.tags,
    category: terms.category,
    outputFormat: terms.output_format,
    token: terms.token,
    price: terms.price,
    commitSecs: terms.commit_secs,
    revealSecs: terms.reveal_secs,
    pickSecs: terms.pick_secs,
    verifier: verification.kind,
    criteria:
      verification.kind === "judge"
        ? new TextDecoder().decode(canonicalJson(verification.criteria))
        : null,
    status,
  };
}

/** The terms of a stored service, as a change starts from. */
function termsOf(row: StoredRow): ServiceTerms {
  return {
    title: row.title,
    description: row.description,
    tags: row.tags,
    category: row.category,
    output_format: row.output_format,
    token: row.token,
    price: row.price,
    commit_secs: row.commit_secs,
    reveal_secs: row.reveal_secs,
    pick_secs: row.pick_secs,
    verification:
      row.verifier === "judge" && row.criteria !== null
        ? { kind: "judge", criteria: JSON.parse(row.criteria) }
        : { kind: "hirer" },
  };
}

/** The body of a request, once it fits `schema`: a 400 with the faults otherwise. */
async function bodyOf<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await readJson(c));
  if (!parsed.success)
    return badRequest("the body does not fit its schema", issuesOf(parsed.error));
  return parsed.data;
}

export function serviceRoutes(
  deps: ApiDeps,
  requireAuth: RequireAuth,
): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const perAccount = rateLimit<{ Variables: AuthVariables }>(
    rateLimitsOf(deps.rateLimits).services,
    (c) => c.var.account,
  );
  const tooLarge = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => {
      const body: ErrorBody = {
        error: "payload_too_large",
        message: "the request body is too large",
      };
      return c.json(body, 413);
    },
  });
  const minWindowSecs = NETWORKS[deps.network].minWindowSecs;

  /** A 400 for terms that a hire could not be made of, on this network and with this Judge. */
  function checkTerms(terms: ServiceTerms, agent: string): void {
    const problem = serviceTermsProblem(terms);
    if (problem !== null) badRequest(problem);
    for (const name of ["commit_secs", "reveal_secs", "pick_secs"] as const) {
      if (terms[name] < minWindowSecs) {
        badRequest(
          `${name} must be at least ${minWindowSecs}, the shortest window on ${deps.network}`,
        );
      }
    }
    if (terms.verification.kind === "judge") {
      if (deps.judgeAccount === undefined) {
        badRequest(
          "this API has no Judge, so a service cannot be checked by one: let the hirer accept the work",
        );
      }
      // The contract refuses to invite a task's verifier.
      if (agent === deps.judgeAccount) {
        badRequest("the Judge cannot offer a service that the Judge checks");
      }
    }
  }

  /**
   * A 403 unless `agent` is `provider`'s: the provider itself, or an account it runs as its provider
   * (the index's `asp`; for an account the index does not hold, the registry's rule, which is the
   * same: the parent of a sub-account with two labels or more). Then a 409 unless the agent can take
   * hires (`canTakeHires`), when `mustBeActive`.
   */
  async function requireAgentOf(provider: string, agent: string, mustBeActive: boolean) {
    const [row] = await deps.db.query<{
      asp: string | null;
      status: "active" | "unregistering" | "retired";
      bond_amount: string | null;
    }>("select asp, status, bond_amount::text as bond_amount from agents where account = $1", [
      agent,
    ]);
    const parent = /^[^.]+[.](.+[.].+)$/.exec(agent)?.[1] ?? null;
    const runsIt = agent === provider || (row?.asp ?? parent) === provider;
    if (!runsIt) {
      fail(
        403,
        "not_your_agent",
        "a service is offered by one of your agents: your own account, or one of its sub-accounts",
      );
    }
    if (mustBeActive && !canTakeHires(row ?? null)) {
      fail(
        409,
        "agent_not_active",
        "the agent must be an active registered agent that holds a bond to take hires",
      );
    }
  }

  async function answer(id: string): Promise<ServiceResponse> {
    const service = await getService(deps.db, BigInt(id), deps.teamAccounts);
    if (service === null) throw new Error(`service ${id} was not found after it was written`);
    return { service };
  }

  app.get("/services", async (c) => {
    const q = c.req.query();
    const text = param(q.q)?.trim();
    if (text !== undefined && (text === "" || [...text].length > MAX_QUERY_CHARS)) {
      return badRequest(`q must be 1 to ${MAX_QUERY_CHARS} characters`);
    }
    const token = parseAccount("token", q.token);
    const maxPrice = param(q.max_price);
    if (maxPrice !== undefined) {
      if (!U128StringSchema.safeParse(maxPrice).success) {
        return badRequest("max_price must be a whole number of the token's smallest unit");
      }
      if (token === undefined) return badRequest("max_price needs token: prices are per token");
    }
    const status = param(q.status) ?? "available";
    if (status !== "available" && status !== "all") {
      return badRequest("status must be available or all");
    }
    const page = await listServices(
      deps.db,
      {
        q: text,
        tag: parseTag(q.tag),
        provider: parseAccount("provider", q.provider),
        agent: parseAccount("agent", q.agent),
        token,
        maxPrice,
        status,
        limit: parseLimit(q.limit),
        cursor: parseU64("cursor", q.cursor),
      },
      deps.teamAccounts,
    );
    return c.json(page);
  });

  /** The service id of the route, or a 404: an id past the largest row is no row's. */
  function idOf(raw: string | undefined): bigint {
    if (raw === undefined || !U64StringSchema.safeParse(raw).success) {
      return notFound("no such service");
    }
    const id = BigInt(raw);
    return id > MAX_ROW_ID ? notFound("no such service") : id;
  }

  app.get("/services/:id", async (c) => {
    const service = await getService(deps.db, idOf(c.req.param("id")), deps.teamAccounts);
    if (service === null) return notFound("no such service");
    const body: ServiceResponse = { service };
    return c.json(body);
  });

  app.post("/services", requireAuth, perAccount, tooLarge, async (c) => {
    const provider = c.var.account;
    const { agent, ...terms } = await bodyOf(c, CreateServiceRequestSchema);
    checkTerms(terms, agent);
    await requireAgentOf(provider, agent, true);
    const result = await insertService(
      deps.db,
      { provider, agent, ...fieldsOf(terms, "active") },
      SERVICES_PER_PROVIDER,
    );
    if (!result.ok) {
      return fail(
        409,
        "service_limit",
        `a provider keeps at most ${SERVICES_PER_PROVIDER} services, paused ones included, and you have that many`,
      );
    }
    return c.json(await answer(result.id));
  });

  app.post("/services/:id", requireAuth, perAccount, tooLarge, async (c) => {
    const id = idOf(c.req.param("id"));
    const [row] = await deps.db.query<StoredRow>(
      `select provider, agent, title, description, tags, category, output_format, token,
              price::text as price, commit_secs, reveal_secs, pick_secs, verifier, criteria, status
         from services where id = $1::numeric`,
      [id],
    );
    if (!row) return notFound("no such service");
    if (row.provider !== c.var.account) {
      return fail(403, "not_provider", "only the provider that listed a service can change it");
    }
    const { status, ...changes } = await bodyOf(c, UpdateServiceRequestSchema);
    const terms: ServiceTerms = { ...termsOf(row), ...changes };
    const next = status ?? row.status;
    checkTerms(terms, row.agent);
    // A pause, or a change to a paused service, never needs the agent to be able to work.
    await requireAgentOf(row.provider, row.agent, next === "active");
    const written = await updateService(deps.db, id, row.provider, fieldsOf(terms, next));
    if (!written) return notFound("no such service");
    return c.json(await answer(id.toString()));
  });

  return app;
}
