import type { Session, SigningWallet, TransactionRequest, WalletProvider } from "../lib/wallet";
import type { OpenTabLink } from "../lib/walletTabs";
import type { FakeChain } from "./fakeChain";

// Wallets for the tests: one that runs what it is sent on a `FakeChain`, a provider that hands a
// store the session a test chooses, and a line to the other tabs that a test holds both ends of.

/** What a wallet was asked to send, as it was asked. */
export interface SentBatch {
  transactions: TransactionRequest[];
  signerId?: string;
}

/** What a wallet was asked to sign. */
export interface SignRequest {
  message: string;
  recipient: string;
  nonce: Uint8Array;
  signerId?: string;
}

export interface ChainWallet extends SigningWallet {
  sent: SentBatch[];
  signRequests: SignRequest[];
}

/**
 * A wallet for `accountId` that runs every batch on `chain`, as a wallet does: in order, stopping at
 * the first transaction that fails, and gives back the outcomes. `signMessage: false` is a wallet
 * whose manifest says it can't sign a message; one that can signs with a fixed, made-up signature.
 */
export function chainWallet(
  chain: FakeChain,
  accountId: string,
  options: { signMessage?: boolean } = {},
): ChainWallet {
  const wallet: ChainWallet = {
    sent: [],
    signRequests: [],
    manifest: { features: { signMessage: options.signMessage ?? true } },
    async signAndSendTransactions(params) {
      wallet.sent.push(params);
      return chain.send(accountId, params.transactions);
    },
    async signMessage(params) {
      wallet.signRequests.push(params);
      return { accountId, publicKey: `ed25519:${"1".repeat(44)}`, signature: "c2lnbmF0dXJl" };
    },
  };
  return wallet;
}

export interface FakeProvider extends WalletProvider {
  connects: number;
  disconnects: number;
  /** Calls the listeners the store gave `subscribe`, as a wallet that signs out by itself does. */
  signOut(): void;
}

/**
 * A provider over `session`. `restored` is what it finds from an earlier visit (nothing by
 * default), and a connect gives `session`, or nothing if `connect` is null, as a closed dialog does.
 */
export function fakeProvider(
  session: Session,
  options: { restored?: boolean; connect?: "session" | "closed" | Error } = {},
): FakeProvider {
  const listeners = new Set<(next: Session | null) => void>();
  const provider: FakeProvider = {
    connects: 0,
    disconnects: 0,
    async restore() {
      return options.restored === true ? session : null;
    },
    async connect() {
      provider.connects++;
      if (options.connect instanceof Error) throw options.connect;
      return options.connect === "closed" ? null : session;
    },
    async disconnect() {
      provider.disconnects++;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    signOut() {
      for (const listener of listeners) listener(null);
    },
  };
  return provider;
}

export interface FakeTabs {
  /** What a store is given as its line to the other tabs. */
  open: OpenTabLink;
  /** How many lines the store opened, and how many times it told the other tabs. */
  opened: number;
  told: number;
  /** Plays another tab telling this one that its wallet session changed. */
  hear(): void;
}

/** A line to the other tabs that records what the store tells them, and can tell the store. */
export function fakeTabs(): FakeTabs {
  let changed: () => void = () => {};
  const tabs: FakeTabs = {
    opened: 0,
    told: 0,
    open(onChanged) {
      tabs.opened++;
      changed = onChanged;
      return {
        tell() {
          tabs.told++;
        },
        close() {},
      };
    },
    hear: () => changed(),
  };
  return tabs;
}
