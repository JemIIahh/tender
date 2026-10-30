import { AccountIdSchema, hexToBytes, sha256Hex } from "@tender/shared";
import { KeyType, PublicKey } from "near-api-js";

/** What a NEP-413 sign-in request carries. `signature` and `nonce` are base64. */
export interface Nep413Input {
  accountId: string;
  publicKey: string;
  /** base64, 64 bytes (ed25519) */
  signature: string;
  message: string;
  /** base64, exactly 32 bytes */
  nonce: string;
  recipient: string;
  /** Left out or null means no callback, as in borsh and near-api-js. An empty string is one. */
  callbackUrl?: string | null;
}

/** The four fields of a sign-in that the signature covers. */
export type Nep413Payload = Pick<Nep413Input, "message" | "nonce" | "recipient" | "callbackUrl">;

/** An access key's permission, as the NEAR RPC reports it. */
export type KeyPermission =
  | "FullAccess"
  | { FunctionCall: { receiver_id: string; method_names: string[] } };

export type AuthErrorCode =
  | "bad_signature"
  | "wrong_recipient"
  | "bad_nonce"
  | "key_not_found"
  | "key_not_allowed";

/** Why a sign-in was refused. Anything else that `verifyNep413` throws is not the caller's fault. */
export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string = code) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

export interface Nep413Deps {
  /** The permission of that key on that account, or null when the account has no such key. */
  viewAccessKey(
    accountId: string,
    publicKey: string,
  ): Promise<{ permission: KeyPermission } | null>;
  /** The Tender contract: the one receiver a function-call key may be limited to. */
  contractId: string;
  /** What `recipient` must equal. */
  expectedRecipient: string;
}

export interface Nep413Result {
  accountId: string;
  /** The key in its canonical `ed25519:<base58>` spelling, which is also what was looked up. */
  publicKey: string;
  keyKind: "full_access" | "function_call";
}

/** NEP-461's tag for NEP 413, 2^31 + 413. Its high bit stops signed bytes parsing as a transaction. */
const NEP413_TAG = 2 ** 31 + 413;
const NONCE_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
/**
 * `PublicKey.from` decodes base58, which is quadratic in the length: 80 kB of input stalls the
 * process for seconds. A key string is 52 characters for ed25519, 98 for secp256k1 and about 2,700
 * for ML-DSA-65. The cap sits above the first two, so a secp256k1 key is refused for its curve and
 * only junk and post-quantum keys are refused for their length.
 */
const MAX_PUBLIC_KEY_CHARS = 128;
const LONE_SURROGATE = /\p{Surrogate}/u;

const utf8 = new TextEncoder();

function u32le(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A string with a UTF-8 form, which one holding a lone surrogate does not have. */
function isWellFormedText(value: unknown): value is string {
  return typeof value === "string" && !LONE_SURROGATE.test(value);
}

/** borsh and near-api-js write `undefined` and `null` alike, as an Option's None. */
function isAbsent(value: unknown): value is null | undefined {
  return value === undefined || value === null;
}

/**
 * Borsh `string`: a u32 byte length, then UTF-8. A lone surrogate has no UTF-8 form: TextEncoder
 * would write U+FFFD, and borsh-js 2.0.0 writes bytes that other strings also produce, so a
 * signature over such text cannot be matched to one string. It is refused with a TypeError, which
 * is what a signer sees, since it can get here before any signature exists. `verifyNep413` checks
 * the caller's text first and answers it with `bad_signature`.
 */
function borshString(name: string, value: unknown): Uint8Array {
  if (!isWellFormedText(value)) {
    throw new TypeError(
      `${name} must be a string without lone surrogates, which have no UTF-8 form`,
    );
  }
  const text = utf8.encode(value);
  return concat([u32le(text.length), text]);
}

function fromBase64(value: unknown): Uint8Array | null {
  if (typeof value !== "string") return null;
  try {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * The nonce as 32 bytes. `atob` also reads unpadded, spaced and loosely padded spellings of the
 * same bytes, so the spelling `btoa` writes is the only one accepted: a nonce has one string form,
 * which lets the API key its single-use record on the string.
 */
function decodeNonce(value: unknown): Uint8Array {
  const bytes = fromBase64(value);
  if (bytes === null || bytes.length !== NONCE_BYTES || toBase64(bytes) !== value) {
    throw new AuthError("bad_nonce", "nonce must be exactly 32 bytes in canonical base64");
  }
  return bytes;
}

function encodePayload(
  message: string,
  nonce: Uint8Array,
  recipient: string,
  callbackUrl: string | null | undefined,
): Uint8Array {
  return concat([
    u32le(NEP413_TAG),
    borshString("message", message),
    nonce,
    borshString("recipient", recipient),
    // Option<string>: absent and null are None, which has the one encoding. "" is Some("").
    isAbsent(callbackUrl)
      ? Uint8Array.of(0)
      : concat([Uint8Array.of(1), borshString("callbackUrl", callbackUrl)]),
  ]);
}

/**
 * The bytes a NEP-413 signature is made over, before hashing: the tag, then the borsh encoding of
 * message, nonce (32 raw bytes, no length), recipient and callbackUrl (an Option). The signature
 * itself is over their SHA-256. Takes a whole sign-in, or just the four signed fields, so that a
 * signer can call it before it has a signature.
 *
 * Throws an `AuthError` (`bad_nonce`) for a nonce that is not 32 bytes of canonical base64, and a
 * `TypeError` for text that is not a string or has a lone surrogate.
 */
export function serializeNep413(i: Nep413Payload & Partial<Nep413Input>): Uint8Array {
  const { message, nonce, recipient, callbackUrl } = i;
  return encodePayload(message, decodeNonce(nonce), recipient, callbackUrl);
}

/** `a` is a non-empty string equal to `b`. An unset or empty setting therefore matches nothing. */
function sameNonEmpty(a: unknown, b: unknown): boolean {
  return typeof a === "string" && a !== "" && a === b;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Only the ed25519 keys that NEP-413 is defined for. `PublicKey.from` also reads other curves. */
function parseEd25519Key(value: unknown): PublicKey {
  if (typeof value === "string" && value.length <= MAX_PUBLIC_KEY_CHARS) {
    try {
      const key = PublicKey.from(value);
      if (key.keyType === KeyType.ED25519) return key;
    } catch {
      // Not a key string at all; refused below.
    }
  }
  throw new AuthError("key_not_allowed", "public key must be a well-formed ed25519 key");
}

function signatureVerifies(key: PublicKey, digest: Uint8Array, signature: Uint8Array): boolean {
  try {
    return key.verify(digest, signature) === true;
  } catch {
    return false;
  }
}

/**
 * The policy: a FullAccess key, or a FunctionCall key limited to the Tender contract. Every other
 * answer is refused, including the RPC's gas-key variants and anything of an unexpected shape.
 * It is exported so that whoever asks again whether a signed-in key still qualifies, as the API
 * does for its tokens, asks the same question as the sign-in did.
 */
export function keyKindOf(permission: unknown, contractId: string): Nep413Result["keyKind"] | null {
  if (permission === "FullAccess") return "full_access";
  const variant = asRecord(permission);
  if (variant === null) return null;
  // The RPC's enum has exactly one own key, and it has to be this one.
  const names = Object.keys(variant);
  if (names.length === 1 && names[0] === "FunctionCall") {
    const functionCall = asRecord(variant.FunctionCall);
    if (functionCall !== null && sameNonEmpty(functionCall.receiver_id, contractId)) {
      return "function_call";
    }
  }
  return null;
}

/**
 * Accepts a sign-in only if all of these hold, checked in this order:
 *
 * 1. the nonce is 32 bytes in canonical base64 (`bad_nonce`);
 * 2. the recipient is the expected one (`wrong_recipient`);
 * 3. the public key is a well-formed ed25519 key (`key_not_allowed`);
 * 4. the signature is the key's ed25519 signature over the SHA-256 of `serializeNep413(i)`
 *    (`bad_signature`);
 * 5. that key is on that account according to `deps.viewAccessKey` (`key_not_found`, which an
 *    account id that is not a NEAR account id also gets, without a lookup);
 * 6. it is a FullAccess key, or a FunctionCall key whose receiver is `deps.contractId`
 *    (`key_not_allowed`).
 *
 * The local checks run first, so a bad request never costs a chain lookup. A failed lookup (the
 * RPC being down) rejects with that error rather than an `AuthError`.
 *
 * Not checked here: that the nonce was issued by the API and is unused, and what `message` says.
 * NEP-413 signs neither the account id nor the public key, so only step 5 ties the key to the
 * account.
 */
export async function verifyNep413(i: Nep413Input, deps: Nep413Deps): Promise<Nep413Result> {
  // Every field is read here, once. Everything below uses these locals, so a getter on `i` cannot
  // show the checks one value and the signature another.
  const {
    accountId,
    publicKey: claimedKey,
    signature: signatureText,
    message,
    nonce: nonceText,
    recipient,
    callbackUrl,
  } = i;

  const nonce = decodeNonce(nonceText);

  if (!sameNonEmpty(recipient, deps.expectedRecipient)) {
    throw new AuthError("wrong_recipient", "message was signed for a different recipient");
  }

  const key = parseEd25519Key(claimedKey);

  const signature = fromBase64(signatureText);
  if (signature === null || signature.length !== ED25519_SIGNATURE_BYTES) {
    throw new AuthError("bad_signature", "signature must be 64 bytes in base64");
  }
  // The recipient equals the configured value by now, so only the caller's own text can be bad.
  if (!isWellFormedText(message) || (!isAbsent(callbackUrl) && !isWellFormedText(callbackUrl))) {
    throw new AuthError("bad_signature", "signed text must be well-formed Unicode");
  }
  const digest = hexToBytes(sha256Hex(encodePayload(message, nonce, recipient, callbackUrl)));
  if (!signatureVerifies(key, digest, signature)) {
    throw new AuthError("bad_signature", "signature does not match the message and key");
  }

  if (!AccountIdSchema.safeParse(accountId).success) {
    throw new AuthError("key_not_found", "account id is not a NEAR account id");
  }
  const publicKey = key.toString();
  const accessKey = await deps.viewAccessKey(accountId, publicKey);
  if (!accessKey) {
    throw new AuthError("key_not_found", "that key is not on that account");
  }

  const keyKind = keyKindOf(accessKey.permission, deps.contractId);
  if (keyKind === null) {
    throw new AuthError("key_not_allowed", "that key may not sign in to Tender");
  }
  return { accountId, publicKey, keyKind };
}
