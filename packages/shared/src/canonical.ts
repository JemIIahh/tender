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
 * Accepts null, booleans, finite numbers, strings, arrays and plain objects. A property whose
 * value is `undefined` counts as absent, as in `JSON.stringify`. Anything else throws a
 * `TypeError` that names the place: `undefined` in an array, NaN or an infinity, a bigint, a
 * function, a symbol, and objects with no JSON form such as a `Date` or a `Map`. Write a `Date` as
 * an ISO string and a u64 as a decimal string before calling.
 */
export function canonicalJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(serialize(value, "$"));
}

function serialize(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`cannot write ${value} as JSON at ${path}`);
      return JSON.stringify(value);
    case "object":
      return Array.isArray(value) ? serializeArray(value, path) : serializeObject(value, path);
    default:
      throw new TypeError(`cannot write ${typeof value} as JSON at ${path}`);
  }
}

function serializeArray(items: unknown[], path: string): string {
  // `Array.from` visits the holes of a sparse array as `undefined`, which then throws, where
  // `map` would skip them and `join` would write invalid JSON.
  return `[${Array.from(items, (item, i) => serialize(item, `${path}[${i}]`)).join(",")}]`;
}

function serializeObject(object: object, path: string): string {
  const tag = Object.prototype.toString.call(object).slice("[object ".length, -1);
  if (tag !== "Object") throw new TypeError(`cannot write a ${tag} as JSON at ${path}`);

  const record = object as Record<string, unknown>;
  const members: string[] = [];
  // Not `Object.fromEntries` on sorted keys: an object lists integer-like keys first, in numeric
  // order, whatever order they went in, so the string has to be put together here.
  for (const key of Object.keys(record).sort()) {
    const member = record[key];
    if (member === undefined) continue;
    members.push(`${JSON.stringify(key)}:${serialize(member, `${path}.${key}`)}`);
  }
  return `{${members.join(",")}}`;
}
