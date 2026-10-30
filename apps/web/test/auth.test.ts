import { inspect } from "node:util";
import { ApiError, SIGN_IN_MESSAGE } from "@tender/shared";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  clearApiToken,
  type SignInWallet,
  signInToTender,
  useApiToken,
  WALLET_CANNOT_SIGN_MESSAGE,
  WalletCannotSign,
} from "../lib/auth";
import type { UseWallet } from "../lib/wallet";
import {
  SignInRefused,
  WalletAccountMismatch,
  WalletError,
  WalletNotConnected,
  walletErrorMessage,
} from "../lib/walletErrors";
import { rejection } from "./support";

// Signing in to the API (lib/auth.ts): what the page will have a wallet sign, and what it does
// with the token it gets. The API is a fake `fetch`; vitest.config.ts gives the config an API
// address of http://api.test, which is whom a sign-in must be for.

const ALICE = "alice.testnet";
const RECIPIENT = "http://api.test";
const NONCE_BYTES = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const NONCE = btoa(String.fromCharCode(...NONCE_BYTES));
const SLASHY = btoa(String.fromCharCode(...new Uint8Array(32).fill(0xfb)));
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
// 32 bytes leave two bits in the last character that carry nothing; the canonical spelling has them
// at 0. Setting one gives another string for the same bytes.
const STRAY_BIT = `${NONCE.slice(0, 42)}${BASE64[BASE64.indexOf(NONCE[42] ?? "A") + 1]}=`;
const TOKEN = "tok-0c7f9d2b61a84e35b0c1d2e3f4a5b6c7";
const PUBLIC_KEY = `ed25519:${"2".repeat(44)}`;
const SIGNATURE = btoa("s".repeat(64));

const CHALLENGE = {
  nonce: NONCE,
  message: SIGN_IN_MESSAGE,
  recipient: RECIPIENT,
  expires_at: "2026-10-30T12:00:00.000Z",
};
const VERIFIED = { token: TOKEN, expires_at: "2099-01-01T00:00:00.000Z", key_kind: "full_access" };

interface Call {
  url: string;
  body: unknown;
}

/** An API that answers the two sign-in requests, and notes what it was asked. */
function fakeApi(answers: { challenge?: unknown; verify?: unknown; verifyStatus?: number } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    if (url.endsWith("/auth/challenge")) {
      return new Response(JSON.stringify(answers.challenge ?? CHALLENGE));
    }
    return new Response(JSON.stringify(answers.verify ?? VERIFIED), {
      status: answers.verifyStatus ?? 200,
    });
  });
  return calls;
}

/** A wallet that signs as `accountId` with a fixed signature. */
function wallet(options: Partial<SignInWallet> = {}) {
  const signMessage = vi.fn<SignInWallet["signMessage"]>(async () => ({
    accountId: ALICE,
    publicKey: PUBLIC_KEY,
    signature: SIGNATURE,
  }));
  const value: SignInWallet = { accountId: ALICE, canSignMessage: true, signMessage, ...options };
  return { value, signMessage };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
  clearApiToken();
});

// ---- One sign-in --------------------------------------------------------------------------------

test("sign_in_has_the_wallet_sign_the_challenge_and_trades_the_signature_for_a_token", async () => {
  const calls = fakeApi();
  const { value, signMessage } = wallet();

  const stored = await signInToTender(value);

  expect(signMessage).toHaveBeenCalledTimes(1);
  expect(signMessage).toHaveBeenCalledWith({
    message: SIGN_IN_MESSAGE,
    recipient: RECIPIENT,
    nonce: NONCE_BYTES,
  });
  expect(calls.map((call) => call.url)).toEqual([
    "http://api.test/v1/auth/challenge",
    "http://api.test/v1/auth/verify",
  ]);
  // The API gets back the challenge's own nonce, message and recipient, with the wallet's
  // signature and key, in its names.
  expect(calls[1]?.body).toEqual({
    account_id: ALICE,
    public_key: PUBLIC_KEY,
    signature: SIGNATURE,
    nonce: NONCE,
    message: SIGN_IN_MESSAGE,
    recipient: RECIPIENT,
  });
  expect(stored).toEqual({
    accountId: ALICE,
    token: TOKEN,
    expiresAtMs: Date.parse("2099-01-01T00:00:00.000Z"),
  });
});

test("sign_in_signs_nothing_that_is_not_what_it_expects", async () => {
  // The signature is good for whatever the challenge says, and the server picks the challenge. So
  // a challenge is signed only if its message, its recipient and its nonce are the expected ones.
  const evil = "evil-value-that-must-not-be-quoted";
  const cases: Array<[SignInRefused["field"], Record<string, unknown>]> = [
    ["message", { message: evil }],
    ["message", { message: `${SIGN_IN_MESSAGE} ` }],
    ["recipient", { recipient: `http://${evil}.test` }],
    ["recipient", { recipient: "http://api.test/" }],
    ["recipient", { recipient: "http://api.test/v1" }],
    ["recipient", { recipient: "https://api.test" }],
    ["nonce", { nonce: evil }],
    ["nonce", { nonce: "" }],
    // 31 bytes, and 33 bytes, in canonical base64.
    ["nonce", { nonce: btoa("x".repeat(31)) }],
    ["nonce", { nonce: btoa("x".repeat(33)) }],
    // 32 bytes, unpadded, and URL-safe, which are other spellings of the same bytes.
    ["nonce", { nonce: NONCE.slice(0, -1) }],
    ["nonce", { nonce: SLASHY.replace(/\+/g, "-").replace(/\//g, "_") }],
    // The same 32 bytes with a stray bit in the last character, which `atob` reads without a word.
    ["nonce", { nonce: STRAY_BIT }],
  ];
  for (const [field, change] of cases) {
    const calls = fakeApi({ challenge: { ...CHALLENGE, ...change } });
    const { value, signMessage } = wallet();

    const failure = await rejection(signInToTender(value));

    const label = `${field}: ${JSON.stringify(change)}`;
    expect(failure, label).toBeInstanceOf(SignInRefused);
    expect((failure as SignInRefused).field, label).toBe(field);
    // Nothing was signed, and nothing was sent to the API to trade for a token.
    expect(signMessage, label).not.toHaveBeenCalled();
    expect(
      calls.map((call) => call.url),
      label,
    ).toEqual(["http://api.test/v1/auth/challenge"]);
    // The error names the field and quotes none of what the server sent.
    expect(failure.message, label).toContain(field);
    expect(failure.message, label).not.toContain(evil);
    expect(walletErrorMessage(failure), label).not.toContain(evil);
    vi.unstubAllGlobals();
  }
});

test("sign_in_refuses_a_nonce_that_only_looks_like_the_bytes_it_decodes_to", () => {
  // The stray-bit spelling decodes to the very bytes of the canonical one. It is refused all the
  // same, because the API keys a nonce on its string, and one string it issued is the only one.
  expect(STRAY_BIT).not.toBe(NONCE);
  expect(atob(STRAY_BIT)).toBe(atob(NONCE));
  expect(STRAY_BIT).toMatch(/^[A-Za-z0-9+/]{43}=$/);
});

test("sign_in_by_a_wallet_that_cannot_sign_asks_nobody", async () => {
  const calls = fakeApi();
  const { value, signMessage } = wallet({ canSignMessage: false });

  const failure = await rejection(signInToTender(value));

  expect(failure).toBeInstanceOf(WalletCannotSign);
  expect(failure.message).toBe(WALLET_CANNOT_SIGN_MESSAGE);
  expect(failure.message).toBe(
    "This wallet can't sign messages. Switch wallet to post tasks or link Telegram.",
  );
  // No challenge was asked for either: there is nothing to sign it with.
  expect(calls).toEqual([]);
  expect(signMessage).not.toHaveBeenCalled();
});

test("sign_in_with_no_wallet_connected_says_so_and_asks_nobody", async () => {
  const calls = fakeApi();
  const { value } = wallet({ accountId: null, canSignMessage: false });

  expect(await rejection(signInToTender(value))).toBeInstanceOf(WalletNotConnected);
  expect(calls).toEqual([]);
});

test("sign_in_stops_if_the_wallet_signed_as_another_account_than_the_one_connected", async () => {
  const calls = fakeApi();
  const { value, signMessage } = wallet();
  signMessage.mockResolvedValueOnce({
    accountId: "mallory.testnet",
    publicKey: PUBLIC_KEY,
    signature: SIGNATURE,
  });

  const failure = await rejection(signInToTender(value));

  expect(failure).toBeInstanceOf(WalletAccountMismatch);
  // The API was asked for a challenge and nothing more.
  expect(calls).toHaveLength(1);
});

test("sign_in_passes_on_what_the_wallet_and_the_api_refuse_with", async () => {
  fakeApi();
  const { value, signMessage } = wallet();
  const closed = new WalletError("sign", new Error("closed"));
  signMessage.mockRejectedValueOnce(closed);
  expect(await rejection(signInToTender(value))).toBe(closed);

  // The API refusing the signature is its own words.
  fakeApi({
    verify: { error: "unauthorized", message: "That signature isn't valid." },
    verifyStatus: 401,
  });
  const refused = await rejection(signInToTender(wallet().value));
  expect(refused).toBeInstanceOf(ApiError);
  expect((refused as ApiError).status).toBe(401);
});

test("the_token_is_in_no_error_and_in_no_log", async () => {
  // An answer that is a success but not the shape promised carries the token in its body. The body
  // of an `ApiError` is not shown by `console.log` or `util.inspect`, and nothing here logs.
  const logs = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
  fakeApi({ verify: { token: TOKEN, expires_at: 12345, key_kind: "full_access" } });

  const failure = await rejection(signInToTender(wallet().value));

  expect(failure).toBeInstanceOf(ApiError);
  const shown = [failure.message, String(failure), inspect(failure), walletErrorMessage(failure)];
  for (const text of shown) expect(text).not.toContain(TOKEN);
  for (const spy of logs) expect(spy).not.toHaveBeenCalled();
});

// ---- The hook: the token's keeping --------------------------------------------------------------

// `useApiToken` reads the wallet of the page; the tests give it the state they want.
const current = vi.hoisted(() => ({ wallet: undefined as unknown as UseWallet }));
vi.mock("../lib/wallet", () => ({ useWallet: () => current.wallet }));

function setWallet(options: Partial<UseWallet> = {}) {
  const signMessage = vi.fn<UseWallet["signMessage"]>(async () => ({
    accountId: ALICE,
    publicKey: PUBLIC_KEY,
    signature: SIGNATURE,
  }));
  current.wallet = {
    ready: true,
    accountId: ALICE,
    canSignMessage: true,
    connect: async () => {},
    disconnect: async () => {},
    signAndSend: async () => ({ events: [], txHashes: [] }),
    signMessage,
    ...options,
  };
  return { signMessage };
}

/** `lib/auth.ts` as a page that has just loaded finds it: nothing read from the tab yet. */
async function freshAuth() {
  vi.resetModules();
  return import("../lib/auth");
}

beforeEach(() => {
  setWallet();
});

test("the_token_lives_in_memory_and_in_session_storage_and_never_in_local_storage", async () => {
  fakeApi();
  const { result } = renderHook(() => useApiToken());
  expect(result.current.token).toBeNull();

  let signedIn = "";
  await act(async () => {
    signedIn = await result.current.signIn();
  });

  expect(signedIn).toBe(TOKEN);
  expect(result.current.token).toBe(TOKEN);
  // The tab keeps it, so that a reload does not ask the wallet again...
  expect(JSON.parse(sessionStorage.getItem("tender.apiToken") ?? "null")).toMatchObject({
    accountId: ALICE,
    token: TOKEN,
  });
  // ...and no later visit can read it.
  expect(localStorage.length).toBe(0);
  expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);

  // A page loaded afterwards in the same tab has it without signing in.
  const next = await freshAuth();
  const reloaded = renderHook(() => next.useApiToken());
  expect(reloaded.result.current.token).toBe(TOKEN);
});

test("a_token_is_for_the_account_that_signed_in_and_goes_with_it", async () => {
  fakeApi();
  const { result, rerender } = renderHook(() => useApiToken());
  await act(async () => {
    await result.current.signIn();
  });
  expect(result.current.token).toBe(TOKEN);

  // The wallet is connected as someone else: the token is not theirs, and is dropped.
  setWallet({ accountId: "bob.testnet" });
  rerender();
  expect(result.current.token).toBeNull();
  await vi.waitFor(() => expect(sessionStorage.getItem("tender.apiToken")).toBeNull());

  // And it does not come back when Alice does.
  setWallet();
  rerender();
  expect(result.current.token).toBeNull();
});

test("disconnecting_the_wallet_drops_the_token_but_looking_for_it_does_not", async () => {
  fakeApi();
  const { result, rerender } = renderHook(() => useApiToken());
  await act(async () => {
    await result.current.signIn();
  });

  // While the page is still looking for the wallet from an earlier visit, no account means nothing.
  setWallet({ ready: false, accountId: null, canSignMessage: false });
  rerender();
  expect(sessionStorage.getItem("tender.apiToken")).not.toBeNull();

  setWallet({ ready: true, accountId: null, canSignMessage: false });
  rerender();
  expect(result.current.token).toBeNull();
  await vi.waitFor(() => expect(sessionStorage.getItem("tender.apiToken")).toBeNull());
});

test("a_token_that_has_expired_is_not_given", async () => {
  sessionStorage.setItem(
    "tender.apiToken",
    JSON.stringify({ accountId: ALICE, token: TOKEN, expiresAtMs: Date.now() - 1000 }),
  );
  const { useApiToken } = await freshAuth();

  const { result } = renderHook(() => useApiToken());

  expect(result.current.token).toBeNull();
  expect(sessionStorage.getItem("tender.apiToken")).toBeNull();
});

test("what_the_tab_kept_that_is_not_a_token_is_ignored", async () => {
  for (const kept of [
    "not json",
    "null",
    "[]",
    JSON.stringify({ accountId: ALICE }),
    JSON.stringify({ accountId: ALICE, token: "", expiresAtMs: Date.now() + 1e6 }),
  ]) {
    sessionStorage.setItem("tender.apiToken", kept);
    const { useApiToken } = await freshAuth();

    const { result } = renderHook(() => useApiToken());

    expect(result.current.token, kept).toBeNull();
  }
});

test("a_tab_that_will_not_keep_the_token_still_has_it_in_memory", async () => {
  fakeApi();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("blocked", "SecurityError");
  });
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("blocked", "SecurityError");
  });
  const { useApiToken } = await freshAuth();
  const { result } = renderHook(() => useApiToken());
  expect(result.current.token).toBeNull();

  await act(async () => {
    await result.current.signIn();
  });

  expect(result.current.token).toBe(TOKEN);
});

test("two_buttons_pressed_together_sign_in_once", async () => {
  const calls = fakeApi();
  const { result } = renderHook(() => useApiToken());

  let tokens: string[] = [];
  await act(async () => {
    tokens = await Promise.all([result.current.signIn(), result.current.signIn()]);
  });

  expect(tokens).toEqual([TOKEN, TOKEN]);
  expect(calls.filter((call) => call.url.endsWith("/auth/challenge"))).toHaveLength(1);
  // Pressed again later, it signs in again: the sign-in asked for is the sign-in done.
  await act(async () => {
    await result.current.signIn();
  });
  expect(calls.filter((call) => call.url.endsWith("/auth/challenge"))).toHaveLength(2);
});

test("a_wallet_without_sign_message_cannot_sign_in_and_the_hook_says_why", async () => {
  const calls = fakeApi();
  setWallet({ canSignMessage: false });
  const { result } = renderHook(() => useApiToken());

  const failure = await rejection(result.current.signIn());

  expect(failure).toBeInstanceOf(WalletCannotSign);
  expect(walletErrorMessage(failure)).toBe(
    "This wallet can't sign messages. Switch wallet to post tasks or link Telegram.",
  );
  expect(result.current.token).toBeNull();
  expect(calls).toEqual([]);
});
