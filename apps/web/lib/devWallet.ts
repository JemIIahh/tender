import { AccountIdSchema } from "@tender/shared";
import { Account, actions, JsonRpcProvider, KeyPairSigner, type KeyPairString } from "near-api-js";
import { toBase64 } from "./base64";
import { config } from "./config";
import type {
  Session,
  SignedMessageResult,
  SigningWallet,
  SignMessageInput,
  TransactionRequest,
  WalletProvider,
} from "./wallet";

// The dev wallet: a wallet that signs in the page with a key from the build's environment, for the
// sandbox, where there is no wallet to install and no one to approve each transaction. It has the
// interface of a near-connect wallet (`SigningWallet`), so the page sends through the same code as
// for a real one.
//
// Its key ships in the page, so it must exist in a sandbox build and nowhere else:
//
// - lib/wallet.ts imports this module only where `process.env.NEXT_PUBLIC_NETWORK !== "sandbox"`
//   is false, spelled out, so that Next drops the import from every other build.
// - The key and the account are read only under that same condition, spelled out again below, so
//   that a build for another network holds neither value even if this module were to be bundled.
//
// test/source-rules.test.ts holds both in place. The build for testnet is also searched, chunk by
// chunk, for the module and for the key (06-T3 report).

/** Where the sandbox build says the dev wallet signs as, and with what. Nothing outside the sandbox. */
function devEnv(): { account: string | undefined; key: string | undefined } {
  return process.env.NEXT_PUBLIC_NETWORK === "sandbox"
    ? {
        account: process.env.NEXT_PUBLIC_DEV_WALLET_ACCOUNT,
        key: process.env.NEXT_PUBLIC_DEV_WALLET_KEY,
      }
    : { account: undefined, key: undefined };
}

export interface DevWallet extends SigningWallet {
  accountId: string;
  signMessage(params: SignMessageInput & { signerId?: string }): Promise<SignedMessageResult>;
}

/** The `FunctionCall` of a connector action, as near-api-js builds one. */
function toNearAction(action: TransactionRequest["actions"][number]) {
  if (action.type !== "FunctionCall") {
    throw new Error(`the dev wallet sends function calls only, not ${String(action.type)}`);
  }
  const { methodName, args, gas, deposit } = action.params;
  return actions.functionCall(methodName, args, BigInt(gas), BigInt(deposit));
}

/** Whether a final outcome says the transaction failed. */
function failed(outcome: { status?: unknown }): boolean {
  return (
    typeof outcome.status === "object" && outcome.status !== null && "Failure" in outcome.status
  );
}

/**
 * The dev wallet. It throws in any build that is not for the sandbox, and if the account or the key
 * is missing or is not one. The messages name the variable and never quote its value.
 */
export function createDevWallet(): DevWallet {
  if (process.env.NEXT_PUBLIC_NETWORK !== "sandbox") {
    throw new Error("the dev wallet is for the sandbox only");
  }
  const { account: accountId, key } = devEnv();
  if (accountId === undefined || !AccountIdSchema.safeParse(accountId).success) {
    throw new Error("NEXT_PUBLIC_DEV_WALLET_ACCOUNT must be a NEAR account id");
  }
  if (key === undefined || !key.startsWith("ed25519:")) {
    throw new Error("NEXT_PUBLIC_DEV_WALLET_KEY must be a key written ed25519:<base58>");
  }

  const signer = KeyPairSigner.fromSecretKey(key as KeyPairString);
  const account = new Account(accountId, new JsonRpcProvider({ url: config.rpcUrl }), signer);

  return {
    accountId,
    manifest: { features: { signMessage: true } },

    // One transaction after the other, each final before the next is signed: a batch is in order,
    // as a wallet runs it, and a failed transaction ends it. (`Account.signAndSendTransactions`
    // sends them all at once.)
    async signAndSendTransactions({ transactions }) {
      const outcomes: unknown[] = [];
      for (const { receiverId, actions: wanted } of transactions) {
        const outcome = await account.signAndSendTransaction({
          receiverId,
          actions: wanted.map(toNearAction),
          waitUntil: "FINAL",
          // A failed transaction is an outcome with a `Failure`, which the caller words by its
          // error code, and not an exception.
          throwOnFailure: false,
        });
        outcomes.push(outcome);
        if (failed(outcome)) break;
      }
      return outcomes;
    },

    async signMessage({ message, recipient, nonce }) {
      const signed = await signer.signNep413Message(accountId, { message, recipient, nonce });
      return {
        accountId: signed.accountId,
        publicKey: signed.publicKey.toString(),
        signature: toBase64(signed.signature),
      };
    },
  };
}

/** Where the dev wallet remembers, for the tab, that it is connected. It holds no secret. */
const CONNECTED_KEY = "tender.devWallet.connected";

function connectedBefore(): boolean {
  try {
    return sessionStorage.getItem(CONNECTED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberConnected(connected: boolean): void {
  try {
    if (connected) sessionStorage.setItem(CONNECTED_KEY, "1");
    else sessionStorage.removeItem(CONNECTED_KEY);
  } catch {
    // The page works without it: a reload shows the Connect button again.
  }
}

/**
 * The dev wallet as a provider. It starts disconnected, so that Connect and Disconnect do what they
 * do with a real wallet; a tab that connected stays connected through a reload.
 */
export function createDevProvider(): WalletProvider {
  const wallet = createDevWallet();
  const session: Session = { wallet, accountId: wallet.accountId };
  return {
    restore: async () => (connectedBefore() ? session : null),
    connect: async () => {
      rememberConnected(true);
      return session;
    },
    disconnect: async () => {
      rememberConnected(false);
    },
    subscribe: () => () => {},
  };
}
