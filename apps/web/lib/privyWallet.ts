import { bytesToHex, hexToBytes } from "@tender/shared";
import { Account, actions, JsonRpcProvider, KeyType, PublicKey, Signer } from "near-api-js";
import { InvalidNonceError, TransactionExecutionError } from "near-api-js/rpc-errors";
import { toBase64 } from "./base64";
import { SendOutcomeUnknown } from "./sendOutcome";

// The wallet of an email or Google login (lib/privy.ts): near-api-js builds each transaction and
// each NEP-413 message, hashes it, and hands the hash to Privy to sign (`signRawHash`, chain type
// `near`); near-api-js then sends the signed transaction to the node. This is the signer of NEAR's
// own example (https://github.com/near-examples/hello-privy, src/context/signer.ts): the SDK does
// the serializing and hashing of transactions, delegate actions and NEP-413 messages the same way
// for every signer, and only `signBytes` is Privy's.
//
// It has the interface of a near-connect wallet (`SigningWallet`), and answers as one does, so the
// store (lib/wallet.ts) reads its results with the same code. It has no import of the page's
// config, so that a test runs it against a node of its own.
//
// The account is an implicit account: its id is the 64 hex characters of its ed25519 public key,
// so the key is read from the id and not asked of the chain, which has no such account until NEAR
// is sent to it.
//
// A transaction is signed once and never again by itself. Privy signs a raw hash with no window to
// approve it, so a second signature is a second transaction the person never saw: near-api-js's
// own retry (on InvalidNonce it takes a new nonce and signs again) is turned off (`retries: 0`),
// and a send that fails after the signature, in a way that leaves open whether the network took
// it, is `SendOutcomeUnknown`: the page says it may still go through, and to look before trying
// again. (The node client still resends the same signed bytes when a request fails; the network
// runs a transaction at most once, so that can't spend twice.)

/** Privy's signing of a raw hash, as its hook `useSignRawHash` gives it. */
export type SignRawHash = (input: {
  address: string;
  chainType: "near";
  hash: `0x${string}`;
}) => Promise<{ signature: `0x${string}` }>;

/** An ed25519 signature: 64 bytes, 128 hex characters, after the `0x`. */
const SIGNATURE = /^0x[0-9a-fA-F]{128}$/;

/** A near-api-js signer whose signatures are Privy's. */
export class PrivySigner extends Signer {
  private readonly key: PublicKey;
  /** How many signatures this signer has made: a send that fails after one may have gone out. */
  signatures = 0;

  constructor(
    private readonly signRawHash: SignRawHash,
    /** The wallet's address, as Privy spells it. */
    private readonly address: string,
    accountId: string,
  ) {
    super();
    if (!/^[0-9a-f]{64}$/.test(accountId)) {
      throw new TypeError("a Privy signer signs for an implicit account only");
    }
    this.key = new PublicKey({ keyType: KeyType.ED25519, data: hexToBytes(accountId) });
  }

  async getPublicKey(): Promise<PublicKey> {
    return this.key;
  }

  protected async signBytes(bytes: Uint8Array): Promise<Uint8Array> {
    const { signature } = await this.signRawHash({
      address: this.address,
      chainType: "near",
      hash: `0x${bytesToHex(bytes)}`,
    });
    if (typeof signature !== "string" || !SIGNATURE.test(signature)) {
      throw new Error("the login's signature is not an ed25519 signature");
    }
    const signed = hexToBytes(signature.slice(2).toLowerCase());
    // A signature by any other key would be refused by the node, or by the API, with words that
    // say less: it is checked here, where it is plain what went wrong.
    if (!this.key.verify(bytes, signed)) {
      throw new Error("the login signed with a key that is not this account's");
    }
    this.signatures++;
    return signed;
  }
}

/** One action of a connector's shape (near-connect 0.12.0), as near-api-js builds it. */
type ConnectorAction =
  | { type: "CreateAccount" }
  | { type: "Transfer"; params: { deposit: string } }
  | { type: "DeployContract"; params: { code: Uint8Array } }
  | {
      type: "FunctionCall";
      params: { methodName: string; args: object; gas: string; deposit: string };
    };

function toNearAction(action: ConnectorAction) {
  switch (action.type) {
    case "CreateAccount":
      return actions.createAccount();
    case "Transfer":
      return actions.transfer(BigInt(action.params.deposit));
    case "DeployContract":
      return actions.deployContract(action.params.code);
    case "FunctionCall": {
      const { methodName, args, gas, deposit } = action.params;
      return actions.functionCall(methodName, args, BigInt(gas), BigInt(deposit));
    }
    default:
      throw new Error(`this wallet does not send ${String((action as { type?: unknown }).type)}`);
  }
}

/**
 * Whether a send that threw after the transaction was signed may have been taken by the network.
 * Only the node's refusal of the transaction itself says it was not (an invalid transaction, which
 * is never run), with one exception: InvalidNonce, which a node also answers to a copy of a
 * transaction that already got in. Anything else, a dropped or timed-out request among it, leaves
 * it open.
 */
function mayHaveLanded(error: unknown): boolean {
  if (error instanceof InvalidNonceError) return true;
  return !(error instanceof TransactionExecutionError);
}

/** Whether a final outcome says the transaction failed. */
function failed(outcome: { status?: unknown }): boolean {
  return (
    typeof outcome.status === "object" && outcome.status !== null && "Failure" in outcome.status
  );
}

export interface PrivyWallet {
  manifest: { features: { signMessage: true; signAndSendTransactions: true } };
  signAndSendTransactions(params: {
    transactions: Array<{ receiverId: string; actions: readonly unknown[] }>;
    signerId?: string;
  }): Promise<unknown[]>;
  signMessage(params: {
    message: string;
    recipient: string;
    nonce: Uint8Array;
    signerId?: string;
  }): Promise<{ accountId: string; publicKey: string; signature: string }>;
}

/**
 * The wallet of the implicit account `accountId`, signing through `signRawHash` with the Privy
 * wallet at `address`, and sending through the node at `rpcUrl`.
 */
export function createPrivyWallet(plan: {
  accountId: string;
  address: string;
  signRawHash: SignRawHash;
  rpcUrl: string;
}): PrivyWallet {
  const signer = new PrivySigner(plan.signRawHash, plan.address, plan.accountId);
  const account = new Account(plan.accountId, new JsonRpcProvider({ url: plan.rpcUrl }), signer);

  return {
    manifest: { features: { signMessage: true, signAndSendTransactions: true } },

    // One transaction after the other, each final before the next is signed: a batch runs in
    // order, as a wallet runs it, and a failed transaction ends it, so the outcomes are those of
    // the transactions up to the first that failed.
    async signAndSendTransactions({ transactions }) {
      const outcomes: unknown[] = [];
      for (const { receiverId, actions: wanted } of transactions) {
        const signedBefore = signer.signatures;
        let outcome: Awaited<ReturnType<typeof account.signAndSendTransaction>>;
        try {
          outcome = await account.signAndSendTransaction({
            receiverId,
            actions: (wanted as ConnectorAction[]).map(toNearAction),
            waitUntil: "FINAL",
            // A failed transaction is an outcome with a `Failure`, which the store words by its
            // error code, and not an exception.
            throwOnFailure: false,
            // Never sign again by itself: see the head of this file.
            retries: 0,
          });
        } catch (error) {
          if (signer.signatures > signedBefore && mayHaveLanded(error)) {
            throw new SendOutcomeUnknown(error);
          }
          throw error;
        }
        outcomes.push(outcome);
        if (failed(outcome)) break;
      }
      return outcomes;
    },

    async signMessage({ message, recipient, nonce }) {
      const signed = await signer.signNep413Message(plan.accountId, { message, recipient, nonce });
      return {
        accountId: signed.accountId,
        publicKey: signed.publicKey.toString(),
        signature: toBase64(signed.signature),
      };
    },
  };
}
