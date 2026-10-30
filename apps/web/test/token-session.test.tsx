import { SIGN_IN_MESSAGE } from "@tender/shared";
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { heldToken } from "../lib/apiToken";
import { clearApiToken, type UseApiToken, useApiToken } from "../lib/auth";
import { createWalletStore, type Session, type WalletStore } from "../lib/wallet";
import { WalletSessionEnded, walletErrorMessage } from "../lib/walletErrors";
import { FakeChain } from "./fakeChain";
import { rejection } from "./support";
import { type ChainWallet, chainWallet, type FakeProvider, fakeProvider } from "./walletDoubles";

// The API token and the wallet session (lib/apiToken.ts, lib/wallet.ts, lib/auth.ts), with the
// real store and the real hook. The token goes where the wallet session ends, whichever page is
// open, and a sign-in does not keep its token for a session that is over. The API is a fake `fetch`;
// vitest.config.ts gives the config an API address of http://api.test.

const ALICE = "alice.testnet";
const BOB = "bob.testnet";
const KEY = "tender.apiToken";
const NONCE = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)));
const CHALLENGE = {
  nonce: NONCE,
  message: SIGN_IN_MESSAGE,
  recipient: "http://api.test",
  expires_at: "2026-10-30T12:00:00.000Z",
};

// The hook reads the wallet from `lib/wallet`; the tests hand it a store of their own.
const holder = vi.hoisted(() => ({ store: undefined as unknown as WalletStore }));
vi.mock("../lib/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wallet")>();
  return { ...actual, useWallet: () => actual.useWalletStore(holder.store) };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearApiToken();
  sessionStorage.clear();
});

interface FakeApi {
  challenges: number;
  /** Trades of a signature for a token that began, and the tokens given, in order. */
  verifies: number;
  tokens: string[];
  /** Lets the held trades through. */
  release(): void;
}

/**
 * An API that issues the challenge and trades any signature for a token named for the account and
 * for its place among the tokens given. `hold`: the trades wait until `release`.
 */
function fakeApi(options: { hold?: boolean } = {}): FakeApi {
  let release: () => void = () => {};
  const gate = options.hold
    ? new Promise<void>((resolve) => {
        release = resolve;
      })
    : undefined;
  const api: FakeApi = { challenges: 0, verifies: 0, tokens: [], release: () => release() };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/auth/challenge")) {
      api.challenges++;
      return new Response(JSON.stringify(CHALLENGE));
    }
    api.verifies++;
    const { account_id: accountId } = JSON.parse(String(init.body)) as { account_id: string };
    await gate;
    const token = `tok-${accountId}-${api.tokens.length + 1}`;
    api.tokens.push(token);
    return new Response(
      JSON.stringify({ token, expires_at: "2099-01-01T00:00:00.000Z", key_kind: "full_access" }),
    );
  });
  return api;
}

/** A wallet for `accountId`, on a chain of its own, and the session it makes. */
function sessionFor(accountId: string): Session & { wallet: ChainWallet } {
  return { wallet: chainWallet(new FakeChain("tender.testnet", []), accountId), accountId };
}

/** A provider that connects as each of the sessions in turn; a closed dialog after the last. */
function providerFor(first: Session, ...later: Session[]): FakeProvider {
  const queue = [first, ...later];
  const provider = fakeProvider(first);
  provider.connect = async () => {
    provider.connects++;
    return queue.shift() ?? null;
  };
  return provider;
}

/** The page's store, with the wallet connected. */
async function connectedStore(provider: FakeProvider): Promise<WalletStore> {
  holder.store = createWalletStore(async () => provider);
  await holder.store.connect();
  return holder.store;
}

/** Makes the first request to sign wait, as the wallet's dialog does while the person has it open. */
function holdFirstSignature(wallet: ChainWallet) {
  const sign = wallet.signMessage.bind(wallet);
  let opened = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  wallet.signMessage = async (params) => {
    if (opened++ === 0) await gate;
    return sign(params);
  };
  return { opened: () => opened, release: () => release() };
}

type Page = { result: { current: UseApiToken } };

async function signIn(page: Page): Promise<string> {
  let token = "";
  await act(async () => {
    token = await page.result.current.signIn();
  });
  return token;
}

/** Presses sign-in and leaves it under way. The caller reads how it ended. */
function startSignIn(page: Page): Promise<string> {
  const signing = page.result.current.signIn();
  // Looked at later, by `rejection`; this keeps it from being called unhandled meanwhile.
  signing.catch(() => {});
  return signing;
}

const tabHolds = () => sessionStorage.getItem(KEY) !== null;

// ---- A session that ends drops the token --------------------------------------------------------

test("disconnecting_drops_the_token_though_no_page_that_uses_it_is_open", async () => {
  fakeApi();
  const store = await connectedStore(providerFor(sessionFor(ALICE)));
  const page = renderHook(() => useApiToken());
  expect(await signIn(page)).toBe("tok-alice.testnet-1");
  expect(heldToken()?.token).toBe("tok-alice.testnet-1");
  expect(tabHolds()).toBe(true);
  // The page that used the token is left. The wallet page, which does not use one, is what is open.
  page.unmount();

  await store.disconnect();

  expect(heldToken()).toBeNull();
  expect(tabHolds()).toBe(false);
});

test("a_wallet_that_signs_itself_out_drops_the_token_too", async () => {
  fakeApi();
  const provider = providerFor(sessionFor(ALICE));
  const store = await connectedStore(provider);
  const page = renderHook(() => useApiToken());
  await signIn(page);
  page.unmount();

  provider.signOut();

  expect(store.getSnapshot().accountId).toBeNull();
  expect(heldToken()).toBeNull();
  expect(tabHolds()).toBe(false);
});

test("the_page_that_is_open_loses_the_token_when_the_wallet_is_disconnected", async () => {
  fakeApi();
  const store = await connectedStore(providerFor(sessionFor(ALICE)));
  const page = renderHook(() => useApiToken());
  await signIn(page);
  expect(page.result.current.token).toBe("tok-alice.testnet-1");

  await act(async () => {
    await store.disconnect();
  });

  expect(page.result.current.token).toBeNull();
  expect(tabHolds()).toBe(false);
});

test("connecting_again_as_the_same_account_signs_in_again", async () => {
  const api = fakeApi();
  const alice = sessionFor(ALICE);
  const store = await connectedStore(providerFor(alice, alice));
  const page = renderHook(() => useApiToken());
  await signIn(page);
  expect(alice.wallet.signRequests).toHaveLength(1);

  // The page stays open as the wallet is disconnected and connected again, as the same account.
  await act(async () => {
    await store.disconnect();
    await store.connect();
  });
  expect(store.getSnapshot().accountId).toBe(ALICE);
  expect(page.result.current.token).toBeNull();
  expect(tabHolds()).toBe(false);

  expect(await signIn(page)).toBe("tok-alice.testnet-2");
  expect(api.challenges).toBe(2);
  expect(alice.wallet.signRequests).toHaveLength(2);
  expect(page.result.current.token).toBe("tok-alice.testnet-2");
});

test("a_wallet_connected_as_another_account_has_no_token_of_the_first", async () => {
  fakeApi();
  const store = await connectedStore(
    providerFor(sessionFor(ALICE), sessionFor(BOB), sessionFor(ALICE)),
  );
  const page = renderHook(() => useApiToken());
  await signIn(page);

  await act(async () => {
    await store.disconnect();
    await store.connect();
  });
  expect(store.getSnapshot().accountId).toBe(BOB);
  expect(page.result.current.token).toBeNull();
  expect(tabHolds()).toBe(false);
  expect(await signIn(page)).toBe("tok-bob.testnet-2");

  // And Alice, back again, does not find the token she had.
  await act(async () => {
    await store.disconnect();
    await store.connect();
  });
  expect(store.getSnapshot().accountId).toBe(ALICE);
  expect(page.result.current.token).toBeNull();
  expect(heldToken()).toBeNull();
});

// ---- A sign-in that outlasts its session keeps nothing -----------------------------------------

test("a_sign_in_that_finishes_after_the_disconnect_stores_nothing", async () => {
  const api = fakeApi();
  const alice = sessionFor(ALICE);
  const dialog = holdFirstSignature(alice.wallet);
  const store = await connectedStore(providerFor(alice));
  const page = renderHook(() => useApiToken());
  const signing = startSignIn(page);
  await vi.waitFor(() => expect(dialog.opened()).toBe(1));

  // The wallet is disconnected while its dialog is open, and the person signs all the same.
  await act(async () => {
    await store.disconnect();
  });
  dialog.release();
  const failure = await rejection(signing);

  expect(failure).toBeInstanceOf(WalletSessionEnded);
  expect(walletErrorMessage(failure)).toBe(
    "The wallet was disconnected or changed during sign-in, so you are not signed in. Try again with the wallet you want to use.",
  );
  // The API did give a token; it was not kept, in memory or in the tab.
  expect(api.tokens).toEqual(["tok-alice.testnet-1"]);
  expect(heldToken()).toBeNull();
  expect(tabHolds()).toBe(false);
  expect(failure.message).not.toContain("tok-");
});

test("a_sign_in_whose_trade_for_a_token_ends_after_the_disconnect_stores_nothing", async () => {
  const api = fakeApi({ hold: true });
  const store = await connectedStore(providerFor(sessionFor(ALICE)));
  const page = renderHook(() => useApiToken());
  const signing = startSignIn(page);
  await vi.waitFor(() => expect(api.verifies).toBe(1));

  await act(async () => {
    await store.disconnect();
  });
  api.release();

  expect(await rejection(signing)).toBeInstanceOf(WalletSessionEnded);
  expect(api.tokens).toHaveLength(1);
  expect(heldToken()).toBeNull();
  expect(tabHolds()).toBe(false);
});

test("a_sign_in_that_finishes_after_the_wallet_signed_itself_out_stores_nothing", async () => {
  fakeApi();
  const alice = sessionFor(ALICE);
  const dialog = holdFirstSignature(alice.wallet);
  const provider = providerFor(alice);
  await connectedStore(provider);
  const page = renderHook(() => useApiToken());
  const signing = startSignIn(page);
  await vi.waitFor(() => expect(dialog.opened()).toBe(1));

  act(() => provider.signOut());
  dialog.release();

  expect(await rejection(signing)).toBeInstanceOf(WalletSessionEnded);
  expect(heldToken()).toBeNull();
  expect(tabHolds()).toBe(false);
});

test("a_sign_in_of_an_earlier_session_does_not_keep_its_token_in_a_later_one_of_the_same_account", async () => {
  const api = fakeApi();
  const alice = sessionFor(ALICE);
  const dialog = holdFirstSignature(alice.wallet);
  const store = await connectedStore(providerFor(alice, alice));
  const page = renderHook(() => useApiToken());
  const first = startSignIn(page);
  await vi.waitFor(() => expect(dialog.opened()).toBe(1));

  // Disconnected and connected again as Alice, who signs in again; the first sign-in is still open.
  await act(async () => {
    await store.disconnect();
    await store.connect();
  });
  expect(await signIn(page)).toBe("tok-alice.testnet-1");
  // A sign-in of the new session is not the one of the old: the wallet was asked twice.
  expect(dialog.opened()).toBe(2);
  expect(api.challenges).toBe(2);

  dialog.release();
  expect(await rejection(first)).toBeInstanceOf(WalletSessionEnded);

  // Its token, the second the API gave, did not replace the one of the session now under way.
  expect(api.tokens).toEqual(["tok-alice.testnet-1", "tok-alice.testnet-2"]);
  await act(async () => {});
  expect(page.result.current.token).toBe("tok-alice.testnet-1");
  expect(heldToken()?.token).toBe("tok-alice.testnet-1");
});

// ---- A wallet found again keeps its token, or does not -----------------------------------------

/** A page loaded again: a store of its own, which looks for the wallet of the visit before. */
async function reloaded(found: Session | null): Promise<void> {
  const session = found ?? sessionFor(ALICE);
  holder.store = createWalletStore(async () => fakeProvider(session, { restored: found !== null }));
  await holder.store.start();
}

test("a_wallet_found_again_after_a_reload_keeps_the_token_of_its_account", async () => {
  fakeApi();
  const alice = sessionFor(ALICE);
  await connectedStore(providerFor(alice));
  const first = renderHook(() => useApiToken());
  await signIn(first);
  first.unmount();

  await reloaded(alice);

  const again = renderHook(() => useApiToken());
  expect(again.result.current.token).toBe("tok-alice.testnet-1");
  expect(tabHolds()).toBe(true);
});

test("a_wallet_found_again_as_another_account_does_not_keep_the_token", async () => {
  fakeApi();
  await connectedStore(providerFor(sessionFor(ALICE)));
  const first = renderHook(() => useApiToken());
  await signIn(first);
  first.unmount();

  await reloaded(sessionFor(BOB));

  expect(heldToken()).toBeNull();
  expect(tabHolds()).toBe(false);
  const again = renderHook(() => useApiToken());
  expect(again.result.current.token).toBeNull();
});

test("no_wallet_found_after_a_reload_drops_the_token_the_tab_kept", async () => {
  fakeApi();
  await connectedStore(providerFor(sessionFor(ALICE)));
  const first = renderHook(() => useApiToken());
  await signIn(first);
  first.unmount();
  expect(tabHolds()).toBe(true);

  await reloaded(null);

  expect(holder.store.getSnapshot()).toEqual({
    ready: true,
    accountId: null,
    canSignMessage: false,
  });
  expect(heldToken()).toBeNull();
  expect(tabHolds()).toBe(false);
});
