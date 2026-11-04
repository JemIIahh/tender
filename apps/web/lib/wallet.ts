import type { TxReceiptsOutcome } from "@tender/client/outcome";
import { receiptsFromTx } from "@tender/client/outcome";
import {
  AccountIdSchema,
  type ConnectorFunctionCallAction,
  extractEvents,
  type TenderCall,
  type TenderEvent,
  toConnectorAction,
} from "@tender/shared";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { clearApiToken, sessionBegan, sessionEnded } from "./apiToken";
import { config } from "./config";
import {
  TransactionFailed,
  WalletCannotSign,
  WalletError,
  WalletNotConnected,
  WalletResultUnreadable,
  WalletUnavailable,
} from "./walletErrors";
import { linkTabs, noTabs, type OpenTabLink, type TabLink } from "./walletTabs";

// The wallet, as the pages use it. One store holds the connected account for the whole page: every
// component that calls `useWallet` sees the same one, and a wallet connects once. What sits behind
// the store is a `WalletProvider`: near-connect for the real wallets, and in a sandbox build, if
// it is switched on, the dev wallet (lib/devWallet.ts). Both give the store a `SigningWallet`,
// which is the part of near-connect's wallet interface this app calls, so a transaction is grouped,
// sent and read back by the same code whoever signs it.
//
// The wallet's answers are not trusted. A transaction result is checked for the fields this file
// reads before it is used, and what a page does next does not rest on it: the pages read their
// balances back from the node.

/** A wallet, as far as this app uses it. near-connect's `NearWalletBase` has all of this. */
export interface SigningWallet {
  manifest?: { features?: { signMessage?: boolean; signAndSendTransactions?: boolean } };
  signAndSendTransactions(params: {
    transactions: TransactionRequest[];
    signerId?: string;
  }): Promise<unknown>;
  signMessage(params: {
    message: string;
    recipient: string;
    nonce: Uint8Array;
    signerId?: string;
  }): Promise<unknown>;
}

/** One transaction for a wallet to sign: calls to a single account, run in order. */
export interface TransactionRequest {
  receiverId: string;
  actions: ConnectorFunctionCallAction[];
}

/**
 * The actions that make an account, in near-connect's shape (0.12.0): "Add an agent" creates the
 * agent's account under the person's, funds it, and gives it the key the agent made, in one
 * transaction to the new account. Nothing else in the app sends them.
 */
export type AccountAction =
  | { type: "CreateAccount" }
  | { type: "Transfer"; params: { deposit: string } }
  | {
      type: "AddKey";
      params: { publicKey: string; accessKey: { permission: "FullAccess" } };
    };

/**
 * One transaction of a batch that mixes the two: the actions that make an account, or function
 * calls. "Add an agent" sends the account's transaction and the calls that pay for it as one batch,
 * one approval.
 */
export interface MixedTransaction {
  receiverId: string;
  actions: AccountAction[] | ConnectorFunctionCallAction[];
}

/** A wallet and the account it is connected as. */
export interface Session {
  wallet: SigningWallet;
  accountId: string;
}

/** Where a store gets its wallet. */
export interface WalletProvider {
  /** The session from an earlier visit, or null if there is none. */
  restore(): Promise<Session | null>;
  /** Has the person pick a wallet and sign in: null if they closed the dialog without one. */
  connect(): Promise<Session | null>;
  disconnect(session: Session): Promise<void>;
  /** `listener(null)` when the wallet signs out by itself. Returns what stops the listening. */
  subscribe(listener: (session: Session | null) => void): () => void;
}

/** What the pages can read about the wallet. */
export interface WalletState {
  /** Whether the wallet from an earlier visit has been looked for. Before then nothing is known. */
  ready: boolean;
  /** The account that is connected, or null. */
  accountId: string | null;
  /** Whether the connected wallet can sign a message (NEP-413). Signing in to the API needs it. */
  canSignMessage: boolean;
}

export interface SendResult {
  /** The Tender events the transactions logged, in order. */
  events: TenderEvent[];
  /** The hash of each transaction, in the order they were sent. */
  txHashes: string[];
}

export interface SignMessageInput {
  message: string;
  recipient: string;
  nonce: Uint8Array;
}

export interface SignedMessageResult {
  accountId: string;
  /** `ed25519:<base58>`, as the wallet gave it. */
  publicKey: string;
  /** Base64, as the wallet gave it. */
  signature: string;
}

export interface WalletActions {
  /** Has the person pick a wallet and sign in. Closing the dialog is not an error. */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /**
   * Has the wallet sign and send `calls`, and gives back what they logged. Consecutive calls to
   * one account are one transaction; the transactions run in the order given. Throws
   * `WalletNotConnected`, `WalletError` for a wallet that threw or was closed, `TransactionFailed`
   * for one that failed on the network, and `WalletResultUnreadable` for an answer it can't read.
   */
  signAndSend(calls: readonly TenderCall[]): Promise<SendResult>;
  /** Has the wallet sign a message (NEP-413). Throws `WalletCannotSign` if it can't. */
  signMessage(input: SignMessageInput): Promise<SignedMessageResult>;
}

/** What "Add an agent" asks of the wallet, beyond the calls every page sends (`useAccountActions`). */
export interface AccountActions {
  /**
   * Whether the connected wallet says it signs and sends whole transactions, which making an
   * account needs: a near-connect wallet's manifest says so (`signAndSendTransactions`), and the
   * sandbox's dev wallet, which sends function calls only, does not.
   */
  canSend(): boolean;
  /**
   * Has the wallet sign and send one transaction of `actions` to `receiverId`, and gives back its
   * hash. Throws as `signAndSend` does, and `WalletCannotSign` if the wallet does not say it can.
   */
  send(receiverId: string, actions: AccountAction[]): Promise<string>;
  /**
   * Has the wallet sign and send `transactions`, in order, in one approval, and gives back their
   * hashes. Throws as `send` does: a wallet that stops at a transaction that failed gives back no
   * outcome for those after it, and that failure is the answer (`TransactionFailed`).
   */
  sendBatch(transactions: MixedTransaction[]): Promise<string[]>;
}

export type UseWallet = WalletState & WalletActions;

/**
 * How long a page waits for the wallet from an earlier visit before it shows the person a Connect
 * button. near-connect loads its wallet list from the network first and has no limit of its own.
 * A wallet that turns up later is still taken, and keeps the token the tab held if it is the same
 * account.
 */
const RESTORE_PATIENCE_MS = 8000;

/** Groups `calls` into the transactions that carry them: consecutive calls to one receiver join. */
export function groupCalls(calls: readonly TenderCall[]): TransactionRequest[] {
  const transactions: TransactionRequest[] = [];
  for (const call of calls) {
    const last = transactions.at(-1);
    if (last !== undefined && last.receiverId === call.receiverId) {
      last.actions.push(toConnectorAction(call));
    } else {
      transactions.push({ receiverId: call.receiverId, actions: [toConnectorAction(call)] });
    }
  }
  return transactions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === "string";

/** Whether the wallet says in its manifest that it can sign a message. */
function canSign(wallet: SigningWallet): boolean {
  return wallet.manifest?.features?.signMessage === true;
}

/** Whether the wallet says in its manifest that it signs and sends whole transactions. */
function sendsTransactions(wallet: SigningWallet): boolean {
  return wallet.manifest?.features?.signAndSendTransactions === true;
}

/** What the contract panicked with, such as `E_FUNDS`, from the `Failure` of a final status. */
function panicCode(failure: unknown): string | null {
  let text: string;
  try {
    text = JSON.stringify(failure) ?? "";
  } catch {
    return null;
  }
  return /Smart contract panicked: (E_[A-Z_]+)/.exec(text)?.[1] ?? null;
}

interface ReadOutcome {
  hash: string;
  receipts: TxReceiptsOutcome;
}

/**
 * One transaction's final outcome, as a wallet hands it over. Only the fields read are checked: the
 * hash, a status that says how it ended, and the receipts with the logs the events come from. A
 * failed status throws `TransactionFailed`, and so does a status that is not a success: only
 * `SuccessValue` is one, as for a receipt (`receiptsFromTx`).
 */
function readOutcome(value: unknown): ReadOutcome {
  if (!isRecord(value) || !isRecord(value.transaction) || !Array.isArray(value.receipts_outcome)) {
    throw new WalletResultUnreadable("transaction");
  }
  const hash = value.transaction.hash;
  if (!isString(hash) || hash === "") throw new WalletResultUnreadable("transaction");

  const receipts: TxReceiptsOutcome["receipts_outcome"][number][] = [];
  for (const receipt of value.receipts_outcome) {
    if (!isRecord(receipt) || !isString(receipt.id) || !isRecord(receipt.outcome)) {
      throw new WalletResultUnreadable("transaction");
    }
    const { executor_id: executorId, logs, status } = receipt.outcome;
    if (!isString(executorId) || !Array.isArray(logs) || !logs.every(isString)) {
      throw new WalletResultUnreadable("transaction");
    }
    receipts.push({ id: receipt.id, outcome: { executor_id: executorId, status, logs } });
  }

  const status = value.status;
  if (isRecord(status) && "Failure" in status) {
    throw new TransactionFailed(hash, panicCode(status.Failure));
  }
  if (!isRecord(status) || !isString(status.SuccessValue)) {
    throw new WalletResultUnreadable("transaction");
  }
  return { hash, receipts: { receipts_outcome: receipts } };
}

/**
 * The transactions' outcomes, one for each that was sent, as a wallet gives them back. A wallet
 * that stopped at a transaction that failed has no outcome for those after it: the failure is the
 * answer, and it is found before the count is.
 */
function readOutcomes(result: unknown, sent: number): SendResult {
  // A wallet may answer one transaction with its outcome and not a list of one.
  const list = Array.isArray(result) ? result : isRecord(result) ? [result] : null;
  if (list === null) throw new WalletResultUnreadable("transaction");
  const outcomes = list.map(readOutcome);
  if (outcomes.length !== sent) throw new WalletResultUnreadable("transaction");
  return {
    events: outcomes.flatMap(({ receipts }) =>
      extractEvents(receiptsFromTx(receipts), config.contractId),
    ),
    txHashes: outcomes.map(({ hash }) => hash),
  };
}

/** A signature, as a wallet hands it over. */
function readSigned(value: unknown): SignedMessageResult {
  if (
    !isRecord(value) ||
    !isString(value.accountId) ||
    !isString(value.publicKey) ||
    !isString(value.signature) ||
    value.signature === ""
  ) {
    throw new WalletResultUnreadable("signature");
  }
  return {
    accountId: value.accountId,
    publicKey: value.publicKey,
    signature: value.signature,
  };
}

/** Resolves when `promise` settles or `ms` pass, whichever is first. Never rejects. */
function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    promise.then(done, done);
  });
}

const SERVER_STATE: WalletState = { ready: false, accountId: null, canSignMessage: false };

/**
 * A wallet store over the provider that `makeProvider` makes the first time one is needed. The
 * page uses the one at the end of this file; a test builds its own over a provider of its own.
 *
 * `openTabs` is the store's line to the other tabs of the browser (lib/walletTabs.ts), opened when
 * the store starts. A wallet session is the browser's and a token is the tab's, so a session that
 * ends or changes in one tab ends in the others: each drops its token, and none asks the wallet.
 * The page's store has the line; a store has none unless it is given one.
 */
export function createWalletStore(
  makeProvider: () => Promise<WalletProvider>,
  openTabs: OpenTabLink = noTabs,
) {
  let state: WalletState = SERVER_STATE;
  let session: Session | null = null;
  let provider: Promise<WalletProvider> | null = null;
  let starting: Promise<void> | null = null;
  let connecting: Promise<void> | null = null;
  let tabs: TabLink | null = null;
  const listeners = new Set<() => void>();

  function publish(next: Partial<WalletState>): void {
    const merged = { ...state, ...next };
    if (
      merged.ready === state.ready &&
      merged.accountId === state.accountId &&
      merged.canSignMessage === state.canSignMessage
    ) {
      return;
    }
    state = merged;
    for (const listener of [...listeners]) listener();
  }

  /** The line to the other tabs, opened the first time it is wanted. */
  function link(): TabLink {
    tabs ??= openTabs(endedElsewhere);
    return tabs;
  }

  /**
   * Takes `next` as the wallet session. The API token belongs to the session (lib/apiToken.ts), so
   * it is dropped here, where the session changes, and not by whatever page is on screen.
   * `restored`: the wallet of an earlier visit, taken up again, which keeps the token of the same
   * account and is no news to the other tabs. A wallet the person connected replaces the session
   * they have, so they are told.
   */
  function beginSession(next: Session, restored: boolean): void {
    session = next;
    sessionBegan(next.accountId, restored);
    publish({ accountId: next.accountId, canSignMessage: canSign(next.wallet) });
    if (!restored) link().tell();
  }

  /**
   * The wallet session is over, or there is none to go on with, and the token goes with it. `tell`:
   * the session ended here (a Disconnect, the wallet signing itself out), so the other tabs are
   * told. They are not told of one that another tab ended, which told them all, nor of a wallet
   * that was not found or could not be looked for: that says nothing of their sessions.
   */
  function endSession(tell: boolean): void {
    session = null;
    sessionEnded();
    publish({ accountId: null, canSignMessage: false });
    if (tell) link().tell();
  }

  /**
   * Another tab said its wallet session ended or changed, so this tab's session is not the wallet's
   * any more. It goes, and the wallet is not asked: that tab did.
   */
  function endedElsewhere(): void {
    endSession(false);
  }

  function getProvider(): Promise<WalletProvider> {
    provider ??= makeProvider()
      .then((made) => {
        // One listener for each provider, here where it is made: a provider that failed to load at
        // first and loads on a later try has to be heard for a sign-out just the same.
        made.subscribe((next) => {
          if (next === null) endSession(true);
        });
        return made;
      })
      .catch((error: unknown) => {
        // Forget a provider that could not be made, so that the next try makes it again.
        provider = null;
        throw error;
      });
    return provider;
  }

  function start(): Promise<void> {
    starting ??= (async () => {
      // Hearing the other tabs begins before the wallet is looked for.
      link();
      try {
        const wallets = await getProvider();
        // A token kept from the earlier visit is dropped only when the wallet is known not to
        // come back: it looked and found none, or could not look. A restore that is still on its
        // way when the page stops waiting leaves the token. It is not served without an account, a
        // Connect drops it, and a wallet that does turn up keeps it for the same account only.
        const restoring = wallets
          .restore()
          .then(
            (restored) => {
              // A wallet connected in the meantime stays.
              if (session !== null) return;
              if (restored !== null) beginSession(restored, true);
              // No wallet: this tab has no session to go on with. The other tabs are not told.
              // near-connect also says "no wallet" when its wallet list did not download, and a
              // guess is no reason to sign them out. A session ends for them when it is
              // disconnected, when the wallet signs itself out, or when a Connect replaces it.
              else endSession(false);
            },
            (error: unknown) => {
              console.error(error);
              // Not looked at: the same for this tab, and the other tabs are left alone.
              if (session === null) endSession(false);
            },
          )
          .catch((error: unknown) => console.error(error));
        await settleWithin(restoring, RESTORE_PATIENCE_MS);
      } catch (error) {
        // A build with no wallet to offer, or a wallet library that did not load: the page shows
        // the Connect button, and pressing it says why.
        console.error(error);
        if (session === null) endSession(false);
      } finally {
        publish({ ready: true });
      }
    })();
    return starting;
  }

  function connect(): Promise<void> {
    connecting ??= (async () => {
      try {
        await start();
        if (session !== null) return;
        const next = await (await getProvider()).connect();
        if (next !== null) beginSession(next, false);
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  }

  async function disconnect(): Promise<void> {
    const current = session;
    if (current === null) return;
    // Tender's token goes first, whatever the wallet does: one that can't sign out still leaves
    // this tab without it, and turns away a sign-in that is under way.
    clearApiToken();
    await (await getProvider()).disconnect(current);
    // A wallet that reports its sign-out has ended the session by now, through the listener.
    if (session === current) endSession(true);
  }

  async function signAndSend(calls: readonly TenderCall[]): Promise<SendResult> {
    if (calls.length === 0) throw new RangeError("there are no calls to send");
    const current = session;
    if (current === null) throw new WalletNotConnected();
    const transactions = groupCalls(calls);
    let result: unknown;
    try {
      result = await current.wallet.signAndSendTransactions({
        transactions,
        signerId: current.accountId,
      });
    } catch (cause) {
      throw new WalletError("send", cause);
    }
    return readOutcomes(result, transactions.length);
  }

  function canSendAccountActions(): boolean {
    return session !== null && sendsTransactions(session.wallet);
  }

  async function sendAccountActions(receiverId: string, actions: AccountAction[]): Promise<string> {
    if (actions.length === 0) throw new RangeError("there are no actions to send");
    const [hash] = await sendMixed([{ receiverId, actions }]);
    if (hash === undefined) throw new WalletResultUnreadable("transaction");
    return hash;
  }

  /**
   * One approval for `transactions`, which may mix the actions that make an account with function
   * calls. Only a wallet whose manifest says it signs and sends whole transactions is asked.
   */
  async function sendMixed(transactions: MixedTransaction[]): Promise<string[]> {
    if (transactions.length === 0 || transactions.some((tx) => tx.actions.length === 0)) {
      throw new RangeError("there are no actions to send");
    }
    const current = session;
    if (current === null) throw new WalletNotConnected();
    if (!sendsTransactions(current.wallet)) throw new WalletCannotSign();
    let result: unknown;
    try {
      result = await current.wallet.signAndSendTransactions({
        // `TransactionRequest` names the function calls the rest of the app sends. A wallet takes
        // every action of near-connect's types, and these are among them.
        transactions: transactions as unknown as TransactionRequest[],
        signerId: current.accountId,
      });
    } catch (cause) {
      throw new WalletError("send", cause);
    }
    return readOutcomes(result, transactions.length).txHashes;
  }

  async function signMessage(input: SignMessageInput): Promise<SignedMessageResult> {
    const current = session;
    if (current === null) throw new WalletNotConnected();
    if (!canSign(current.wallet)) throw new WalletCannotSign();
    let result: unknown;
    try {
      result = await current.wallet.signMessage({ ...input, signerId: current.accountId });
    } catch (cause) {
      throw new WalletError("sign", cause);
    }
    return readSigned(result);
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: (): WalletState => state,
    getServerSnapshot: (): WalletState => SERVER_STATE,
    start,
    connect,
    disconnect,
    signAndSend,
    signMessage,
    canSendAccountActions,
    sendAccountActions,
    sendMixed,
  };
}

export type WalletStore = ReturnType<typeof createWalletStore>;

// ---- near-connect ------------------------------------------------------------------------------

/** What near-connect throws when no wallet was connected before. Neither is a failure. */
const NO_SESSION = ["No wallet selected", "No accounts found"];

/** What near-connect rejects with when the person closes its wallet dialog. */
const DIALOG_CLOSED = "User rejected";

/** The session of `connected` (near-connect's `getConnectedWallet`), if its account is one. */
function sessionOf(connected: {
  wallet: SigningWallet;
  accounts: ReadonlyArray<{ accountId: string }>;
}): Session {
  const accountId = connected.accounts[0]?.accountId;
  if (accountId === undefined || !AccountIdSchema.safeParse(accountId).success) {
    throw new TypeError("the wallet reported an account that is not a NEAR account id");
  }
  return { wallet: connected.wallet, accountId };
}

/**
 * What the app asks of near-connect. Every send in the app is one `signAndSendTransactions` (a
 * batch: a storage top-up, a deposit and a post are one approval), so the picker lists only wallets
 * whose manifest says they do that (`availableWallets` in the library hides the rest), and a person
 * cannot pick one that would fail every deposit, withdrawal and post. `signMessage` is not asked
 * for: a wallet that can't sign a message may still send transactions, and the pages say what it
 * can't do (`WALLET_CANNOT_SIGN_MESSAGE`).
 */
export function connectorOptions(network: "mainnet" | "testnet"): {
  network: "mainnet" | "testnet";
  features: { signAndSendTransactions: true };
} {
  return { network, features: { signAndSendTransactions: true } };
}

/**
 * near-connect as a provider. The library touches `window` as it loads, so it is imported when the
 * first page needs a wallet and not before.
 */
export async function connectorProvider(network: "mainnet" | "testnet"): Promise<WalletProvider> {
  let library: typeof import("@hot-labs/near-connect");
  try {
    library = await import("@hot-labs/near-connect");
  } catch (cause) {
    throw new WalletError("connect", cause);
  }
  const connector = new library.NearConnector(connectorOptions(network));

  return {
    async restore() {
      try {
        return sessionOf(await connector.getConnectedWallet());
      } catch (error) {
        if (error instanceof Error && NO_SESSION.includes(error.message)) return null;
        console.error(error);
        return null;
      }
    },

    async connect() {
      try {
        await connector.connect();
      } catch (error) {
        if (error instanceof Error && error.message === DIALOG_CLOSED) return null;
        throw new WalletError("connect", error);
      }
      try {
        return sessionOf(await connector.getConnectedWallet());
      } catch (cause) {
        throw new WalletError("connect", cause);
      }
    },

    async disconnect() {
      try {
        await connector.disconnect();
      } catch (cause) {
        throw new WalletError("disconnect", cause);
      }
    },

    subscribe(listener) {
      const onSignOut = () => listener(null);
      connector.on("wallet:signOut", onSignOut);
      return () => connector.off("wallet:signOut", onSignOut);
    },
  };
}

// ---- The dev wallet ----------------------------------------------------------------------------

/**
 * The dev wallet's module, or null when this build has none. `process.env.NEXT_PUBLIC_NETWORK` is
 * spelled out in full, because Next puts the value in at build time only where it finds that
 * text, and then drops the branch that can't run. In a testnet or mainnet build the `import` is
 * in the dropped branch, so the module (and near-api-js, which only it uses) never reaches the
 * browser's code. `config.devWallet` is worked out when the page runs, and so can't do this alone.
 * test/source-rules.test.ts keeps this text and the module's own guard in place.
 */
export function loadDevWallet(): Promise<typeof import("./devWallet") | null> {
  return process.env.NEXT_PUBLIC_NETWORK !== "sandbox"
    ? Promise.resolve(null)
    : config.devWallet
      ? import("./devWallet")
      : Promise.resolve(null);
}

async function createProvider(): Promise<WalletProvider> {
  const dev = await loadDevWallet();
  if (dev !== null) return dev.createDevProvider();
  if (config.network === "sandbox") throw new WalletUnavailable();
  return connectorProvider(config.network);
}

/** The wallet of this page. */
export const walletStore: WalletStore = createWalletStore(createProvider, linkTabs);

/**
 * The wallet of `store`, for a client component. It starts looking for the wallet from an earlier
 * visit when the first component that uses it mounts; until `ready` is true, `accountId` being
 * null means nothing yet.
 */
/**
 * `start: false` reads the store without looking for a wallet: a page that only might need one (the
 * task page's question board, for a reader) loads no wallet library until someone presses Connect,
 * which starts the store, or until `start` turns true. A store that another page started stays
 * started.
 */
export interface UseWalletOptions {
  start?: boolean;
}

export function useWalletStore(
  store: WalletStore,
  { start = true }: UseWalletOptions = {},
): UseWallet {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  useEffect(() => {
    if (start) void store.start();
  }, [store, start]);
  return useMemo(
    () => ({
      ...state,
      connect: store.connect,
      disconnect: store.disconnect,
      signAndSend: store.signAndSend,
      signMessage: store.signMessage,
    }),
    [state, store],
  );
}

/** The connected wallet of this page, for a client component. */
export function useWallet(options?: UseWalletOptions): UseWallet {
  return useWalletStore(walletStore, options);
}

/** The account actions of `store`'s wallet. */
export function accountActionsOf(store: WalletStore): AccountActions {
  return {
    canSend: store.canSendAccountActions,
    send: store.sendAccountActions,
    sendBatch: store.sendMixed,
  };
}

/**
 * The account actions of this page's wallet. A component that uses them also calls `useWallet`,
 * which starts the store and renders again when the account changes.
 */
export function useAccountActions(): AccountActions {
  return accountActionsOf(walletStore);
}
