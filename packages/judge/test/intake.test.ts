import { type BlobKind, type Db, getBlob, putBlob, recordHeldoutUpload } from "@tender/db";
import { canonicalJson, sha256Hex, type TaskView } from "@tender/shared";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import {
  intakeTask,
  type JudgeDeps,
  newJudgeMemory,
  ScorerUnavailableError,
  scoreJsonSchema,
} from "../src/index";
import { checkJsonSchemaIsolated, TOO_SLOW_TO_COMPILE } from "../src/isolate";
import {
  at,
  fakeChain,
  insertTask,
  JUDGE,
  judgeDeps,
  judgeRow,
  MINUTE_NS,
  NOW_NS,
  POSTER,
  putCriteria,
  putHeldout,
  resetDb,
  TEAM_POSTER,
  taskView,
  testDb,
} from "./helpers";

// The real check runs, in its worker, unless a test makes it fail with `mockRejectedValueOnce`.
// (`mockClear` before counting calls: the mock keeps them from one test to the next.)
vi.mock("../src/isolate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/isolate")>();
  return { ...actual, checkJsonSchemaIsolated: vi.fn(actual.checkJsonSchemaIsolated) };
});

const EXACT = {
  version: 1,
  kind: "exact",
  min_score: 100,
  split: "winner_take_all",
  has_heldout: true,
  normalize: ["trim"],
};
const EXACT_HELDOUT = { exact: { expected: ["42"] } };
const JSON_SCHEMA = {
  version: 1,
  kind: "json_schema",
  min_score: 100,
  split: "winner_take_all",
  has_heldout: true,
  schema: { type: "object", required: ["total"] },
};
const JSON_SCHEMA_HELDOUT = { json_schema: { assertions: [{ path: "$.total", equals: 42 }] } };
const REGEX = {
  version: 1,
  kind: "regex_cases",
  min_score: 100,
  split: "winner_take_all",
  has_heldout: false,
  examples: { match: ["a"], no_match: ["b"] },
};
const REGEX_HELDOUT = { regex_cases: { match: ["aa"], no_match: ["bb"] } };
const RUBRIC = {
  version: 1,
  kind: "rubric",
  min_score: 50,
  split: "winner_take_all",
  has_heldout: false,
  rubric: [{ criterion: "clear", weight: 1 }],
};
/** The model server of a Judge that can grade rubric tasks. Intake does not call it. */
const LLM = { baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-test-intake", model: "test-model" };
/** The brief of the rubric tasks here. */
const BRIEF = {
  version: 1,
  title: "Describe a lighthouse",
  summary: "One paragraph about a lighthouse.",
  instructions: "Write one paragraph of at most 80 words that describes a lighthouse at night.",
  category: "writing",
  tags: ["writing"],
  output: { format: "text", max_bytes: 2000 },
};
const TESTS = {
  version: 1,
  kind: "tests",
  min_score: 100,
  split: "winner_take_all",
  has_heldout: false,
  language: "js",
  entry: "f",
  examples: [{ input: 1, output: 2 }],
};

const BUILT_IN_REFERENCE = "criteria schema is not supported: a reference names a built-in member";
const REFERENCE_NOT_ALLOWED =
  'criteria schema is not supported: a reference must be "#" or point to a $defs or definitions entry (move the schema it points to into $defs)';
// A pointer that is already to a $defs entry, where the entry is the problem (the #14 hint).
const REFERENCE_TARGET_UNUSABLE =
  'criteria schema is not supported: a reference points to a $defs or definitions entry that is not there, is not a schema, or has a "%" in its name';
const DYNAMIC_REFERENCE =
  "criteria schema is not supported: $dynamicRef and $recursiveRef are not supported, use $ref";
const ID_BELOW_ROOT = "criteria schema is not supported: $id is only allowed at the root";
/** Text from someone's private answer, which no public reason may quote. */
const SECRET = "secret-part-of-someone-elses-private-answer";
const HAS_HELDOUT_MISMATCH = "has_heldout does not match the task's held-out commitment";
const NO_MODEL = "no model is configured to grade rubric tasks";
const ENTRIES_NEEDED =
  "kind rubric needs max_entries 0 for an open task, or 1 to 50 for an invite-only one";
const MIN_SCORE_NEEDED = "kind rubric needs a min_score of at least 1";
/** The accounts an invite-only task names. */
const INVITED = ["alice.test.near", "bob.test.near"];
const BRIEF_UNREADABLE = "the task's brief could not be read";
const TOO_MANY_CRITERIA = "kind rubric has more than 20 criteria";
const CRITERION_TOO_LONG = "kind rubric has a criterion of more than 200 characters";
const CRITERION_BLANK = "kind rubric has a blank criterion";
const CRITERION_BRACKET = "kind rubric has a criterion with an angle bracket in it";
const CRITERIA_COLLIDE = "kind rubric has two criteria that read the same";
/** The characters that are, or fold to, an angle bracket, with a name for each. */
const ANGLE_BRACKETS: [name: string, bracket: string][] = [
  ["a <", "<"],
  ["a >", ">"],
  ["a fullwidth <", "\u{FF1C}"],
  ["a fullwidth >", "\u{FF1E}"],
  ["a small <", "\u{FE64}"],
  ["a small >", "\u{FE65}"],
  ["a not-less-than sign", "\u{226E}"],
  ["a not-greater-than sign", "\u{226F}"],
];
/** More than the largest document intake reads. */
const TOO_LONG = "a".repeat(262_144);

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * Stores `content` as it is, the way a client that skipped the canonical form might have. A
 * held-out document is recorded as `uploader`'s upload, as `POST /v1/heldout` records one.
 */
async function putRaw(
  db: Db,
  kind: BlobKind,
  content: Uint8Array,
  uploader = POSTER,
): Promise<string> {
  const sha256 = await putBlob(db, {
    kind,
    contentType: "application/json",
    bytes: content,
    uploader,
    isPublic: kind !== "heldout",
  });
  if (kind === "heldout") await recordHeldoutUpload(db, { sha256, account: uploader });
  return sha256;
}

/** The re-review's probe 1 for `keyword`: `t` names the number schema in `$defs`. */
const dynamicProbe = (keyword: string) => ({
  $defs: { n: { type: "number" } },
  properties: { x: { type: "integer" }, t: { [keyword]: "#/$defs/n" } },
});

/** The re-review's probe 2 for `keyword`: an array entry whose items name the whole schema. */
const recursionProbe = (keyword: string) => ({
  type: "object",
  required: ["x"],
  $defs: { e: { type: "array", items: { [keyword]: "#" } } },
  properties: { x: { type: "integer" }, t: { $ref: "#/$defs/e" } },
});

/** A json_schema task with `schema`, and its held-out checks, stored. */
async function jsonSchemaTask(
  db: Db,
  schema: Record<string, unknown>,
  heldout: object = JSON_SCHEMA_HELDOUT,
): Promise<Partial<TaskView>> {
  return {
    criteria_hash: await putCriteria(db, { ...JSON_SCHEMA, schema }),
    heldout_commitment: await putHeldout(db, heldout),
  };
}

/** An exact task whose held-out blob is `heldout`, stored as it is by the poster. */
async function exactTaskWithRawHeldout(db: Db, heldout: Uint8Array): Promise<Partial<TaskView>> {
  return {
    criteria_hash: await putCriteria(db, EXACT),
    heldout_commitment: await putRaw(db, "heldout", heldout),
  };
}

/** A rubric of these criteria, each of weight 1. */
const rubricOf = (...criteria: string[]) => ({
  ...RUBRIC,
  rubric: criteria.map((criterion) => ({ criterion, weight: 1 })),
});

/** `n` different criteria. */
const numbered = (n: number): string[] => Array.from({ length: n }, (_, i) => `criterion ${i}`);

/**
 * A rubric task from the team that intake can take, given a Judge with a model (`LLM`): `criteria`
 * (the rubric above unless given), a brief that is stored, and no list of invited accounts and no
 * cap on entries, which is the open task the post wizard posts (P05-R21). `over` changes the task.
 */
async function rubricTask(
  criteria: object = RUBRIC,
  over: Partial<TaskView> = {},
): Promise<Partial<TaskView>> {
  return {
    poster: TEAM_POSTER,
    criteria_hash: await putCriteria(db, criteria),
    brief_hash: await putRaw(db, "brief", canonicalJson(BRIEF), TEAM_POSTER),
    max_entries: 0,
    invited: [],
    ...over,
  };
}

let db: Db;

beforeAll(async () => {
  db = await testDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  vi.restoreAllMocks();
});

/** Stores task `id`, made of `view`, and runs intake on it at `NOW`, as a Judge made with `over`. */
async function intake(
  id: number,
  view: Partial<TaskView>,
  status: string | null = null,
  over: Partial<JudgeDeps> = {},
) {
  await insertTask(db, taskView({ id: `${id}`, ...view }), status);
  return intakeTask(judgeDeps(db, fakeChain(null), over), BigInt(id));
}

test("intake_rejects_each_rule", { timeout: 60_000 }, async () => {
  // Each rule is broken by one task of its own, so every reason is checked against the others.
  const rules: {
    rule: string;
    reason: string;
    view: () => Promise<Partial<TaskView>>;
    /** What the Judge is made with besides the test defaults: no model unless it says so. */
    deps?: Partial<JudgeDeps>;
  }[] = [
    {
      rule: "no criteria stored under criteria_hash",
      reason: "criteria not found or invalid",
      view: async () => ({ criteria_hash: sha256Hex("never stored") }),
    },
    {
      rule: "criteria that are not JSON",
      reason: "criteria not found or invalid",
      view: async () => ({ criteria_hash: await putRaw(db, "criteria", bytes("{not json")) }),
    },
    {
      rule: "criteria that are not UTF-8",
      reason: "criteria not found or invalid",
      view: async () => ({ criteria_hash: await putRaw(db, "criteria", Uint8Array.of(0xff)) }),
    },
    {
      rule: "criteria that do not fit the criteria schema",
      reason: "criteria not found or invalid",
      view: async () => ({ criteria_hash: await putCriteria(db, { ...REGEX, version: 2 }) }),
    },
    {
      // The review's probe: someone's private result, shaped like criteria, whose schema names a
      // secret. Read as criteria, Ajv quoted the secret in the public reason.
      rule: "a criteria_hash that names someone's private result",
      reason: "criteria not found or invalid",
      view: async () => ({
        criteria_hash: await putBlob(db, {
          kind: "result",
          contentType: "application/json",
          bytes: canonicalJson({ ...JSON_SCHEMA, schema: { $ref: `#/$defs/${SECRET}` } }),
          uploader: "alice.test.near",
          isPublic: false,
        }),
      }),
    },
    {
      rule: "criteria stored as a criteria blob that is not public",
      reason: "criteria not found or invalid",
      view: async () => ({
        criteria_hash: await putBlob(db, {
          kind: "criteria",
          contentType: "application/json",
          bytes: canonicalJson({ ...REGEX, min_score: 99 }),
          uploader: POSTER,
          isPublic: false,
        }),
      }),
    },
    {
      rule: "criteria stored as a public blob of another kind",
      reason: "criteria not found or invalid",
      view: async () => ({
        criteria_hash: await putRaw(db, "brief", canonicalJson({ ...REGEX, min_score: 98 })),
      }),
    },
    {
      rule: "criteria larger than 262_144 bytes",
      reason: "criteria too large",
      view: async () => ({
        criteria_hash: await putCriteria(db, {
          ...REGEX,
          examples: { match: [TOO_LONG], no_match: [] },
        }),
      }),
    },
    {
      rule: "rubric from a poster outside the team (C16)",
      reason: "kind rubric is limited to team tasks in v1",
      view: async () => ({ criteria_hash: await putCriteria(db, RUBRIC) }),
    },
    {
      rule: "tests from a poster outside the team (C16)",
      reason: "kind tests is limited to team tasks in v1",
      view: async () => ({ criteria_hash: await putCriteria(db, TESTS) }),
    },
    {
      // A rubric is graded by a model against public weights: it has no held-out part to commit to.
      rule: "rubric from the team that says it has held-out checks",
      reason: "kind rubric has no held-out checks",
      view: async () => ({
        poster: TEAM_POSTER,
        criteria_hash: await putCriteria(db, { ...RUBRIC, has_heldout: true }),
        // Never stored: the rule is found before the checks are looked for. (Storing a document
        // that a later row leaves out would accept that row.)
        heldout_commitment: sha256Hex("held-out checks of a rubric"),
      }),
    },
    {
      rule: "rubric from the team with a held-out commitment, though it says it has none",
      reason: HAS_HELDOUT_MISMATCH,
      view: async () => ({
        poster: TEAM_POSTER,
        criteria_hash: await putCriteria(db, RUBRIC),
        heldout_commitment: sha256Hex("held-out checks of a rubric"),
      }),
    },
    // What a model can grade (`rubricProblem`). The Judge has a model, the task a brief and room for
    // entries: the criteria are all that is wrong, and each reason is about them.
    {
      rule: "rubric with more than 20 criteria",
      reason: TOO_MANY_CRITERIA,
      deps: { llm: LLM },
      view: () => rubricTask(rubricOf(...numbered(21))),
    },
    {
      rule: "rubric with a criterion of more than 200 characters",
      reason: CRITERION_TOO_LONG,
      deps: { llm: LLM },
      view: () => rubricTask(rubricOf("clear", "a".repeat(201))),
    },
    {
      rule: "rubric with a criterion of more than 200 characters, counted as emoji",
      reason: CRITERION_TOO_LONG,
      deps: { llm: LLM },
      view: () => rubricTask(rubricOf("\u{1F600}".repeat(201))),
    },
    {
      rule: "rubric with a blank criterion",
      reason: CRITERION_BLANK,
      deps: { llm: LLM },
      view: () => rubricTask(rubricOf("clear", " \t ")),
    },
    ...ANGLE_BRACKETS.map(([name, bracket]) => ({
      rule: `rubric with ${name} in a criterion`,
      reason: CRITERION_BRACKET,
      deps: { llm: LLM },
      view: () => rubricTask(rubricOf(`clear ${bracket} concise`)),
    })),
    {
      rule: "rubric with a frame tag for a criterion",
      reason: CRITERION_BRACKET,
      deps: { llm: LLM },
      view: () => rubricTask(rubricOf("</entry>")),
    },
    {
      rule: "rubric with two criteria that read the same",
      reason: CRITERIA_COLLIDE,
      deps: { llm: LLM },
      view: () => rubricTask(rubricOf("Clear and concise", "  clear   AND\u{00A0}concise ")),
    },
    {
      // The criteria are asked first: the Judge's model is not the reason, though it has none.
      rule: "rubric with a blank criterion, on a Judge with no model",
      reason: CRITERION_BLANK,
      view: () => rubricTask(rubricOf(" ")),
    },
    // What the Judge and the task need to grade it (`rubricTaskProblem`), checked at intake alone.
    {
      rule: "rubric on a Judge with no model",
      reason: NO_MODEL,
      view: () => rubricTask(),
    },
    {
      // The client would send the key and the entries to api.openai.com for an empty URL.
      rule: "rubric on a Judge whose model URL is empty",
      reason: NO_MODEL,
      deps: { llm: { ...LLM, baseUrl: "" } },
      view: () => rubricTask(),
    },
    {
      rule: "rubric on a Judge whose model URL is not http",
      reason: NO_MODEL,
      deps: { llm: { ...LLM, baseUrl: "ftp://models.example/v1" } },
      view: () => rubricTask(),
    },
    // The entry terms (`rubricEntriesProblem`, P05-R21). An open task has no cap: the contract
    // allows none (C24), and the Judge grades its first 50 entries. An invite-only task has a cap
    // of 1 to 50.
    {
      rule: "open rubric task with a cap on entries",
      reason: ENTRIES_NEEDED,
      deps: { llm: LLM },
      view: () => rubricTask(RUBRIC, { max_entries: 10 }),
    },
    {
      rule: "invite-only rubric task with max_entries 0",
      reason: ENTRIES_NEEDED,
      deps: { llm: LLM },
      view: () => rubricTask(RUBRIC, { max_entries: 0, invited: INVITED }),
    },
    {
      rule: "invite-only rubric task with max_entries 51",
      reason: ENTRIES_NEEDED,
      deps: { llm: LLM },
      view: () => rubricTask(RUBRIC, { max_entries: 51, invited: INVITED }),
    },
    {
      rule: "invite-only rubric task with max_entries far above the limit",
      reason: ENTRIES_NEEDED,
      deps: { llm: LLM },
      view: () => rubricTask(RUBRIC, { max_entries: 2_000_000_000, invited: INVITED }),
    },
    {
      // P05-R20: a disqualified entry scores 0, and a pass mark of 0 would pass it.
      rule: "rubric with a min_score of 0",
      reason: MIN_SCORE_NEEDED,
      deps: { llm: LLM },
      view: () => rubricTask({ ...RUBRIC, min_score: 0 }),
    },
    {
      // The criteria are asked first, then the pass mark.
      rule: "rubric with a blank criterion and a min_score of 0",
      reason: CRITERION_BLANK,
      deps: { llm: LLM },
      view: () => rubricTask({ ...rubricOf(" "), min_score: 0 }),
    },
    {
      rule: "rubric whose brief is not stored",
      reason: BRIEF_UNREADABLE,
      deps: { llm: LLM },
      view: () => rubricTask(RUBRIC, { brief_hash: sha256Hex("no brief was stored") }),
    },
    {
      rule: "rubric whose brief is not JSON",
      reason: BRIEF_UNREADABLE,
      deps: { llm: LLM },
      view: async () =>
        rubricTask(RUBRIC, {
          brief_hash: await putRaw(db, "brief", bytes("{not json"), TEAM_POSTER),
        }),
    },
    {
      rule: "rubric whose brief does not fit the brief schema",
      reason: BRIEF_UNREADABLE,
      deps: { llm: LLM },
      view: async () =>
        rubricTask(RUBRIC, {
          brief_hash: await putRaw(
            db,
            "brief",
            canonicalJson({ ...BRIEF, version: 2 }),
            TEAM_POSTER,
          ),
        }),
    },
    {
      // Someone's private result, shaped like a brief: it is not read, and nothing of it is said.
      rule: "rubric whose brief_hash names someone's private result",
      reason: BRIEF_UNREADABLE,
      deps: { llm: LLM },
      view: async () =>
        rubricTask(RUBRIC, {
          brief_hash: await putBlob(db, {
            kind: "result",
            contentType: "application/json",
            bytes: canonicalJson({ ...BRIEF, title: SECRET }),
            uploader: "alice.test.near",
            isPublic: false,
          }),
        }),
    },
    {
      rule: "tests from the team, which has no scorer yet",
      reason: "kind tests is not available yet",
      view: async () => ({ poster: TEAM_POSTER, criteria_hash: await putCriteria(db, TESTS) }),
    },
    {
      rule: "has_heldout without a held-out commitment",
      reason: HAS_HELDOUT_MISMATCH,
      view: async () => ({ criteria_hash: await putCriteria(db, { ...REGEX, has_heldout: true }) }),
    },
    {
      rule: "a held-out commitment without has_heldout",
      reason: HAS_HELDOUT_MISMATCH,
      view: async () => ({
        criteria_hash: await putCriteria(db, REGEX),
        heldout_commitment: await putHeldout(db, REGEX_HELDOUT),
      }),
    },
    {
      rule: "exact with no held-out checks",
      reason: "held-out checks required for kind exact",
      view: async () => ({
        criteria_hash: await putCriteria(db, { ...EXACT, has_heldout: false }),
      }),
    },
    {
      rule: "json_schema with no held-out checks",
      reason: "held-out checks required for kind json_schema",
      view: async () => ({
        criteria_hash: await putCriteria(db, { ...JSON_SCHEMA, has_heldout: false }),
      }),
    },
    {
      rule: "an $async schema, which checkJsonSchemaUsable refuses",
      reason: 'criteria schema is not supported: it is an "$async" schema',
      view: () => jsonSchemaTask(db, { $async: true, type: "object" }),
    },
    // P05-R10: a reference is "#", or names an entry of the root's $defs or definitions.
    {
      rule: "a $ref to a member of the root itself",
      reason: REFERENCE_NOT_ALLOWED,
      view: () => jsonSchemaTask(db, { $ref: "#/constructor" }),
    },
    {
      rule: "the same name, percent-encoded",
      reason: REFERENCE_NOT_ALLOWED,
      view: () => jsonSchemaTask(db, { $ref: "#/%63onstructor" }),
    },
    {
      rule: "a $ref into $defs by a member every object has",
      reason: BUILT_IN_REFERENCE,
      view: () =>
        jsonSchemaTask(db, { $defs: {}, properties: { a: { $ref: "#/$defs/toString" } } }),
    },
    {
      rule: "a $defs entry named after an Object.prototype member, though it is defined",
      reason: BUILT_IN_REFERENCE,
      view: () =>
        jsonSchemaTask(db, {
          $defs: { constructor: { type: "string" } },
          properties: { a: { $ref: "#/$defs/constructor" } },
        }),
    },
    // The review of ac7f8a2: a pointer that lands on a map of names, an array or a number.
    {
      rule: "a $ref to a map of names",
      reason: REFERENCE_NOT_ALLOWED,
      view: () =>
        jsonSchemaTask(db, { properties: { a: { type: "string" } }, $ref: "#/properties" }),
    },
    {
      rule: "a $ref into an array of schemas",
      reason: REFERENCE_NOT_ALLOWED,
      view: () => jsonSchemaTask(db, { allOf: [{ type: "string" }], $ref: "#/allOf/0" }),
    },
    {
      // Ajv would land on x's map of names. The entry named "x/properties" (`x~1properties` in a
      // pointer) is a decoy for a reading of the rest of the pointer as one name.
      rule: "a $ref past a $defs entry",
      reason: REFERENCE_NOT_ALLOWED,
      view: () =>
        jsonSchemaTask(db, {
          $defs: { x: { properties: { a: { type: "string" } } }, "x/properties": true },
          $ref: "#/$defs/x/properties",
        }),
    },
    {
      rule: "a $defs entry that is an array",
      reason: REFERENCE_TARGET_UNUSABLE,
      view: () => jsonSchemaTask(db, { $defs: { x: [{ type: "string" }] }, $ref: "#/$defs/x" }),
    },
    {
      rule: "a $defs entry that is a number",
      reason: REFERENCE_TARGET_UNUSABLE,
      view: () => jsonSchemaTask(db, { $defs: { x: 5 }, $ref: "#/$defs/x" }),
    },
    {
      rule: "a $ref to a $defs entry that is not there",
      reason: REFERENCE_TARGET_UNUSABLE,
      view: () => jsonSchemaTask(db, { $defs: { y: { type: "string" } }, $ref: "#/$defs/x" }),
    },
    {
      // A percent-escape is refused, not decoded, so that the name read here is the one Ajv reads:
      // Ajv would look up `a`, not the `%61` that is defined.
      rule: "a $defs name that is percent-encoded",
      reason: REFERENCE_TARGET_UNUSABLE,
      view: () => jsonSchemaTask(db, { $defs: { "%61": { type: "string" } }, $ref: "#/$defs/%61" }),
    },
    {
      rule: "a $ref with a URI before its fragment",
      reason: REFERENCE_NOT_ALLOWED,
      view: () => jsonSchemaTask(db, { $ref: "hasOwnProperty#" }),
    },
    // The first review's three: a URI before a pointer took Ajv through a built-in member.
    {
      rule: "a $ref into the root by its $id",
      reason: REFERENCE_NOT_ALLOWED,
      view: () =>
        jsonSchemaTask(db, {
          $id: "https://t.example/root.json",
          allOf: [{}],
          $ref: "root.json#/allOf/length",
        }),
    },
    {
      rule: "a $ref into a resource inside the schema",
      reason: REFERENCE_NOT_ALLOWED,
      view: () =>
        jsonSchemaTask(db, {
          $defs: { x: { $id: "https://t.example/x.json", allOf: [{}] } },
          $ref: "https://t.example/x.json#/allOf/length",
        }),
    },
    {
      rule: "a $ref by $id into a string",
      reason: REFERENCE_NOT_ALLOWED,
      view: () =>
        jsonSchemaTask(db, {
          $id: "https://t.example/root.json",
          $defs: { s: { type: "string" } },
          $ref: "root.json#/$defs/s/type/length",
        }),
    },
    // P05-R9: the schema is one resource, named only at its root.
    {
      rule: "an $id below the root",
      reason: ID_BELOW_ROOT,
      view: () =>
        jsonSchemaTask(db, {
          type: "object",
          properties: {
            a: { $id: "https://t.example/a.json", allOf: [{}, { $ref: "#/allOf/length" }] },
          },
        }),
    },
    {
      rule: "a root $id with a fragment",
      reason: "criteria schema is not supported: the root $id must not have a fragment",
      view: () => jsonSchemaTask(db, { $id: "https://t.example/root.json#foo", type: "object" }),
    },
    {
      // The review of d75de82: Ajv compiles what such a pointer finds as a schema, though it is
      // data to the walk.
      rule: "a pointer into examples",
      reason: REFERENCE_NOT_ALLOWED,
      view: () =>
        jsonSchemaTask(db, {
          type: "object",
          examples: [{ type: "number" }],
          properties: { x: { $ref: "#/examples/0" } },
        }),
    },
    {
      rule: "a pointer into default",
      reason: REFERENCE_NOT_ALLOWED,
      view: () =>
        jsonSchemaTask(db, {
          type: "object",
          default: { type: "number" },
          properties: { x: { $ref: "#/default" } },
        }),
    },
    {
      rule: "a pointer into the default of a schema below the root",
      reason: REFERENCE_NOT_ALLOWED,
      view: () =>
        jsonSchemaTask(db, {
          type: "object",
          properties: { a: { default: { type: "number" } }, b: { $ref: "#/properties/a/default" } },
        }),
    },
    // The re-review's probe B: an `$id` of "" or "#" is still an `$id` below the root.
    ...[
      ['$id "" on the schema with the $ref', { $id: "", $ref: "#/allOf/length" }],
      ['$id "#" on the schema with the $ref', { $id: "#", $ref: "#/allOf/length" }],
      ['$id "" on an ancestor', { $id: "", anyOf: [{ $ref: "#/allOf/length" }] }],
      ['$id "" and a step into a string', { $id: "", $ref: "#/$defs/s/type/length" }],
    ].map(([rule, total]) => ({
      rule: String(rule),
      reason: ID_BELOW_ROOT,
      view: () =>
        jsonSchemaTask(db, {
          type: "object",
          required: ["total"],
          allOf: [{}],
          $defs: { s: { type: "string" } },
          properties: { total: total as object },
        }),
    })),
    {
      // Data keywords are skipped only as keywords: under `properties` a name is just a name.
      rule: "a property named default, whose schema is still walked",
      reason: REFERENCE_NOT_ALLOWED,
      view: () =>
        jsonSchemaTask(db, {
          type: "object",
          allOf: [{}],
          properties: { default: { $ref: "#/allOf/length" } },
        }),
    },
    {
      rule: "a $ref to a resource embedded by its $id",
      reason: REFERENCE_NOT_ALLOWED,
      view: () =>
        jsonSchemaTask(db, {
          $id: "https://example.com/schemas/order",
          type: "object",
          $defs: { addr: { $id: "address", type: "object" } },
          properties: { shipTo: { $ref: "address" } },
        }),
    },
    {
      rule: "a $ref whose fragment cannot be decoded",
      reason: REFERENCE_NOT_ALLOWED,
      view: () => jsonSchemaTask(db, { $ref: "#/%E0%A4%A" }),
    },
    {
      rule: "a $dynamicRef to an anchor",
      reason: DYNAMIC_REFERENCE,
      view: () => jsonSchemaTask(db, { $dynamicRef: "#isPrototypeOf" }),
    },
    // P05-R11, the re-review's probe 1: Ajv checks `t` against the root, not against `n`, so
    // `t: "text"` would score 100. And probe 2: inside a $defs entry, `$dynamicRef: "#"` recurses
    // into the entry, not into the root.
    ...["$dynamicRef", "$recursiveRef"].map((keyword) => ({
      rule: `a ${keyword} to a $defs entry`,
      reason: DYNAMIC_REFERENCE,
      view: () => jsonSchemaTask(db, dynamicProbe(keyword)),
    })),
    {
      rule: 'a $dynamicRef to "#" inside a $defs entry',
      reason: DYNAMIC_REFERENCE,
      view: () => jsonSchemaTask(db, recursionProbe("$dynamicRef")),
    },
    // The security review of 0b3af35: under a keyword that maps names to schemas, a member named
    // like a data keyword is a schema, and is walked as one, so a dynamic reference in it is found.
    ...["dependencies", "dependentSchemas", "patternProperties", "$defs"].flatMap((container) =>
      ["const", "enum", "default", "examples"].flatMap((name) =>
        [
          ["$dynamicRef", "#/$defs/n"],
          ["$recursiveRef", "#"],
        ].map(([keyword, target]) => ({
          rule: `a ${keyword} in a ${container} member named ${name}`,
          reason: DYNAMIC_REFERENCE,
          view: () =>
            jsonSchemaTask(db, {
              $defs: { n: { type: "number" } },
              [container]: { [name]: { [String(keyword)]: target } },
            }),
        })),
      ),
    ),
    {
      rule: "a $ref to a member every array has",
      reason: REFERENCE_NOT_ALLOWED,
      view: () => jsonSchemaTask(db, { allOf: [{}], $ref: "#/allOf/length" }),
    },
    {
      rule: "held-out checks of another kind",
      reason: "held-out checks are for another kind",
      view: async () => ({
        criteria_hash: await putCriteria(db, EXACT),
        heldout_commitment: await putHeldout(db, { regex_cases: { match: ["x"], no_match: [] } }),
      }),
    },
    {
      rule: "held-out checks that do not fit the held-out schema",
      reason: "held-out checks invalid",
      view: async () => ({
        criteria_hash: await putCriteria(db, EXACT),
        heldout_commitment: await putHeldout(db, { exact: { expected: [] } }),
      }),
    },
    {
      rule: "held-out checks that are not JSON",
      reason: "held-out checks invalid",
      view: () => exactTaskWithRawHeldout(db, bytes('{"exact":')),
    },
    {
      rule: "held-out checks with a lone surrogate, which have no canonical form",
      reason: "held-out checks invalid",
      view: () => exactTaskWithRawHeldout(db, bytes('{"exact":{"expected":["\\ud800"]}}')),
    },
    {
      rule: "held-out checks whose bytes are not their canonical form",
      reason: "held-out checks do not match the commitment",
      view: () => exactTaskWithRawHeldout(db, bytes(JSON.stringify(EXACT_HELDOUT, null, 2))),
    },
    {
      rule: "held-out checks larger than 262_144 bytes",
      reason: "held-out checks too large",
      view: async () => ({
        criteria_hash: await putCriteria(db, EXACT),
        heldout_commitment: await putHeldout(db, { exact: { expected: [TOO_LONG] } }),
      }),
    },
    {
      // `taskView` posts the task 20 minutes before `NOW`.
      rule: "held-out checks still missing 10 minutes after posting",
      reason: "held-out checks missing",
      view: async () => ({
        criteria_hash: await putCriteria(db, EXACT),
        heldout_commitment: sha256Hex(canonicalJson(EXACT_HELDOUT)),
      }),
    },
  ];

  for (const [i, { rule, reason, view, deps }] of rules.entries()) {
    const id = i + 1;
    expect(await intake(id, await view(), null, deps), rule).toBe("rejected");
    expect(await judgeRow(db, id), rule).toEqual({
      judge_status: "rejected",
      judge_reason: reason,
    });
  }
  // No reason quotes what a private blob holds.
  const reasons = await db.query<{ judge_reason: string | null }>("select judge_reason from tasks");
  expect(reasons.filter(({ judge_reason }) => judge_reason?.includes(SECRET))).toEqual([]);
});

test("intake_rejects_a_schema_that_does_not_compile_with_a_short_reason", {
  timeout: 30_000,
}, async () => {
  expect(await intake(1, await jsonSchemaTask(db, { type: 12 }))).toBe("rejected");
  expect((await judgeRow(db, 1))?.judge_reason).toMatch(/^criteria schema cannot be compiled: /);

  // Ajv names the meta-schema it cannot find, and a poster can make that as long as the
  // criteria. The reason keeps the first 199 code points and an ellipsis.
  const metaSchema = `https://t.example/${"x".repeat(10_000)}`;
  // Its own held-out checks: a task whose checks are used already is turned away for that first.
  const own = { json_schema: { assertions: [{ path: "$.other", equals: 2 }] } };
  expect(await intake(2, await jsonSchemaTask(db, { $schema: metaSchema }, own))).toBe("rejected");
  const reason = (await judgeRow(db, 2))?.judge_reason ?? "";
  expect(reason).toMatch(
    /^criteria schema cannot be compiled: no schema with key or ref "https:\/\/t\.example\/x+…$/,
  );
  expect([...reason]).toHaveLength(200);
});

// Each json_schema task here starts a worker for its schema check.
test("intake_accepts_the_p0_kinds", { timeout: 30_000 }, async () => {
  const accepted: Partial<TaskView>[] = [
    {
      criteria_hash: await putCriteria(db, EXACT),
      heldout_commitment: await putHeldout(db, EXACT_HELDOUT),
    },
    await jsonSchemaTask(db, JSON_SCHEMA.schema),
    // A $ref to a definition of its own is no built-in member. (Checks of its own, too: held-out
    // checks are single-use.)
    await jsonSchemaTask(
      db,
      { $defs: { total: { type: "number" } }, $ref: "#/$defs/total" },
      { json_schema: { assertions: [{ path: "$", equals: 42 }] } },
    ),
    // The shapes P05-R9 and P05-R10 keep: a root `$id` that is a URL, with or without a bare `#`;
    // `#/$defs/x` and `#/definitions/x`; `#` for the whole schema; and entry names with `~1` and
    // `~0` in them, one of them a boolean schema.
    await jsonSchemaTask(
      db,
      {
        $id: "https://example.com/schemas/order.json",
        type: "object",
        $defs: { item: { type: "string" } },
        properties: { a: { $ref: "#/$defs/item" } },
      },
      { json_schema: { assertions: [{ path: "$", equals: 43 }] } },
    ),
    await jsonSchemaTask(
      db,
      {
        $id: "https://example.com/schemas/tree.json#",
        type: "object",
        definitions: { item: { type: "string" } },
        properties: {
          a: { $ref: "#/definitions/item" },
          children: { type: "array", items: { $ref: "#" } },
        },
      },
      { json_schema: { assertions: [{ path: "$", equals: 45 }] } },
    ),
    await jsonSchemaTask(
      db,
      {
        type: "object",
        $defs: { "a/b": { type: "string" }, "c~d": true },
        properties: { x: { $ref: "#/$defs/a~1b" }, y: { $ref: "#/$defs/c~0d" } },
      },
      { json_schema: { assertions: [{ path: "$", equals: 46 }] } },
    ),
    // The re-review's two probes with `$ref`, which goes where it says.
    await jsonSchemaTask(db, dynamicProbe("$ref"), {
      json_schema: { assertions: [{ path: "$", equals: 47 }] },
    }),
    await jsonSchemaTask(db, recursionProbe("$ref"), {
      json_schema: { assertions: [{ path: "$", equals: 48 }] },
    }),
    // `dependencies` as written for property dependencies: a list of names, no schema at all.
    await jsonSchemaTask(
      db,
      {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" } },
        dependencies: { a: ["b"] },
      },
      { json_schema: { assertions: [{ path: "$", equals: 49 }] } },
    ),
    // What reads like a reference inside data is data: the values of const, enum, examples and
    // default are no schemas, whatever names they hold.
    await jsonSchemaTask(
      db,
      {
        type: "object",
        properties: {
          link: { const: { $ref: "other.json" } },
          kind: { enum: [{ $ref: "#/constructor" }] },
          spec: { type: "object", default: { $ref: "./pet.yaml" } },
        },
        examples: [{ spec: { $ref: "./pet.yaml" } }],
      },
      { json_schema: { assertions: [{ path: "$", equals: 44 }] } },
    ),
    // regex_cases may go without held-out checks: the published examples are the cases then.
    { criteria_hash: await putCriteria(db, REGEX) },
    {
      criteria_hash: await putCriteria(db, { ...REGEX, has_heldout: true }),
      heldout_commitment: await putHeldout(db, REGEX_HELDOUT),
    },
  ];
  for (const [i, view] of accepted.entries()) {
    expect(await intake(i + 1, view), `task ${i + 1}`).toBe("accepted");
    expect(await judgeRow(db, i + 1)).toEqual({ judge_status: "accepted", judge_reason: null });
  }
});

test("intake_accepts_a_rubric_from_the_team_that_the_judge_can_grade", async () => {
  // A rubric has no schema to compile and no held-out checks to wait for, so a team task is
  // accepted at once when the Judge has a model, the task is open (no cap on entries: the Judge
  // grades the first 50, P05-R21) or invite-only with a cap of 1 to 50, its brief reads and its
  // criteria are within the limits, at the edge of each. Nothing is asked of the model: the URL
  // below is a port nobody listens on.
  const edge = Array.from(
    { length: 20 },
    (_, i) => `${String(i).padStart(3, "0")}${"x".repeat(197)}`,
  );
  const accepted: Partial<TaskView>[] = [
    await rubricTask(),
    await rubricTask(RUBRIC, { max_entries: 1, invited: INVITED }),
    await rubricTask(RUBRIC, { max_entries: 50, invited: INVITED }),
    // The lowest pass mark a rubric may have.
    await rubricTask({ ...RUBRIC, min_score: 1 }),
    // 20 criteria of 200 characters each.
    await rubricTask(rubricOf(...edge)),
    // 200 characters that are 400 UTF-16 units.
    await rubricTask(rubricOf("\u{1F600}".repeat(200))),
    // Criteria that read differently, though nearly alike: another word, another letter.
    await rubricTask(rubricOf("clear", "clearer", "cl\u{0435}ar")),
    // A brief written in XML: the grader is shown its angle brackets as ‹ ›.
    await rubricTask(RUBRIC, {
      brief_hash: await putRaw(
        db,
        "brief",
        canonicalJson({ ...BRIEF, instructions: "Answer in XML: <entry>x</entry>" }),
        TEAM_POSTER,
      ),
    }),
  ];

  for (const [i, view] of accepted.entries()) {
    expect(await intake(i + 1, view, null, { llm: LLM }), `task ${i + 1}`).toBe("accepted");
    expect(await judgeRow(db, i + 1), `task ${i + 1}`).toEqual({
      judge_status: "accepted",
      judge_reason: null,
    });
  }
});

test("intake_asks_a_rubric_task_for_a_model_only_once_it_is_otherwise_sound", async () => {
  // A rubric task from a poster outside the team is refused for that, with or without a model.
  const view = { criteria_hash: await putCriteria(db, RUBRIC) };
  expect(await intake(1, view, null, { llm: LLM })).toBe("rejected");
  expect(await judgeRow(db, 1)).toEqual({
    judge_status: "rejected",
    judge_reason: "kind rubric is limited to team tasks in v1",
  });

  // A task that was decided stays decided: a Judge that has a model later does not take back a
  // refusal made when it had none.
  const task = await rubricTask();
  expect(await intake(2, task)).toBe("rejected");
  expect(await judgeRow(db, 2)).toEqual({ judge_status: "rejected", judge_reason: NO_MODEL });
  expect(await intakeTask(judgeDeps(db, fakeChain(null), { llm: LLM }), 2n)).toBe("rejected");
  expect(await judgeRow(db, 2)).toEqual({ judge_status: "rejected", judge_reason: NO_MODEL });

  // The kinds with no model to ask are taken by a Judge that has none.
  expect(await intake(3, { criteria_hash: await putCriteria(db, REGEX) })).toBe("accepted");
});

test("the_probe_shapes_with_ref_check_what_they_point_to", () => {
  // What intake accepts in their place checks what it says. In probe 1 `t` must be a number; in
  // probe 2 each item of `t` must be the whole schema: an object with an integer `x`.
  const score = (schema: Record<string, unknown>, document: unknown) =>
    scoreJsonSchema(
      {
        version: 1,
        kind: "json_schema",
        min_score: 100,
        split: "winner_take_all",
        has_heldout: true,
        schema,
      },
      { assertions: [{ path: "$.x", equals: 1 }] },
      bytes(JSON.stringify(document)),
    ).score;

  expect(score(dynamicProbe("$ref"), { x: 1, t: "text" })).toBe(0);
  expect(score(dynamicProbe("$ref"), { x: 1, t: 2 })).toBe(100);
  expect(score(recursionProbe("$ref"), { x: 1, t: [[]] })).toBe(0);
  expect(score(recursionProbe("$ref"), { x: 1, t: [{ x: 2 }] })).toBe(100);
});

test("intake_pending_then_accepted_when_heldout_arrives", async () => {
  // Posted a minute before `NOW`; the poster has not sent the held-out checks yet.
  const posted = {
    criteria_hash: await putCriteria(db, EXACT),
    heldout_commitment: sha256Hex(canonicalJson(EXACT_HELDOUT)),
    created_at: (NOW_NS - MINUTE_NS).toString(),
  };
  await insertTask(db, taskView({ id: "1", ...posted }));
  const deps = judgeDeps(db, fakeChain(null));

  expect(await intakeTask(deps, 1n)).toBe("pending");
  expect(await judgeRow(db, 1)).toEqual({
    judge_status: "pending",
    judge_reason: "waiting for held-out checks",
  });
  // Still pending a moment before the 10 minutes are up.
  expect(await intakeTask({ ...deps, now: at(8.99) }, 1n)).toBe("pending");

  await putHeldout(db, EXACT_HELDOUT);
  expect(await intakeTask({ ...deps, now: at(8.99) }, 1n)).toBe("accepted");
  expect(await judgeRow(db, 1)).toEqual({ judge_status: "accepted", judge_reason: null });

  // A task whose held-out checks never come is pending until 10 minutes after it was posted.
  const missing = { ...posted, heldout_commitment: sha256Hex("never sent") };
  await insertTask(db, taskView({ id: "2", ...missing }));
  expect(await intakeTask({ ...deps, now: at(8.99) }, 2n)).toBe("pending");
  expect(await intakeTask({ ...deps, now: at(9) }, 2n)).toBe("rejected");
  expect(await judgeRow(db, 2)).toEqual({
    judge_status: "rejected",
    judge_reason: "held-out checks missing",
  });
});

test("a_pending_task_starts_no_worker_and_a_check_is_kept", { timeout: 60_000 }, async () => {
  // While a task waits for its held-out checks, the compile part of the criteria check, which
  // needs a worker, waits too: the checks that cost little run, and a schema they refuse is turned
  // away at once. Once the checks are in, the compile check runs; its outcome is kept in the
  // Judge's memory, so a second task with the same criteria does not start a worker for it.
  vi.mocked(checkJsonSchemaIsolated).mockClear();
  const memory = newJudgeMemory();
  const deps = judgeDeps(db, fakeChain(null), { memory });
  const criteriaHash = await putCriteria(db, JSON_SCHEMA);
  const checks = [
    { json_schema: { assertions: [{ path: "$.total", equals: 1 }] } },
    { json_schema: { assertions: [{ path: "$.total", equals: 2 }] } },
  ];
  for (const [i, heldout] of checks.entries()) {
    await insertTask(
      db,
      taskView({
        id: `${i + 1}`,
        criteria_hash: criteriaHash,
        heldout_commitment: sha256Hex(canonicalJson(heldout)),
        created_at: (NOW_NS - MINUTE_NS).toString(),
      }),
    );
  }

  for (let tick = 0; tick < 3; tick++) expect(await intakeTask(deps, 1n)).toBe("pending");
  expect(checkJsonSchemaIsolated).not.toHaveBeenCalled();
  // A reference the shape check refuses is no reason to wait.
  await insertTask(
    db,
    taskView({
      id: "3",
      criteria_hash: await putCriteria(db, { ...JSON_SCHEMA, schema: { $ref: "#/constructor" } }),
      heldout_commitment: sha256Hex("never sent"),
      created_at: (NOW_NS - MINUTE_NS).toString(),
    }),
  );
  expect(await intakeTask(deps, 3n)).toBe("rejected");
  expect(checkJsonSchemaIsolated).not.toHaveBeenCalled();

  for (const heldout of checks) await putHeldout(db, heldout);
  expect(await intakeTask(deps, 1n)).toBe("accepted");
  expect(await intakeTask(deps, 2n)).toBe("accepted");
  expect(checkJsonSchemaIsolated).toHaveBeenCalledTimes(1);
});

test("a_check_refused_for_time_is_not_kept", { timeout: 60_000 }, async () => {
  // A schema that ran past its compile budget, on a busy machine say, is not refused for good
  // (M1) and its outcome is not kept: it is the machine's load as much as the schema. The task
  // stays pending and is checked again, and the next task with the same criteria is checked again,
  // and accepted. A refusal that the schema decides is kept: a second task with the same broken
  // criteria is refused without a check.
  vi.mocked(checkJsonSchemaIsolated).mockClear();
  vi.mocked(checkJsonSchemaIsolated).mockResolvedValueOnce({
    ok: false,
    reason: TOO_SLOW_TO_COMPILE,
  });
  const memory = newJudgeMemory();
  const deps = judgeDeps(db, fakeChain(null), { memory });
  const heldout = (n: number) => ({ json_schema: { assertions: [{ path: "$.x", equals: n }] } });
  const posted: [schema: Record<string, unknown>, status: string][] = [
    [{ type: "object" }, "pending"],
    [{ type: "object" }, "accepted"],
    [{ type: 12 }, "rejected"],
    [{ type: 12 }, "rejected"],
  ];
  for (const [i, [schema, status]] of posted.entries()) {
    await insertTask(
      db,
      taskView({ id: `${i + 1}`, ...(await jsonSchemaTask(db, schema, heldout(i))) }),
    );
    expect(await intakeTask(deps, BigInt(i + 1)), `task ${i + 1}`).toBe(status);
  }
  expect(await judgeRow(db, 1)).toEqual({
    judge_status: "pending",
    judge_reason: "the criteria check ran out of time, checking again",
  });
  expect(memory.overruns).toEqual(new Map([["1", 1]]));
  expect((await judgeRow(db, 4))?.judge_reason).toMatch(/^criteria schema cannot be compiled: /);
  expect(checkJsonSchemaIsolated).toHaveBeenCalledTimes(3);

  // The load is over: the check of task 1 comes from what task 2 found, and it is accepted.
  expect(await intakeTask(deps, 1n)).toBe("accepted");
  expect(await judgeRow(db, 1)).toEqual({ judge_status: "accepted", judge_reason: null });
  expect(memory.overruns.size).toBe(0);
  expect(checkJsonSchemaIsolated).toHaveBeenCalledTimes(3);
});

test("intake_rejects_heldout_from_non_poster", async () => {
  const reason = "held-out checks were not uploaded by the poster";
  // Someone else holds the bytes and uploaded them, and the poster never did: they are not the
  // poster's checks, and there is nothing to wait for, as they are stored.
  await insertTask(
    db,
    taskView({
      id: "1",
      criteria_hash: await putCriteria(db, EXACT),
      heldout_commitment: await putHeldout(db, EXACT_HELDOUT, "mallory.test.near"),
    }),
  );
  // The poster's bytes, stored as another kind of blob.
  await insertTask(
    db,
    taskView({
      id: "2",
      criteria_hash: await putCriteria(db, EXACT),
      heldout_commitment: await putRaw(
        db,
        "result",
        canonicalJson({ exact: { expected: ["43"] } }),
      ),
    }),
  );
  const deps = judgeDeps(db, fakeChain(null));

  for (const id of [1n, 2n]) {
    expect(await intakeTask(deps, id)).toBe("rejected");
    expect(await judgeRow(db, id)).toEqual({ judge_status: "rejected", judge_reason: reason });
  }
});

test("a_check_that_is_slow_every_time_is_tried_3_more_times_and_then_refused", {
  timeout: 60_000,
}, async () => {
  vi.mocked(checkJsonSchemaIsolated).mockClear();
  vi.mocked(checkJsonSchemaIsolated).mockResolvedValue({ ok: false, reason: TOO_SLOW_TO_COMPILE });
  try {
    const memory = newJudgeMemory();
    const deps = judgeDeps(db, fakeChain(null), { memory });
    await insertTask(db, taskView({ id: "1", ...(await jsonSchemaTask(db, { type: "object" })) }));
    const retry = {
      judge_status: "pending",
      judge_reason: "the criteria check ran out of time, checking again",
    };

    for (const tick of [1, 2, 3]) {
      expect(await intakeTask(deps, 1n), `tick ${tick}`).toBe("pending");
      expect(await judgeRow(db, 1), `tick ${tick}`).toEqual(retry);
      expect(memory.overruns.get("1"), `tick ${tick}`).toBe(tick);
    }
    // The fourth overrun is the last: the task is refused for the time, as a schema that cannot be
    // checked in time for good, and the count goes with the decision.
    expect(await intakeTask(deps, 1n)).toBe("rejected");
    expect(await judgeRow(db, 1)).toEqual({
      judge_status: "rejected",
      judge_reason: TOO_SLOW_TO_COMPILE,
    });
    expect(memory.overruns.size).toBe(0);
    expect(checkJsonSchemaIsolated).toHaveBeenCalledTimes(4);

    // A Judge that keeps no memory cannot count, and refuses at the first overrun, as before.
    const own = { json_schema: { assertions: [{ path: "$.y", equals: 2 }] } };
    await insertTask(
      db,
      taskView({ id: "2", ...(await jsonSchemaTask(db, { type: "array" }, own)) }),
    );
    expect(await intakeTask(judgeDeps(db, fakeChain(null)), 2n)).toBe("rejected");
    expect((await judgeRow(db, 2))?.judge_reason).toBe(TOO_SLOW_TO_COMPILE);
  } finally {
    vi.mocked(checkJsonSchemaIsolated).mockReset();
  }
});

test("intake_takes_heldout_the_poster_sent_after_a_stranger", async () => {
  // A stranger who has the bytes, as anyone has those of a seed, stores them first, and the row
  // is the stranger's. The poster's own upload of them is recorded as well, and that is what
  // counts: the stranger's being first changes nothing (I2).
  const commitment = await putHeldout(db, EXACT_HELDOUT, "mallory.test.near");
  await putHeldout(db, EXACT_HELDOUT);
  expect((await getBlob(db, commitment))?.uploader).toBe("mallory.test.near");

  const criteria_hash = await putCriteria(db, EXACT);
  expect(await intake(1, { criteria_hash, heldout_commitment: commitment })).toBe("accepted");
  expect(await judgeRow(db, 1)).toEqual({ judge_status: "accepted", judge_reason: null });

  // Only the poster's upload counts: the stranger's task with the same checks takes them from
  // its own poster, who is the stranger, and the stranger sent them too (P05-R7).
  const own = await intake(2, {
    poster: "mallory.test.near",
    criteria_hash,
    heldout_commitment: commitment,
  });
  expect(own).toBe("accepted");
  // A third account, which never sent them, has no claim to them.
  const third = await intake(3, {
    poster: "carol.test.near",
    criteria_hash,
    heldout_commitment: commitment,
  });
  expect(third).toBe("rejected");
  expect((await judgeRow(db, 3))?.judge_reason).toBe(
    "held-out checks were not uploaded by the poster",
  );
});

test("held_out_checks_that_are_used_or_missing_are_refused_before_a_worker_is_started", async () => {
  // I5: the two refusals that need no worker come before the compile, which starts one.
  vi.mocked(checkJsonSchemaIsolated).mockClear();
  const deps = judgeDeps(db, fakeChain(null));
  const shared = { json_schema: { assertions: [{ path: "$.x", equals: 1 }] } };
  const first = await jsonSchemaTask(db, { type: "object" }, shared);
  // Task 1 holds the checks. Task 2, the same poster's, repeats them: refused without a check.
  await insertTask(db, taskView({ id: "1", ...first }));
  await insertTask(
    db,
    taskView({ id: "2", ...(await jsonSchemaTask(db, { type: "array" }, shared)) }),
  );
  expect(await intakeTask(deps, 2n)).toBe("rejected");
  expect(await judgeRow(db, 2)).toEqual({
    judge_status: "rejected",
    judge_reason: "held-out checks already used by task 1",
  });
  expect(checkJsonSchemaIsolated).not.toHaveBeenCalled();

  // Checks that never came, once the 10 minutes are over: refused without a check as well.
  await insertTask(
    db,
    taskView({
      id: "3",
      criteria_hash: await putCriteria(db, { ...JSON_SCHEMA, schema: { type: "string" } }),
      heldout_commitment: sha256Hex("never sent"),
    }),
  );
  expect(await intakeTask(deps, 3n)).toBe("rejected");
  expect(await judgeRow(db, 3)).toEqual({
    judge_status: "rejected",
    judge_reason: "held-out checks missing",
  });
  expect(checkJsonSchemaIsolated).not.toHaveBeenCalled();

  // Task 1 itself is checked, once.
  expect(await intakeTask(deps, 1n)).toBe("accepted");
  expect(checkJsonSchemaIsolated).toHaveBeenCalledTimes(1);
});

test("intake_rejects_heldout_checks_already_used", async () => {
  // Judging a task publishes its held-out checks, so a set of checks is good for one of its
  // poster's tasks: the one with the lowest id. Intake of a later task may run first, and it is
  // rejected all the same. (`taskView` posts every task as `POSTER`.)
  const criteriaHash = await putCriteria(db, EXACT);
  const shared = await putHeldout(db, EXACT_HELDOUT);
  for (const id of ["1", "2", "3"]) {
    await insertTask(db, taskView({ id, criteria_hash: criteriaHash, heldout_commitment: shared }));
  }
  const deps = judgeDeps(db, fakeChain(null));
  const usedBy = (id: number) => ({
    judge_status: "rejected",
    judge_reason: `held-out checks already used by task ${id}`,
  });

  expect(await intakeTask(deps, 2n)).toBe("rejected");
  expect(await judgeRow(db, 2)).toEqual(usedBy(1));
  expect(await intakeTask(deps, 1n)).toBe("accepted");
  expect(await judgeRow(db, 1)).toEqual({ judge_status: "accepted", judge_reason: null });
  // A third is told of the first, whatever became of the second.
  expect(await intakeTask(deps, 3n)).toBe("rejected");
  expect(await judgeRow(db, 3)).toEqual(usedBy(1));

  // Ids compare as numbers, 9 before 10, and an earlier task counts whoever its verifier is.
  const other = await putHeldout(db, { exact: { expected: ["another answer"] } });
  const verifiers: [string, string][] = [
    ["9", "other-judge.test.near"],
    ["10", JUDGE],
  ];
  for (const [id, verifier] of verifiers) {
    await insertTask(
      db,
      taskView({ id, verifier, criteria_hash: criteriaHash, heldout_commitment: other }),
    );
  }
  expect(await intakeTask(deps, 10n)).toBe("rejected");
  expect(await judgeRow(db, 10)).toEqual(usedBy(9));
});

test("intake_counts_only_the_posters_own_earlier_use", async () => {
  // A commitment is public once its task is posted, so a stranger can post a task with it first
  // and take a lower id (P05-R7). Only someone who holds the bytes already can have a copy
  // judged, so that task must not use the poster's checks up.
  const criteriaHash = await putCriteria(db, EXACT);
  const commitment = await putHeldout(db, EXACT_HELDOUT);
  const posted: [string, string][] = [
    ["1", "stranger.test.near"],
    ["2", POSTER],
    ["3", POSTER],
  ];
  for (const [id, poster] of posted) {
    await insertTask(
      db,
      taskView({ id, poster, criteria_hash: criteriaHash, heldout_commitment: commitment }),
    );
  }
  const deps = judgeDeps(db, fakeChain(null));

  expect(await intakeTask(deps, 2n)).toBe("accepted");
  expect(await judgeRow(db, 2)).toEqual({ judge_status: "accepted", judge_reason: null });
  // The stranger's task fails on whose upload the checks are, as before.
  expect(await intakeTask(deps, 1n)).toBe("rejected");
  expect(await judgeRow(db, 1)).toEqual({
    judge_status: "rejected",
    judge_reason: "held-out checks were not uploaded by the poster",
  });
  // The poster's own reuse is still refused, and names the poster's first task.
  expect(await intakeTask(deps, 3n)).toBe("rejected");
  expect(await judgeRow(db, 3)).toEqual({
    judge_status: "rejected",
    judge_reason: "held-out checks already used by task 2",
  });
});

test("intake_only_judges_its_own_tasks", async () => {
  const deps = judgeDeps(db, fakeChain(null));
  await insertTask(
    db,
    taskView({
      id: "1",
      verifier: "other-judge.test.near",
      criteria_hash: await putCriteria(db, REGEX),
    }),
  );

  // Another verifier's task, and a task the database does not have yet, are left undecided.
  expect(await intakeTask(deps, 1n)).toBe("pending");
  expect(await judgeRow(db, 1)).toEqual({ judge_status: null, judge_reason: null });
  expect(await intakeTask(deps, 2n)).toBe("pending");
});

test("intake_does_not_reconsider_a_decided_task", async () => {
  // Criteria that would be rejected now, under statuses decided before.
  const view = { criteria_hash: sha256Hex("never stored") };
  const decided: [string, string][] = [
    ["accepted", "accepted"],
    ["rejected", "rejected"],
    ["failed_closed", "rejected"],
  ];
  for (const [i, [status, answer]] of decided.entries()) {
    await insertTask(db, taskView({ id: `${i + 1}`, ...view }), status, "decided before");
    expect(await intakeTask(judgeDeps(db, fakeChain(null)), BigInt(i + 1))).toBe(answer);
    expect(await judgeRow(db, i + 1)).toEqual({
      judge_status: status,
      judge_reason: "decided before",
    });
  }
});

test("intake_rejects_a_task_whose_check_throws", async () => {
  // A check that throws, or crashes its worker (a RangeError from a document nested too deeply,
  // or an out-of-memory, say), rejects the task with a fixed reason instead of stopping intake.
  vi.mocked(checkJsonSchemaIsolated).mockRejectedValueOnce(
    new RangeError("Maximum call stack size exceeded"),
  );
  expect(await intake(1, await jsonSchemaTask(db, JSON_SCHEMA.schema))).toBe("rejected");
  expect(await judgeRow(db, 1)).toEqual({
    judge_status: "rejected",
    judge_reason: "criteria could not be checked",
  });
});

test("intake_leaves_a_task_undecided_when_no_check_worker_can_start", async () => {
  // A worker that cannot be started is the Judge's trouble, like a database that cannot be read:
  // the task stays undecided, and the next tick tries again.
  vi.mocked(checkJsonSchemaIsolated).mockRejectedValueOnce(
    new ScorerUnavailableError("a score worker could not be started"),
  );
  await insertTask(db, taskView({ id: "1", ...(await jsonSchemaTask(db, JSON_SCHEMA.schema)) }));
  await expect(intakeTask(judgeDeps(db, fakeChain(null)), 1n)).rejects.toBeInstanceOf(
    ScorerUnavailableError,
  );
  expect(await judgeRow(db, 1)).toEqual({ judge_status: null, judge_reason: null });
  expect(await intakeTask(judgeDeps(db, fakeChain(null)), 1n)).toBe("accepted");
});

test("intake_leaves_a_task_undecided_when_the_database_fails", async () => {
  // A database that cannot be read says nothing about the task, so the task is not rejected: the
  // error goes to the loop, and the next tick tries again.
  await insertTask(db, taskView({ id: "1", criteria_hash: await putCriteria(db, REGEX) }));
  const failing: Db = {
    ...db,
    query: async (sql, params) => {
      if (sql.includes("from blobs")) throw new Error("connection terminated");
      return db.query(sql, params);
    },
  };

  await expect(intakeTask(judgeDeps(failing, fakeChain(null)), 1n)).rejects.toThrow(
    "connection terminated",
  );
  expect(await judgeRow(db, 1)).toEqual({ judge_status: null, judge_reason: null });
});
