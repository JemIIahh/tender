import { baseDecode, baseEncode } from "near-api-js";

// The server's secrets must not leave in a result. A reveal publishes the work word for word, and
// the scrubber only ever sees what a tool says, so what a result holds is checked here: for each
// secret as it is, and in the ways that a copy is usually disguised. It is best effort, and no proof
// that a result holds no secret: a copy that is reversed, in base32 or base85, a list of byte
// values, or cut up by anything but white space, is not found.
//
// The bytes are looked at in three ways. As they are, for a secret's own bytes. With the breaks
// taken out (white space, and the NULs between the letters of UTF-16 text), for every copy that is
// text: wrapped base64, hex in pairs, a key one letter to a line, and UTF-16 of either order are
// whole again. And in lower case, for hex, whose digits are the same in either.
//
// A document is JSON, whose bytes write a line break as an escape, so it is looked at twice: as the
// bytes that go up, and as the text it holds (`documentText`).

/**
 * A secret shorter than this is looked for as it is and not in disguise: too many texts hold a
 * short one by chance, once it is white space apart or in hex.
 */
const MIN_DISGUISED_BYTES = 12;
/** A key is never fewer bytes than this: 64 for ed25519, 96 for secp256k1, behind the curve's name. */
const MIN_KEY_BYTES = 32;
/** The secret part of a key: its first 32 bytes, and the public half is the rest. */
const SEED_BYTES = 32;

/** The bytes that a copy may be broken up by: white space, and the NULs of UTF-16 text. */
const BREAKS = new Uint8Array(256);
for (const byte of [0x00, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]) BREAKS[byte] = 1;

/** `bytes` without the breaks. */
function withoutBreaks(bytes: Uint8Array): Buffer {
  const kept = Buffer.allocUnsafe(bytes.length);
  let length = 0;
  for (const byte of bytes) {
    if (BREAKS[byte] === 0) {
      kept[length] = byte;
      length += 1;
    }
  }
  return kept.subarray(0, length);
}

/** `bytes` with the letters A to Z made a to z. */
function lowerCased(bytes: Uint8Array): Buffer {
  const lower = Buffer.allocUnsafe(bytes.length);
  for (let at = 0; at < bytes.length; at++) {
    const byte = bytes[at] ?? 0;
    lower[at] = byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
  }
  return lower;
}

/**
 * The base64 of `bytes`, standard and URL-safe, as it reads inside a longer text that is encoded
 * whole. Three bytes make four letters, so the letters of a copy depend on where it starts: a text
 * encoded with `before` bytes ahead of the copy (0, 1 or 2 of them, modulo 3) has its first letters
 * made partly of those bytes, and its last, partly of the ones behind. Those are left out, and
 * what is left is the same wherever the copy sits. Padding is left out too, as a text may end short.
 */
function base64Spellings(bytes: Uint8Array): Buffer[] {
  const spellings: Buffer[] = [];
  for (const encoding of ["base64", "base64url"] as const) {
    for (let before = 0; before < 3; before++) {
      const whole = Buffer.concat([Buffer.alloc(before), bytes]);
      const letters = whole.toString(encoding).replace(/=+$/, "");
      const lead = [0, 2, 3][before] ?? 0;
      const tail = whole.length % 3 === 0 ? 0 : 1;
      spellings.push(Buffer.from(letters.slice(lead, letters.length - tail)));
    }
  }
  return spellings;
}

/**
 * The raw bytes of a private key given as `curve:base58`, or as the base58 alone, or null if
 * `secret` is not one. Why it is not is never said: a library's message can quote the secret.
 */
function keyBytesOf(secret: string): Uint8Array | null {
  try {
    const raw = baseDecode(secret.slice(secret.indexOf(":") + 1));
    return raw.length >= MIN_KEY_BYTES ? raw : null;
  } catch {
    return null;
  }
}

/** What is looked for, and in which view of the bytes; each needle once. */
interface Needles {
  /** In the bytes as they are. */
  plain: Map<string, Buffer>;
  /** In the bytes with the breaks taken out. */
  text: Map<string, Buffer>;
  /** In the bytes with the breaks taken out, in lower case. */
  hex: Map<string, Buffer>;
}

function addTo(list: Map<string, Buffer>, needle: Buffer): void {
  list.set(needle.toString("latin1"), needle);
}

/** `bytes` in the disguises of a text that is not a key's own: base64 in both alphabets, and hex. */
function addDisguises(needles: Needles, bytes: Uint8Array): void {
  for (const spelling of base64Spellings(bytes)) addTo(needles.text, spelling);
  addTo(needles.hex, Buffer.from(Buffer.from(bytes).toString("hex")));
}

function needlesOf(secrets: readonly string[]): Needles {
  const needles: Needles = { plain: new Map(), text: new Map(), hex: new Map() };
  for (const secret of secrets) {
    // An empty string is in every text, and is no secret.
    if (secret === "") continue;
    const bytes = Buffer.from(secret);
    addTo(needles.plain, bytes);
    if (bytes.length < MIN_DISGUISED_BYTES) continue;

    const unbroken = withoutBreaks(bytes);
    if (unbroken.length >= MIN_DISGUISED_BYTES) addTo(needles.text, unbroken);
    addDisguises(needles, bytes);

    // A key is also its bytes, and its seed alone is the secret: each as they are, in base58, and in
    // the disguises. (The base58 of the whole key is the text after the curve's name, which is
    // listed already as a secret of its own.)
    const key = keyBytesOf(secret);
    if (key === null) continue;
    for (const part of [key, key.subarray(0, SEED_BYTES)]) {
      addTo(needles.plain, Buffer.from(part));
      addTo(needles.text, Buffer.from(baseEncode(part)));
      addDisguises(needles, part);
    }
  }
  return needles;
}

/**
 * A check that says whether some bytes hold any of `secrets`: as they are, or in a disguise (see
 * the top of this file). Built once, since the disguises are worked out from the secrets.
 */
export function secretCheck(secrets: readonly string[]): (bytes: Uint8Array) => boolean {
  const { plain, text, hex } = needlesOf(secrets);
  const plainList = [...plain.values()];
  const textList = [...text.values()];
  const hexList = [...hex.values()];
  return (bytes) => {
    const work = Buffer.from(bytes);
    if (plainList.some((needle) => work.includes(needle))) return true;
    if (textList.length === 0 && hexList.length === 0) return false;
    const unbroken = withoutBreaks(work);
    if (textList.some((needle) => unbroken.includes(needle))) return true;
    const lower = lowerCased(unbroken);
    return hexList.some((needle) => lower.includes(needle));
  };
}

/**
 * The text of a JSON document as a reader has it: every key and every string, one to a line, in the
 * order of the document, with the escapes read. The bytes of a document write a line break or a tab
 * as a backslash and a letter, and a NUL as six characters, so a copy that was wrapped over lines,
 * or that has NULs between its letters as UTF-16 text does, is whole again only in this reading. The
 * numbers and the rest are left out, and so is anything that is no JSON value. It walks with a
 * stack of its own, since a document can be nested deep, and meets a shared object once.
 */
export function documentText(document: unknown): Uint8Array {
  const lines: string[] = [];
  const seen = new Set<object>();
  // Each item is a string to write down or a value to open. The last one goes first, so the members
  // of an array or an object are pushed backwards (a key above its value) to come out in order.
  const pending: unknown[] = [document];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      lines.push(value);
    } else if (typeof value === "object" && value !== null && !seen.has(value)) {
      seen.add(value);
      if (Array.isArray(value)) {
        for (let at = value.length - 1; at >= 0; at--) pending.push(value[at]);
      } else {
        for (const [key, member] of Object.entries(value).reverse()) pending.push(member, key);
      }
    }
  }
  return Buffer.from(lines.join("\n"));
}

// ---- Credentials in a URL --------------------------------------------------------------------

/** The names of query parameters that carry a credential: apikey, api_key, dkey, access_token, ... */
const CREDENTIAL_NAME = /key|token|secret|auth|pass|pwd|sig|cred|jwt|bearer/i;
/** What a token in a URL looks like: 16 or more URL-safe characters, with a letter and a digit. */
const TOKEN_SHAPE = /^(?=.*[0-9])(?=.*[A-Za-z])[A-Za-z0-9._~-]{16,}$/;
/** The shortest piece of a URL that is taken for a credential: a shorter one is cut from too much. */
const MIN_CREDENTIAL_CHARS = 8;

/** `text` with its percent-escapes read, or as it is if they are not valid. */
function unescaped(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * The credentials in `url`, each as written in it and as it reads once unescaped: the user name and
 * the password; the value of a query parameter named like a key or a token, or shaped like one; and
 * a path segment shaped like a token, which is where some providers put theirs. A piece shorter than
 * 8 characters is left out, and so is a host: what is listed is cut from every text the server says
 * and refused in every result, so a short or common word would cost more than it protects. A URL
 * that is no URL has none.
 */
export function urlCredentials(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const found = new Set<string>();
  const add = (written: string) => {
    for (const piece of [written, unescaped(written)]) {
      if (piece.length >= MIN_CREDENTIAL_CHARS) found.add(piece);
    }
  };
  add(parsed.username);
  add(parsed.password);
  for (const pair of parsed.search.slice(1).split("&")) {
    const equals = pair.indexOf("=");
    if (equals < 0) continue;
    const value = pair.slice(equals + 1);
    if (
      CREDENTIAL_NAME.test(unescaped(pair.slice(0, equals))) ||
      TOKEN_SHAPE.test(unescaped(value))
    ) {
      add(value);
    }
  }
  for (const segment of parsed.pathname.split("/")) {
    if (TOKEN_SHAPE.test(unescaped(segment))) add(segment);
  }
  return [...found];
}
