import {
  CONNECT_CODE_PATTERN,
  ConnectCodeCreatedSchema,
  ConnectCodeStateSchema,
  ConnectImplicitAgentsSchema,
  ConnectLookupSchema,
  ConnectRegisteredSchema,
  connectFingerprint,
  implicitAccountOf,
} from "@tender/shared";
import { Hono } from "hono";
import { KeyPair } from "near-api-js";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { AuthVariables, KeyKind, RequireAuth } from "../src/auth";
import { handleError } from "../src/format";
import { type ApiDeps, createApp, type ErrorBody } from "../src/index";
import { connectRoutes } from "../src/routes/connect";
import { resetDb, TEST_NOW, testDeps } from "./helpers";

// The connect codes of "Connect your agent". The routes are mounted on an app of their own with
// `stubAuth`, which reads the signed-in account and the kind of its key from headers, so most tests
// do not sign in; `codes_need_a_signed_in_owner` holds `createApp` itself to refusing a request with
// no bearer token. The clock is a variable, so a test moves it across a code's 30 minutes. Every rule
// of the routes has its test: who may make a code, the name, the plain-text rule and the body cap,
// single use, expiry, the fingerprint, who may read a code, the agent's last word, and the limits.

const SECOND_NS = 1_000_000_000n;
const MINUTE_NS = 60n * SECOND_NS;
const OWNER = "alice.testnet";

let deps: ApiDeps;
let nowNs = TEST_NOW;

beforeAll(async () => {
  deps = await testDeps({ network: "testnet", now: () => nowNs });
});

afterAll(() => deps.db.close());

beforeEach(async () => {
  await resetDb(deps.db);
  nowNs = TEST_NOW;
});

/**
 * A stand-in for sign-in: the account is the `x-test-account` header (none is no sign-in), and the
 * key kind is `x-test-key`, full access unless it says `function_call`.
 */
const stubAuth: RequireAuth = async (c, next) => {
  const account = c.req.header("x-test-account");
  if (account === undefined) {
    const body: ErrorBody = { error: "unauthorized", message: "sign in first" };
    return c.json(body, 401);
  }
  c.set("account", account);
  c.set("keyKind", (c.req.header("x-test-key") ?? "full_access") as KeyKind);
  await next();
};

function appWith(over: Partial<ApiDeps> = {}): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.onError(handleError);
  app.route("/v1", connectRoutes({ ...deps, ...over }, stubAuth));
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
  o: { account?: string; key?: KeyKind; body?: unknown; raw?: string; app?: Requester } = {},
): Promise<Reply<T>> {
  const headers: Record<string, string> = {};
  if (o.account !== undefined) headers["x-test-account"] = o.account;
  if (o.key !== undefined) headers["x-test-key"] = o.key;
  const body = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await (o.app ?? appWith()).request(path, { method, headers, body });
  return { status: res.status, body: (await res.json()) as T, headers: res.headers };
}

const publicKeyOf = () => KeyPair.fromRandom("ed25519").getPublicKey().toString();

async function makeCode(name = "writer", app?: Requester) {
  const reply = await send("POST", "/v1/connect/codes", {
    account: OWNER,
    body: { name },
    ...(app === undefined ? {} : { app }),
  });
  expect(reply.status).toBe(200);
  return ConnectCodeCreatedSchema.parse(reply.body);
}

const lookup = (code: string, app?: Requester) =>
  send("POST", "/v1/connect/lookup", { body: { code }, ...(app === undefined ? {} : { app }) });
const attach = (code: string, publicKey: string, app?: Requester) =>
  send("POST", "/v1/connect/attach", {
    body: { code, public_key: publicKey },
    ...(app === undefined ? {} : { app }),
  });
const stateOf = (id: string, account = OWNER) =>
  send("GET", `/v1/connect/codes/${id}`, { account });
const registered = (code: string) => send("POST", "/v1/connect/registered", { body: { code } });

/** Puts `account` in the index as an agent, as the indexer would on `agent_registered`. */
async function indexAgent(account: string, status = "active") {
  await deps.db.query(
    `insert into agents (account, asp, profile_uri, profile_hash, tags, registered_height, status,
                         bond_token, bond_amount)
     values ($1, $2, $3, $4, '[]'::jsonb, 100, $5, 'tusdc.testnet', 1000000)`,
    [account, OWNER, `tender://agent/${account}`, "a".repeat(64), status],
  );
}

// ---- Making a code ----------------------------------------------------------------------------

test("codes_need_a_signed_in_owner", async () => {
  const real = createApp(deps);
  const res = await real.request("/v1/connect/codes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "writer" }),
  });
  expect(res.status).toBe(401);
  expect(await res.json()).toMatchObject({ error: "unauthorized" });
  const read = await real.request("/v1/connect/codes/AAAAAAAAAAAAAAAAAAAAAA");
  expect(read.status).toBe(401);
  // The stub's refusal, for the same request without an account.
  expect((await send("POST", "/v1/connect/codes", { body: { name: "writer" } })).status).toBe(401);
});

test("a_code_is_made_only_with_a_full_access_key", async () => {
  const reply = await send<ErrorBody>("POST", "/v1/connect/codes", {
    account: OWNER,
    key: "function_call",
    body: { name: "writer" },
  });
  expect(reply.status).toBe(403);
  expect(reply.body.error).toBe("full_access_required");
  expect(await deps.db.query("select id from connect_codes")).toEqual([]);
});

test("a_code_is_bound_to_the_owner_and_the_name_and_lasts_30_minutes", async () => {
  const created = await makeCode("writer");
  expect(created.code).toMatch(CONNECT_CODE_PATTERN);
  expect(created).toMatchObject({
    owner: OWNER,
    name: "writer",
    account_id: `writer.${OWNER}`,
    expires_at: new Date(Number(TEST_NOW / 1_000_000n) + 30 * 60_000).toISOString(),
  });
  // Two codes are never the same.
  expect((await makeCode("writer")).code).not.toBe(created.code);

  const state = await stateOf(created.id);
  expect(state.status).toBe(200);
  expect(state.headers.get("cache-control")).toBe("no-store");
  expect(ConnectCodeStateSchema.parse(state.body)).toMatchObject({
    id: created.id,
    account_id: `writer.${OWNER}`,
    state: "waiting",
    public_key: null,
    fingerprint: null,
    agent: null,
  });
});

test("the_code_itself_is_never_stored_only_its_hash", async () => {
  const created = await makeCode();
  const rows = await deps.db.query<Record<string, unknown>>("select * from connect_codes");
  expect(rows).toHaveLength(1);
  const stored = JSON.stringify(rows);
  expect(stored).not.toContain(created.code);
  expect(stored).not.toContain(created.code.slice(3));
});

test("the_name_follows_the_sub_account_rules_in_the_pages_words", async () => {
  const refused = async (name: unknown, account = OWNER) => {
    const reply = await send<ErrorBody>("POST", "/v1/connect/codes", { account, body: { name } });
    expect(reply.status).toBe(400);
    return reply.body.issues?.[0]?.message;
  };
  expect(await refused("Writer")).toMatch(/one part of an account id/);
  expect(await refused("two.parts")).toMatch(/one part of an account id/);
  expect(await refused("-dash")).toMatch(/one part of an account id/);
  expect(await refused("a__b")).toMatch(/one part of an account id/);
  expect(await refused("")).toMatch(/one part of an account id/);
  expect(await refused(7)).toBeDefined();
  // The whole id is 64 characters at most: the words say how long it came out.
  expect(await refused("w".repeat(60))).toBe(
    `Too long: ${"w".repeat(60)}.${OWNER} is ${61 + OWNER.length} characters, and an account id is 64 at most.`,
  );
  // An implicit account can have no account under it.
  expect(await refused("writer", "a".repeat(64))).toMatch(/too long to have accounts under it/);
  expect(await deps.db.query("select id from connect_codes")).toEqual([]);
});

test("invisible_and_control_characters_are_refused_as_on_the_board", async () => {
  const refused = async (body: unknown, path = "/v1/connect/codes") => {
    const reply = await send<ErrorBody>("POST", path, { account: OWNER, body });
    expect(reply.status).toBe(400);
    return reply.body.issues?.[0]?.message;
  };
  // Each is named, and never cleaned up and taken.
  expect(await refused({ name: "wri​ter" })).toBe(
    "expected plain text, without invisible formatting characters (found U+200B)",
  );
  expect(await refused({ name: "writer\u{E0041}" })).toBe(
    "expected plain text, without invisible formatting characters (found U+E0041)",
  );
  expect(await refused({ name: "writer\u0000" })).toBe(
    "expected plain text, without control characters",
  );
  expect(await refused({ name: "writer‮" })).toBe(
    "expected plain text, without invisible formatting characters (found U+202E)",
  );
  const { code } = await makeCode();
  expect(await refused({ code: `${code}‍` }, "/v1/connect/lookup")).toBe(
    "expected plain text, without invisible formatting characters (found U+200D)",
  );
  expect(await refused({ code, public_key: `${publicKeyOf()}﻿` }, "/v1/connect/attach")).toBe(
    "expected plain text, without invisible formatting characters (found U+FEFF)",
  );
});

test("bodies_are_capped_at_16_KiB_and_must_be_the_routes_own", async () => {
  const big = JSON.stringify({ name: "w".repeat(17_000) });
  for (const path of [
    "/v1/connect/codes",
    "/v1/connect/lookup",
    "/v1/connect/attach",
    "/v1/connect/contest",
    "/v1/connect/registered",
  ]) {
    const reply = await send<ErrorBody>("POST", path, { account: OWNER, raw: big });
    expect(reply.status, path).toBe(413);
    expect(reply.body.error).toBe("payload_too_large");
  }
  // An unknown key, and a body that is not JSON.
  expect(
    (await send("POST", "/v1/connect/codes", { account: OWNER, body: { name: "w", x: 1 } })).status,
  ).toBe(400);
  expect((await send("POST", "/v1/connect/lookup", { raw: "{not json" })).status).toBe(400);
});

// ---- The agent's side -------------------------------------------------------------------------

test("a_lookup_says_what_the_code_is_for_and_where", async () => {
  const created = await makeCode();
  const reply = await lookup(created.code);
  expect(reply.status).toBe(200);
  expect(reply.headers.get("cache-control")).toBe("no-store");
  expect(ConnectLookupSchema.parse(reply.body)).toEqual({
    owner: OWNER,
    name: "writer",
    account_id: `writer.${OWNER}`,
    account_kind: "sub_account",
    network: "testnet",
    contract: deps.contractId,
    state: "waiting",
    expires_at: created.expires_at,
    fingerprint: null,
  });
  // A code of the right shape that was never made, and one of the wrong shape.
  const unknown = await lookup(`tc_${"a".repeat(26)}`);
  expect(unknown.status).toBe(404);
  expect((unknown.body as ErrorBody).message).toMatch(/ask the owner for a new one/);
  expect((await lookup("tc_short")).status).toBe(400);
  expect((await lookup(created.code.toUpperCase())).status).toBe(400);
});

test("attaching_stores_the_public_key_once_and_both_sides_see_its_fingerprint", async () => {
  const created = await makeCode();
  const key = publicKeyOf();
  const reply = await attach(created.code, key);
  expect(reply.status).toBe(200);
  const answered = ConnectLookupSchema.parse(reply.body);
  expect(answered.state).toBe("attached");
  expect(answered.fingerprint).toBe(connectFingerprint(key));
  expect(answered.fingerprint).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);

  const state = ConnectCodeStateSchema.parse((await stateOf(created.id)).body);
  expect(state).toMatchObject({
    state: "attached",
    public_key: key,
    fingerprint: connectFingerprint(key),
    attached_at: new Date(Number(TEST_NOW / 1_000_000n)).toISOString(),
  });
  // The lookup tells a second run of the agent which key the code has.
  expect(ConnectLookupSchema.parse((await lookup(created.code)).body).fingerprint).toBe(
    connectFingerprint(key),
  );
});

test("a_code_is_single_use_the_same_key_again_is_the_same_answer_and_another_is_refused", async () => {
  const { code, id } = await makeCode();
  const key = publicKeyOf();
  expect((await attach(code, key)).status).toBe(200);
  // The agent asking again, its first answer lost.
  const again = await attach(code, key);
  expect(again.status).toBe(200);
  expect(ConnectLookupSchema.parse(again.body).fingerprint).toBe(connectFingerprint(key));
  // Anyone else's key.
  const other = await attach(code, publicKeyOf());
  expect(other.status).toBe(409);
  expect((other.body as ErrorBody).error).toBe("already_attached");
  expect((other.body as ErrorBody).message).toMatch(/do not create the account/);
  const state = ConnectCodeStateSchema.parse((await stateOf(id)).body);
  expect(state.public_key).toBe(key);
});

test("of_attachments_at_once_exactly_one_is_taken", async () => {
  const { code, id } = await makeCode();
  const keys = Array.from({ length: 8 }, publicKeyOf);
  const replies = await Promise.all(keys.map((key) => attach(code, key)));
  const taken = replies.filter((reply) => reply.status === 200);
  expect(taken).toHaveLength(1);
  expect(replies.filter((reply) => reply.status === 409)).toHaveLength(7);
  const state = ConnectCodeStateSchema.parse((await stateOf(id)).body);
  const [winner] = taken;
  expect(state.fingerprint).toBe(
    (winner?.body as { fingerprint?: string } | undefined)?.fingerprint,
  );
});

test("only_a_public_key_is_taken", async () => {
  const { code } = await makeCode();
  const pair = KeyPair.fromRandom("ed25519");
  for (const bad of [
    // A private key: 64 bytes.
    pair.toString(),
    pair.getPublicKey().toString().slice("ed25519:".length),
    `ED25519:${pair.getPublicKey().toString().slice("ed25519:".length)}`,
    "ed25519:",
    `ed25519:${"1".repeat(45)}`,
    "secp256k1:abc",
  ]) {
    const reply = await attach(code, bad);
    expect(reply.status, bad.slice(0, 12)).toBe(400);
    expect((reply.body as ErrorBody).issues?.[0]?.message).toBe(
      "expected a public key: ed25519: and 32 bytes in base58",
    );
    // A refusal says nothing of what was sent.
    if (bad.length > 20) expect(JSON.stringify(reply.body)).not.toContain(bad.slice(10));
  }
  expect((await lookup(code)).body).toMatchObject({ state: "waiting" });
});

test("a_code_that_took_no_key_in_30_minutes_expires_and_one_that_did_stays_readable", async () => {
  const late = await makeCode("late");
  const early = await makeCode("early");
  const key = publicKeyOf();
  expect((await attach(early.code, key)).status).toBe(200);

  nowNs = TEST_NOW + 30n * MINUTE_NS - 1n;
  expect((await lookup(late.code)).body).toMatchObject({ state: "waiting" });
  nowNs = TEST_NOW + 30n * MINUTE_NS;
  expect((await lookup(late.code)).body).toMatchObject({ state: "expired" });
  const refused = await attach(late.code, publicKeyOf());
  expect(refused.status).toBe(410);
  expect((refused.body as ErrorBody).error).toBe("code_expired");
  expect(ConnectCodeStateSchema.parse((await stateOf(late.id)).body).state).toBe("expired");

  // The one that has its key is still the owner's to act on, and its key does not change.
  nowNs = TEST_NOW + 5n * 60n * MINUTE_NS;
  expect(ConnectCodeStateSchema.parse((await stateOf(early.id)).body)).toMatchObject({
    state: "attached",
    public_key: key,
  });
  expect((await attach(early.code, publicKeyOf())).status).toBe(409);
});

test("rows_go_a_day_after_their_code_expired", async () => {
  const old = await makeCode("old");
  nowNs = TEST_NOW + 30n * MINUTE_NS + 24n * 60n * MINUTE_NS - 1n;
  await makeCode("kept");
  expect((await stateOf(old.id)).status).toBe(200);
  nowNs = TEST_NOW + 30n * MINUTE_NS + 24n * 60n * MINUTE_NS + MINUTE_NS;
  await makeCode("new");
  expect((await stateOf(old.id)).status).toBe(404);
  expect((await lookup(old.code)).status).toBe(404);
});

test("a_code_is_read_by_its_owner_alone", async () => {
  const { id } = await makeCode();
  expect((await stateOf(id, "mallory.testnet")).status).toBe(404);
  expect((await stateOf("not-an-id")).status).toBe(404);
  expect((await stateOf(`${id.slice(0, -1)}${id.endsWith("A") ? "B" : "A"}`)).status).toBe(404);
});

// ---- Contested --------------------------------------------------------------------------------

const contest = (code: string) => send("POST", "/v1/connect/contest", { body: { code } });

test("a_second_different_key_marks_the_code_contested_and_every_read_says_so", async () => {
  const { code, id, account_id } = await makeCode();
  const first = publicKeyOf();
  expect((await attach(code, first)).status).toBe(200);
  expect(ConnectCodeStateSchema.parse((await stateOf(id)).body).contested_at).toBeNull();

  nowNs = TEST_NOW + MINUTE_NS;
  const second = await attach(code, publicKeyOf());
  expect(second.status).toBe(409);
  expect((second.body as ErrorBody).error).toBe("already_attached");

  const contestedAt = new Date(Number(nowNs / 1_000_000n)).toISOString();
  expect(ConnectCodeStateSchema.parse((await stateOf(id)).body)).toMatchObject({
    state: "contested",
    public_key: first,
    contested_at: contestedAt,
  });
  expect(ConnectLookupSchema.parse((await lookup(code)).body).state).toBe("contested");
  // The first key asking again still gets its answer, which says contested.
  expect(ConnectLookupSchema.parse((await attach(code, first)).body).state).toBe("contested");
  // The first time is the one kept.
  nowNs += MINUTE_NS;
  await attach(code, publicKeyOf());
  expect(ConnectCodeStateSchema.parse((await stateOf(id)).body).contested_at).toBe(contestedAt);

  // A contested code is not taken as registered, whatever the index says.
  await indexAgent(account_id);
  const done = await registered(code);
  expect(done.status).toBe(409);
  expect((done.body as ErrorBody).error).toBe("contested");
  expect(ConnectCodeStateSchema.parse((await stateOf(id)).body).state).toBe("contested");
});

test("the_agent_contests_a_code_whose_key_is_not_its_own_and_sends_nothing_secret", async () => {
  const { code, id } = await makeCode();
  // Nothing attached: nothing to contest, and nothing changes.
  const early = await contest(code);
  expect(early.status).toBe(409);
  expect((early.body as ErrorBody).error).toBe("not_attached");
  expect(ConnectCodeStateSchema.parse((await stateOf(id)).body).state).toBe("waiting");

  expect((await attach(code, publicKeyOf())).status).toBe(200);
  const contested = await contest(code);
  expect(contested.status).toBe(200);
  expect(contested.headers.get("cache-control")).toBe("no-store");
  expect(ConnectLookupSchema.parse(contested.body).state).toBe("contested");
  expect(ConnectCodeStateSchema.parse((await stateOf(id)).body).state).toBe("contested");
  // The route takes the code and nothing else.
  expect(
    (await send("POST", "/v1/connect/contest", { body: { code, public_key: publicKeyOf() } }))
      .status,
  ).toBe(400);
  expect((await contest(`tc_${"q".repeat(26)}`)).status).toBe(404);
});

// ---- Registered -------------------------------------------------------------------------------

test("the_agents_word_that_it_registered_is_taken_once_the_index_shows_it", async () => {
  const { code, id, account_id } = await makeCode();
  const notAttached = await registered(code);
  expect(notAttached.status).toBe(409);
  expect((notAttached.body as ErrorBody).error).toBe("not_attached");

  expect((await attach(code, publicKeyOf())).status).toBe(200);
  const early = await registered(code);
  expect(early.status).toBe(409);
  expect((early.body as ErrorBody).error).toBe("not_registered");
  expect(early.headers.get("retry-after")).toBe("5");

  // Retired is not active.
  await indexAgent(account_id, "retired");
  expect((await registered(code)).status).toBe(409);
  await deps.db.query("update agents set status = 'active' where account = $1", [account_id]);

  nowNs = TEST_NOW + 2n * MINUTE_NS;
  const done = await registered(code);
  expect(done.status).toBe(200);
  expect(ConnectRegisteredSchema.parse(done.body)).toEqual({
    account_id,
    state: "registered",
    registered_at: new Date(Number(nowNs / 1_000_000n)).toISOString(),
  });
  // Saying it twice changes nothing.
  nowNs += MINUTE_NS;
  expect((await registered(code)).body).toEqual(done.body);

  const state = ConnectCodeStateSchema.parse((await stateOf(id)).body);
  expect(state).toMatchObject({
    state: "registered",
    agent: { status: "active", bond_token: "tusdc.testnet", bond_amount: "1000000" },
  });
});

// ---- The implicit account ---------------------------------------------------------------------

const toImplicit = (id: string, o: { account?: string; key?: KeyKind } = {}) =>
  send("POST", `/v1/connect/codes/${id}/implicit`, { account: o.account ?? OWNER, ...o });
const implicitAgents = (account = OWNER) => send("GET", "/v1/connect/implicit", { account });

test("the_owner_moves_an_attached_code_to_the_implicit_account_of_its_key", async () => {
  const { code, id, account_id } = await makeCode();
  expect(account_id).toBe(`writer.${OWNER}`);
  // No key yet: there is no implicit account to choose.
  const early = await toImplicit(id);
  expect(early.status).toBe(409);
  expect((early.body as ErrorBody).error).toBe("not_attached");

  const key = publicKeyOf();
  expect(ConnectLookupSchema.parse((await attach(code, key)).body).account_kind).toBe(
    "sub_account",
  );
  const moved = await toImplicit(id);
  expect(moved.status).toBe(200);
  expect(moved.headers.get("cache-control")).toBe("no-store");
  const implicit = implicitAccountOf(key);
  expect(ConnectCodeStateSchema.parse(moved.body)).toMatchObject({
    account_kind: "implicit",
    account_id: implicit,
    name: "writer",
    public_key: key,
    state: "attached",
  });
  // Every read says so, the agent's too, and asking again changes nothing.
  expect(ConnectCodeStateSchema.parse((await stateOf(id)).body).account_id).toBe(implicit);
  expect(ConnectLookupSchema.parse((await lookup(code)).body)).toMatchObject({
    account_kind: "implicit",
    account_id: implicit,
  });
  expect((await toImplicit(id)).body).toEqual(moved.body);

  // The agent's word that it registered is held to the implicit account in the index.
  expect((await registered(code)).status).toBe(409);
  await indexAgent(implicit ?? "");
  expect((await registered(code)).status).toBe(200);
});

test("only_the_owners_own_key_moves_a_code_and_nothing_names_the_account", async () => {
  const { code, id } = await makeCode();
  const key = publicKeyOf();
  await attach(code, key);
  const fnKey = await toImplicit(id, { key: "function_call" });
  expect(fnKey.status).toBe(403);
  expect((fnKey.body as ErrorBody).error).toBe("full_access_required");
  expect((await toImplicit(id, { account: "mallory.testnet" })).status).toBe(404);
  expect((await toImplicit("not-an-id")).status).toBe(404);
  expect((await send("POST", `/v1/connect/codes/${id}/implicit`, {})).status, "signed out").toBe(
    401,
  );
  // A body naming another account is not read: the account is the key's own.
  const named = await send("POST", `/v1/connect/codes/${id}/implicit`, {
    account: OWNER,
    body: { account_id: "mallory.testnet" },
  });
  expect(ConnectCodeStateSchema.parse(named.body).account_id).toBe(implicitAccountOf(key));
});

test("a_contested_or_registered_code_keeps_its_account", async () => {
  const contested = await makeCode("first");
  await attach(contested.code, publicKeyOf());
  await attach(contested.code, publicKeyOf());
  const refused = await toImplicit(contested.id);
  expect(refused.status).toBe(409);
  expect((refused.body as ErrorBody).error).toBe("contested");

  const done = await makeCode("second");
  await attach(done.code, publicKeyOf());
  await indexAgent(done.account_id);
  expect((await registered(done.code)).status).toBe(200);
  const late = await toImplicit(done.id);
  expect(late.status).toBe(409);
  expect((late.body as ErrorBody).error).toBe("already_registered");
  expect(ConnectCodeStateSchema.parse((await stateOf(done.id)).body)).toMatchObject({
    account_kind: "sub_account",
    account_id: done.account_id,
  });
});

test("the_owners_implicit_agents_are_listed_and_kept_past_their_day", async () => {
  // One sub-account code, one implicit agent registered, one implicit agent not yet, and one
  // implicit code contested afterwards, which is not listed.
  const sub = await makeCode("sub");
  await attach(sub.code, publicKeyOf());
  const keyA = publicKeyOf();
  const a = await makeCode("alpha");
  await attach(a.code, keyA);
  await toImplicit(a.id);
  await indexAgent(implicitAccountOf(keyA) ?? "");
  nowNs += MINUTE_NS;
  const keyB = publicKeyOf();
  const b = await makeCode("beta");
  await attach(b.code, keyB);
  await toImplicit(b.id);
  const c = await makeCode("gamma");
  await attach(c.code, publicKeyOf());
  await toImplicit(c.id);
  await send("POST", "/v1/connect/contest", { body: { code: c.code } });

  const list = await implicitAgents();
  expect(list.status).toBe(200);
  expect(list.headers.get("cache-control")).toBe("no-store");
  expect(ConnectImplicitAgentsSchema.parse(list.body).agents).toEqual([
    {
      id: b.id,
      account_id: implicitAccountOf(keyB),
      name: "beta",
      created_at: new Date(Number((TEST_NOW + MINUTE_NS) / 1_000_000n)).toISOString(),
      agent: null,
    },
    {
      id: a.id,
      account_id: implicitAccountOf(keyA),
      name: "alpha",
      created_at: new Date(Number(TEST_NOW / 1_000_000n)).toISOString(),
      agent: { status: "active", bond_token: "tusdc.testnet", bond_amount: "1000000" },
    },
  ]);
  expect(ConnectImplicitAgentsSchema.parse((await implicitAgents("bob.testnet")).body)).toEqual({
    agents: [],
  });
  expect((await send("GET", "/v1/connect/implicit", {})).status).toBe(401);

  // Days later, a new code clears the old rows: the implicit agents' stay, the others go.
  nowNs = TEST_NOW + 3n * 24n * 60n * MINUTE_NS;
  await makeCode("later");
  expect((await stateOf(sub.id)).status).toBe(404);
  expect((await stateOf(c.id)).status).toBe(404);
  expect((await stateOf(a.id)).status).toBe(200);
  expect(ConnectImplicitAgentsSchema.parse((await implicitAgents()).body).agents).toHaveLength(2);
});

const dismiss = (id: string, o: { account?: string; key?: KeyKind } = {}) =>
  send("POST", `/v1/connect/codes/${id}/dismiss`, { account: o.account ?? OWNER, ...o });

test("the_owner_dismisses_an_implicit_agent_the_index_does_not_list_and_nothing_else", async () => {
  const key = publicKeyOf();
  const solo = await makeCode("solo");
  await attach(solo.code, key);
  await toImplicit(solo.id);

  // Only the owner's own key, and only the owner's own code.
  const fnKey = await dismiss(solo.id, { key: "function_call" });
  expect(fnKey.status).toBe(403);
  expect((fnKey.body as ErrorBody).error).toBe("full_access_required");
  expect((await dismiss(solo.id, { account: "mallory.testnet" })).status).toBe(404);
  expect((await send("POST", `/v1/connect/codes/${solo.id}/dismiss`, {})).status).toBe(401);
  // A code on the sub-account is not dismissed: it goes by itself after its day.
  const sub = await makeCode("sub");
  expect((await dismiss(sub.id)).status).toBe(404);
  expect((await stateOf(sub.id)).status).toBe(200);

  // An agent the index lists stays.
  const listed = await makeCode("listed");
  const listedKey = publicKeyOf();
  await attach(listed.code, listedKey);
  await toImplicit(listed.id);
  await indexAgent(implicitAccountOf(listedKey) ?? "");
  const refused = await dismiss(listed.id);
  expect(refused.status).toBe(409);
  expect((refused.body as ErrorBody).error).toBe("registered");
  expect((await stateOf(listed.id)).status).toBe(200);

  // The unfunded one goes: its row, its code and its place in the list.
  const done = await dismiss(solo.id);
  expect(done.status).toBe(200);
  expect(done.headers.get("cache-control")).toBe("no-store");
  expect(done.body).toEqual({ dismissed: true });
  expect((await stateOf(solo.id)).status).toBe(404);
  expect((await lookup(solo.code)).status).toBe(404);
  expect(
    ConnectImplicitAgentsSchema.parse((await implicitAgents()).body).agents.map((a) => a.name),
  ).toEqual(["listed"]);
  expect((await dismiss(solo.id)).status).toBe(404);
});

// ---- Limits -----------------------------------------------------------------------------------

test("an_owner_makes_a_limited_number_of_codes", async () => {
  const app = appWith({ rateLimits: { connectCreate: { limit: 2, windowMs: 60_000 } } });
  await makeCode("one", app);
  await makeCode("two", app);
  const third = await send<ErrorBody>("POST", "/v1/connect/codes", {
    account: OWNER,
    body: { name: "three" },
    app,
  });
  expect(third.status).toBe(429);
  expect(third.body.error).toBe("rate_limited");
  expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
  // Another owner has a limit of its own.
  expect(
    (await send("POST", "/v1/connect/codes", { account: "bob.testnet", body: { name: "x" }, app }))
      .status,
  ).toBe(200);
});

test("a_client_is_held_to_a_limit_on_the_routes_no_account_signs", async () => {
  const { code } = await makeCode();
  const app = appWith({ rateLimits: { connectClient: { limit: 3, windowMs: 60_000 } } });
  expect((await lookup(code, app)).status).toBe(200);
  expect((await attach(code, publicKeyOf(), app)).status).toBe(200);
  expect((await lookup(code, app)).status).toBe(200);
  const over = await lookup(code, app);
  expect(over.status).toBe(429);
  expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
  // The same limit counts the codes made from that client, before anyone is signed in.
  expect(
    (await send("POST", "/v1/connect/codes", { account: OWNER, body: { name: "x" }, app })).status,
  ).toBe(429);
});

test("an_owners_page_is_held_to_a_limit_on_reads", async () => {
  const { id } = await makeCode();
  const app = appWith({ rateLimits: { connectRead: { limit: 2, windowMs: 60_000 } } });
  const read = () => send("GET", `/v1/connect/codes/${id}`, { account: OWNER, app });
  expect((await read()).status).toBe(200);
  expect((await read()).status).toBe(200);
  expect((await read()).status).toBe(429);
});
