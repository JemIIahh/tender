// Helpers for the tests that change one place of a JSON document at a time and expect a schema to
// notice.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** Object keys are strings and array indexes are numbers. */
export type Path = Array<string | number>;

/** `"funders.0.amount"` as `["funders", 0, "amount"]`: a segment of digits is an array index. */
export function pathOf(dotted: string): Path {
  return dotted.split(".").map((step) => (/^\d+$/.test(step) ? Number(step) : step));
}

/** Every leaf of `node` (a string, number, boolean or null), with its path. */
export function leaves(node: Json, path: Path = []): Array<{ path: Path; value: Json }> {
  if (Array.isArray(node)) return node.flatMap((item, i) => leaves(item, [...path, i]));
  if (node !== null && typeof node === "object") {
    return Object.entries(node).flatMap(([key, value]) => leaves(value, [...path, key]));
  }
  return [{ path, value: node }];
}

/** Every member of `node`, nested ones included: each object key and each array element. */
export function members(node: Json, path: Path = []): Array<{ path: Path; value: Json }> {
  let own: Array<{ path: Path; value: Json }> = [];
  if (Array.isArray(node)) {
    own = node.map((value, i) => ({ path: [...path, i], value }));
  } else if (node !== null && typeof node === "object") {
    own = Object.entries(node).map(([key, value]) => ({ path: [...path, key], value }));
  }
  return own.flatMap((member) => [member, ...members(member.value, member.path)]);
}

/** The path of every key of every object in `node`, nested ones included. */
export function keyPaths(node: Json, path: Path = []): Path[] {
  if (Array.isArray(node)) return node.flatMap((item, i) => keyPaths(item, [...path, i]));
  if (node !== null && typeof node === "object") {
    return Object.entries(node).flatMap(([key, value]) => [
      [...path, key],
      ...keyPaths(value, [...path, key]),
    ]);
  }
  return [];
}

/**
 * A copy of `node` with the value at `path` replaced, or the key removed if `replacement` is
 * undefined. An object key that is not there yet is added.
 */
export function edited(node: Json, path: Path, replacement: Json | undefined): Json {
  const [head, ...rest] = path;
  if (head === undefined) return replacement ?? null;
  if (Array.isArray(node)) {
    return node.map((item, i) => (i === head ? edited(item, rest, replacement) : item));
  }
  if (node !== null && typeof node === "object") {
    const copy: { [key: string]: Json } = {};
    for (const [key, value] of Object.entries(node)) {
      if (key !== head) copy[key] = value;
      else if (rest.length > 0 || replacement !== undefined)
        copy[key] = edited(value, rest, replacement);
    }
    const isNewKey = typeof head === "string" && !Object.hasOwn(copy, head);
    if (isNewKey && rest.length === 0 && replacement !== undefined) copy[head] = replacement;
    return copy;
  }
  return node;
}
