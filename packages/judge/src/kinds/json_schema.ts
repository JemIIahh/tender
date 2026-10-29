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
 * schema itself cannot be compiled (the criteria say what a task asks for, and a task that asks
 * for something that cannot be checked pays nobody).
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

/** The reasons `document` does not fit `schema`, or `null` when it fits. */
function checkSchema(schema: Record<string, unknown>, document: unknown): string[] | null {
  let validate: ValidateFunction;
  try {
    validate = newAjv().compile(schema);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return [`criteria schema cannot be compiled: ${why}`];
  }

  let fits: boolean;
  try {
    fits = validate(document);
  } catch (error) {
    // Under a recursive schema Ajv recurses once per level of nesting, and JSON.parse reads
    // documents far deeper than the stack allows. Any other error is a bug: let it surface.
    if (error instanceof RangeError) return ["too deeply nested to validate"];
    throw error;
  }
  return fits ? null : (validate.errors ?? []).slice(0, MAX_SCHEMA_ERRORS).map(formatError);
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
