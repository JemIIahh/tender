import type { KeyHolder, Session, SigningWallet, WalletProvider } from "./wallet";
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
  /** Opens Privy's login window. What came of it is told to the bridge (`loginEnded`). */
  login(): void;
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

/** What Privy calls a login window closed by the person. Not a failure. */
const LOGIN_CLOSED = "exited_auth_flow";

/** How long a connect waits for Privy's kit to be ready before it says it couldn't connect. */
export const PRIVY_READY_MS = 15_000;

/**
 * Where the kit's hooks meet the provider. The kit's component calls `publish` with every render,
 * and `loginEnded` from the login's callbacks; the provider reads the latest.
 */
export interface PrivyBridge {
  publish(kit: PrivyKit): void;
  /** The login window ended: with a user, or with Privy's error code (`exited_auth_flow`: closed). */
  loginEnded(outcome: { user: PrivyUser } | { error: string }): void;
  /** The kit, once it is ready. Rejects after `withinMs` without it. */
  whenReady(withinMs?: number): Promise<PrivyKit>;
  /** The latest kit. Throws before the first. */
  kit(): PrivyKit;
  /** Opens the login window: the user it logs in, or null when the person closes it. */
  login(): Promise<PrivyUser | null>;
  /** `listener` hears a login that was on end without this page asking (it ran out, another tab). */
  onLoggedOut(listener: () => void): () => void;
}

export function createPrivyBridge(): PrivyBridge {
  let latest: PrivyKit | null = null;
  const waiting = new Set<(kit: PrivyKit) => void>();
  const loggedOut = new Set<() => void>();
  let pending: {
    resolve: (user: PrivyUser | null) => void;
    reject: (error: unknown) => void;
    promise: Promise<PrivyUser | null>;
  } | null = null;

  return {
    publish(kit) {
      const was = latest;
      latest = kit;
      if (!kit.ready) return;
      for (const resolve of [...waiting]) resolve(kit);
      waiting.clear();
      if (was?.ready === true && was.authenticated && !kit.authenticated) {
        for (const listener of [...loggedOut]) listener();
      }
    },

    loginEnded(outcome) {
      const current = pending;
      if (current === null) return;
      pending = null;
      if ("user" in outcome) current.resolve(outcome.user);
      else if (outcome.error === LOGIN_CLOSED) current.resolve(null);
      else current.reject(new Error(`the login failed: ${outcome.error}`));
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

    login() {
      if (pending !== null) return pending.promise;
      let resolve!: (user: PrivyUser | null) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<PrivyUser | null>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      pending = { resolve, reject, promise };
      try {
        if (latest === null) throw new Error("Privy's kit has not started");
        latest.login();
      } catch (error) {
        pending = null;
        reject(error);
      }
      return promise;
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

export interface PrivyProviderOptions {
  bridge: PrivyBridge;
  makeWallet: MakePrivyWallet;
  readyWithinMs?: number;
}

/**
 * The email and Google login as a provider, over a bridge whose kit is mounted. A session is the
 * user's NEAR wallet, made for them on their first login.
 */
export function privyProvider({
  bridge,
  makeWallet,
  readyWithinMs = PRIVY_READY_MS,
}: PrivyProviderOptions): WalletProvider {
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

  return {
    async restore() {
      const kit = await bridge.whenReady(readyWithinMs);
      if (!kit.authenticated || kit.user === null) return null;
      return sessionOf(kit.user);
    },

    async connect() {
      let user: PrivyUser | null;
      try {
        const kit = await bridge.whenReady(readyWithinMs);
        user = kit.authenticated ? kit.user : await bridge.login();
      } catch (cause) {
        throw new WalletError("connect", cause);
      }
      if (user === null) return null;
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

// ---- Two ways to connect ------------------------------------------------------------------------

/** The two ways to connect: the email or Google login, or a NEAR wallet (near-connect). */
export type ConnectChoice = "login" | "wallet";

/** Where the way of the last connect is kept, so that a restore prefers it (lib/lastWay.ts). */
export interface WayMemory {
  get(): ConnectChoice | null;
  set(choice: ConnectChoice): void;
}

/**
 * How long a restore waits for the remembered login before it takes the other way's session. The
 * login loads Privy's kit, which talks to Privy's servers and can be slow or blocked. With no
 * session elsewhere the restore waits for the login's own answer, however long: the store shows
 * Connect after its own patience (`START_PATIENCE_MS`) meanwhile, and takes up the login, with the
 * token the tab kept, when it comes.
 */
export const LOGIN_RESTORE_MS = 2500;

export interface ChoiceOptions {
  /** The email and Google login. Made the first time it is wanted. */
  login: () => Promise<WalletProvider>;
  /** near-connect. Made the first time it is wanted. */
  wallet: () => Promise<WalletProvider>;
  /** Asks the person which way: null when they close the chooser. */
  ask: () => Promise<ConnectChoice | null>;
  /** Gets a session of the login ready to pay fees (lib/gasGift.ts), as the chooser shows it. */
  prepare: (session: Session) => Promise<void>;
  /** The way of the last connect. None by default: nothing is kept. */
  memory?: WayMemory;
  loginRestoreMs?: number;
}

const NO_MEMORY: WayMemory = { get: () => null, set: () => {} };

const otherWay = (choice: ConnectChoice): ConnectChoice =>
  choice === "login" ? "wallet" : "login";

/**
 * One provider over both ways, with one session at a time. Connect asks which, remembers it, and
 * ends the other way's session. A restore looks at both ways at once and prefers the remembered
 * one: another way's session is taken only once the preferred way has said it has none, or, for
 * the login, after `loginRestoreMs` (with no way remembered, the first session found is taken).
 * "None" is said only once both ways have answered. A session that turns up beside the one taken
 * is ended. Log out ends every session this provider knows of, so that a reload brings back none.
 * A sign-out is the way's that gave the session. Each way is made once, and made again after it
 * failed to load.
 */
export function choiceProvider({
  login,
  wallet,
  ask,
  prepare,
  memory = NO_MEMORY,
  loginRestoreMs = LOGIN_RESTORE_MS,
}: ChoiceOptions): WalletProvider {
  const made: Partial<Record<ConnectChoice, Promise<WalletProvider>>> = {};
  // The way of the session the store holds, as far as this provider gave it.
  let active: ConnectChoice | null = null;
  // The session each way is known to hold, from its restore or its connect.
  const known: Partial<Record<ConnectChoice, Session>> = {};
  // A way being disconnected by this provider: the sign-out that causes is not news.
  let muted: ConnectChoice | null = null;
  const listeners = new Set<(session: Session | null) => void>();

  const tell = (session: Session | null) => {
    for (const listener of [...listeners]) listener(session);
  };

  function way(choice: ConnectChoice): Promise<WalletProvider> {
    made[choice] ??= (choice === "login" ? login() : wallet())
      .then((provider) => {
        provider.subscribe((next) => {
          if (next !== null) return;
          delete known[choice];
          if (active === choice && muted !== choice) {
            active = null;
            tell(null);
          }
        });
        return provider;
      })
      .catch((error: unknown) => {
        delete made[choice];
        throw error;
      });
    return made[choice];
  }

  /** The session `choice` restores, or null when it has none or could not look. */
  async function restoreOf(choice: ConnectChoice): Promise<Session | null> {
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
  async function endOther(choice: ConnectChoice): Promise<void> {
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

  return {
    restore() {
      const preferred = memory.get();
      return new Promise((resolve) => {
        const answers: Partial<Record<ConnectChoice, Session | null>> = {};
        let loginGivenUp = false;
        let done = false;
        const answered = (choice: ConnectChoice) =>
          choice in answers || (choice === "login" && loginGivenUp);
        const take = (session: Session | null, choice: ConnectChoice | null) => {
          done = true;
          if (active === null) active = choice;
          // A connect came first: the store keeps that one, and this way's session ends.
          else if (session !== null && choice !== null && choice !== active) void endOther(choice);
          resolve(session);
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
        const giveUp = setTimeout(() => {
          loginGivenUp = true;
          decide();
        }, loginRestoreMs);
        void restoreOf("login").then((session) => {
          clearTimeout(giveUp);
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

    async connect() {
      const choice = await ask();
      if (choice === null) return null;
      let session: Session | null;
      try {
        session = await (await way(choice)).connect();
      } catch (error) {
        throw error instanceof WalletError ? error : new WalletError("connect", error);
      }
      if (session === null) return null;
      active = choice;
      known[choice] = session;
      memory.set(choice);
      // One session at a time: the other way's, if it has one, ends.
      await endOther(otherWay(choice));
      if (choice === "login") await prepare(session);
      return session;
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
