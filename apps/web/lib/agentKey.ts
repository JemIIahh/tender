import { AccountIdSchema } from "@tender/shared";

// What a person types into "Add an agent" (app/(app)/my-agents/new): the agent's public key, which
// its own tool printed where the agent runs, and the name of the account the agent gets under
// theirs. Both are read here, in plain words for what to change, and nothing here makes, keeps or
// sends a key: the page only ever holds the public half.

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** The bytes of `text` in Bitcoin's base58, as NEAR writes keys; null if it has a character base58 doesn't. */
export function base58Decode(text: string): Uint8Array | null {
  let value = 0n;
  for (const char of text) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  // Each leading "1" is a leading zero byte.
  for (const char of text) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** `bytes` in Bitcoin's base58, as NEAR writes keys. */
export function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let text = "";
  while (value > 0n) {
    text = BASE58[Number(value % 58n)] + text;
    value /= 58n;
  }
  // Each leading zero byte is a leading "1".
  for (const byte of bytes) {
    if (byte !== 0) break;
    text = `1${text}`;
  }
  return text;
}

export type KeyReading =
  | { ok: true; publicKey: string }
  | {
      ok: false;
      message: string;
      /** What was pasted is a private key: the page drops it at once, and keeps nothing of it. */
      secret: boolean;
    };

const PREFIX = "ed25519:";

/** What the page says, and does, when what was pasted looks like a secret: it is already cleared. */
export const SECRET_WARNING =
  "That looks like a private key or seed phrase, so it was cleared and not kept. Never paste it here: paste only the public key, which starts with ed25519: and is marked public.";

/**
 * A run of base58 too long to be a public key. 32 bytes are 43 or 44 characters of base58, so a run
 * of 45 or more is something else: a private key (64 bytes, about 88 characters), a public key with
 * more stuck to it, or a key that is neither.
 */
const LONG_BASE58 = /[1-9A-HJ-NP-Za-km-z]{45,}/;
/** 32 or more bytes in hex: a raw seed or key, which NEAR never writes a public key as. */
const LONG_HEX = /[0-9a-fA-F]{64,}/;
/** The words a secret is labelled with: `private_key` and `secret_key` in NEAR's credentials. */
const SECRET_WORDS = /secret|private/i;
/** A seed phrase is 12 or 24 words (BIP-39); a key is one word. */
const SEED_WORDS = 12;

/**
 * Whether `text` looks like key material that must not be on this page: a private key with or
 * without its prefix (in any case), NEAR's credentials JSON or any text that names a secret or
 * private key, a seed phrase, or a run of base58 or hex too long to be a public key. A public key
 * alone, as the agent's tool prints it, is none of these.
 */
export function looksSecret(text: string): boolean {
  if (SECRET_WORDS.test(text) || LONG_BASE58.test(text) || LONG_HEX.test(text)) return true;
  const words = text
    .trim()
    .split(/[\s,]+/)
    .filter((word) => /^[a-z]+$/i.test(word));
  return words.length >= SEED_WORDS;
}

/**
 * The public key a person pasted: `ed25519:` and the 32 bytes of the key in base58, as the agent's
 * tool prints it. Anything that is not one and looks like a secret (`looksSecret`) is refused as a
 * secret, so that the page can drop it from the field at once and say why; anything else is a
 * format to fix.
 */
export function readPublicKey(text: string): KeyReading {
  const typed = text.trim();
  if (typed === "") {
    return { ok: false, secret: false, message: "Paste the public key the agent's tool printed." };
  }
  if (typed.startsWith(PREFIX) && base58Decode(typed.slice(PREFIX.length))?.length === 32) {
    return { ok: true, publicKey: typed };
  }
  if (looksSecret(typed)) return { ok: false, secret: true, message: SECRET_WARNING };
  if (!typed.startsWith(PREFIX)) {
    return { ok: false, secret: false, message: "A public key starts with ed25519:" };
  }
  const bytes = base58Decode(typed.slice(PREFIX.length));
  if (bytes === null || bytes.length === 0) {
    return {
      ok: false,
      secret: false,
      message: "That has characters a key can't have. Copy the key again, all of it.",
    };
  }
  return {
    ok: false,
    secret: false,
    message: "That isn't a whole public key. Copy the key again, all of it.",
  };
}

/** One part of an account id: lower-case letters and digits, joined by single `-` or `_`. */
const PART = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/** An implicit account: 64 hex characters, which has no room for a sub-account under it. */
const IMPLICIT = /^[0-9a-f]{64}$/;

/** The longest account id NEAR takes. */
export const MAX_ACCOUNT_LENGTH = 64;

export type NameReading = { ok: true; accountId: string } | { ok: false; message: string };

/**
 * The account an agent called `name` gets under `parent`: `<name>.<parent>`, a direct sub-account,
 * which `parent` alone can create. The name is one part of an account id, and the whole id is at
 * most 64 characters.
 */
export function readAgentName(name: string, parent: string): NameReading {
  if (IMPLICIT.test(parent) || parent.length + 2 > MAX_ACCOUNT_LENGTH) {
    return {
      ok: false,
      message: `${parent} is too long to have accounts under it. Connect a named account, such as you.testnet.`,
    };
  }
  const typed = name.trim();
  if (typed === "") return { ok: false, message: "Choose a name for the agent's account." };
  if (typed !== typed.toLowerCase()) {
    return { ok: false, message: "Use lower case: an account id has no capitals." };
  }
  if (typed.includes(".")) {
    return {
      ok: false,
      message: `One part only, with no dots: the account will be <name>.${parent}.`,
    };
  }
  if (!PART.test(typed)) {
    return {
      ok: false,
      message: "Use a to z and 0 to 9, with a single - or _ between them.",
    };
  }
  const accountId = `${typed}.${parent}`;
  if (accountId.length > MAX_ACCOUNT_LENGTH) {
    return {
      ok: false,
      message: `Too long: ${accountId} is ${accountId.length} characters, and an account id is ${MAX_ACCOUNT_LENGTH} at most.`,
    };
  }
  if (!AccountIdSchema.safeParse(accountId).success) {
    return { ok: false, message: "That doesn't make a valid account id." };
  }
  return { ok: true, accountId };
}
