import type { Heldout, PublicCriteria } from "@tender/shared";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { EntryScore } from "../types";

type JsonSchemaCriteria = Extract<PublicCriteria, { kind: "json_schema" }>;
// `Heldout` is a union, so `Heldout["json_schema"]` does not compile: pick the member first.
type JsonSchemaHeldout = Extract<Heldout, { json_schema: unknown }>["json_schema"];

/** How many schema errors the reasons of a document that does not fit list. */
const MAX_SCHEMA_ERRORS = 3;

/** An assertion path: `$`, then `.key` and `[n]` segments. A key is anything but `.` and `[`. */
const PATH = /^\$(?:\.[^.[]+|\[(?:0|[1-9]\d*)\])*$/;
/** One segment of a path that matched `PATH`: the key, or the index. */
const SEGMENT = /\.([^.[]+)|\[(\d+)\]/g;
/** What a path finds when it leads nowhere. Not `undefined` or `null`: `null` is a JSON value. */
const MISSING = Symbol("missing");
/** What `checkJsonSchemaUsable` runs a schema on: the smallest document of each JSON type. */
const TRIAL_DOCUMENTS: unknown[] = [null, true, 0, "", [], {}];

/**
 * Scores a `json_schema` entry. The bytes must be valid UTF-8 holding one JSON document that fits
 * the criteria's schema (JSON Schema 2020-12, with the standard formats such as `date`);
 * otherwise the score is 0, and the reasons say why. A document that fits is scored on the
 * held-out assertions: `round(100 × passed / total)`, with one reason per failed assertion.
 *
 * An assertion is a path and a value. A path is `$` followed by `.key` and `[n]` segments:
 * `.key` picks an own key of an object, `[n]` an element of an array (no leading zeros). An
 * assertion fails when its path is not written like that or leads nowhere, and when the value
 * found is not deeply equal to `equals`: objects by key set, whatever the order, arrays by order.
 * A missing key is not `null`.
 *
 * Pure and total: any bytes give a score, and none of them can make this throw. A document nested
 * so deeply that validating it overflows the stack scores 0, and so does every document when the
 * schema itself cannot be used: it does not compile, it is an `$async` schema, or it throws when
 * it is evaluated (the criteria say what a task asks for, and a task that asks for something that
 * cannot be checked pays nobody). `checkJsonSchemaUsable` lets task intake find such a schema
 * before any agent enters.
 */
export function scoreJsonSchema(
  c: JsonSchemaCriteria,
  h: JsonSchemaHeldout,
  content: Uint8Array,
): EntryScore {
  const text = decodeUtf8(content);
  if (text === null) return scored(c, 0, ["not valid UTF-8"]);

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return scored(c, 0, ["not JSON"]);
  }

  const schemaErrors = checkSchema(c.schema, document);
  if (schemaErrors !== null) return scored(c, 0, schemaErrors);

  const total = h.assertions.length;
  // The held-out schema asks for one assertion at least. Without one, 100 × 0 / 0 would be NaN.
  if (total === 0) return scored(c, 0, ["held-out document has no assertions"]);

  const failed = h.assertions.filter(({ path, equals }) => {
    const found = resolve(document, path);
    return found === MISSING || !deepEqual(found, equals);
  });
  const score = Math.round((100 * (total - failed.length)) / total);
  return scored(
    c,
    score,
    failed.map(({ path, equals }) => `${path} expected ${JSON.stringify(equals)}`),
  );
}

/**
 * Whether `scoreJsonSchema` can use `schema` to score anything. Task intake can use this to turn
 * a task away before any agent enters it, rather than let every entry score 0.
 *
 * It compiles the schema with the scorer's own Ajv options, refuses what the scorer refuses (an
 * `$async` schema), and runs the schema on a few small documents, which finds the schemas that
 * throw when they are evaluated. It cannot reach every part of a schema. One that throws only on
 * some documents passes this check, and the scorer scores such a document 0.
 */
export function checkJsonSchemaUsable(
  schema: Record<string, unknown>,
): { ok: true } | { ok: false; reason: string } {
  const compiled = compile(schema);
  if ("reason" in compiled) return { ok: false, reason: compiled.reason };

  for (const trial of TRIAL_DOCUMENTS) {
    const run = validateOnce(compiled.validate, trial);
    if ("error" in run) return { ok: false, reason: cannotEvaluate(run.error) };
  }
  return { ok: true };
}

/** The reasons `document` does not fit `schema`, or `null` when it fits. */
function checkSchema(schema: Record<string, unknown>, document: unknown): string[] | null {
  const compiled = compile(schema);
  if ("reason" in compiled) return [compiled.reason];

  const run = validateOnce(compiled.validate, document);
  if ("error" in run) {
    // Under a recursive schema Ajv recurses once per level of nesting, and JSON.parse reads
    // documents far deeper than the stack allows. Whatever else a schema does to throw, the
    // document it throws on scores 0 like any other that does not fit.
    return [
      run.error instanceof RangeError ? "too deeply nested to validate" : cannotEvaluate(run.error),
    ];
  }
  if (run.fits) return null;
  return (compiled.validate.errors ?? []).slice(0, MAX_SCHEMA_ERRORS).map(formatError);
}

/** `schema` compiled, or why it cannot be used. */
function compile(
  schema: Record<string, unknown>,
): { validate: ValidateFunction } | { reason: string } {
  let validate: ValidateFunction;
  try {
    validate = newAjv().compile(schema);
  } catch (error) {
    return { reason: `criteria schema cannot be compiled: ${messageOf(error)}` };
  }
  // With `$async: true` the validator returns a Promise. A Promise is truthy whatever the
  // document, so every document would fit, and the Promise rejects, unhandled, for the ones that
  // do not. Ajv sets the flag to exactly `true`, for any truthy `$async`.
  if ((validate as { $async?: boolean }).$async === true) {
    return { reason: 'criteria schema cannot be compiled: "$async" schemas are not supported' };
  }
  return { validate };
}

/** Runs `validate` on `document`: whether it fits, or what the schema threw. */
function validateOnce(
  validate: ValidateFunction,
  document: unknown,
): { fits: boolean } | { error: unknown } {
  try {
    // Only `true` fits. Nothing that is merely truthy does.
    return { fits: validate(document) === true };
  } catch (error) {
    return { error };
  }
}

function cannotEvaluate(error: unknown): string {
  return `criteria schema cannot be evaluated: ${messageOf(error)}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A new Ajv for every schema. Ajv keeps each schema it compiles by its `$id`, so one shared
 * instance would make a score depend on the tasks scored before it (the same `$id` twice is an
 * error). Building one takes about 6 ms.
 */
function newAjv(): Ajv2020 {
  const ajv = new Ajv2020({
    // Keywords and formats Ajv does not know are ignored, not errors.
    strict: false,
    // `strict: false` also lets NaN and the infinities pass as numbers, and JSON.parse reads
    // 1e999 as Infinity.
    strictNumbers: true,
    // Only the keys a document has count. By default Ajv also finds what every object inherits,
    // so `required: ["toString"]` would be met by `{}`.
    ownProperties: true,
    allErrors: true,
    // Without this, every unknown format is a console.warn.
    logger: false,
  });
  addFormats(ajv);
  return ajv;
}

/** An Ajv error as `instancePath message`; the document itself has no path. */
function formatError(error: ErrorObject): string {
  return `${error.instancePath} ${error.message ?? error.keyword}`.trim();
}

/** What `path` finds in `document`, or `MISSING`. */
function resolve(document: unknown, path: string): unknown {
  if (!PATH.test(path)) return MISSING;

  let current = document;
  for (const [, key, index] of path.matchAll(SEGMENT)) {
    if (key !== undefined) {
      // Own keys of plain objects only: not an array's `length`, not a member objects inherit.
      if (!isObject(current) || !Object.hasOwn(current, key)) return MISSING;
      current = current[key];
    } else {
      const i = Number(index);
      if (!Array.isArray(current) || !(i < current.length)) return MISSING;
      current = current[i];
    }
  }
  return current;
}

/** JSON equality: objects by key set, arrays by order, nothing coerced. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => deepEqual(item, b[i]))
    );
  }
  if (!isObject(a) || !isObject(b)) return false;

  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text of `content`, or `null` when it is not valid UTF-8. */
function decodeUtf8(content: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

function scored(c: JsonSchemaCriteria, score: number, reasons: string[]): EntryScore {
  return { score, passed: score >= c.min_score, reasons };
}
