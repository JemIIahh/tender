import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  type ConnectChoice,
  choiceProvider,
  createPrivyBridge,
  loginOf,
  nearWalletOf,
  type PrivyBridge,
  type PrivyKit,
  type PrivyUser,
  privyProvider,
} from "../lib/privy";
import { createWalletStore, type Session, type SigningWallet } from "../lib/wallet";
import { WalletError } from "../lib/walletErrors";
import { fakeProvider } from "./walletDoubles";

// The email and Google login as a wallet provider (lib/privy.ts), with Privy's hooks stood in for
// by a kit the tests drive: what `usePrivy`, `useLogin`, `useLogout`, `useCreateWallet`,
// `useSignRawHash` and `useExportWallet` give, handed to the bridge as lib/privyKit.tsx does.

const ACCOUNT = "9f".repeat(32);
const nearWallet = (address = ACCOUNT) => ({ type: "wallet", chainType: "near", address });
const EMAIL_USER: PrivyUser = {
  linkedAccounts: [{ type: "email" }, nearWallet()],
  email: { address: "x" },
};

interface FakeKit extends PrivyKit {
  logins: number;
  logouts: number;
  made: number;
  exports: string[];
}

/** A kit that is ready, signed out, and whose login the test ends by calling the bridge. */
function fakeKit(bridge: PrivyBridge, over: Partial<PrivyKit> = {}): FakeKit {
  const kit: FakeKit = {
    ready: true,
    authenticated: false,
    user: null,
    logins: 0,
    logouts: 0,
    made: 0,
    exports: [],
    login: () => {
      kit.logins++;
    },
    logout: async () => {
      kit.logouts++;
      bridge.publish({ ...kit, authenticated: false, user: null });
    },
    createWallet: async () => {
      kit.made++;
      return { wallet: { address: ACCOUNT } };
    },
    signRawHash: async () => ({ signature: `0x${"00".repeat(64)}` }),
    exportWallet: async ({ address }) => {
      kit.exports.push(address);
    },
    getAccessToken: async () => "login-token",
    ...over,
  };
  return kit;
}

const madeWallets: Array<{ accountId: string; address: string }> = [];
const makeWallet = (plan: { accountId: string; address: string }): SigningWallet => {
  madeWallets.push({ accountId: plan.accountId, address: plan.address });
  return {
    manifest: { features: { signMessage: true, signAndSendTransactions: true } },
    signAndSendTransactions: async () => [],
    signMessage: async () => ({}),
  };
};

beforeEach(() => {
  madeWallets.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("the_near_wallet_is_picked_from_the_linked_accounts_and_the_login_is_named", () => {
  expect(nearWalletOf(EMAIL_USER)).toBe(ACCOUNT);
  // Another chain's wallet is not the NEAR one.
  expect(
    nearWalletOf({
      linkedAccounts: [{ type: "wallet", chainType: "ethereum", address: "0xabc" }],
    }),
  ).toBeNull();
  expect(loginOf(EMAIL_USER)).toBe("email");
  expect(loginOf({ linkedAccounts: [], google: { email: "x" } })).toBe("google");
  expect(loginOf({ linkedAccounts: [] })).toBeNull();
});

test("connect_opens_the_login_and_gives_the_near_wallet_s_account_with_who_holds_its_key", async () => {
  const bridge = createPrivyBridge();
  const kit = fakeKit(bridge);
  bridge.publish(kit);
  const provider = privyProvider({ bridge, makeWallet });

  const connecting = provider.connect();
  await vi.waitFor(() => expect(kit.logins).toBe(1));
  bridge.loginEnded({ user: EMAIL_USER });
  const session = await connecting;

  expect(session?.accountId).toBe(ACCOUNT);
  expect(session?.keyHolder?.login).toBe("email");
  expect(madeWallets).toEqual([{ accountId: ACCOUNT, address: ACCOUNT }]);
  // The key's export is Privy's own window, for this wallet; the token is the login's.
  await session?.keyHolder?.exportKey();
  expect(kit.exports).toEqual([ACCOUNT]);
  expect(await session?.keyHolder?.loginToken()).toBe("login-token");
  // No wallet was made: the user had one.
  expect(kit.made).toBe(0);
});

test("a_closed_login_is_no_session_and_a_failed_one_is_a_wallet_error", async () => {
  const bridge = createPrivyBridge();
  const kit = fakeKit(bridge);
  bridge.publish(kit);
  const provider = privyProvider({ bridge, makeWallet });

  const closed = provider.connect();
  await vi.waitFor(() => expect(kit.logins).toBe(1));
  bridge.loginEnded({ error: "exited_auth_flow" });
  expect(await closed).toBeNull();

  const failed = provider.connect();
  await vi.waitFor(() => expect(kit.logins).toBe(2));
  bridge.loginEnded({ error: "oauth_unexpected" });
  const error = await failed.catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(WalletError);
  expect((error as WalletError).action).toBe("connect");
});

test("a_user_with_no_near_wallet_gets_one_made_once_even_by_two_at_once", async () => {
  const bridge = createPrivyBridge();
  const user: PrivyUser = { linkedAccounts: [{ type: "google_oauth" }], google: { email: "x" } };
  const kit = fakeKit(bridge, { authenticated: true, user });
  bridge.publish(kit);
  const provider = privyProvider({ bridge, makeWallet });

  const [restored, connected] = await Promise.all([provider.restore(), provider.connect()]);
  expect(restored?.accountId).toBe(ACCOUNT);
  expect(connected?.accountId).toBe(ACCOUNT);
  expect(restored?.keyHolder?.login).toBe("google");
  expect(kit.made).toBe(1);
  // Already logged in: no login window.
  expect(kit.logins).toBe(0);
});

test("a_wallet_that_is_not_an_implicit_account_is_refused_and_one_in_capitals_is_lower_cased", async () => {
  const bridge = createPrivyBridge();
  bridge.publish(
    fakeKit(bridge, {
      authenticated: true,
      user: { linkedAccounts: [nearWallet("alice.near")] },
    }),
  );
  const refused = await privyProvider({ bridge, makeWallet })
    .connect()
    .catch((thrown: unknown) => thrown);
  expect(refused).toBeInstanceOf(WalletError);

  const upper = createPrivyBridge();
  upper.publish(
    fakeKit(upper, {
      authenticated: true,
      user: { linkedAccounts: [nearWallet(ACCOUNT.toUpperCase())] },
    }),
  );
  const session = await privyProvider({ bridge: upper, makeWallet }).restore();
  expect(session?.accountId).toBe(ACCOUNT);
  // Privy is asked about the wallet by its own spelling.
  expect(madeWallets.at(-1)).toEqual({ accountId: ACCOUNT, address: ACCOUNT.toUpperCase() });
});

test("restore_is_the_logged_in_user_s_wallet_or_nothing", async () => {
  const signedOut = createPrivyBridge();
  signedOut.publish(fakeKit(signedOut));
  expect(await privyProvider({ bridge: signedOut, makeWallet }).restore()).toBeNull();

  const signedIn = createPrivyBridge();
  // The kit is not ready at first: restore waits for it.
  const kit = fakeKit(signedIn, { ready: false, authenticated: false });
  signedIn.publish(kit);
  const restoring = privyProvider({ bridge: signedIn, makeWallet }).restore();
  signedIn.publish({ ...kit, ready: true, authenticated: true, user: EMAIL_USER });
  expect((await restoring)?.accountId).toBe(ACCOUNT);
});

test("a_kit_that_never_gets_ready_makes_connect_fail_and_not_hang", async () => {
  vi.useFakeTimers();
  const bridge = createPrivyBridge();
  bridge.publish(fakeKit(bridge, { ready: false }));
  const connecting = privyProvider({ bridge, makeWallet, readyWithinMs: 1000 })
    .connect()
    .catch((thrown: unknown) => thrown);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await connecting).toBeInstanceOf(WalletError);
});

test("disconnect_logs_out_and_a_logout_from_elsewhere_ends_the_store_s_session", async () => {
  const bridge = createPrivyBridge();
  const kit = fakeKit(bridge, { authenticated: true, user: EMAIL_USER });
  bridge.publish(kit);
  const store = createWalletStore(async () => privyProvider({ bridge, makeWallet }));

  await store.start();
  expect(store.getSnapshot()).toMatchObject({ ready: true, accountId: ACCOUNT });
  expect(store.getSnapshot().keyHolder?.login).toBe("email");
  await store.disconnect();
  expect(kit.logouts).toBe(1);
  expect(store.getSnapshot()).toEqual({ ready: true, accountId: null, canSignMessage: false });

  // Logged in again, then the login ends without this page (it ran out, or another tab).
  bridge.publish({ ...kit, authenticated: true, user: EMAIL_USER });
  await store.connect();
  expect(store.getSnapshot().accountId).toBe(ACCOUNT);
  bridge.publish({ ...kit, authenticated: false, user: null });
  expect(store.getSnapshot().accountId).toBeNull();
});

// ---- The two ways together ----------------------------------------------------------------------

const ALICE = "alice.testnet";
const wallet = (): SigningWallet => ({
  manifest: { features: { signMessage: true, signAndSendTransactions: true } },
  signAndSendTransactions: async () => [],
  signMessage: async () => ({}),
});
const loginSession: Session = {
  wallet: wallet(),
  accountId: ACCOUNT,
  keyHolder: { login: "email", exportKey: async () => {}, loginToken: async () => "t" },
};
const walletSession: Session = { wallet: wallet(), accountId: ALICE };

function choices(
  options: {
    answer?: ConnectChoice | null;
    loginRestored?: boolean;
    walletRestored?: boolean;
  } = {},
) {
  const login = fakeProvider(loginSession, { restored: options.loginRestored });
  const near = fakeProvider(walletSession, { restored: options.walletRestored });
  const prepared: Session[] = [];
  let asked = 0;
  const provider = choiceProvider({
    login: async () => login,
    wallet: async () => near,
    ask: async () => {
      asked++;
      return options.answer === undefined ? "login" : options.answer;
    },
    prepare: async (session) => {
      prepared.push(session);
    },
  });
  return { provider, login, near, prepared, asked: () => asked };
}

test("connect_asks_which_way_and_only_a_login_is_got_ready", async () => {
  const byLogin = choices({ answer: "login" });
  expect((await byLogin.provider.connect())?.accountId).toBe(ACCOUNT);
  expect(byLogin.login.connects).toBe(1);
  expect(byLogin.near.connects).toBe(0);
  expect(byLogin.prepared.map((session) => session.accountId)).toEqual([ACCOUNT]);

  const byWallet = choices({ answer: "wallet" });
  expect((await byWallet.provider.connect())?.accountId).toBe(ALICE);
  expect(byWallet.near.connects).toBe(1);
  expect(byWallet.login.connects).toBe(0);
  expect(byWallet.prepared).toEqual([]);

  // The chooser closed: no way is asked.
  const closed = choices({ answer: null });
  expect(await closed.provider.connect()).toBeNull();
  expect(closed.login.connects + closed.near.connects).toBe(0);
});

test("restore_takes_whichever_way_has_a_session_and_disconnect_goes_to_that_way", async () => {
  const none = choices();
  expect(await none.provider.restore()).toBeNull();

  const byWallet = choices({ walletRestored: true });
  expect((await byWallet.provider.restore())?.accountId).toBe(ALICE);
  await byWallet.provider.disconnect(walletSession);
  expect(byWallet.near.disconnects).toBe(1);
  expect(byWallet.login.disconnects).toBe(0);

  const byLogin = choices({ loginRestored: true });
  expect((await byLogin.provider.restore())?.accountId).toBe(ACCOUNT);
  await byLogin.provider.disconnect(loginSession);
  expect(byLogin.login.disconnects).toBe(1);
  expect(byLogin.near.disconnects).toBe(0);
  // A restore is no login: nothing is got ready, and nobody is asked.
  expect(byLogin.prepared).toEqual([]);
  expect(byLogin.asked()).toBe(0);
});

test("a_login_that_cannot_load_leaves_the_wallet_s_session_to_come_back", async () => {
  const near = fakeProvider(walletSession, { restored: true });
  const provider = choiceProvider({
    login: async () => {
      throw new Error("the kit did not load");
    },
    wallet: async () => near,
    ask: async () => "login",
    prepare: async () => {},
  });
  expect((await provider.restore())?.accountId).toBe(ALICE);
  // Connect by the login says it couldn't connect, in a wallet's words.
  await expect(provider.connect()).rejects.toBeInstanceOf(WalletError);
});

test("only_the_way_of_the_session_is_heard_signing_out", async () => {
  const { provider, login, near } = choices({ walletRestored: true });
  const heard: Array<Session | null> = [];
  provider.subscribe((next) => heard.push(next));
  await provider.restore();
  // The login, which holds no session here, ends: nothing to hear.
  login.signOut();
  expect(heard).toEqual([]);
  near.signOut();
  expect(heard).toEqual([null]);
});
