import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LAST_WAY_KEY, type LastUsed, lastUsedOf, lastWay, wayOf } from "../lib/lastWay";
import {
  type ConnectPick,
  type ConnectWays,
  choiceProvider,
  createPrivyBridge,
  LoginEnded,
  type LoginSteps,
  loginOf,
  nearWalletOf,
  oauthReturn,
  type PrivyBridge,
  type PrivyKit,
  type PrivyUser,
  privyProvider,
} from "../lib/privy";
import {
  createWalletStore,
  type Session,
  type SigningWallet,
  type WalletProvider,
  type WalletRow,
  walletRowOf,
} from "../lib/wallet";
import { WalletError } from "../lib/walletErrors";
import { fakeProvider } from "./walletDoubles";

// The email and Google login as a wallet provider (lib/privy.ts), with Privy's hooks stood in for
// by a kit the tests drive: what `usePrivy`, `useLoginWithEmail`, `useLoginWithOAuth`,
// `useLogout`, `useCreateWallet`, `useSignRawHash` and `useExportWallet` give, handed to the bridge
// as lib/privyKit.tsx does.

const ACCOUNT = "9f".repeat(32);
const nearWallet = (address = ACCOUNT) => ({ type: "wallet", chainType: "near", address });
const EMAIL_USER: PrivyUser = {
  linkedAccounts: [{ type: "email" }, nearWallet()],
  email: { address: "x" },
};

interface FakeKit extends PrivyKit {
  /** What the headless hooks were asked, in order. */
  asked: string[];
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
    asked: [],
    logouts: 0,
    made: 0,
    exports: [],
    sendCode: async ({ email }) => {
      kit.asked.push(`sendCode ${email}`);
    },
    loginWithCode: async ({ code }) => {
      kit.asked.push(`loginWithCode ${code}`);
    },
    initOAuth: async ({ provider }) => {
      kit.asked.push(`initOAuth ${provider}`);
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

test("the_steps_are_privy_s_headless_hooks", async () => {
  const bridge = createPrivyBridge();
  const kit = fakeKit(bridge);
  bridge.publish(kit);
  const { steps } = privyProvider({ bridge, makeWallet });

  await steps.sendCode("ada@example.com");
  await steps.loginWithCode("123456");
  await steps.google();
  expect(kit.asked).toEqual([
    "sendCode ada@example.com",
    "loginWithCode 123456",
    "initOAuth google",
  ]);
});

test("connect_takes_the_user_the_window_logged_in_with_who_holds_its_key", async () => {
  const bridge = createPrivyBridge();
  const kit = fakeKit(bridge);
  bridge.publish(kit);
  const provider = privyProvider({ bridge, makeWallet });

  // The window's login ended, and Privy's callback says so while the connect waits.
  const connecting = provider.connect();
  await new Promise((resolve) => setTimeout(resolve, 0));
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

  // Or the kit says the person is logged in (its hooks rendered after the login).
  const second = privyProvider({ bridge, makeWallet }).connect();
  bridge.publish({ ...kit, authenticated: true, user: EMAIL_USER });
  expect((await second)?.accountId).toBe(ACCOUNT);
});

test("a_login_that_ends_without_a_user_or_never_ends_is_a_wallet_error", async () => {
  vi.useFakeTimers();
  const bridge = createPrivyBridge();
  bridge.publish(fakeKit(bridge));
  const provider = privyProvider({ bridge, makeWallet, readyWithinMs: 1000 });

  const failed = provider.connect().catch((thrown: unknown) => thrown);
  await vi.advanceTimersByTimeAsync(0);
  bridge.loginEnded({ error: "oauth_unexpected" });
  const error = await failed;
  expect(error).toBeInstanceOf(WalletError);
  expect((error as WalletError).action).toBe("connect");
  expect((error as WalletError).cause).toBeInstanceOf(LoginEnded);
  expect(((error as WalletError).cause as LoginEnded).code).toBe("oauth_unexpected");

  const hung = provider.connect().catch((thrown: unknown) => thrown);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await hung).toBeInstanceOf(WalletError);
});

test("back_from_google_restore_waits_for_the_kit_to_end_the_login", async () => {
  // Privy's parameters on the address the person comes back to.
  expect(
    oauthReturn("?privy_oauth_code=c&privy_oauth_state=s&privy_oauth_provider=google&x=1"),
  ).toBe("google");
  expect(oauthReturn("?privy_oauth_code=c&privy_oauth_provider=google")).toBeNull();
  expect(oauthReturn("")).toBeNull();

  const bridge = createPrivyBridge();
  const kit = fakeKit(bridge);
  bridge.publish(kit);
  const restoring = privyProvider({ bridge, makeWallet, returning: true }).restore();
  // The kit's `useLoginWithOAuth` ends it a moment after the kit is ready.
  const google: PrivyUser = { linkedAccounts: [nearWallet()], google: { email: "x" } };
  bridge.publish({ ...kit, authenticated: true, user: google });
  const session = await restoring;
  expect(session?.accountId).toBe(ACCOUNT);
  expect(session?.keyHolder?.login).toBe("google");

  // Turned down at Google: the restore fails, and the page offers Connect.
  const denied = createPrivyBridge();
  denied.publish(fakeKit(denied));
  const refused = privyProvider({ bridge: denied, makeWallet, returning: true })
    .restore()
    .catch((thrown: unknown) => thrown);
  denied.loginEnded({ error: "oauth_user_denied" });
  expect(await refused).toBeInstanceOf(LoginEnded);

  // Not coming back from anywhere: a signed-out kit is no session, at once.
  const plain = createPrivyBridge();
  plain.publish(fakeKit(plain));
  expect(await privyProvider({ bridge: plain, makeWallet }).restore()).toBeNull();
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
  // Already logged in: nothing was asked of the login.
  expect(kit.asked).toEqual([]);
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

const ROWS: WalletRow[] = [
  { id: "ash-wallet", name: "Ash Wallet", icon: null, site: "wallet.ash.test" },
];

/** The two ways over fakes: the login with steps, near-connect with a list and picks by id. */
function choices(
  options: {
    answer?: ConnectPick | null;
    loginRestored?: boolean;
    walletRestored?: boolean;
    remembered?: LastUsed | null;
    loginRestoreMs?: number;
    login?: boolean;
    returning?: string | null;
  } = {},
) {
  const steps = {
    sendCode: async () => {},
    loginWithCode: async () => {},
    google: async () => {},
  };
  const login = Object.assign(fakeProvider(loginSession, { restored: options.loginRestored }), {
    steps,
  });
  const base = fakeProvider(walletSession, { restored: options.walletRestored });
  const baseConnect = base.connect.bind(base);
  const picked: Array<string | null | undefined> = [];
  const near = Object.assign(base, {
    wallets: async () => ROWS,
    connect: (walletId?: string | null) => {
      picked.push(walletId);
      return baseConnect();
    },
  });
  const prepared: Session[] = [];
  const offered: ConnectWays[] = [];
  // How the last sign-in went, as the memory holds it, and every write to it.
  const remembered: { used: LastUsed | null; sets: LastUsed[] } = {
    used: options.remembered ?? null,
    sets: [],
  };
  let closes = 0;
  const provider = choiceProvider({
    login: options.login === false ? null : async () => login,
    wallet: async () => near,
    ask: async (ways) => {
      offered.push(ways);
      return options.answer === undefined ? { way: "login" } : options.answer;
    },
    prepare: async (session) => {
      prepared.push(session);
    },
    close: () => {
      closes++;
    },
    returning: options.returning ?? null,
    memory: {
      get: () => remembered.used,
      set: (used) => {
        remembered.used = used;
        remembered.sets.push(used);
      },
    },
    ...(options.loginRestoreMs === undefined ? {} : { loginRestoreMs: options.loginRestoreMs }),
  });
  return {
    provider,
    login,
    near,
    steps,
    picked,
    prepared,
    offered,
    remembered,
    asked: () => offered.length,
    closes: () => closes,
  };
}

test("connect_opens_the_window_and_only_a_login_is_got_ready", async () => {
  const byLogin = choices({ answer: { way: "login" }, remembered: "google" });
  expect((await byLogin.provider.connect())?.accountId).toBe(ACCOUNT);
  expect(byLogin.login.connects).toBe(1);
  expect(byLogin.near.connects).toBe(0);
  expect(byLogin.prepared.map((session) => session.accountId)).toEqual([ACCOUNT]);
  expect(byLogin.remembered.sets).toEqual(["email"]);
  // The window was offered the login's steps, the wallets near-connect lists, and "Last used".
  const [ways] = byLogin.offered;
  expect(await ways?.login?.()).toBe(byLogin.steps);
  expect(await ways?.wallets()).toEqual(ROWS);
  expect(ways?.lastUsed).toBe("google");

  // A wallet's row connects that wallet, by its id, and is not got ready.
  const byWallet = choices({ answer: { way: "wallet", walletId: "ash-wallet" } });
  expect((await byWallet.provider.connect())?.accountId).toBe(ALICE);
  expect(byWallet.picked).toEqual(["ash-wallet"]);
  expect(byWallet.login.connects).toBe(0);
  expect(byWallet.prepared).toEqual([]);
  expect(byWallet.remembered.sets).toEqual(["wallet:ash-wallet"]);

  // The row that opens near-connect's own list.
  const byList = choices({ answer: { way: "wallet", walletId: null } });
  expect((await byList.provider.connect())?.accountId).toBe(ALICE);
  expect(byList.picked).toEqual([null]);
  expect(byList.remembered.sets).toEqual(["wallet"]);

  // The window closed: no way is asked.
  const closed = choices({ answer: null });
  expect(await closed.provider.connect()).toBeNull();
  expect(closed.login.connects + closed.near.connects).toBe(0);

  // No login in the build: the window is offered the wallets alone.
  const walletsOnly = choices({ login: false, answer: null });
  await walletsOnly.provider.connect();
  expect(walletsOnly.offered[0]?.login).toBeNull();
});

test("a_login_the_window_ended_that_gives_no_session_closes_the_window", async () => {
  const { provider, login, closes } = choices({ answer: { way: "login" } });
  login.connect = async () => {
    throw new Error("the wallet could not be made");
  };
  await expect(provider.connect()).rejects.toBeInstanceOf(WalletError);
  expect(closes()).toBe(1);
});

test("back_from_google_the_restored_login_is_got_ready_and_remembered", async () => {
  const back = choices({ loginRestored: true, returning: "google" });
  expect((await back.provider.restore())?.accountId).toBe(ACCOUNT);
  expect(back.prepared.map((session) => session.accountId)).toEqual([ACCOUNT]);
  expect(back.remembered.sets).toEqual(["google"]);
  expect(back.asked()).toBe(0);
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
    wallet: async () => Object.assign(near, { wallets: async () => [] }),
    ask: async () => ({ way: "login" }),
    prepare: async () => {},
    close: () => {},
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

test("restore_prefers_the_way_this_browser_last_connected", async () => {
  // Both ways hold a session: the remembered way's is the one, whichever answers first.
  for (const way of ["login", "wallet"] as const) {
    const both = choices({
      loginRestored: true,
      walletRestored: true,
      remembered: way === "login" ? "email" : "wallet:ash-wallet",
    });
    const session = await both.provider.restore();
    expect(session?.accountId, way).toBe(way === "login" ? ACCOUNT : ALICE);
  }
  // The remembered way has none: the other's session is taken.
  const other = choices({ walletRestored: true, remembered: "google" });
  expect((await other.provider.restore())?.accountId).toBe(ALICE);
});

test("connect_remembers_its_way_and_ends_the_other_way_s_session", async () => {
  const { provider, login, near, remembered } = choices({
    answer: { way: "wallet", walletId: "ash-wallet" },
    loginRestored: true,
    remembered: "email",
  });
  const heard: Array<Session | null> = [];
  provider.subscribe((next) => heard.push(next));
  expect((await provider.restore())?.accountId).toBe(ACCOUNT);

  expect((await provider.connect())?.accountId).toBe(ALICE);
  expect(near.connects).toBe(1);
  expect(remembered.used).toBe("wallet:ash-wallet");
  // One session at a time: the login's ended, quietly.
  expect(login.disconnects).toBe(1);
  expect(heard).toEqual([]);
});

/** A login whose restore answers only when the test says, and which counts its log outs. */
function slowLogin() {
  let answer: (session: Session | null) => void = () => {};
  const provider: WalletProvider & { logouts: number; steps: LoginSteps } = {
    logouts: 0,
    steps: { sendCode: async () => {}, loginWithCode: async () => {}, google: async () => {} },
    restore: () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
    connect: async () => null,
    disconnect: async () => {
      provider.logouts++;
    },
    subscribe: () => () => {},
  };
  return { provider, answer: (session: Session | null) => answer(session) };
}

test("a_login_slow_to_answer_is_not_taken_for_none_and_keeps_the_token_the_tab_kept", async () => {
  // A reload: the tab kept a Tender token for the login's account (lib/apiToken.ts).
  vi.resetModules();
  sessionStorage.setItem(
    "tender.apiToken",
    JSON.stringify({
      accountId: ACCOUNT,
      token: "kept-token",
      expiresAtMs: Date.now() + 3_600_000,
    }),
  );
  const [wallet, privy, tokens] = await Promise.all([
    import("../lib/wallet"),
    import("../lib/privy"),
    import("../lib/apiToken"),
  ]);
  vi.useFakeTimers();
  const login = slowLogin();
  const store = wallet.createWalletStore(async () =>
    privy.choiceProvider({
      login: async () => login.provider,
      wallet: async () => Object.assign(fakeProvider(walletSession), { wallets: async () => [] }),
      ask: async () => null,
      prepare: async () => {},
      close: () => {},
      loginRestoreMs: 2500,
    }),
  );

  // Past the login's 2.5 s and the store's own patience: the page shows Connect...
  const starting = store.start();
  await vi.advanceTimersByTimeAsync(wallet.START_PATIENCE_MS);
  await starting;
  expect(store.getSnapshot()).toMatchObject({ ready: true, accountId: null });
  // ...but nothing has said there is no login, so the tab's token stays.
  expect(tokens.heldToken()?.token).toBe("kept-token");

  // The login answers: it is taken up as the earlier visit's, with its token.
  login.answer(loginSession);
  await vi.advanceTimersByTimeAsync(0);
  expect(store.getSnapshot().accountId).toBe(ACCOUNT);
  expect(tokens.heldToken()?.token).toBe("kept-token");
  sessionStorage.clear();
});

test("a_login_that_answers_after_the_wallet_was_taken_is_ended", async () => {
  vi.useFakeTimers();
  const login = slowLogin();
  const provider = choiceProvider({
    login: async () => login.provider,
    wallet: async () =>
      Object.assign(fakeProvider(walletSession, { restored: true }), { wallets: async () => [] }),
    ask: async () => null,
    prepare: async () => {},
    close: () => {},
    memory: { get: () => "email", set: () => {} },
    loginRestoreMs: 2500,
  });
  const restoring = provider.restore();
  await vi.advanceTimersByTimeAsync(2500);
  // The remembered login didn't answer in time and the wallet has a session: it is taken.
  expect((await restoring)?.accountId).toBe(ALICE);

  // The login comes back late: one session at a time, so it ends.
  login.answer(loginSession);
  await vi.advanceTimersByTimeAsync(0);
  expect(login.provider.logouts).toBe(1);
});

test("log_out_ends_every_session_the_provider_knows_of", async () => {
  // Both ways hold a session (from before the way was remembered); the login's is taken.
  const both = choices({ loginRestored: true, walletRestored: true, remembered: "email" });
  const heard: Array<Session | null> = [];
  both.provider.subscribe((next) => heard.push(next));
  expect((await both.provider.restore())?.accountId).toBe(ACCOUNT);

  await both.provider.disconnect(loginSession);
  // Both end, so that a reload can't bring back the wallet's account; quietly.
  expect(both.login.disconnects).toBe(1);
  expect(both.near.disconnects).toBe(1);
  expect(heard).toEqual([]);
});

test("a_disconnect_that_fails_keeps_the_way_heard_and_one_that_works_is_not_told_back", async () => {
  // The way's own sign-out, caused by the disconnect, is not told back to the store.
  const quiet = choices({ loginRestored: true });
  quiet.login.disconnect = async () => {
    quiet.login.signOut();
  };
  const heard: Array<Session | null> = [];
  quiet.provider.subscribe((next) => heard.push(next));
  await quiet.provider.restore();
  await quiet.provider.disconnect(loginSession);
  expect(heard).toEqual([]);

  // A disconnect that throws leaves the session the way's: a sign-out from elsewhere later is heard.
  const stuck = choices({ loginRestored: true });
  stuck.login.disconnect = async () => {
    throw new Error("logout failed");
  };
  const later: Array<Session | null> = [];
  stuck.provider.subscribe((next) => later.push(next));
  await stuck.provider.restore();
  await expect(stuck.provider.disconnect(loginSession)).rejects.toThrow("logout failed");
  stuck.login.signOut();
  expect(later).toEqual([null]);
});

test("the_last_sign_in_is_kept_as_its_method_and_the_way_is_read_from_it", () => {
  localStorage.clear();
  expect(lastWay.get()).toBeNull();
  lastWay.set("wallet:ash-wallet");
  expect(localStorage.getItem(LAST_WAY_KEY)).toBe("wallet:ash-wallet");
  expect(lastWay.get()).toBe("wallet:ash-wallet");
  // The way, read from the method; "login" and "wallet", as an earlier build kept them, still count.
  for (const [kept, way] of [
    ["email", "login"],
    ["google", "login"],
    ["login", "login"],
    ["wallet", "wallet"],
    ["wallet:ash-wallet", "wallet"],
  ] as const) {
    localStorage.setItem(LAST_WAY_KEY, kept);
    expect(wayOf(lastWay.get()), kept).toBe(way);
  }
  // Anything else is none, and nothing else is written.
  localStorage.setItem(LAST_WAY_KEY, "alice.near");
  expect(lastWay.get()).toBeNull();
  expect(lastUsedOf("wallet:<script>")).toBeNull();
  lastWay.set("wallet:a b" as LastUsed);
  expect(localStorage.getItem(LAST_WAY_KEY)).toBe("alice.near");
  // A browser that won't keep it loses only the preference.
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  expect(() => lastWay.set("email")).not.toThrow();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  expect(lastWay.get()).toBeNull();
  vi.restoreAllMocks();
  localStorage.clear();
});

test("a_wallet_row_is_the_manifest_s_name_its_site_s_host_and_a_safe_icon", () => {
  expect(
    walletRowOf({
      id: "ash-wallet",
      name: "Ash Wallet",
      icon: "https://example.test/ash.png",
      website: "https://wallet.ash.test/start",
    }),
  ).toEqual({
    id: "ash-wallet",
    name: "Ash Wallet",
    icon: "https://example.test/ash.png",
    site: "wallet.ash.test",
  });
  // An icon at another kind of address, and a site that is no address, are left out.
  expect(
    walletRowOf({ id: "x", name: "X", icon: "javascript:alert(1)", website: "not a url" }),
  ).toEqual({ id: "x", name: "X", icon: null, site: null });
  expect(walletRowOf({ id: "y", name: "Y", icon: "data:image/svg+xml,%3Csvg/%3E" }).icon).toBe(
    "data:image/svg+xml,%3Csvg/%3E",
  );
});
