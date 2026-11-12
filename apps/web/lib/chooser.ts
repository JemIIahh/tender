import { useSyncExternalStore } from "react";
import { api } from "./api";
import { GOOGLE_DIDNT_FINISH } from "./copy";
import { type GiftDeps, type GiftProblem, getAccountReady, type Readiness } from "./gasGift";
import type { LastUsed } from "./lastWay";
import type { ConnectPick, ConnectWays, LoginSteps } from "./privy";
import { nearBalanceOf } from "./rpc";
import type { Session, WalletRow } from "./wallet";

// The Connect window (components/ConnectChooser.tsx), as a store. Connect opens it: in a build with
// the email and Google login, an email field (a code is sent, and the person types it here), Google
// (the page goes to Google and comes back), and under them a row for each NEAR wallet near-connect
// lists, which connects that wallet at once; in a build without the login, the wallets alone. A
// wallet's row closes the window, so that the wallet's own approval is what shows next. After a
// login, the window stays open to get the account ready (lib/gasGift.ts): "Getting your account
// ready…", then nothing (it closes), or one line that says what is in the way, with a Try again or
// the faucet or both.

/** The NEAR wallets of the window: on their way, listed, or not to be had. */
export type WalletList =
  | { status: "loading" }
  | { status: "listed"; wallets: WalletRow[] }
  | { status: "failed" };

/** What the window offers while the person picks. */
export interface Offer {
  /** Whether the email and Google login is offered (a build with a Privy app id). */
  login: boolean;
  wallets: WalletList;
  lastUsed: LastUsed | null;
}

export type ChooserState =
  | { step: "closed" }
  | ({
      step: "choose";
      /** The address typed last, kept for Back. */
      email: string;
      busy: "email" | "google" | null;
      problem: string | null;
    } & Offer)
  | ({
      step: "code";
      email: string;
      busy: "code" | "resend" | null;
      problem: string | null;
      /** Wrong codes typed since the code was sent. */
      tries: number;
      /** A new code was sent (Resend). */
      resent: boolean;
    } & Offer)
  | { step: "finishing" }
  | { step: "preparing"; accountId: string | null }
  | { step: "stuck"; accountId: string; problem: GiftProblem; before: bigint | null };

const CLOSED: ChooserState = { step: "closed" };

/** How long the window waits for near-connect's list before it offers near-connect's own window. */
export const WALLETS_WITHIN_MS = 8000;

/** How many codes Privy takes for one it sent; after that, a new one is needed. */
export const CODE_TRIES = 5;

/** Privy's error code on what one of its hooks threw (`privyErrorCode`), or null. */
function privyCode(error: unknown): string | null {
  const code = (error as { privyErrorCode?: unknown } | null)?.privyErrorCode;
  return typeof code === "string" ? code : null;
}

/** Why a code could not be sent, in one line. */
export function sendCodeProblem(error: unknown): string {
  switch (privyCode(error)) {
    case "invalid_data":
      return "Check the email address.";
    case "too_many_requests":
      return "Too many tries. Wait a few minutes, then try again.";
    case "disallowed_login_method":
    case "disallowed_plus_email":
    case "allowlist_rejected":
      return "This email address can't log in here.";
    default:
      return "Couldn't send the code. Try again.";
  }
}

/**
 * Why a code did not log the person in, in one line. Privy answers a wrong code and an expired one
 * the same way; after `CODE_TRIES` wrong ones the code is spent.
 */
export function codeProblem(error: unknown, tries: number): string {
  switch (privyCode(error)) {
    case "invalid_credentials":
      return tries >= CODE_TRIES
        ? "Too many wrong codes. Send a new code."
        : "That code is wrong or has expired.";
    case "too_many_requests":
      return "Too many tries. Wait a few minutes, then send a new code.";
    default:
      return "Couldn't log in. Try again.";
  }
}

/** Whether `email` looks like an address: something, an @, and a domain with a dot. */
function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** What the window needs of a login's session to get it ready: its account, and its token. */
type Readied = Pick<Session, "accountId" | "keyHolder">;

export function createChooser(
  makeDeps: (session: Readied) => GiftDeps,
  { walletsWithinMs = WALLETS_WITHIN_MS }: { walletsWithinMs?: number } = {},
) {
  let state: ChooserState = CLOSED;
  const listeners = new Set<() => void>();
  let answer: ((pick: ConnectPick | null) => void) | null = null;
  let asked: Promise<ConnectPick | null> | null = null;
  // What the open window reaches through.
  let ways: ConnectWays | null = null;
  // The session that is being got ready, or that is stuck: what Try again runs for.
  let readying: Readied | null = null;
  // Which opening of the window, or run of the check, counts: what comes back for one the person
  // closed, or that was started again, is not shown.
  let run = 0;

  function set(next: ChooserState): void {
    state = next;
    for (const listener of [...listeners]) listener();
  }

  function settle(pick: ConnectPick | null): void {
    const resolve = answer;
    answer = null;
    asked = null;
    resolve?.(pick);
  }

  /** Changes the window while it is at `step`, in the same opening (`mine`); otherwise nothing. */
  function update<S extends ChooserState["step"]>(
    mine: number,
    step: S,
    change: (current: Extract<ChooserState, { step: S }>) => ChooserState,
  ): void {
    if (mine !== run || state.step !== step) return;
    set(change(state as Extract<ChooserState, { step: S }>));
  }

  /** The offer of the window as it stands, while the person picks. */
  function offerOf(current: Offer): Offer {
    return { login: current.login, wallets: current.wallets, lastUsed: current.lastUsed };
  }

  /** Lists the wallets for the opening `mine`, within `walletsWithinMs`. */
  function listWallets(mine: number, from: ConnectWays): void {
    const show = (wallets: WalletList) => {
      if (mine !== run || (state.step !== "choose" && state.step !== "code")) return;
      if (state.wallets.status === "listed") return;
      set({ ...state, wallets });
    };
    const timer = setTimeout(() => show({ status: "failed" }), walletsWithinMs);
    from.wallets().then(
      (wallets) => {
        clearTimeout(timer);
        show({ status: "listed", wallets });
      },
      (error: unknown) => {
        clearTimeout(timer);
        console.error(error);
        show({ status: "failed" });
      },
    );
  }

  /** The login's steps, or null in a build without them. */
  async function steps(): Promise<LoginSteps> {
    if (ways?.login == null) throw new Error("this build has no login");
    return ways.login();
  }

  // Ends the wait of whoever is waiting on the check under way: the person closed the window.
  let release: (() => void) | null = null;

  /** Runs the check and shows it. Resolves when it is done, or when the person closes it. */
  function check(
    session: Readied,
    retrying?: { problem: GiftProblem; before: bigint | null },
  ): Promise<void> {
    const mine = ++run;
    readying = session;
    set({ step: "preparing", accountId: session.accountId });
    return new Promise((resolve) => {
      release = resolve;
      void getAccountReady(
        session.accountId,
        makeDeps(session),
        retrying === undefined ? {} : { retrying },
      ).then((readiness: Readiness) => {
        if (mine === run) {
          if (readiness.status === "ready") {
            readying = null;
            set(CLOSED);
          } else {
            set({
              step: "stuck",
              accountId: session.accountId,
              problem: readiness.problem,
              before: readiness.before,
            });
          }
        }
        resolve();
      });
    });
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: (): ChooserState => state,
    getServerSnapshot: (): ChooserState => CLOSED,

    /** Opens the window over `offered`: what the person did, or null when they close it. */
    ask(offered: ConnectWays): Promise<ConnectPick | null> {
      if (asked !== null) return asked;
      // A new opening: a check still on its way is no longer shown.
      const mine = ++run;
      readying = null;
      ways = offered;
      asked = new Promise((resolve) => {
        answer = resolve;
      });
      set({
        step: "choose",
        login: offered.login !== null,
        wallets: { status: "loading" },
        lastUsed: offered.lastUsed,
        email: "",
        busy: null,
        problem: offered.problem ?? null,
      });
      listWallets(mine, offered);
      return asked;
    },

    /** Sends a code to `typed`; the window then asks for it. */
    async sendCode(typed: string): Promise<void> {
      if (state.step !== "choose" || state.busy !== null || !state.login) return;
      const email = typed.trim();
      const mine = run;
      if (!looksLikeEmail(email)) {
        set({
          ...state,
          email,
          problem: email === "" ? "Enter your email address." : "Check the email address.",
        });
        return;
      }
      set({ ...state, email, busy: "email", problem: null });
      try {
        await (await steps()).sendCode(email);
      } catch (error) {
        update(mine, "choose", (current) => ({
          ...current,
          busy: null,
          problem: sendCodeProblem(error),
        }));
        return;
      }
      update(mine, "choose", (current) => ({
        ...offerOf(current),
        step: "code",
        email,
        busy: null,
        problem: null,
        tries: 0,
        resent: false,
      }));
    },

    /** Logs in with the code the person typed. The window then gets the account ready. */
    async submitCode(typed: string): Promise<void> {
      if (state.step !== "code" || state.busy !== null) return;
      const code = typed.replace(/\s/g, "");
      const mine = run;
      if (!/^\d{6}$/.test(code)) {
        set({ ...state, problem: "Enter the 6-digit code." });
        return;
      }
      set({ ...state, busy: "code", problem: null, resent: false });
      try {
        await (await steps()).loginWithCode(code);
      } catch (error) {
        update(mine, "code", (current) => {
          const tries = current.tries + 1;
          return { ...current, busy: null, tries, problem: codeProblem(error, tries) };
        });
        return;
      }
      if (mine !== run || state.step !== "code") return;
      // Logged in: the window stays open, and says it is getting the account ready.
      set({ step: "preparing", accountId: null });
      settle({ way: "login" });
    },

    /** Sends a new code to the same address. */
    async resend(): Promise<void> {
      if (state.step !== "code" || state.busy !== null) return;
      const { email } = state;
      const mine = run;
      set({ ...state, busy: "resend", problem: null, resent: false });
      try {
        await (await steps()).sendCode(email);
      } catch (error) {
        update(mine, "code", (current) => ({
          ...current,
          busy: null,
          problem: sendCodeProblem(error),
        }));
        return;
      }
      update(mine, "code", (current) => ({ ...current, busy: null, tries: 0, resent: true }));
    },

    /** From the code back to the window's first step, with the address kept. */
    back(): void {
      if (state.step !== "code") return;
      set({ ...offerOf(state), step: "choose", email: state.email, busy: null, problem: null });
    },

    /** Sends the page to Google. The login ends when the page comes back (lib/privy.ts). */
    async google(): Promise<void> {
      if (state.step !== "choose" || state.busy !== null || !state.login) return;
      const mine = run;
      set({ ...state, busy: "google", problem: null });
      try {
        await (await steps()).google();
      } catch (error) {
        console.error(error);
        update(mine, "choose", (current) => ({
          ...current,
          busy: null,
          problem: GOOGLE_DIDNT_FINISH,
        }));
      }
      // Otherwise the page is on its way to Google, and the window stays as it is until it goes.
    },

    /**
     * The person picked a NEAR wallet (`walletId` null: near-connect's own list). The window
     * closes, so that the wallet's own approval is what shows next.
     */
    pickWallet(walletId: string | null): void {
      if (state.step !== "choose" && state.step !== "code") return;
      run++;
      set(CLOSED);
      settle({ way: "wallet", walletId });
    },

    /**
     * Says the page is finishing a login that came back from Google, until the account is got ready
     * (`prepare`) or the window asks again (`ask`, saying it didn't finish).
     */
    finishing(): void {
      run++;
      readying = null;
      set({ step: "finishing" });
    },

    /**
     * Gets a login's account ready to pay fees, showing it. Resolves once it is ready (the window
     * closes) or stuck (it stays open, saying why); never rejects.
     */
    prepare(session: Readied): Promise<void> {
      return check(session);
    },

    /**
     * Try again, from a stuck window that offers it: the balance first (NEAR that arrived after a
     * gift that was sent, or may have been, is that gift), then a wait or a new ask, as
     * `getAccountReady` says.
     */
    retry(): Promise<void> {
      if (state.step !== "stuck" || readying === null) return Promise.resolve();
      return check(readying, { problem: state.problem, before: state.before });
    },

    /** The person closed the window. A question is answered with null. */
    close(): void {
      run++;
      readying = null;
      ways = null;
      set(CLOSED);
      settle(null);
      release?.();
      release = null;
    },
  };
}

export type Chooser = ReturnType<typeof createChooser>;

/** What the readiness check reads and calls, for a login's session. */
export function giftDeps(session: Readied): GiftDeps {
  return {
    // The newest block: a gift the API waited for is there a block or two before it is final.
    balanceOf: (accountId) => nearBalanceOf(accountId, "optimistic"),
    loginToken: async () => (await session.keyHolder?.loginToken()) ?? null,
    requestGift: (token, accountId) => api.gasGift(token, accountId),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

/** The chooser of this page. */
export const chooser: Chooser = createChooser(giftDeps);

/** The state of `store`, for a component. */
export function useChooserState(store: Chooser = chooser): ChooserState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}
