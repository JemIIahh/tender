import { useSyncExternalStore } from "react";
import { api } from "./api";
import { type GiftDeps, type GiftProblem, getAccountReady, type Readiness } from "./gasGift";
import type { ConnectChoice } from "./privy";
import { nearBalanceOf } from "./rpc";
import type { Session } from "./wallet";

// The Connect chooser (components/ConnectChooser.tsx), as a store. In a build with the email and
// Google login, Connect asks the person which way to connect: the login, or a NEAR wallet. The
// store opens the chooser, and closes it once a way is picked, so that the login's window or the
// wallet's list is what shows next and nothing of ours is in front of it. After a login, it opens
// again to get the account ready (lib/gasGift.ts): "Getting your account ready…", then nothing
// (it closes), or one line that says what is in the way, with the faucet and a Try again.

export type ChooserState =
  | { step: "closed" }
  | { step: "choose" }
  | { step: "preparing"; accountId: string }
  | { step: "stuck"; accountId: string; problem: GiftProblem };

const CLOSED: ChooserState = { step: "closed" };

/** What the chooser needs of a login's session to get it ready: its account, and its token. */
type Readied = Pick<Session, "accountId" | "keyHolder">;

export function createChooser(makeDeps: (session: Readied) => GiftDeps) {
  let state: ChooserState = CLOSED;
  const listeners = new Set<() => void>();
  let answer: ((choice: ConnectChoice | null) => void) | null = null;
  let asked: Promise<ConnectChoice | null> | null = null;
  // The session that is being got ready, or that is stuck: what Try again runs for.
  let readying: Readied | null = null;
  // Which run of the check counts: one the person closed, or ran again, is not shown.
  let run = 0;

  function set(next: ChooserState): void {
    state = next;
    for (const listener of [...listeners]) listener();
  }

  function settle(choice: ConnectChoice | null): void {
    const resolve = answer;
    answer = null;
    asked = null;
    resolve?.(choice);
  }

  // Ends the wait of whoever is waiting on the check under way: the person closed the chooser.
  let release: (() => void) | null = null;

  /** Runs the check and shows it. Resolves when it is done, or when the person closes it. */
  function check(session: Readied, waitOnly: boolean): Promise<void> {
    const mine = ++run;
    readying = session;
    set({ step: "preparing", accountId: session.accountId });
    return new Promise((resolve) => {
      release = resolve;
      void getAccountReady(session.accountId, makeDeps(session), { waitOnly }).then(
        (readiness: Readiness) => {
          if (mine === run) {
            if (readiness.status === "ready") {
              readying = null;
              set(CLOSED);
            } else {
              set({ step: "stuck", accountId: session.accountId, problem: readiness.problem });
            }
          }
          resolve();
        },
      );
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

    /** Opens the chooser: the way the person picks, or null when they close it. */
    ask(): Promise<ConnectChoice | null> {
      if (asked !== null) return asked;
      // A question is a new start: a check still on its way is no longer shown.
      run++;
      readying = null;
      asked = new Promise((resolve) => {
        answer = resolve;
      });
      set({ step: "choose" });
      return asked;
    },

    /** The person picked a way. The chooser closes, so that what the way opens is in front. */
    choose(choice: ConnectChoice): void {
      if (state.step !== "choose") return;
      set(CLOSED);
      settle(choice);
    },

    /**
     * Gets a login's account ready to pay fees, showing it. Resolves once it is ready (the chooser
     * closes) or stuck (it stays open, saying why); never rejects.
     */
    prepare(session: Readied): Promise<void> {
      return check(session, false);
    },

    /** Try again, from a stuck chooser: a gift that was sent is waited for, and not asked again. */
    retry(): Promise<void> {
      if (state.step !== "stuck" || readying === null) return Promise.resolve();
      return check(readying, state.problem === "timeout");
    },

    /** The person closed the chooser. A question is answered with null. */
    close(): void {
      run++;
      readying = null;
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
