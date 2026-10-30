/**
 * The canonical bytes of a JSON document: object keys sorted, no whitespace, UTF-8. Every document
 * Tender authors (brief, criteria, held-out checks, scorecard, profile) is stored as exactly these
 * bytes, and the hash the contract keeps for it is `sha256Hex` of them.
 *
 * Keys are ordered by UTF-16 code unit, and values are written as `JSON.stringify` writes them
 * (numbers in their shortest round-trip form, only the characters JSON requires escaped). That is
 * RFC 8785 (JCS) for the data JSON can hold, so another language can reproduce the bytes with a
 * JCS library.
 *
 * Accepts null, booleans, finite numbers, strings, arrays and plain objects, meaning objects whose
 * prototype is `Object.prototype` or `null`. A property whose value is `undefined` counts as
 * absent, as in `JSON.stringify`, and so does its key. Anything else throws a `TypeError` that
 * names the place, such as `$.entries[0].score`: `undefined` in an array, NaN or an infinity, a
 * bigint, a function, a symbol, an object with no JSON form (a `Date`, a `Map`, an instance of any
 * class), a value that contains itself, and a string or a key with a lone surrogate. RFC 8785
 * requires refusing a lone surrogate, which is not well-formed Unicode and has no UTF-8 form, where
 * `JSON.stringify` would escape it. Write a `Date` as an ISO string and a u64 as a decimal string
 * before calling. An object may appear more than once, as long as it is not inside itself.
 */
export function canonicalJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(serialize(value, "$", new Set()));
}

/** `ancestors` holds the arrays and objects being written, from the outermost to this one. */
function serialize(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      requireWellFormed(value, "a string", path);
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`cannot write ${value} as JSON at ${path}`);
      return JSON.stringify(value);
    case "object": {
      if (ancestors.has(value)) throw new TypeError(`circular reference at ${path}`);
      ancestors.add(value);
      const written = Array.isArray(value)
        ? serializeArray(value, path, ancestors)
        : serializeObject(value, path, ancestors);
      ancestors.delete(value);
      return written;
    }
    default:
      throw new TypeError(`cannot write ${typeof value} as JSON at ${path}`);
  }
}

function serializeArray(items: unknown[], path: string, ancestors: Set<object>): string {
  // `Array.from` visits the holes of a sparse array as `undefined`, which then throws, where
  // `map` would skip them and `join` would write invalid JSON.
  const written = Array.from(items, (item, i) => serialize(item, `${path}[${i}]`, ancestors));
  return `[${written.join(",")}]`;
}

function serializeObject(object: object, path: string, ancestors: Set<object>): string {
  const prototype = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`cannot write ${describe(object)} as JSON at ${path}`);
  }

  const record = object as Record<string, unknown>;
  const members: string[] = [];
  // Not `Object.fromEntries` on sorted keys: an object lists integer-like keys first, in numeric
  // order, whatever order they went in, so the string has to be put together here.
  for (const key of Object.keys(record).sort()) {
    const member = record[key];
    if (member === undefined) continue;
    requireWellFormed(key, "a key", path);
    members.push(`${JSON.stringify(key)}:${serialize(member, `${path}.${key}`, ancestors)}`);
  }
  return `{${members.join(",")}}`;
}

/**
 * A surrogate that is not half of a pair: with the `u` flag a pair is one code point, so only a lone
 * one is in the category. This is `!text.isWellFormed()`, which the ES2023 lib of this package does
 * not declare.
 */
const LONE_SURROGATE = /\p{Surrogate}/u;

/** Throws unless `text` is well-formed Unicode, which a string with a lone surrogate is not. */
function requireWellFormed(text: string, what: "a string" | "a key", path: string): void {
  if (LONE_SURROGATE.test(text)) {
    throw new TypeError(`cannot write ${what} with a lone surrogate as JSON at ${path}`);
  }
}

/** What to call an object that is not plain: `an instance of Date`, `an instance of Point`. */
function describe(object: object): string {
  const name = object.constructor?.name || Object.prototype.toString.call(object).slice(8, -1);
  return `an instance of ${name}`;
}
