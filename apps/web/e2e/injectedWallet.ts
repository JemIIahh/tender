import type { Page } from "@playwright/test";
import { type FakeChain, FakeNode } from "../test/fakeChain";
import { RPC_URL } from "./fixtures";
import { routeWalletManifest, type SentBatch, STUB_WALLET_NAME } from "./walletStub";

// The wallet of the specs that sign a message: the post wizard's (which signs in and sends the
// transactions that fund the vault and post the task) and the Telegram page's (which signs in and
// sends nothing). It is announced on `window` the way an extension is, so the page finds it
// through near-connect and the picker, the connection, the signature and the batch are the real
// ones. e2e/walletStub.ts has the wallet of the wallet page's specs, which signs nothing.
//
// What the transactions do is the model's (test/fakeChain.ts), when the wallet is given one; a
// wallet with no chain sends nothing, and throws if it is asked to. What the signature is signed
// with is made up: the fixture APIs (e2e/postApi.ts, e2e/agentsApi.ts) check that the page signed
// the challenge it was given, not a key, which the API's own tests check. 06-T1b's specs of the
// local chain use the dev wallet in the page instead (e2e/chain/).

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

const PUBLIC_KEY = `ed25519:${"1".repeat(44)}`;
const SIGNATURE = Buffer.alloc(64, 9).toString("base64");

/** One request to sign, as the wallet got it. `nonce` is the 32 bytes of the challenge's nonce. */
export interface SignRequest {
  message: string;
  recipient: string;
  nonce: number[];
  signerId?: string;
}

export interface InjectedWallet {
  /** Every batch the page has sent to the wallet, in order. */
  sent: SentBatch[];
  /** Every message the page has asked the wallet to sign, in order. */
  signed: SignRequest[];
}

/**
 * Puts a wallet for `account` in front of `page`. With `chain`, the wallet runs what it is sent on
 * `chain` as `account`, and a node answers the page's reads from `chain`; without, it sends
 * nothing. `signMessage: false` is a wallet whose manifest says it can't sign a message: the page
 * must not ask it to.
 */
export async function installInjectedWallet(
  page: Page,
  options: { account: string; chain?: FakeChain; signMessage?: boolean },
): Promise<InjectedWallet> {
  const { account, chain } = options;
  const wallet: InjectedWallet = { sent: [], signed: [] };

  if (chain !== undefined) {
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
  }

  await routeWalletManifest(page);

  await page.exposeFunction("__tenderE2eInjectedSend", (batch: SentBatch) => {
    if (chain === undefined) throw new Error("this wallet sends no transactions in the specs");
    wallet.sent.push(batch);
    return chain.send(account, batch.transactions);
  });
  await page.exposeFunction("__tenderE2eInjectedSign", (request: SignRequest) => {
    wallet.signed.push(request);
    return { accountId: account, publicKey: PUBLIC_KEY, signature: SIGNATURE };
  });

  await page.addInitScript(
    ({ account, name, signMessage, publicKey }) => {
      const call = (exposed: string, argument: unknown) =>
        (window as unknown as Record<string, (argument: unknown) => Promise<unknown>>)[exposed]?.(
          argument,
        );
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
          features: { signMessage, testnet: true },
        },
        signIn: async () => [{ accountId: account, publicKey }],
        signOut: async () => {},
        getAccounts: async () => [{ accountId: account, publicKey }],
        signAndSendTransactions: (batch: unknown) => call("__tenderE2eInjectedSend", batch),
        signMessage: (params: { message: string; recipient: string; nonce: Uint8Array }) =>
          call("__tenderE2eInjectedSign", {
            message: params.message,
            recipient: params.recipient,
            nonce: Array.from(params.nonce),
            signerId: (params as { signerId?: string }).signerId,
          }),
      };
      // near-connect listens from when the page first needs a wallet, and asks every wallet that
      // is already there to announce itself (`near-selector-ready`): both orders work.
      const announce = () =>
        window.dispatchEvent(new CustomEvent("near-wallet-injected", { detail: wallet }));
      window.addEventListener("near-selector-ready", announce);
      announce();
    },
    {
      account,
      name: STUB_WALLET_NAME,
      signMessage: options.signMessage ?? true,
      publicKey: PUBLIC_KEY,
    },
  );

  return wallet;
}
