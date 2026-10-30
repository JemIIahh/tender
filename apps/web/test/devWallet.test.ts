import { verifyNep413 } from "@tender/client";
import { depositCall, tokenStorageDepositCall, withdrawCall } from "@tender/shared";
import { KeyPair } from "near-api-js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createDevProvider, createDevWallet } from "../lib/devWallet";
import { createWalletStore, groupCalls } from "../lib/wallet";
import { TransactionFailed } from "../lib/walletErrors";
import { FakeChain, FakeNode, fakeFetch } from "./fakeChain";
import { rejection } from "./support";

// The dev wallet (lib/devWallet.ts) signing for real: its transactions are signed with near-api-js,
// sent as a JSON-RPC node receives them, decoded there and run on a model of the contract. The
// signature of a message is checked by the verifier the API uses.

const CONTRACT = "tender.testnet";
const TOKEN = "tusdc.testnet";
const DEV = "dev.sandbox";

const keys = KeyPair.fromRandom("ed25519");
const SECRET = keys.toString();
const PUBLIC = keys.getPublicKey().toString();

let chain: FakeChain;
let node: FakeNode;

beforeEach(() => {
  chain = new FakeChain(CONTRACT, [{ token: TOKEN }]);
  node = new FakeNode(chain, { account: DEV, publicKey: PUBLIC });
  // The page is built for the sandbox: the dev wallet reads these as it is made.
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "sandbox");
  vi.stubEnv("NEXT_PUBLIC_DEV_WALLET_ACCOUNT", DEV);
  vi.stubEnv("NEXT_PUBLIC_DEV_WALLET_KEY", SECRET);
  vi.stubGlobal("fetch", fakeFetch("http://rpc.test", node));
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("the_dev_wallet_signs_a_batch_with_its_key_and_sends_it_transaction_by_transaction", async () => {
  chain.fundVault(DEV, TOKEN, 100n);
  chain.give(TOKEN, DEV, 50n);
  const wallet = createDevWallet();
  const calls = [depositCall(TOKEN, CONTRACT, 10n), withdrawCall(CONTRACT, TOKEN, 5n)];

  const outcomes = await wallet.signAndSendTransactions({ transactions: groupCalls(calls) });

  expect(wallet.accountId).toBe(DEV);
  expect(wallet.manifest?.features?.signMessage).toBe(true);
  expect(outcomes).toHaveLength(2);
  // What the node received is what the calls say, signed by the key as the dev account.
  expect(node.received).toHaveLength(2);
  const [deposit, withdraw] = node.received;
  expect(deposit).toMatchObject({ signerId: DEV, publicKey: PUBLIC, receiverId: TOKEN });
  expect(deposit?.actions).toEqual([
    {
      methodName: "ft_transfer_call",
      args: { receiver_id: CONTRACT, amount: "10", msg: "" },
      gas: calls[0]?.gas,
      deposit: 1n,
    },
  ]);
  expect(withdraw).toMatchObject({ signerId: DEV, publicKey: PUBLIC, receiverId: CONTRACT });
  expect(withdraw?.actions[0]).toMatchObject({ methodName: "withdraw", gas: calls[1]?.gas });
  // One after the other: the second was signed after the first was final.
  expect((withdraw?.nonce ?? 0n) > (deposit?.nonce ?? 0n)).toBe(true);
});

test("the_dev_wallet_stops_a_batch_at_the_transaction_that_failed", async () => {
  chain.fundVault(DEV, TOKEN, 1n);
  chain.give(TOKEN, DEV, 0n);
  const store = createWalletStore(async () => createDevProvider());
  await store.connect();

  const failure = await rejection(
    store.signAndSend([withdrawCall(CONTRACT, TOKEN, 5n), tokenStorageDepositCall(TOKEN, DEV)]),
  );

  // The failure is the answer, with the contract's code. The second transaction was never sent.
  expect(failure).toBeInstanceOf(TransactionFailed);
  expect((failure as TransactionFailed).code).toBe("E_FUNDS");
  expect(node.received).toHaveLength(1);
});

test("the_dev_wallet_through_the_store_reads_the_events_of_what_it_sent", async () => {
  chain.fundVault(DEV, TOKEN, 100n);
  chain.give(TOKEN, DEV, 50n);
  const store = createWalletStore(async () => createDevProvider());
  await store.connect();

  const result = await store.signAndSend([
    depositCall(TOKEN, CONTRACT, 10n),
    withdrawCall(CONTRACT, TOKEN, 5n),
  ]);

  expect(store.getSnapshot()).toEqual({ ready: true, accountId: DEV, canSignMessage: true });
  expect(result.events.map((event) => event.event)).toEqual(["deposit", "withdraw"]);
  expect(result.txHashes).toHaveLength(2);
});

test("a_dev_wallet_signature_is_one_the_apis_verifier_accepts", async () => {
  const wallet = createDevWallet();
  const nonce = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
  const nonceText = btoa(String.fromCharCode(...nonce));

  const signed = await wallet.signMessage({
    message: "Sign in to Tender",
    recipient: "http://api.test",
    nonce,
  });

  expect(signed).toMatchObject({ accountId: DEV, publicKey: PUBLIC });
  const verified = await verifyNep413(
    {
      accountId: signed.accountId,
      publicKey: signed.publicKey,
      signature: signed.signature,
      message: "Sign in to Tender",
      nonce: nonceText,
      recipient: "http://api.test",
    },
    {
      viewAccessKey: async () => ({ permission: "FullAccess" }),
      contractId: CONTRACT,
      expectedRecipient: "http://api.test",
    },
  );
  expect(verified).toEqual({ accountId: DEV, publicKey: PUBLIC, keyKind: "full_access" });
});

test("the_dev_wallet_starts_disconnected_and_a_tab_that_connected_stays_connected", async () => {
  const first = createDevProvider();
  expect(await first.restore()).toBeNull();

  const session = await first.connect();
  expect(session?.accountId).toBe(DEV);
  // A reload makes the provider again; the tab remembers (sessionStorage, which holds no secret).
  expect((await createDevProvider().restore())?.accountId).toBe(DEV);
  expect(sessionStorage.length).toBe(1);
  expect(JSON.stringify({ ...sessionStorage })).not.toContain(SECRET);

  if (session === null) throw new Error("no session");
  await first.disconnect(session);
  expect(await createDevProvider().restore()).toBeNull();
  // A tab whose storage is blocked still connects; it just forgets on reload.
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect((await createDevProvider().connect())?.accountId).toBe(DEV);
  expect(await createDevProvider().restore()).toBeNull();
});

test("the_dev_wallet_is_not_made_without_an_account_and_a_key_and_never_says_the_key", () => {
  const messages = new Set<string>();
  const attempt = () => {
    try {
      createDevWallet();
    } catch (error) {
      messages.add((error as Error).message);
      return;
    }
    throw new Error("expected createDevWallet to throw");
  };

  vi.stubEnv("NEXT_PUBLIC_DEV_WALLET_ACCOUNT", "");
  attempt();
  vi.stubEnv("NEXT_PUBLIC_DEV_WALLET_ACCOUNT", "Not An Account");
  attempt();
  vi.stubEnv("NEXT_PUBLIC_DEV_WALLET_ACCOUNT", DEV);
  vi.stubEnv("NEXT_PUBLIC_DEV_WALLET_KEY", "");
  attempt();
  vi.stubEnv("NEXT_PUBLIC_DEV_WALLET_KEY", "secp256k1:whatever");
  attempt();

  expect([...messages].sort()).toEqual([
    "NEXT_PUBLIC_DEV_WALLET_ACCOUNT must be a NEAR account id",
    "NEXT_PUBLIC_DEV_WALLET_KEY must be a key written ed25519:<base58>",
  ]);
});
