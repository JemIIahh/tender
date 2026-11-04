import { randomBytes } from "node:crypto";
import { insertService, updateService } from "@tender/db";
import { applyBlock } from "@tender/indexer";
import { blockOf, eventLine, FIXTURE_OPTIONS } from "@tender/indexer/testing";
import {
  type CreateServiceRequest,
  canonicalJson,
  HIRER_ACCEPTS_CRITERIA_HASH,
  isHireTask,
  ListServicesResponseSchema,
  type PublicCriteria,
  SERVICE_MAX_PRICE,
  SERVICES_PER_PROVIDER,
  ServiceResponseSchema,
  sha256Hex,
  TaskDetailResponseSchema,
} from "@tender/shared";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { AuthVariables, RequireAuth } from "../src/auth";
import { handleError } from "../src/format";
import { type ApiDeps, createApp, type ErrorBody } from "../src/index";
import { serviceRoutes } from "../src/routes/services";
import { resetDb, TEST_NOW, testDeps } from "./helpers";

// The service listings. The routes are mounted on an app of their own with `stubAuth`, which reads
// the signed-in account from a header, as the board's tests do; `every_write_requires_sign_in` holds
// `createApp` to refusing a request without a bearer token and to taking one that sign-in issued.
//
// The agents are rows of the index, written as the indexer writes them: `acme.near` is a provider
// with two sub-accounts, `writer.acme.near` (active, bonded, with a record) and
// `idle.acme.near` (active, no bond); `solo.near` is an agent of its own with a bond, and
// `leaving.solo.near` is unregistering. `other.near` runs nothing.

const ACME = "acme.near";
const WRITER = "writer.acme.near";
const IDLE = "idle.acme.near";
const SOLO = "solo.near";
const LEAVING = "leaving.solo.near";
const OTHER = "other.near";
const JUDGE = "judge.near";
const TOKEN = "usdc.near";

let deps: ApiDeps;

beforeAll(async () => {
  deps = await testDeps({ judgeAccount: JUDGE, teamAccounts: [SOLO] });
});

afterAll(() => deps.db.close());

beforeEach(async () => {
  await resetDb(deps.db);
  await agent(WRITER, { asp: ACME, wins: 3, entries: 7, earned: { [TOKEN]: "4750000" } });
  await agent(IDLE, { asp: ACME, bond: false });
  await agent(SOLO, { asp: null });
  await agent(LEAVING, { asp: SOLO, status: "unregistering" });
});

/** An agent row, as the indexer leaves one. */
async function agent(
  account: string,
  o: {
    asp: string | null;
    status?: "active" | "unregistering" | "retired";
    bond?: boolean;
    wins?: number;
    entries?: number;
    earned?: Record<string, string>;
  },
): Promise<void> {
  await deps.db.query(
    `insert into agents (account, asp, profile_uri, profile_hash, tags, registered_height, entries,
                         reveals, wins, earned, status, bond_token, bond_amount)
     values ($1, $2, 'ipfs://p', $3, '[]', 10, $4, $4, $5, $6::jsonb, $7, $8, $9::numeric)`,
    [
      account,
      o.asp,
      "ab".repeat(32),
      o.entries ?? 0,
      o.wins ?? 0,
      JSON.stringify(o.earned ?? {}),
      o.status ?? "active",
      o.bond === false ? null : TOKEN,
      o.bond === false ? null : "5000000",
    ],
  );
}

/** A stand-in for sign-in: the account is the `x-test-account` header, and no header is no sign-in. */
const stubAuth: RequireAuth = async (c, next) => {
  const account = c.req.header("x-test-account");
  if (account === undefined) {
    const body: ErrorBody = { error: "unauthorized", message: "sign in first" };
    return c.json(body, 401);
  }
  c.set("account", account);
  await next();
};

function appWith(over: Partial<ApiDeps> = {}): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.onError(handleError);
  app.route("/v1", serviceRoutes({ ...deps, ...over }, stubAuth));
  return app;
}

type Requester = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

interface Reply<T> {
  status: number;
  body: T;
  headers: Headers;
}

async function send<T = unknown>(
  method: "GET" | "POST",
  path: string,
  o: { account?: string; body?: unknown; raw?: string; app?: Requester; headers?: object } = {},
): Promise<Reply<T>> {
  const headers: Record<string, string> = { ...(o.headers as Record<string, string>) };
  if (o.account !== undefined) headers["x-test-account"] = o.account;
  let body: string | undefined;
  if (o.raw !== undefined) body = o.raw;
  else if (o.body !== undefined) body = JSON.stringify(o.body);
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await (o.app ?? appWith()).request(path, { method, headers, body });
  return { status: res.status, body: (await res.json()) as T, headers: res.headers };
}

type ServiceBody = { service: Record<string, unknown> } & ErrorBody;

/** A valid listing of `agent`'s, with `over` on top. */
function listing(agentId: string, over: Partial<CreateServiceRequest> = {}): object {
  return {
    agent: agentId,
    title: "Summarise a filing",
    description: "Reads a public filing and returns a plain summary of it.",
    tags: ["research", "filings"],
    category: "research",
    output_format: "text",
    token: TOKEN,
    price: "2500000",
    commit_secs: 600,
    reveal_secs: 300,
    pick_secs: 600,
    verification: { kind: "hirer" },
    ...over,
  };
}

const REGEX_CRITERIA: PublicCriteria = {
  version: 1,
  kind: "regex_cases",
  min_score: 100,
  split: "winner_take_all",
  has_heldout: false,
  examples: { match: ["2026-11-04"], no_match: ["4 Nov 2026"] },
};

const create = (account: string | undefined, body: unknown, app?: Requester) =>
  send<ServiceBody>("POST", "/v1/services", { account, body, app });
const change = (id: string, account: string | undefined, body: unknown, app?: Requester) =>
  send<ServiceBody>("POST", `/v1/services/${id}`, { account, body, app });
const list = (query = "", app?: Requester) =>
  send<{ services: Array<Record<string, unknown>>; next_cursor: string | null } & ErrorBody>(
    "GET",
    `/v1/services${query}`,
    { app },
  );

// ---- Listing ----------------------------------------------------------------------------------

test("a_provider_lists_a_service_of_its_sub_account_with_the_agents_real_record", async () => {
  const made = await create(ACME, listing(WRITER));
  expect(made.status).toBe(200);
  const { service } = ServiceResponseSchema.parse(made.body);
  expect(service).toMatchObject({
    id: "1",
    provider: ACME,
    agent: WRITER,
    title: "Summarise a filing",
    tags: ["research", "filings"],
    token: TOKEN,
    price: "2500000",
    verification: { kind: "hirer" },
    status: "active",
    available: true,
    is_team: false,
  });
  // The record is the index's, as GET /v1/agents/:account gives it: no figure of the listing's own.
  expect(service.agent_record).toMatchObject({
    account: WRITER,
    asp: ACME,
    wins: 3,
    entries: 7,
    earned: { [TOKEN]: "4750000" },
    status: "active",
  });
  const read = await send<ServiceBody>("GET", "/v1/services/1");
  expect(read.status).toBe(200);
  expect(read.body).toEqual(made.body);
});

test("a_provider_may_offer_itself_and_the_team_label_follows_the_agent", async () => {
  const made = await create(SOLO, listing(SOLO));
  expect(made.status).toBe(200);
  expect(made.body.service).toMatchObject({ provider: SOLO, agent: SOLO, is_team: true });
});

test("a_judge_checked_service_shows_its_criteria_and_the_hash_every_hire_carries", async () => {
  const made = await create(
    ACME,
    listing(WRITER, {
      output_format: "regex_json",
      verification: { kind: "judge", criteria: REGEX_CRITERIA },
    }),
  );
  expect(made.status).toBe(200);
  expect(made.body.service.verification).toEqual({
    kind: "judge",
    criteria: REGEX_CRITERIA,
    criteria_hash: sha256Hex(canonicalJson(REGEX_CRITERIA)),
    // The Judge this API serves, whom every hire of it names as verifier.
    judge: JUDGE,
  });
  // An API without a Judge names none, and the service cannot be hired there.
  const read = await send<ServiceBody>("GET", "/v1/services/1", {
    app: appWith({ judgeAccount: undefined }),
  });
  expect(read.body.service).toMatchObject({ available: false, verification: { judge: null } });
  const listed = await list("", appWith({ judgeAccount: undefined }));
  expect(listed.body.services).toEqual([]);
});

test("only_the_provider_of_an_agent_can_list_for_it", async () => {
  // Another account's sub-account, an account of its own, and a sibling under the same parent.
  for (const [account, agentId] of [
    [OTHER, WRITER],
    [OTHER, SOLO],
    [WRITER, IDLE],
    [SOLO, WRITER],
  ] as const) {
    const refused = await create(account, listing(agentId));
    expect(refused.status, `${account} for ${agentId}`).toBe(403);
    expect(refused.body.error).toBe("not_your_agent");
  }
  // A sub-account of a sub-account is its parent's, not the grandparent's (the registry's rule).
  await agent("deep.writer.acme.near", { asp: WRITER });
  expect((await create(ACME, listing("deep.writer.acme.near"))).body.error).toBe("not_your_agent");
  expect((await create(WRITER, listing("deep.writer.acme.near"))).status).toBe(200);
  expect(await rows()).toBe(1);
});

test("the_agent_must_be_active_and_bonded", async () => {
  for (const [account, agentId] of [
    [ACME, IDLE],
    [SOLO, LEAVING],
    // An account the index holds no agent for: the provider's by the registry's rule, but no agent.
    [ACME, "ghost.acme.near"],
  ] as const) {
    const refused = await create(account, listing(agentId));
    expect(refused.status, agentId).toBe(409);
    expect(refused.body.error).toBe("agent_not_active");
  }
  // Checked after ownership: a stranger is told it is not theirs, and nothing of the agent.
  expect((await create(OTHER, listing(IDLE))).body.error).toBe("not_your_agent");
  expect(await rows()).toBe(0);
});

test("the_words_follow_the_plain_text_rules_and_the_limits", async () => {
  const cases: Array<[string, Partial<CreateServiceRequest>, string]> = [
    ["a title too long", { title: "x".repeat(81) }, "expected at most 80 characters"],
    ["a title of two lines", { title: "one\ntwo" }, "expected one line, without line breaks"],
    [
      "an invisible character",
      { title: "Summarise\u200b" },
      "expected plain text, without invisible formatting characters (found U+200B)",
    ],
    [
      "a control character",
      { description: "bell\u0007" },
      "expected plain text, without control characters",
    ],
    [
      "a description too long",
      { description: "y".repeat(1001) },
      "expected at most 1000 characters",
    ],
    ["a blank title", { title: "   " }, "expected some text"],
    ["six tags", { tags: ["a", "b", "c", "d", "e", "f"] }, "Too big"],
    ["a tag twice", { tags: ["a", "a"] }, "expected each tag once"],
    ["a tag that is no tag", { tags: ["Not A Tag"] }, "Invalid string"],
    ["a price of 0", { price: "0" }, "expected a price above 0"],
    ["a price that is no u128", { price: "1.5" }, "expected a u128 as a decimal string"],
    [
      "a price no task can pay",
      { price: (SERVICE_MAX_PRICE + 1n).toString() },
      "the most a task can pay",
    ],
  ];
  for (const [what, over, message] of cases) {
    const refused = await create(ACME, listing(WRITER, over));
    expect(refused.status, what).toBe(400);
    expect(
      refused.body.issues?.some((issue) => issue.message.includes(message)),
      `${what}: ${JSON.stringify(refused.body.issues)}`,
    ).toBe(true);
  }
  const extra = await create(ACME, { ...listing(WRITER), status: "active" });
  expect(extra.status).toBe(400);
  expect(extra.body.issues?.[0]?.message).toBe("unrecognized key");
  // 80 characters of a script outside the first plane are 160 UTF-16 units, and are 80.
  expect((await create(ACME, listing(WRITER, { title: "\u{1d400}".repeat(80) }))).status).toBe(200);
  expect(await rows()).toBe(1);
});

test("the_windows_and_the_checks_are_ones_a_hire_can_be_made_of", async () => {
  const judged = (criteria: object, over: Partial<CreateServiceRequest> = {}) =>
    listing(WRITER, {
      output_format: "regex_json",
      verification: { kind: "judge", criteria: criteria as PublicCriteria },
      ...over,
    });
  const cases: Array<[string, object, string]> = [
    [
      "a window under the network's",
      listing(WRITER, { reveal_secs: 4 }),
      "reveal_secs must be at least 5",
    ],
    [
      "held-out checks",
      judged({ ...REGEX_CRITERIA, has_heldout: true }),
      "has_heldout must be false",
    ],
    [
      "kind exact",
      judged(
        {
          version: 1,
          kind: "exact",
          min_score: 100,
          split: "winner_take_all",
          has_heldout: false,
          normalize: [],
        },
        { output_format: "text" },
      ),
      "the Judge needs held-out checks for kind exact",
    ],
    [
      "a split",
      judged({ ...REGEX_CRITERIA, split: "equal" }),
      'the split must be "winner_take_all"',
    ],
    [
      "no example",
      judged({ ...REGEX_CRITERIA, examples: { match: [], no_match: [] } }),
      "kind regex_cases needs at least one example",
    ],
    [
      "a format the kind cannot read",
      judged(REGEX_CRITERIA, { output_format: "text" }),
      "output_format must be regex_json",
    ],
  ];
  for (const [what, body, message] of cases) {
    const refused = await create(ACME, body);
    expect(refused.status, what).toBe(400);
    const said = [refused.body.message, ...(refused.body.issues ?? []).map((i) => i.message)];
    expect(said.join(" "), what).toContain(message);
  }
  // The Judge checks only on an API that has one, and never a service the Judge itself offers.
  const noJudge = await create(ACME, judged(REGEX_CRITERIA), appWith({ judgeAccount: undefined }));
  expect(noJudge.status).toBe(400);
  expect(noJudge.body.message).toContain("this API has no Judge");
  await agent(JUDGE, { asp: null });
  const own = await create(JUDGE, { ...judged(REGEX_CRITERIA), agent: JUDGE });
  expect(own.body.message).toBe("the Judge cannot offer a service that the Judge checks");
  expect(await rows()).toBe(0);
});

test("a_provider_keeps_at_most_its_limit_of_services", async () => {
  for (let i = 0; i < SERVICES_PER_PROVIDER; i++) {
    const done = await insertService(
      deps.db,
      {
        provider: ACME,
        agent: WRITER,
        title: `Service ${i}`,
        description: "d",
        tags: [],
        category: "other",
        outputFormat: "text",
        token: TOKEN,
        price: "1",
        commitSecs: 60,
        revealSecs: 60,
        pickSecs: 60,
        verifier: "hirer",
        criteria: null,
        status: i % 2 === 0 ? "active" : "paused",
      },
      SERVICES_PER_PROVIDER,
    );
    expect(done.ok).toBe(true);
  }
  const refused = await create(ACME, listing(WRITER));
  expect(refused.status).toBe(409);
  expect(refused.body.error).toBe("service_limit");
  // Another provider is held to its own count.
  expect((await create(SOLO, listing(SOLO))).status).toBe(200);
});

test("writes_are_held_to_the_route_limit_and_the_body_cap", async () => {
  const app = appWith({ rateLimits: { services: { limit: 2, windowMs: 60_000 } } });
  expect((await create(ACME, listing(WRITER), app)).status).toBe(200);
  expect((await change("1", ACME, { status: "paused" }, app)).status).toBe(200);
  const limited = await create(ACME, listing(WRITER), app);
  expect(limited.status).toBe(429);
  expect(limited.body.error).toBe("rate_limited");
  expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  // Another account has its own count.
  expect((await create(SOLO, listing(SOLO), app)).status).toBe(200);

  const huge = await send<ErrorBody>("POST", "/v1/services", {
    account: ACME,
    raw: JSON.stringify({ ...listing(WRITER), description: "z".repeat(20_000) }),
  });
  expect(huge.status).toBe(413);
  expect(huge.body.error).toBe("payload_too_large");
  const notJson = await send<ErrorBody>("POST", "/v1/services", { account: ACME, raw: "{" });
  expect(notJson.status).toBe(400);
});

// ---- Changing -------------------------------------------------------------------------------

test("only_the_provider_changes_a_service_and_an_unknown_one_is_a_404", async () => {
  await create(ACME, listing(WRITER));
  const stranger = await change("1", OTHER, { price: "1" });
  expect(stranger.status).toBe(403);
  expect(stranger.body.error).toBe("not_provider");
  // The agent itself is not its provider.
  expect((await change("1", WRITER, { price: "1" })).body.error).toBe("not_provider");
  for (const id of ["2", "0", "01", "x", "18446744073709551615"]) {
    expect((await change(id, ACME, { price: "1" })).status, id).toBe(404);
  }
  expect((await change("1", ACME, {})).status).toBe(400);
  expect((await change("1", ACME, { agent: SOLO })).status).toBe(400);

  const edited = await change("1", ACME, { price: "3000000", title: "Summarise two filings" });
  expect(edited.status).toBe(200);
  expect(edited.body.service).toMatchObject({ price: "3000000", title: "Summarise two filings" });
  // The rules that span fields are checked on the service as it would be after the change.
  const judge = await change("1", ACME, {
    verification: { kind: "judge", criteria: REGEX_CRITERIA },
  });
  expect(judge.status).toBe(400);
  expect(judge.body.message).toBe(
    "kind regex_cases reads a regex: output_format must be regex_json",
  );
  expect(
    (
      await change("1", ACME, {
        output_format: "regex_json",
        verification: { kind: "judge", criteria: REGEX_CRITERIA },
      })
    ).status,
  ).toBe(200);
});

test("a_pause_is_always_taken_and_a_resume_needs_an_agent_that_can_work", async () => {
  await create(ACME, listing(WRITER));
  // The agent starts to leave after the listing.
  await deps.db.query("update agents set status = 'unregistering' where account = $1", [WRITER]);
  const shown = await send<ServiceBody>("GET", "/v1/services/1");
  expect(shown.body.service).toMatchObject({ status: "active", available: false });

  const paused = await change("1", ACME, { status: "paused" });
  expect(paused.status).toBe(200);
  expect(paused.body.service).toMatchObject({ status: "paused", available: false });
  // A change that leaves it paused is taken too.
  expect((await change("1", ACME, { description: "Back next week." })).status).toBe(200);
  const resumed = await change("1", ACME, { status: "active" });
  expect(resumed.status).toBe(409);
  expect(resumed.body.error).toBe("agent_not_active");

  await deps.db.query("update agents set status = 'active' where account = $1", [WRITER]);
  expect((await change("1", ACME, { status: "active" })).body.service).toMatchObject({
    status: "active",
    available: true,
  });
});

test("a_pause_alone_is_taken_even_when_the_terms_would_no_longer_pass", async () => {
  await create(
    ACME,
    listing(WRITER, {
      output_format: "regex_json",
      verification: { kind: "judge", criteria: REGEX_CRITERIA },
    }),
  );
  // The API lost its Judge since the listing: the terms would not pass now.
  const noJudge = appWith({ judgeAccount: undefined });
  const paused = await change("1", ACME, { status: "paused" }, noJudge);
  expect(paused.status).toBe(200);
  expect(paused.body.service.status).toBe("paused");
  // A change of terms, and a resume, are checked.
  expect((await change("1", ACME, { price: "1" }, noJudge)).status).toBe(400);
  expect((await change("1", ACME, { status: "active" }, noJudge)).status).toBe(400);
});

test("a_change_writes_the_status_only_when_it_names_one", async () => {
  await create(ACME, listing(WRITER));
  const [row] = await deps.db.query<Record<string, unknown>>(
    "select title, description, tags, category, output_format, token, price::text as price, commit_secs, reveal_secs, pick_secs from services where id = 1",
  );
  // A pause lands between the read of a change and its write: the write must not undo it.
  await change("1", ACME, { status: "paused" });
  const written = await updateService(deps.db, 1n, ACME, {
    title: String(row?.title),
    description: String(row?.description),
    tags: row?.tags as string[],
    category: String(row?.category),
    outputFormat: String(row?.output_format),
    token: String(row?.token),
    price: "7",
    commitSecs: Number(row?.commit_secs),
    revealSecs: Number(row?.reveal_secs),
    pickSecs: Number(row?.pick_secs),
    verifier: "hirer",
    criteria: null,
    status: null,
  });
  expect(written).toBe(true);
  expect((await send<ServiceBody>("GET", "/v1/services/1")).body.service).toMatchObject({
    price: "7",
    status: "paused",
  });
});

test("the_index_decides_whose_agent_an_indexed_account_is", async () => {
  // An indexed agent whose recorded provider is none: the name rule does not stand in for it.
  await agent("orphan.acme.near", { asp: null });
  expect((await create(ACME, listing("orphan.acme.near"))).body.error).toBe("not_your_agent");
});

// ---- Reading ------------------------------------------------------------------------------------

test("the_list_shows_what_can_be_hired_and_filters_and_pages", async () => {
  await create(ACME, listing(WRITER));
  await create(
    ACME,
    listing(WRITER, {
      title: "Extract dates",
      tags: ["dates"],
      price: "900000",
      category: "extraction",
    }),
  );
  await create(SOLO, listing(SOLO, { title: "Review 100% of a diff", token: "other.token.near" }));
  await create(ACME, listing(WRITER, { title: "Paused one" }));
  await change("4", ACME, { status: "paused" });

  const ids = async (query: string) => {
    const res = await list(query);
    expect(res.status, query).toBe(200);
    return ListServicesResponseSchema.parse(res.body).services.map((service) => service.id);
  };
  expect(await ids("")).toEqual(["3", "2", "1"]);
  expect(await ids("?status=all")).toEqual(["4", "3", "2", "1"]);
  expect(await ids("?q=extract")).toEqual(["2"]);
  expect(await ids("?q=SUMMARISE")).toEqual(["1"]);
  // A search is words, not a pattern: % and _ are themselves.
  expect(await ids(`?q=${encodeURIComponent("100%")}`)).toEqual(["3"]);
  expect(await ids("?q=%25")).toEqual(["3"]);
  expect(await ids("?q=_")).toEqual([]);
  expect(await ids("?tag=dates")).toEqual(["2"]);
  expect(await ids(`?provider=${ACME}&status=all`)).toEqual(["4", "2", "1"]);
  expect(await ids(`?agent=${SOLO}`)).toEqual(["3"]);
  expect(await ids(`?token=${TOKEN}&max_price=1000000`)).toEqual(["2"]);
  expect(await ids(`?token=${TOKEN}&max_price=2500000`)).toEqual(["2", "1"]);

  const first = await list("?limit=2");
  expect(first.body.next_cursor).toBe("2");
  expect(await ids("?limit=2&cursor=2")).toEqual(["1"]);
  expect((await list("?limit=2&cursor=2")).body.next_cursor).toBeNull();

  for (const query of [
    "?max_price=5",
    `?token=${TOKEN}&max_price=-1`,
    "?status=paused",
    `?q=${"q".repeat(81)}`,
    "?q=%20%20",
    "?tag=Not",
    "?provider=NOT",
    "?limit=0",
  ]) {
    expect((await list(query)).status, query).toBe(400);
  }
  for (const id of ["9", "0", "x", "-1", "99999999999999999999"]) {
    expect((await send("GET", `/v1/services/${id}`)).status, id).toBe(404);
  }
});

test("an_agent_that_leaves_drops_out_of_the_list_and_stays_readable", async () => {
  await create(ACME, listing(WRITER));
  await deps.db.query(
    "update agents set status = 'retired', bond_amount = null where account = $1",
    [WRITER],
  );
  expect((await list()).body.services).toEqual([]);
  const one = await send<ServiceBody>("GET", "/v1/services/1");
  expect(one.body.service).toMatchObject({ status: "active", available: false });
});

test("every_write_requires_sign_in", async () => {
  const app = createApp(deps);
  for (const headers of [{}, { authorization: "Bearer anything" }, { "x-test-account": ACME }]) {
    const res = await send<ErrorBody>("POST", "/v1/services", {
      app,
      body: listing(WRITER),
      headers,
    });
    expect(res.status).toBe(401);
    expect(
      (await send<ErrorBody>("POST", "/v1/services/1", { app, body: { price: "1" }, headers }))
        .status,
    ).toBe(401);
  }
  expect(await rows()).toBe(0);

  const asAcme = { authorization: `Bearer ${await tokenFor(ACME)}` };
  const made = await send<ServiceBody>("POST", "/v1/services", {
    app,
    body: listing(WRITER),
    headers: asAcme,
  });
  expect(made.status).toBe(200);
  expect(made.body.service.provider).toBe(ACME);
  const asOther = { authorization: `Bearer ${await tokenFor(OTHER)}` };
  expect(
    (
      await send<ErrorBody>("POST", "/v1/services/1", {
        app,
        body: { price: "1" },
        headers: asOther,
      })
    ).status,
  ).toBe(403);
  // The reads are public through the whole app.
  expect((await send("GET", "/v1/services", { app })).status).toBe(200);
  expect((await send("GET", "/v1/services/1", { app })).status).toBe(200);
});

// ---- The task list, for the hired side ---------------------------------------------------------

test("the_task_list_finds_the_pinned_tasks_that_invite_an_account", async () => {
  const SECOND = 1_000_000_000n;
  const commit = TEST_NOW + 60n * SECOND;
  const windows = {
    created_at: String(TEST_NOW - SECOND),
    commit_deadline: String(commit),
    reveal_deadline: String(commit + 60n * SECOND),
    pick_deadline: String(commit + 120n * SECOND),
    fallback_deadline: String(commit + 180n * SECOND),
  };
  await applyBlock(
    deps.db,
    blockOf(100n, [
      eventLine("task_created", { id: "2", invited: [WRITER], max_entries: 1, ...windows }),
      eventLine("task_created", { id: "3", invited: [], max_entries: 0, ...windows }),
      eventLine("task_created", { id: "4", invited: [SOLO, WRITER], max_entries: 2, ...windows }),
    ]),
    FIXTURE_OPTIONS,
  );
  const app = createApp(deps);
  const tasks = async (query: string) => {
    const res = await app.request(`/v1/tasks${query}`);
    expect(res.status, query).toBe(200);
    return ((await res.json()) as { tasks: Array<{ id: string }> }).tasks.map((task) => task.id);
  };
  expect(await tasks(`?invited=${WRITER}`)).toEqual(["4", "2"]);
  expect(await tasks(`?invited=${SOLO}&phase=open`)).toEqual(["4"]);
  expect(await tasks(`?invited=${OTHER}`)).toEqual([]);
  expect((await app.request("/v1/tasks?invited=NOT")).status).toBe(400);
});

test("the_task_list_finds_the_hires_by_the_shared_rule", async () => {
  // A service the hirer checks and one the Judge checks, both of writer's.
  const hirer = await create(ACME, listing(WRITER));
  const judged = await create(
    ACME,
    listing(WRITER, {
      output_format: "regex_json",
      verification: { kind: "judge", criteria: REGEX_CRITERIA },
    }),
  );
  const services = ListServicesResponseSchema.parse((await list("?status=all")).body).services;
  expect(services.map((service) => service.id).sort()).toEqual([hirer, judged].map(idOf).sort());
  const judgedHash = sha256Hex(canonicalJson(REGEX_CRITERIA));

  const SECOND = 1_000_000_000n;
  const commit = TEST_NOW + 60n * SECOND;
  const windows = {
    created_at: String(TEST_NOW - SECOND),
    commit_deadline: String(commit),
    reveal_deadline: String(commit + 60n * SECOND),
    pick_deadline: String(commit + 120n * SECOND),
    fallback_deadline: String(commit + 180n * SECOND),
  };
  const pinned = (id: string, over: object) =>
    eventLine("task_created", {
      id,
      poster: OTHER,
      invited: [WRITER],
      max_entries: 1,
      criteria_hash: HIRER_ACCEPTS_CRITERIA_HASH,
      ...windows,
      ...over,
    });
  await applyBlock(
    deps.db,
    blockOf(100n, [
      // Hires: writer alone, once, with the criteria of the hirer's acceptance or of its service.
      pinned("2", {}),
      pinned("3", { criteria_hash: judgedHash }),
      // Not hires: the service's criteria for an agent that does not offer it, more than one
      // entry, more than one invited account, none invited, and criteria of no service.
      pinned("4", { invited: [SOLO], criteria_hash: judgedHash }),
      pinned("5", { max_entries: 2 }),
      pinned("6", { invited: [WRITER, SOLO] }),
      pinned("7", { invited: [] }),
      pinned("8", { criteria_hash: "cd".repeat(32) }),
      // A hire by another hirer.
      pinned("9", { poster: SOLO }),
    ]),
    FIXTURE_OPTIONS,
  );
  const app = createApp(deps);
  const tasks = async (query: string) => {
    const res = await app.request(`/v1/tasks${query}`);
    expect(res.status, query).toBe(200);
    return ((await res.json()) as { tasks: Array<{ id: string }> }).tasks.map((task) => task.id);
  };
  expect(await tasks("?hire=true")).toEqual(["9", "3", "2"]);
  expect(await tasks(`?hire=true&poster=${OTHER}`)).toEqual(["3", "2"]);
  expect(await tasks(`?hire=true&poster=${OTHER}&limit=1`)).toEqual(["3"]);
  expect(await tasks(`?hire=true&poster=${OTHER}&cursor=3`)).toEqual(["2"]);
  expect(await tasks(`?hire=true&invited=${SOLO}`)).toEqual([]);
  // An empty value is no filter.
  expect(await tasks("?hire=")).toHaveLength(8);

  // The SQL is the shared rule: for every task, the list and `isHireTask` agree.
  const hires = new Set(await tasks("?hire=true"));
  for (const id of ["2", "3", "4", "5", "6", "7", "8", "9"]) {
    const detail = TaskDetailResponseSchema.parse(
      await (await app.request(`/v1/tasks/${id}`)).json(),
    );
    expect(isHireTask(detail.task, services), `task ${id}`).toBe(hires.has(id));
  }

  for (const value of ["false", "1", "yes", "TRUE"]) {
    const res = await app.request(`/v1/tasks?hire=${value}`);
    expect(res.status, value).toBe(400);
    expect(((await res.json()) as ErrorBody).message).toBe("hire must be true");
  }
});

/** The id of a service a create answered with. */
function idOf(reply: Reply<ServiceBody>): string {
  return String(reply.body.service.id);
}

// ---- Helpers ------------------------------------------------------------------------------------

async function rows(): Promise<number> {
  const [row] = await deps.db.query<{ n: number }>("select count(*)::int as n from services");
  return row?.n ?? 0;
}

async function tokenFor(account: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await deps.db.query(
    `insert into auth_tokens (token_sha256, account, public_key, key_kind, expires_at)
     values ($1, $2, 'ed25519:test', 'full_access', $3::timestamptz)`,
    [sha256Hex(token), account, new Date(Number(TEST_NOW / 1_000_000n) + 3_600_000).toISOString()],
  );
  return token;
}
