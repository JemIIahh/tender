import { GOOGLE_DIDNT_FINISH } from "./copy";
import { keepReturnPage, type LastUsed, walletUsed, wayOf } from "./lastWay";
import type {
  KeyHolder,
  NearProvider,
  Session,
  SigningWallet,
  WalletProvider,
  WalletRow,
} from "./wallet";
import { WalletError } from "./walletErrors";

// The email and Google login, through Privy, as a wallet provider of the store (lib/wallet.ts).
//
// Privy logs the person in and makes them a NEAR wallet: an implicit account, whose id is the 64 hex
// characters of its ed25519 public key. Privy keeps the key and signs raw hashes with it; it builds
// and sends nothing for NEAR. So the page builds, signs and sends with near-api-js, the way NEAR's
// own example does (https://github.com/near-examples/hello-privy, src/context/signer.ts and
// provider.tsx): a near-api-js `Signer` whose signing calls Privy's `signRawHash` with
// `chainType: "near"` (lib/privyWallet.ts), and `createWallet({ chainType: "near" })` for a person
// who has no NEAR wallet yet.
//
// Privy's kit is React: its hooks work under its provider only. lib/privyKit.tsx mounts the
// provider in a root of its own and hands what the hooks give to a `PrivyBridge` on every render;
// this file reads the bridge, and has no import of the kit, so that the kit (and near-api-js) load
// only when a page needs them, in a build that has a Privy app id.
//
// No window of Privy's logs anyone in: Tender's Connect window (components/ConnectChooser.tsx)
// does, with Privy's headless hooks (`useLoginWithEmail`, `useLoginWithOAuth`), which the provider
// hands it as `steps`. The Google login leaves the page for Google and comes back to it; the hook,
// mounted on every page, ends the login there, and `restore` takes it up.

/** One of the accounts a Privy user has linked, as far as this app reads them. */
export interface PrivyLinkedAccount {
  type: string;
  chainType?: string;
  address?: string;
}

/** A Privy user, as far as this app reads one: no email address or name is read or kept. */
export interface PrivyUser {
  linkedAccounts: readonly PrivyLinkedAccount[];
  google?: unknown;
  email?: unknown;
}

/** What Privy's hooks give, as lib/privyKit.tsx hands them over. */
export interface PrivyKit {
  ready: boolean;
  authenticated: boolean;
  user: PrivyUser | null;
  /** Sends a one-time code to `email` (`useLoginWithEmail().sendCode`). Rejects with Privy's error. */
  sendCode(input: { email: string }): Promise<void>;
  /** Logs in with the code that was sent (`loginWithCode`). Rejects with Privy's error. */
  loginWithCode(input: { code: string }): Promise<void>;
  /**
   * Sends the page to Google (`useLoginWithOAuth().initOAuth`). The login ends when the page comes
   * back, and Privy says so to the bridge (`loginEnded`).
   */
  initOAuth(input: { provider: "google" }): Promise<void>;
  logout(): Promise<void>;
  createWallet(input: { chainType: "near" }): Promise<{ wallet: { address: string } }>;
  signRawHash(input: {
    address: string;
    chainType: "near";
    hash: `0x${string}`;
  }): Promise<{ signature: `0x${string}` }>;
  /** Opens Privy's own window, from which the person can copy the key. */
  exportWallet(input: { address: string }): Promise<void>;
  getAccessToken(): Promise<string | null>;
}

/** How long a connect waits for Privy's kit to be ready before it says it couldn't connect. */
export const PRIVY_READY_MS = 15_000;

/**
 * How long a login back from Google has to end once the kit is ready: Privy then trades the code
 * for a session with its servers, which a slow connection makes slow. Only then does the window
 * say the Google sign-in didn't finish.
 */
export const GOOGLE_RETURN_MS = 30_000;

/** A login that ended without a user, with Privy's error code (`oauth_user_denied`, ...). */
export class LoginEnded extends Error {
  constructor(readonly code: string) {
    super(`the login ended without a user: ${code}`);
    this.name = "LoginEnded";
  }
}

/**
 * Where the kit's hooks meet the provider. The kit's component calls `publish` with every render,
 * and `loginEnded` from the login's callbacks; the provider reads the latest.
 */
export interface PrivyBridge {
  publish(kit: PrivyKit): void;
  /** A login ended: with a user, or with Privy's error code. */
  loginEnded(outcome: { user: PrivyUser } | { error: string }): void;
  /** The kit, once it is ready. Rejects after `withinMs` without it. */
  whenReady(withinMs?: number): Promise<PrivyKit>;
  /** The latest kit. Throws before the first. */
  kit(): PrivyKit;
  /**
   * The user, once a kit says the person is logged in (at once if the latest does), or a login
   * ends with one. Rejects with `LoginEnded` for a login that ends without one, and after
   * `withinMs` with neither: counted from now, or from when `from` settles.
   */
  loggedIn(withinMs?: number, from?: Promise<unknown>): Promise<PrivyUser>;
  /** `listener` hears a login that was on end without this page asking (it ran out, another tab). */
  onLoggedOut(listener: () => void): () => void;
}

export function createPrivyBridge(): PrivyBridge {
  let latest: PrivyKit | null = null;
  const waiting = new Set<(kit: PrivyKit) => void>();
  const loggedOut = new Set<() => void>();
  // Those waiting for a login to end (`loggedIn`).
  const ending = new Set<{ yes: (user: PrivyUser) => void; no: (error: unknown) => void }>();

  function ended(outcome: { user: PrivyUser } | { error: unknown }): void {
    for (const waiter of [...ending]) {
      if ("user" in outcome) waiter.yes(outcome.user);
      else waiter.no(outcome.error);
    }
    ending.clear();
  }

  return {
    publish(kit) {
      const was = latest;
      latest = kit;
      if (!kit.ready) return;
      for (const resolve of [...waiting]) resolve(kit);
      waiting.clear();
      if (kit.authenticated && kit.user !== null) ended({ user: kit.user });
      if (was?.ready === true && was.authenticated && !kit.authenticated) {
        for (const listener of [...loggedOut]) listener();
      }
    },

    loginEnded(outcome) {
      ended("user" in outcome ? outcome : { error: new LoginEnded(outcome.error) });
    },

    whenReady(withinMs = PRIVY_READY_MS) {
      if (latest?.ready === true) return Promise.resolve(latest);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(done);
          reject(new Error("Privy's kit was not ready in time"));
        }, withinMs);
        const done = (kit: PrivyKit) => {
          clearTimeout(timer);
          resolve(kit);
        };
        waiting.add(done);
      });
    },

    kit() {
      if (latest === null) throw new Error("Privy's kit has not started");
      return latest;
    },

    loggedIn(withinMs = PRIVY_READY_MS, from) {
      if (latest?.ready === true && latest.authenticated && latest.user !== null) {
        return Promise.resolve(latest.user);
      }
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const stop = () => {
          if (timer !== null) clearTimeout(timer);
        };
        const waiter = {
          yes: (user: PrivyUser) => {
            stop();
            resolve(user);
          },
          no: (error: unknown) => {
            stop();
            reject(error);
          },
        };
        // The waiter is there from now, so that no login's end is missed; its time from `from`.
        ending.add(waiter);
        const start = () => {
          if (!ending.has(waiter)) return;
          timer = setTimeout(() => {
            ending.delete(waiter);
            reject(new Error("the login did not end in time"));
          }, withinMs);
        };
        if (from === undefined) start();
        else from.then(start, start);
      });
    },

    onLoggedOut(listener) {
      loggedOut.add(listener);
      return () => {
        loggedOut.delete(listener);
      };
    },
  };
}

/** An implicit account id: 64 hex characters. Privy's NEAR wallet's address is one. */
const IMPLICIT = /^[0-9a-f]{64}$/i;

/** The address of the user's NEAR wallet, or null when they have none yet. */
export function nearWalletOf(user: PrivyUser): string | null {
  const wallet = user.linkedAccounts.find(
    (account) =>
      account.type === "wallet" && account.chainType === "near" && account.address !== undefined,
  );
  return wallet?.address ?? null;
}

/** How the person logs in, from what the user has linked. The address itself is not read. */
export function loginOf(user: PrivyUser): KeyHolder["login"] {
  if (user.google !== undefined && user.google !== null) return "google";
  if (user.email !== undefined && user.email !== null) return "email";
  return null;
}

/** What lib/privyWallet.ts gives: a wallet over Privy's signing, for one account. */
export type MakePrivyWallet = (plan: {
  accountId: string;
  address: string;
  signRawHash: PrivyKit["signRawHash"];
}) => SigningWallet;

/**
 * The provider of a login coming back to the page from its OAuth sign-in, read from the address
 * (`search`: `location.search`), or null. Privy sends the person back to the page they started on
 * with `privy_oauth_code`, `privy_oauth_state` and `privy_oauth_provider`, and takes them off the
 * address once it has read them, so this is read before the kit starts.
 */
export function oauthReturn(search: string): string | null {
  const params = new URLSearchParams(search);
  if (params.get("privy_oauth_code") === null || params.get("privy_oauth_state") === null) {
    return null;
  }
  return params.get("privy_oauth_provider");
}

/** The login's steps, as the Connect window takes the person through them. */
export interface LoginSteps {
  /** Sends a one-time code to `email`. Rejects with Privy's error (`privyErrorCode`). */
  sendCode(email: string): Promise<void>;
  /** Logs in with the code. Resolves once the person is logged in; rejects with Privy's error. */
  loginWithCode(code: string): Promise<void>;
  /** Sends the page to Google; the login ends when the page comes back (`restore`). */
  google(): Promise<void>;
}

/** The login as a provider: a connect takes the login the Connect window ended (`steps`). */
export interface LoginProvider extends WalletProvider {
  steps: LoginSteps;
}

export interface PrivyProviderOptions {
  bridge: PrivyBridge;
  makeWallet: MakePrivyWallet;
  readyWithinMs?: number;
  /** Whether the page is coming back from a login's OAuth sign-in (`oauthReturn`). */
  returning?: boolean;
  /** How long that return has to end once the kit is ready. */
  returnWithinMs?: number;
}

/**
 * The email and Google login as a provider, over a bridge whose kit is mounted. A session is the
 * user's NEAR wallet, made for them on their first login.
 */
export function privyProvider({
  bridge,
  makeWallet,
  readyWithinMs = PRIVY_READY_MS,
  returning = false,
  returnWithinMs = GOOGLE_RETURN_MS,
}: PrivyProviderOptions): LoginProvider {
  // One wallet made at a time: a restore and a connect at once must not make two.
  let making: Promise<string> | null = null;

  const makeNearWallet = (): Promise<string> => {
    making ??= bridge
      .kit()
      .createWallet({ chainType: "near" })
      .then(({ wallet }) => wallet.address)
      .finally(() => {
        making = null;
      });
    return making;
  };

  async function sessionOf(user: PrivyUser): Promise<Session> {
    const address = nearWalletOf(user) ?? (await makeNearWallet());
    if (!IMPLICIT.test(address)) {
      throw new TypeError("the login's NEAR wallet is not an implicit account");
    }
    // NEAR account ids are lower case. Privy is asked about the wallet by its own spelling.
    const accountId = address.toLowerCase();
    const holder: KeyHolder = {
      login: loginOf(user),
      exportKey: () => bridge.kit().exportWallet({ address }),
      loginToken: () => bridge.kit().getAccessToken(),
    };
    return {
      accountId,
      // The latest kit's signing, at the time of each signature: a hook's function can change.
      wallet: makeWallet({
        accountId,
        address,
        signRawHash: (input) => bridge.kit().signRawHash(input),
      }),
      keyHolder: holder,
    };
  }

  const ready = () => bridge.whenReady(readyWithinMs);

  return {
    steps: {
      sendCode: async (email) => (await ready()).sendCode({ email }),
      loginWithCode: async (code) => (await ready()).loginWithCode({ code }),
      google: async () => {
        const kit = await ready();
        // Google comes back to the site's root; the landing sends the person on to this page.
        keepReturnPage(
          `${window.location.pathname}${window.location.search}${window.location.hash}`,
        );
        await kit.initOAuth({ provider: "google" });
      },
    },

    async restore() {
      // Back from Google: the kit's hook ends that login on this page once the kit is ready, so
      // the wait for it starts first, and its own time once the kit is ready.
      const readying = ready();
      const ending = returning ? bridge.loggedIn(returnWithinMs, readying) : null;
      // Read below, or not at all (a login of an earlier visit came back instead).
      ending?.catch(() => {});
      const kit = await readying;
      if (kit.authenticated && kit.user !== null) return sessionOf(kit.user);
      if (ending === null) return null;
      let user: PrivyUser;
      try {
        user = await ending;
      } catch (error) {
        // Turned down or failed at Google: no login, and no fault of the page's. The Connect window
        // says so (`choiceProvider`); anything else is thrown, and logged.
        if (error instanceof LoginEnded) return null;
        throw error;
      }
      return sessionOf(user);
    },

    // The Connect window has logged the person in by now (`steps`): this takes the user it logged
    // in, as soon as the kit says so.
    async connect() {
      let user: PrivyUser;
      try {
        [, user] = await Promise.all([ready(), bridge.loggedIn(readyWithinMs)]);
      } catch (cause) {
        throw new WalletError("connect", cause);
      }
      try {
        return await sessionOf(user);
      } catch (cause) {
        throw new WalletError("connect", cause);
      }
    },

    async disconnect() {
      try {
        await bridge.kit().logout();
      } catch (cause) {
        throw new WalletError("disconnect", cause);
      }
    },

    subscribe(listener) {
      return bridge.onLoggedOut(() => listener(null));
    },
  };
}

// ---- One window for both ways ------------------------------------------------------------------

/** The two ways to connect: the email or Google login, or a NEAR wallet (near-connect). */
export type ConnectWay = "login" | "wallet";

/**
 * What the person did in the Connect window: logged in by email (the login has ended), or picked a
 * NEAR wallet (`walletId` null: near-connect's own list, when the window could not list them).
 */
export type ConnectPick = { way: "login" } | { way: "wallet"; walletId: string | null };

/** What the Connect window offers, and reaches through. */
export interface ConnectWays {
  /** The login's steps, loaded the first time they are wanted; null in a build with no login. */
  login: (() => Promise<LoginSteps>) | null;
  /** The NEAR wallets near-connect lists. Rejects when they can't be listed. */
  wallets: () => Promise<WalletRow[]>;
  /** How this browser signed in last, for the window's "Last used". */
  lastUsed: LastUsed | null;
  /** A line the window opens with: what went wrong just before (`GOOGLE_DIDNT_FINISH`). */
  problem?: string | null;
}

/**
 * Where the method of the last sign-in is kept (lib/lastWay.ts): a restore prefers its way, and the
 * window marks its row.
 */
export interface WayMemory {
  get(): LastUsed | null;
  set(used: LastUsed): void;
}

/**
 * How long a restore waits for the remembered login before it takes the other way's session. The
 * login loads Privy's kit, which talks to Privy's servers and can be slow or blocked. With no
 * session elsewhere the restore waits for the login's own answer, however long: the store shows
 * Sign in after its own patience (`START_PATIENCE_MS`) meanwhile, and takes up the login, with the
 * token the tab kept, when it comes. A login coming back from Google is waited for in full.
 */
export const LOGIN_RESTORE_MS = 2500;

export interface ChoiceOptions {
  /** The email and Google login, made the first time it is wanted; null in a build with none. */
  login: (() => Promise<LoginProvider>) | null;
  /** near-connect. Made the first time it is wanted. */
  wallet: () => Promise<NearProvider>;
  /** Opens the Connect window: what the person did, or null when they close it. */
  ask: (ways: ConnectWays) => Promise<ConnectPick | null>;
  /** Gets a session of the login ready to pay fees (lib/gasGift.ts), as the window shows it. */
  prepare: (session: Session) => Promise<void>;
  /** Closes the window: a login it ended gave no session. */
  close: () => void;
  /** Shows, in the window, that a login coming back from Google is being finished. */
  finishing?: () => void;
  /** The provider of a login coming back to the page from its OAuth sign-in (`oauthReturn`). */
  returning?: string | null;
  /** How the last sign-in went. None by default: nothing is kept. */
  memory?: WayMemory;
  loginRestoreMs?: number;
}

const NO_MEMORY: WayMemory = { get: () => null, set: () => {} };

const otherWay = (choice: ConnectWay): ConnectWay => (choice === "login" ? "wallet" : "login");

/** Memoizes `load`: made once, and made again after it failed. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let made: Promise<T> | null = null;
  return () => {
    made ??= load().catch((error: unknown) => {
      made = null;
      throw error;
    });
    return made;
  };
}

/**
 * One provider over both ways, with one session at a time. Connect opens the window, which logs
 * the person in or picks a wallet; the method is remembered, and the other way's session ends. A
 * restore looks at both ways at once and prefers the remembered way: another way's session is
 * taken only once the preferred way has said it has none, or, for the login, after
 * `loginRestoreMs` (with no way remembered, the first session found is taken). "None" is said only
 * once both ways have answered. A session that turns up beside the one taken is ended. A login
 * coming back from Google is the preferred way and is waited for in full, while the window says
 * it is being finished; it is got ready as a connect's is, or, if it came back without a login,
 * the window opens again and says so. Log out ends every session this provider knows of, so that a
 * reload brings back none. A sign-out is the way's that gave the session. Each way is made once,
 * and made again after it failed to load.
 */
export function choiceProvider({
  login,
  wallet,
  ask,
  prepare,
  close,
  finishing,
  returning = null,
  memory = NO_MEMORY,
  loginRestoreMs = LOGIN_RESTORE_MS,
}: ChoiceOptions): WalletProvider {
  // The way of the session the store holds, as far as this provider gave it.
  let active: ConnectWay | null = null;
  // The session each way is known to hold, from its restore or its connect.
  const known: Partial<Record<ConnectWay, Session>> = {};
  // A way being disconnected by this provider: the sign-out that causes is not news.
  let muted: ConnectWay | null = null;
  const listeners = new Set<(session: Session | null) => void>();

  const tell = (session: Session | null) => {
    for (const listener of [...listeners]) listener(session);
  };

  /** `load`, heard for a sign-out of the session it gave. */
  function heard<P extends WalletProvider>(choice: ConnectWay, load: () => Promise<P>) {
    return once(async () => {
      const provider = await load();
      provider.subscribe((next) => {
        if (next !== null) return;
        delete known[choice];
        if (active === choice && muted !== choice) {
          active = null;
          tell(null);
        }
      });
      return provider;
    });
  }

  const loginWay = login === null ? null : heard("login", login);
  const walletWay = heard("wallet", wallet);
  const way = (choice: ConnectWay): Promise<WalletProvider> => {
    if (choice === "wallet") return walletWay();
    if (loginWay === null) return Promise.reject(new Error("this build has no login"));
    return loginWay();
  };

  /** The session `choice` restores, or null when it has none or could not look. */
  async function restoreOf(choice: ConnectWay): Promise<Session | null> {
    // A build with no login has no login's session, and nothing to say about it.
    if (choice === "login" && loginWay === null) return null;
    try {
      const session = await (await way(choice)).restore();
      if (session !== null) known[choice] = session;
      return session;
    } catch (error) {
      console.error(error);
      return null;
    }
  }

  /** Ends `choice`'s session, if it is known to have one, quietly: a failure is only logged. */
  async function endOther(choice: ConnectWay): Promise<void> {
    const session = known[choice];
    if (session === undefined) return;
    delete known[choice];
    muted = choice;
    try {
      await (await way(choice)).disconnect(session);
    } catch (error) {
      console.error(error);
    } finally {
      muted = null;
    }
  }

  /** Opens the window (with `problem`, a line it opens with) and connects what the person picks. */
  async function connectBy(problem: string | null): Promise<Session | null> {
    const pick = await ask({
      login: loginWay === null ? null : async () => (await loginWay()).steps,
      wallets: async () => (await walletWay()).wallets(),
      lastUsed: memory.get(),
      problem,
    });
    if (pick === null) return null;
    let session: Session | null;
    try {
      session =
        pick.way === "login"
          ? await (await way("login")).connect()
          : await (await walletWay()).connect(pick.walletId);
    } catch (error) {
      if (pick.way === "login") close();
      throw error instanceof WalletError ? error : new WalletError("connect", error);
    }
    if (session === null) {
      if (pick.way === "login") close();
      return null;
    }
    active = pick.way;
    known[pick.way] = session;
    memory.set(pick.way === "login" ? "email" : walletUsed(pick.walletId));
    // One session at a time: the other way's, if it has one, ends.
    await endOther(otherWay(pick.way));
    if (pick.way === "login") await prepare(session);
    return session;
  }

  /**
   * What a restore that came back from Google gives, when it was the first to give a session
   * (`first`; a sign-in made meanwhile has the window and the session, and this gives none):
   * the login, remembered, the other way's session ended, and got ready; another way's session
   * from before, as it is (the window closes); or, with neither, the window again, which says the
   * Google sign-in didn't finish and offers every way. A session the person signed in to here is
   * new (`justSignedIn`), as a connect's is.
   */
  async function finishReturn(
    session: Session | null,
    choice: ConnectWay | null,
    first: boolean,
  ): Promise<Session | null> {
    if (!first) return null;
    if (session !== null && choice === "login" && active === "login") {
      memory.set(returning === "google" ? "google" : "login");
      // One session at a time, as for a connect.
      await endOther("wallet");
      await prepare(session);
      return { ...session, justSignedIn: true };
    }
    if (session !== null) {
      close();
      return session;
    }
    if (active !== null) return null;
    try {
      const picked = await connectBy(GOOGLE_DIDNT_FINISH);
      return picked === null ? null : { ...picked, justSignedIn: true };
    } catch (error) {
      console.error(error);
      return null;
    }
  }

  return {
    restore() {
      // Back from Google: the login is the way the person just took, waited for in full.
      const back = returning !== null && loginWay !== null;
      if (back) finishing?.();
      const preferred = back ? "login" : wayOf(memory.get());
      return new Promise((resolve) => {
        const answers: Partial<Record<ConnectWay, Session | null>> = {};
        let loginGivenUp = false;
        let done = false;
        const answered = (choice: ConnectWay) =>
          choice in answers || (choice === "login" && loginGivenUp);
        const take = (session: Session | null, choice: ConnectWay | null) => {
          done = true;
          const first = active === null;
          if (first) active = choice;
          // A connect came first: the store keeps that one, and this way's session ends.
          else if (session !== null && choice !== null && choice !== active) void endOther(choice);
          if (back) void finishReturn(session, choice, first).then(resolve);
          else resolve(session);
        };
        const decide = () => {
          if (done) return;
          if (preferred === null) {
            // No way remembered: the first session found.
            for (const choice of ["login", "wallet"] as const) {
              const session = answers[choice];
              if (session) return take(session, choice);
            }
          } else {
            // The remembered way first; the other's session only once it has none.
            for (const choice of [preferred, otherWay(preferred)]) {
              if (!answered(choice)) return;
              const session = answers[choice];
              if (session) return take(session, choice);
            }
          }
          // "None" only once both ways have really answered: a login that is slow to say is not a
          // login that isn't there, and the token the tab kept for it must not be dropped.
          if ("login" in answers && "wallet" in answers) take(null, null);
        };
        const giveUp = back
          ? null
          : setTimeout(() => {
              loginGivenUp = true;
              decide();
            }, loginRestoreMs);
        void restoreOf("login").then((session) => {
          if (giveUp !== null) clearTimeout(giveUp);
          answers.login = session;
          if (!done) return decide();
          // Too late: the other way's session was taken. One session at a time, so this one ends,
          // unless the person has connected by the login since.
          if (session !== null && active !== "login") void endOther("login");
        });
        void restoreOf("wallet").then((session) => {
          answers.wallet = session;
          decide();
        });
      });
    },

    connect() {
      return connectBy(null);
    },

    async disconnect(session) {
      const choice = active ?? (session.keyHolder === undefined ? "wallet" : "login");
      // The sign-out this causes is the store's own doing: it is not told back. `active` stays
      // until the way has disconnected, so that a way that failed to is still heard later.
      muted = choice;
      try {
        await (await way(choice)).disconnect(session);
      } finally {
        muted = null;
      }
      if (active === choice) active = null;
      delete known[choice];
      // Log out is no session at all: any other this provider knows of ends too, quietly, so that
      // a reload can't bring it back.
      await endOther(otherWay(choice));
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
