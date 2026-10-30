import type { Page } from "@playwright/test";
import { routeWalletManifest, STUB_WALLET_NAME } from "./walletStub";

// A wallet for the pages that ask for a signature and send no transaction (the Telegram page). It
// is announced on `window` the way an extension is (see e2e/walletStub.ts, whose wallet sends
// transactions and signs nothing), so the page finds it through near-connect and the picker, the
// connection and the call to `signMessage` are the real ones. What it signs with is made up: the
// fixture API (e2e/agentsApi.ts) checks that the page signed the challenge it was given, and not a
// key, which is checked in the API's own tests.

const PUBLIC_KEY = `ed25519:${"1".repeat(44)}`;
const SIGNATURE = Buffer.alloc(64, 9).toString("base64");

/** One request to sign, as the wallet got it. `nonce` is the 32 bytes of the challenge's nonce. */
export interface SignRequest {
  message: string;
  recipient: string;
  nonce: number[];
  signerId?: string;
}

export interface SigningWallet {
  /** Every message the page has asked the wallet to sign, in order. */
  signed: SignRequest[];
}

/**
 * Puts a wallet for `account` in front of `page`. `signMessage: false` is a wallet whose manifest
 * says it can't sign a message: the page must not ask it to.
 */
export async function installSigningWallet(
  page: Page,
  options: { account: string; signMessage?: boolean },
): Promise<SigningWallet> {
  const wallet: SigningWallet = { signed: [] };

  await routeWalletManifest(page);
  await page.exposeFunction("__tenderE2eSign", (request: SignRequest) => {
    wallet.signed.push(request);
    return { accountId: options.account, publicKey: PUBLIC_KEY, signature: SIGNATURE };
  });

  await page.addInitScript(
    ({ account, name, signMessage, publicKey }) => {
      const sign = (request: unknown) =>
        (
          window as unknown as Record<string, (request: unknown) => Promise<unknown>>
        ).__tenderE2eSign?.(request);
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
        signAndSendTransactions: async () => {
          throw new Error("this wallet sends no transactions in the specs");
        },
        signMessage: (params: { message: string; recipient: string; nonce: Uint8Array }) =>
          sign({
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
      account: options.account,
      name: STUB_WALLET_NAME,
      signMessage: options.signMessage ?? true,
      publicKey: PUBLIC_KEY,
    },
  );

  return wallet;
}
