import { serializeNep413, verifyNep413 } from "@tender/client";
import {
  bytesToHex,
  depositCall,
  hexToBytes,
  SIGN_IN_MESSAGE,
  sha256Hex,
  withdrawCall,
} from "@tender/shared";
import { KeyPair, KeyType, PublicKey } from "near-api-js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createPrivyWallet, type SignRawHash } from "../lib/privyWallet";
import { createWalletStore } from "../lib/wallet";
import { TransactionFailed } from "../lib/walletErrors";
import { FakeChain, FakeNode, fakeFetch } from "./fakeChain";
import { rejection } from "./support";
import { fakeProvider } from "./walletDoubles";

// The login's wallet (lib/privyWallet.ts) signing for real, with Privy's `signRawHash` replaced by
// an ed25519 key made here: near-api-js builds and hashes each transaction, the "Privy" here signs
// the hash, and a JSON-RPC node decodes what it is sent and runs it on a model of the contract. A
// message's signature is checked with the verifier the API uses. test/privy-wallet.sandbox.test.ts
// (in scripts/) does the same against a real local chain and the real API.

const CONTRACT = "tender.testnet";
const TOKEN = "tusdc.testnet";

const keys = KeyPair.fromRandom("ed25519");
const PUBLIC = keys.getPublicKey().toString();
/** The implicit account of the key: what Privy's NEAR wallet's address is. */
const ACCOUNT = bytesToHex(keys.getPublicKey().data);

/** Privy's raw signing, as the key here does it: the hash in, `0x` and the signature's hex out. */
function localSigner(key = keys) {
  const hashes: string[] = [];
  const sign: SignRawHash = async ({ address, chainType, hash }) => {
    expect(chainType).toBe("near");
    expect(address).toBe(ACCOUNT);
    hashes.push(hash);
    return { signature: `0x${bytesToHex(key.sign(hexToBytes(hash.slice(2))).signature)}` };
  };
  return { sign, hashes };
}

let chain: FakeChain;
let node: FakeNode;

beforeEach(() => {
  chain = new FakeChain(CONTRACT, [{ token: TOKEN }]);
  node = new FakeNode(chain, { account: ACCOUNT, publicKey: PUBLIC });
  vi.stubGlobal("fetch", fakeFetch("http://rpc.test", node));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const walletOf = (sign: SignRawHash) =>
  createPrivyWallet({
    accountId: ACCOUNT,
    address: ACCOUNT,
    signRawHash: sign,
    rpcUrl: "http://rpc.test",
  });

test("the_key_is_read_from_the_implicit_account_and_is_the_one_privy_signs_with", () => {
  const key = new PublicKey({ keyType: KeyType.ED25519, data: hexToBytes(ACCOUNT) });
  expect(key.toString()).toBe(PUBLIC);
});

test("a_batch_is_built_hashed_signed_by_the_login_and_sent_as_the_account", async () => {
  chain.fundVault(ACCOUNT, TOKEN, 100n);
  chain.give(TOKEN, ACCOUNT, 50n);
  const { sign, hashes } = localSigner();
  const store = createWalletStore(async () =>
    fakeProvider({ wallet: walletOf(sign), accountId: ACCOUNT }, { connect: "session" }),
  );
  await store.connect();

  const result = await store.signAndSend([
    depositCall(TOKEN, CONTRACT, 10n),
    withdrawCall(CONTRACT, TOKEN, 5n),
  ]);

  // Read back by the store as any wallet's answer is: the events, and a hash for each transaction.
  expect(result.events.map((event) => event.event)).toEqual(["deposit", "withdraw"]);
  expect(result.txHashes).toHaveLength(2);
  // Two transactions, each hashed and signed once, as the account with its own key.
  expect(hashes).toHaveLength(2);
  expect(node.received.map((tx) => [tx.signerId, tx.publicKey, tx.receiverId])).toEqual([
    [ACCOUNT, PUBLIC, TOKEN],
    [ACCOUNT, PUBLIC, CONTRACT],
  ]);
});

test("a_batch_stops_at_the_transaction_that_failed", async () => {
  chain.fundVault(ACCOUNT, TOKEN, 1n);
  const { sign } = localSigner();
  const store = createWalletStore(async () =>
    fakeProvider({ wallet: walletOf(sign), accountId: ACCOUNT }, { connect: "session" }),
  );
  await store.connect();
  const failure = await rejection(
    store.signAndSend([withdrawCall(CONTRACT, TOKEN, 5n), depositCall(TOKEN, CONTRACT, 1n)]),
  );
  expect(failure).toBeInstanceOf(TransactionFailed);
  expect((failure as TransactionFailed).code).toBe("E_FUNDS");
  expect(node.received).toHaveLength(1);
});

test("a_message_is_the_nep413_hash_tender_computes_and_passes_the_api_s_verifier", async () => {
  const { sign, hashes } = localSigner();
  const nonce = Uint8Array.from({ length: 32 }, (_, i) => i * 3);
  const nonceText = btoa(String.fromCharCode(...nonce));
  const recipient = "http://api.test";

  const signed = await walletOf(sign).signMessage({ message: SIGN_IN_MESSAGE, recipient, nonce });

  expect(signed).toMatchObject({ accountId: ACCOUNT, publicKey: PUBLIC });
  // What Privy was asked to sign is the SHA-256 of `@tender/client`'s NEP-413 bytes.
  expect(hashes).toEqual([
    `0x${sha256Hex(serializeNep413({ message: SIGN_IN_MESSAGE, nonce: nonceText, recipient }))}`,
  ]);
  const verified = await verifyNep413(
    { ...signed, message: SIGN_IN_MESSAGE, nonce: nonceText, recipient },
    {
      viewAccessKey: async (account, key) =>
        account === ACCOUNT && key === PUBLIC ? { permission: "FullAccess" } : null,
      contractId: CONTRACT,
      expectedRecipient: recipient,
    },
  );
  expect(verified).toEqual({ accountId: ACCOUNT, publicKey: PUBLIC, keyKind: "full_access" });
});

test("a_signature_by_another_key_or_of_another_shape_is_refused_before_anything_is_sent", async () => {
  const other = localSigner(KeyPair.fromRandom("ed25519"));
  await expect(
    walletOf(other.sign).signMessage({
      message: SIGN_IN_MESSAGE,
      recipient: "http://api.test",
      nonce: new Uint8Array(32),
    }),
  ).rejects.toThrow(/not this account's/);

  const short: SignRawHash = async () => ({ signature: "0x1234" });
  await expect(
    walletOf(short).signAndSendTransactions({
      transactions: [
        { receiverId: CONTRACT, actions: [{ type: "Transfer", params: { deposit: "1" } }] },
      ],
    }),
  ).rejects.toThrow(/not an ed25519 signature/);
  expect(node.received).toEqual([]);
});

test("a_signer_is_for_an_implicit_account_only", () => {
  const { sign } = localSigner();
  expect(() =>
    createPrivyWallet({
      accountId: "alice.testnet",
      address: "x",
      signRawHash: sign,
      rpcUrl: "http://rpc.test",
    }),
  ).toThrow(/implicit account/);
});
