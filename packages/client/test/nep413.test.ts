import { bytesToHex, hexToBytes, sha256Hex } from "@tender/shared";
import { Account, KeyPair, KeyPairSigner, KeyType, type Provider, PublicKey } from "near-api-js";
import * as nearNep413 from "near-api-js/nep413";
import { expect, test, vi } from "vitest";
import {
  AuthError,
  type KeyPermission,
  type Nep413Input,
  serializeNep413,
  verifyNep413,
} from "../src/nep413";

const ACCOUNT = "alice.test.near";
const CONTRACT = "tender.test.near";
const RECIPIENT = "tender";
const MESSAGE = "Sign in to Tender";

type Payload = nearNep413.SignMessageArgs["payload"];

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const randomNonce = () => crypto.getRandomValues(new Uint8Array(32));
const newKey = () => KeyPair.fromRandom("ed25519");

/**
 * Signs with near-api-js itself, so the tests do not lean on the serializer they check. Signing a
 * NEP-413 message is local, so the account's provider is never called.
 */
async function signWithNearApiJs(keyPair: KeyPair, payload: Payload): Promise<Nep413Input> {
  const signerAccount = new Account(ACCOUNT, {} as unknown as Provider, new KeyPairSigner(keyPair));
  const signed = await nearNep413.signMessage({ signerAccount, payload });
  return {
    accountId: ACCOUNT,
    publicKey: signed.publicKey.toString(),
    signature: toBase64(signed.signature),
    message: payload.message,
    nonce: toBase64(payload.nonce),
    recipient: payload.recipient,
    ...(payload.callbackUrl === undefined ? {} : { callbackUrl: payload.callbackUrl }),
  };
}

/** The four fields a NEP-413 signature covers, read back out of a sign-in. */
function payloadOf(input: Nep413Input): Payload {
  return {
    message: input.message,
    recipient: input.recipient,
    nonce: Uint8Array.from(Buffer.from(input.nonce, "base64")),
    ...(input.callbackUrl === undefined ? {} : { callbackUrl: input.callbackUrl }),
  };
}

/** A sign-in the way the API sees it: a fresh key signs the standard challenge. */
async function signIn(overrides: Partial<Payload> = {}) {
  const keyPair = newKey();
  const input = await signWithNearApiJs(keyPair, {
    message: MESSAGE,
    recipient: RECIPIENT,
    nonce: randomNonce(),
    ...overrides,
  });
  return { keyPair, input };
}

interface DepsOverrides {
  contractId?: string;
  expectedRecipient?: string;
}

/** Dependencies whose chain lookup answers `permission`, or "no such key" for `null`. */
function depsFor(permission: KeyPermission | null, overrides: DepsOverrides = {}) {
  return {
    viewAccessKey: vi.fn(async (_accountId: string, _publicKey: string) =>
      permission === null ? null : { permission },
    ),
    contractId: CONTRACT,
    expectedRecipient: RECIPIENT,
    ...overrides,
  };
}

/** Dependencies whose lookup finds the key and reports `permission` untouched, whatever its shape. */
function depsForRaw(permission: unknown, overrides: DepsOverrides = {}) {
  return {
    ...depsFor("FullAccess", overrides),
    viewAccessKey: vi.fn(async (_accountId: string, _publicKey: string) => ({
      permission: permission as KeyPermission,
    })),
  };
}

function functionCallTo(receiver_id: string): KeyPermission {
  return { FunctionCall: { receiver_id, method_names: [] } };
}

async function expectAuthError(promise: Promise<unknown>, code: AuthError["code"]) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AuthError);
  expect((error as AuthError).code).toBe(code);
}

// The eight cases of the task brief.

test("serialization_matches_near_api_js", async () => {
  const keyPair = newKey();
  const payloads: Payload[] = [
    { message: MESSAGE, recipient: RECIPIENT, nonce: randomNonce() },
    {
      message: "Sign in \u0000 to Tender ✓ héllo \u{1F600}",
      recipient: RECIPIENT,
      nonce: randomNonce(),
      callbackUrl: "https://tender.example/cb?x=1&y=é",
    },
    // Some("") is not None: the two encode differently, and both sides must agree on which is meant.
    { message: "", recipient: "r", nonce: new Uint8Array(32), callbackUrl: "" },
  ];

  for (const payload of payloads) {
    // near-api-js signs, Tender verifies: the signature only checks if both hash the same bytes.
    const input = await signWithNearApiJs(keyPair, payload);
    const deps = depsFor("FullAccess", { expectedRecipient: payload.recipient });
    await expect(verifyNep413(input, deps)).resolves.toEqual({
      accountId: ACCOUNT,
      publicKey: keyPair.getPublicKey().toString(),
      keyKind: "full_access",
    });

    // Tender's bytes are signed, near-api-js verifies (its stub provider reports a full-access key).
    const digest = hexToBytes(sha256Hex(serializeNep413(input)));
    await expect(
      nearNep413.verifyMessage({
        signerAccountId: ACCOUNT,
        signerPublicKey: keyPair.getPublicKey(),
        payload,
        signature: keyPair.sign(digest).signature,
        provider: {
          viewAccessKey: async () => ({ nonce: 0, permission: "FullAccess" }),
        } as unknown as Provider,
      }),
    ).resolves.toBeUndefined();
  }
});

test("full_access_accepted", async () => {
  const { keyPair, input } = await signIn();
  const deps = depsFor("FullAccess");

  await expect(verifyNep413(input, deps)).resolves.toEqual({
    accountId: ACCOUNT,
    publicKey: keyPair.getPublicKey().toString(),
    keyKind: "full_access",
  });
  expect(deps.viewAccessKey).toHaveBeenCalledExactlyOnceWith(
    ACCOUNT,
    keyPair.getPublicKey().toString(),
  );
});

test("function_call_key_for_tender_accepted", async () => {
  const { keyPair, input } = await signIn();

  // Any method list is fine, including a restricted one; only the receiver matters.
  for (const method_names of [[], ["commit", "reveal"]]) {
    const deps = depsFor({ FunctionCall: { receiver_id: CONTRACT, method_names } });
    await expect(verifyNep413(input, deps)).resolves.toEqual({
      accountId: ACCOUNT,
      publicKey: keyPair.getPublicKey().toString(),
      keyKind: "function_call",
    });
  }
});

test("function_call_key_for_other_contract_rejected", async () => {
  const { input } = await signIn();

  // The receiver has to be the Tender contract exactly: no other contract, no look-alike.
  const receivers = [
    "evil.test.near",
    `sub.${CONTRACT}`,
    `${CONTRACT}.evil`,
    `x${CONTRACT}`,
    CONTRACT.toUpperCase(),
    `${CONTRACT} `,
    "",
  ];
  for (const receiver of receivers) {
    await expectAuthError(
      verifyNep413(input, depsFor(functionCallTo(receiver))),
      "key_not_allowed",
    );
  }
});

test("wrong_recipient_rejected", async () => {
  const deps = depsFor("FullAccess");

  // Signed for another app: the signature is valid, the audience is wrong.
  const forOtherApp = await signIn({ recipient: "evil.app" });
  await expectAuthError(verifyNep413(forOtherApp.input, deps), "wrong_recipient");

  // Signed for Tender, but the request names another recipient.
  const { input } = await signIn();
  for (const recipient of ["evil.app", "Tender", "tender ", " tender", "tende", "tender2", ""]) {
    await expectAuthError(verifyNep413({ ...input, recipient }, deps), "wrong_recipient");
  }
  expect(deps.viewAccessKey).not.toHaveBeenCalled();
});

test("tampered_message_rejected", async () => {
  const { keyPair, input } = await signIn();
  const deps = depsFor("FullAccess");
  await expect(verifyNep413(input, deps)).resolves.toBeDefined();
  deps.viewAccessKey.mockClear();

  const otherKey = newKey();
  const flipped = Buffer.from(input.signature, "base64");
  flipped[0] = (flipped[0] ?? 0) ^ 1;
  const signedByOtherKey = await signWithNearApiJs(otherKey, payloadOf(input));
  const tampered: Nep413Input[] = [
    { ...input, message: `${MESSAGE} and approve everything` },
    { ...input, message: MESSAGE.toLowerCase() },
    { ...input, nonce: toBase64(randomNonce()) },
    { ...input, callbackUrl: "https://evil.example" },
    { ...input, callbackUrl: "" },
    { ...input, signature: flipped.toString("base64") },
    { ...input, signature: toBase64(new Uint8Array(64)) },
    // Signed by someone else's key but claiming this one, and the reverse.
    { ...input, signature: signedByOtherKey.signature },
    { ...input, publicKey: otherKey.getPublicKey().toString() },
  ];
  for (const attempt of tampered) {
    await expectAuthError(verifyNep413(attempt, deps), "bad_signature");
  }

  // A signature made over a callbackUrl does not verify once the callbackUrl is dropped.
  const withCallback = await signWithNearApiJs(keyPair, {
    ...payloadOf(input),
    callbackUrl: "https://tender.example/cb",
  });
  const { callbackUrl: _dropped, ...withoutCallback } = withCallback;
  await expectAuthError(verifyNep413(withoutCallback, deps), "bad_signature");

  // None of these reached the chain: the cheap local checks run first.
  expect(deps.viewAccessKey).not.toHaveBeenCalled();
});

test("unknown_key_rejected", async () => {
  // An attacker signs with their own key but names somebody else's account. The signature is
  // perfectly valid; the chain says that key is not on that account.
  const { keyPair, input } = await signIn();
  const deps = depsFor(null);

  await expectAuthError(
    verifyNep413({ ...input, accountId: "victim.test.near" }, deps),
    "key_not_found",
  );
  expect(deps.viewAccessKey).toHaveBeenCalledExactlyOnceWith(
    "victim.test.near",
    keyPair.getPublicKey().toString(),
  );
});

test("nonce_must_be_32_bytes", async () => {
  const { input } = await signIn();
  const deps = depsFor("FullAccess");

  for (const length of [0, 1, 31, 33, 64]) {
    const nonce = toBase64(new Uint8Array(length).fill(7));
    await expectAuthError(verifyNep413({ ...input, nonce }, deps), "bad_nonce");
    expect(() => serializeNep413({ ...input, nonce })).toThrow(AuthError);
  }
  for (const nonce of ["", "not base64!", "%%%%", "=", "A"]) {
    await expectAuthError(verifyNep413({ ...input, nonce }, deps), "bad_nonce");
  }
  expect(deps.viewAccessKey).not.toHaveBeenCalled();

  // Exactly 32 bytes is accepted.
  await expect(verifyNep413(input, deps)).resolves.toBeDefined();
});

// Checks for the decisions in nep413.ts that go beyond the eight cases above.

test("serialization_layout_is_the_nep413_tag_then_borsh", () => {
  const nonce = Uint8Array.from({ length: 32 }, (_, i) => i);
  const base = { message: "hi", nonce: toBase64(nonce), recipient: "tender" };
  const upToCallback = `9d010080${"02000000"}6869${bytesToHex(nonce)}${"06000000"}74656e646572`;

  // 2^31 + 413 as a little-endian u32, then message, nonce (no length prefix), recipient, Option.
  expect(bytesToHex(serializeNep413(base))).toBe(`${upToCallback}00`);
  expect(bytesToHex(serializeNep413({ ...base, callbackUrl: "x" }))).toBe(
    `${upToCallback}01${"01000000"}78`,
  );
  expect(serializeNep413({ ...base, callbackUrl: "" })).not.toEqual(serializeNep413(base));
});

test("only_exact_permissions_are_accepted", async () => {
  const { input } = await signIn();
  const gas = { balance: "0", num_nonces: 1 };

  const permissions: unknown[] = [
    // The newer gas-key variants of the RPC's permission view are neither of the two accepted.
    { GasKeyFullAccess: gas },
    { GasKeyFunctionCall: { receiver_id: CONTRACT, method_names: [], ...gas } },
    // Near misses of the two accepted spellings.
    "fullaccess",
    "FULL_ACCESS",
    "FullAccess ",
    "FunctionCall",
    { FunctionCall: null },
    { FunctionCall: {} },
    { FunctionCall: { method_names: [] } },
    { FunctionCall: { receiver_id: 42 } },
    { FunctionCall: { receiver_id: [CONTRACT] } },
    { FunctionCall: { receiver_id: CONTRACT }, GasKeyFullAccess: gas },
    // Not a permission at all.
    {},
    [],
    null,
    undefined,
    42,
    true,
  ];
  for (const permission of permissions) {
    await expectAuthError(verifyNep413(input, depsForRaw(permission)), "key_not_allowed");
  }

  // A lookup that answers with something that is not even `{ permission }` is not trusted either.
  const odd: Array<unknown> = [{}, "FullAccess", 1, true];
  for (const answer of odd) {
    const deps = { ...depsFor("FullAccess"), viewAccessKey: async () => answer as never };
    await expectAuthError(verifyNep413(input, deps), "key_not_allowed");
  }
});

test("empty_configuration_fails_closed", async () => {
  // A deployment that forgot to set these must not accept the empty string as a match.
  const emptyRecipient = await signIn({ recipient: "" });
  await expectAuthError(
    verifyNep413(emptyRecipient.input, depsFor("FullAccess", { expectedRecipient: "" })),
    "wrong_recipient",
  );

  const { input } = await signIn();
  for (const receiver of ["", CONTRACT]) {
    await expectAuthError(
      verifyNep413(input, depsFor(functionCallTo(receiver), { contractId: "" })),
      "key_not_allowed",
    );
  }
  await expectAuthError(
    verifyNep413(input, depsForRaw({ FunctionCall: {} }, { contractId: undefined as never })),
    "key_not_allowed",
  );
});

test("nonce_spelling_is_canonical", async () => {
  // Bytes chosen so that the base64 contains both '+' and '/'.
  const bytes = Uint8Array.from(
    { length: 32 },
    (_, i) => [0xfb, 0xef, 0xbe, 0xff, 0xff, 0xff][i] ?? i,
  );
  const { input } = await signIn({ nonce: bytes });
  const deps = depsFor("FullAccess");
  const canonical = toBase64(bytes);
  expect(canonical).toMatch(/\+.*\//);
  expect(input.nonce).toBe(canonical);
  await expect(verifyNep413(input, deps)).resolves.toBeDefined();

  // The last character of a 32-byte nonce has two unused bits that lenient decoders ignore.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lastIndex = alphabet.indexOf(canonical.charAt(42));
  const spellings = [
    canonical.replace(/=+$/, ""),
    canonical.replaceAll("+", "-").replaceAll("/", "_"),
    ` ${canonical}`,
    `${canonical}\n`,
    `${canonical.slice(0, 20)}\n${canonical.slice(20)}`,
    `${canonical.slice(0, 42)}${alphabet.charAt(lastIndex + 1)}=`,
  ];
  for (const nonce of spellings) {
    // Each one is another spelling of the same 32 bytes to a lenient decoder such as Buffer's...
    expect(nonce).not.toBe(canonical);
    expect(Buffer.from(nonce, "base64")).toEqual(Buffer.from(bytes));
    // ...so none of them is accepted: a nonce has one spelling.
    await expectAuthError(verifyNep413({ ...input, nonce }, deps), "bad_nonce");
  }
});

test("only_ed25519_keys_can_sign_in", async () => {
  const deps = depsFor("FullAccess");

  // Valid keys of other curves, with signatures made by near-api-js, are refused up front.
  for (const curve of ["secp256k1", "ml-dsa-65"] as const) {
    const input = await signWithNearApiJs(KeyPair.fromRandom(curve), {
      message: MESSAGE,
      recipient: RECIPIENT,
      nonce: randomNonce(),
    });
    await expectAuthError(verifyNep413(input, deps), "key_not_allowed");
  }

  // Strings that are not keys, and one so long that decoding it would stall the process.
  const { input } = await signIn();
  const notKeys = ["", "not a key", "ed25519:", "ed25519:0OIl", "ed25519:ed25519:x", "rsa:abc"];
  for (const publicKey of [...notKeys, `ed25519:${"z".repeat(80_000)}`]) {
    await expectAuthError(verifyNep413({ ...input, publicKey }, deps), "key_not_allowed");
  }
  expect(deps.viewAccessKey).not.toHaveBeenCalled();
});

test("public_key_is_looked_up_and_returned_in_canonical_form", async () => {
  const { keyPair, input } = await signIn();
  const canonical = keyPair.getPublicKey().toString();
  const bareBase58 = canonical.slice("ed25519:".length);

  // PublicKey.from reads these as the same key; the chain lookup and the result use one spelling.
  for (const publicKey of [canonical, bareBase58, `ED25519:${bareBase58}`]) {
    const deps = depsFor("FullAccess");
    await expect(verifyNep413({ ...input, publicKey }, deps)).resolves.toEqual({
      accountId: ACCOUNT,
      publicKey: canonical,
      keyKind: "full_access",
    });
    expect(deps.viewAccessKey).toHaveBeenCalledExactlyOnceWith(ACCOUNT, canonical);
  }
});

test("malformed_signatures_are_bad_signatures", async () => {
  const { input } = await signIn();
  const deps = depsFor("FullAccess");
  const raw = Buffer.from(input.signature, "base64");

  const malformed = [
    "",
    "!!!!",
    "not base64",
    toBase64(raw.subarray(0, 63)),
    toBase64(Buffer.concat([raw, Buffer.of(0)])),
    toBase64(new Uint8Array(0)),
    undefined as unknown as string,
    null as unknown as string,
    42 as unknown as string,
  ];
  for (const signature of malformed) {
    await expectAuthError(verifyNep413({ ...input, signature }, deps), "bad_signature");
  }

  // Padding is the one thing about a signature's spelling that is not insisted on.
  const unpadded = input.signature.replace(/=+$/, "");
  expect(unpadded).not.toBe(input.signature);
  await expect(verifyNep413({ ...input, signature: unpadded }, deps)).resolves.toBeDefined();
});

test("ill_formed_text_is_rejected", async () => {
  // A lone surrogate has no UTF-8 form. TextEncoder would silently write U+FFFD for it, and
  // borsh-js 2.0.0 maps different such strings onto the same bytes, so there is no one right answer.
  const { input } = await signIn();
  const deps = depsFor("FullAccess");

  for (const bad of ["\ud800", "\udc00", "a\ud800b", "\udc00\ud800"]) {
    await expectAuthError(verifyNep413({ ...input, message: bad }, deps), "bad_signature");
    await expectAuthError(verifyNep413({ ...input, callbackUrl: bad }, deps), "bad_signature");
    expect(() => serializeNep413({ ...input, message: bad })).toThrow(AuthError);
  }
  // A correctly paired surrogate is ordinary text (and is covered by the near-api-js parity test).
  expect(() => serializeNep413({ ...input, message: "\u{1F600}" })).not.toThrow();
});

test("account_id_must_be_present_and_bounded", async () => {
  const { input } = await signIn();
  const deps = depsFor("FullAccess");

  // NEAR account ids are at most 64 characters.
  for (const accountId of ["", "a".repeat(65), undefined as unknown as string]) {
    await expectAuthError(verifyNep413({ ...input, accountId }, deps), "key_not_found");
  }
  expect(deps.viewAccessKey).not.toHaveBeenCalled();
});

test("a_key_that_is_not_a_curve_point_is_a_bad_signature", async () => {
  // Thirty-two 0xff bytes are the right size for a key but not a point on the curve.
  const { input } = await signIn();
  const notAPoint = new PublicKey({
    keyType: KeyType.ED25519,
    data: new Uint8Array(32).fill(0xff),
  });
  const deps = depsFor("FullAccess");

  await expectAuthError(
    verifyNep413({ ...input, publicKey: notAPoint.toString() }, deps),
    "bad_signature",
  );
  expect(deps.viewAccessKey).not.toHaveBeenCalled();
});

test("a_throwing_verify_is_a_refusal_not_a_crash_or_a_pass", async () => {
  // No known input makes ed25519 verification throw once sizes are checked, so make it throw: the
  // answer must still be a refusal, whatever the crypto library does.
  const { input } = await signIn();
  const spy = vi.spyOn(PublicKey.prototype, "verify").mockImplementation(() => {
    throw new RangeError("unexpected");
  });
  try {
    await expectAuthError(verifyNep413(input, depsFor("FullAccess")), "bad_signature");
    expect(spy).toHaveBeenCalledOnce();
  } finally {
    spy.mockRestore();
  }
});

test("chain_errors_propagate_and_never_pass_for_success", async () => {
  const { input } = await signIn();
  const outage = new Error("rpc unavailable");
  const deps = { ...depsFor("FullAccess"), viewAccessKey: vi.fn().mockRejectedValue(outage) };

  // An outage is the caller's 5xx, not "key not found" and not an accepted sign-in.
  await expect(verifyNep413(input, deps)).rejects.toBe(outage);
});
