import type { Page } from "@playwright/test";
import { type FakeChain, FakeNode, type WalletAction } from "../test/fakeChain";
import { RPC_URL } from "./fixtures";

// A wallet and a node for the specs of the wallet page, with no chain behind them but the model in
// test/fakeChain.ts (the one the unit tests use).
//
// The wallet is the kind a browser extension is: it announces itself on `window`
// (`near-wallet-injected`), and the page finds it through near-connect, the way it finds a real
// one. It runs what it is sent on the model, in this process, so a spec can look at what the
// model holds after the page has done something. The node answers the page's reads (JSON-RPC)
// from the same model. Nothing here reaches a network: the node's address is one that never
// resolves, and near-connect's manifest (which it fetches from GitHub) is answered with no wallets.

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

/**
 * Answers near-connect's request for the list of wallets it can open (it asks GitHub, then a CDN)
 * with an empty one, or with `wallets`, so that a page that uses the wallet reaches no server
 * outside the spec. The list a page needs, it is given in the browser (`installWallet`).
 */
export async function routeWalletManifest(page: Page, wallets: unknown[] = []): Promise<void> {
  await page.route("**/repository/manifest.json", (route) =>
    route.fulfill({ status: 200, headers: CORS, json: { wallets, version: "1.0.0" } }),
  );
}

/** A square icon of one colour, as a wallet's manifest gives an icon. */
const square = (colour: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${colour}"/><circle cx="16" cy="16" r="7" fill="#0a0a0b" opacity=".55"/></svg>`,
  )}`;

/**
 * Two made-up wallets in the shape of near-connect's list (sandboxed wallets, for testnet, that
 * send a batch): what the Connect window lists as rows. Their code is never loaded: no spec picks
 * them.
 */
export const LISTED_WALLETS = [
  ["ash-wallet", "Ash Wallet", "https://wallet.ash.test", "#d9c6a5"],
  ["birch-wallet", "Birch Wallet", "https://birch.test", "#9fb8a0"],
].map(([id, name, website, colour]) => ({
  id,
  name,
  icon: square(colour as string),
  description: "A made-up wallet for the specs.",
  website,
  version: "1.0.0",
  executor: `${website}/executor.js`,
  type: "sandbox",
  platform: {},
  permissions: {},
  features: { signMessage: true, signAndSendTransactions: true, testnet: true, mainnet: true },
}));

/** One batch the page sent to the wallet, as the wallet got it. */
export interface SentBatch {
  transactions: Array<{ receiverId: string; actions: WalletAction[] }>;
  signerId?: string;
}

export interface StubWallet {
  /** Every batch the page has sent to the wallet, in order. */
  sent: SentBatch[];
}

/** The name of the wallet in near-connect's list, and so on its row in the Connect window. */
export const STUB_WALLET_NAME = "E2E Wallet";

/**
 * Picks the specs' wallet in the Connect window (components/ConnectChooser.tsx): its row, which
 * connects it with no window of near-connect's. Before the one window, the specs picked it in
 * near-connect's own list.
 */
export async function pickStubWallet(page: Page): Promise<void> {
  await page.getByRole("dialog").getByRole("button", { name: STUB_WALLET_NAME }).click();
}

/**
 * Puts the wallet and the node in front of `page`: it will find a wallet for `account`, which runs
 * what it is sent on `chain` as `account`, and its reads of the chain are answered from `chain`.
 * `signMessage: false` is a wallet whose manifest says it can't sign a message.
 */
export async function installWallet(
  page: Page,
  chain: FakeChain,
  options: { account: string; signMessage?: boolean },
): Promise<StubWallet> {
  const stub: StubWallet = { sent: [] };
  const node = new FakeNode(chain);

  await page.route(`${RPC_URL}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const body = request.postDataJSON() as { id: unknown; method: string; params: unknown };
    await route.fulfill({
      status: 200,
      headers: CORS,
      json: { jsonrpc: "2.0", id: body.id, ...node.handle(body) },
    });
  });

  await routeWalletManifest(page);

  await page.exposeFunction("__tenderE2eSend", (batch: SentBatch) => {
    stub.sent.push(batch);
    return chain.send(options.account, batch.transactions);
  });

  await page.addInitScript(
    ({ account, name, signMessage }) => {
      const send = (batch: unknown) =>
        (
          window as unknown as Record<string, (batch: unknown) => Promise<unknown>>
        ).__tenderE2eSend?.(batch);
      const publicKey = `ed25519:${"1".repeat(44)}`;
      const wallet = {
        manifest: {
          id: "e2e-wallet",
          name,
          icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
          description: "A wallet for the specs.",
          website: "https://e2e-wallet.test",
          version: "1.0.0",
          executor: "",
          type: "injected",
          platform: {},
          permissions: {},
          features: { signMessage, signAndSendTransactions: true, testnet: true },
        },
        signIn: async () => [{ accountId: account, publicKey }],
        signOut: async () => {},
        getAccounts: async () => [{ accountId: account, publicKey }],
        signAndSendTransactions: (batch: unknown) => send(batch),
        signMessage: async () => {
          throw new Error("this wallet signs no messages in the specs");
        },
      };
      // near-connect listens from when the page first needs a wallet, and asks every wallet that
      // is already there to announce itself (`near-selector-ready`): both orders work.
      const announce = () =>
        window.dispatchEvent(new CustomEvent("near-wallet-injected", { detail: wallet }));
      window.addEventListener("near-selector-ready", announce);
      announce();
    },
    { account: options.account, name: STUB_WALLET_NAME, signMessage: options.signMessage ?? true },
  );

  return stub;
}
