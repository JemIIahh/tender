import {
  base58Decode,
  base58Encode,
  MAX_ACCOUNT_LENGTH,
  type NameReading,
  readAgentName,
} from "@tender/shared";

// What a person types into "Add an agent" (app/(app)/my-agents/new): the agent's public key, which
// its own tool printed where the agent runs, and the name of the account the agent gets under
// theirs. Both are read here, in plain words for what to change, and nothing here makes, keeps or
// sends a key: the page only ever holds the public half.

// The base58 of NEAR's keys and the rule for an agent's account name are `@tender/shared`'s, so
// that the connect codes of the API (packages/api/src/routes/connect.ts) check a name as this page
// does, in the same words.
export { base58Decode, base58Encode, MAX_ACCOUNT_LENGTH, type NameReading, readAgentName };

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
