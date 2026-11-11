import { createApp } from "@tender/api";
import { type LocalChain, receiptsFromTx, startLocalChain, TenderClient } from "@tender/client";
import { type Db, migrate, openDb } from "@tender/db";
import {
  bytesToHex,
  extractEvents,
  hexToBytes,
  implicitAccountActions,
  implicitAccountOf,
  SIGN_IN_MESSAGE,
  storageDepositCall,
  toConnectorAction,
} from "@tender/shared";
import { Account, actions, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createPrivyWallet, type SignRawHash } from "../apps/web/lib/privyWallet";

// The web app's wallet for the email and Google login (apps/web/lib/privyWallet.ts) on a real local
// chain. Privy itself can't run here, so its raw signing (`signRawHash`) is an ed25519 key made in
// this test, and the account is that key's implicit account, as a Privy NEAR wallet's is. The rest
// is the app's own code: near-api-js builds and hashes each transaction, the signer hands the hash
// to "Privy", and the transaction goes to the node. A real Tender call succeeds on chain, so does
// the "Add an agent" transfer that creates an implicit account, and the NEP-413 sign-in it signs is
// accepted by the Tender API itself (its routes, its verifier and its database), for that account.

const key = KeyPair.fromRandom("ed25519");
const ACCOUNT = bytesToHex(key.getPublicKey().data);
const ONE_NEAR = 10n ** 24n;
const SETUP_DEPOSIT = 50_000_000_000_000_000_000_000n;

/** Privy's raw signing, done with the key here: `0x` and the hash's hex in, the signature out. */
const signRawHash: SignRawHash = async ({ address, chainType, hash }) => {
  if (chainType !== "near" || address !== ACCOUNT) throw new Error("asked for another wallet");
  return { signature: `0x${bytesToHex(key.sign(hexToBytes(hash.slice(2))).signature)}` };
};

let chain: LocalChain;
let db: Db;
let reader: TenderClient;

beforeAll(async () => {
  chain = await startLocalChain();
  reader = new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
  });
  // The login's account is not on the chain until NEAR is sent to it, as the gas gift does.
  const { alice } = chain.accounts;
  const funder = new Account(
    alice.accountId,
    new JsonRpcProvider({ url: chain.rpcUrl }),
    KeyPairSigner.fromSecretKey(alice.privateKey as `ed25519:${string}`),
  );
  await funder.signAndSendTransaction({
    receiverId: ACCOUNT,
    actions: [actions.transfer(2n * ONE_NEAR)],
    waitUntil: "FINAL",
  });
  db = await openDb("pglite:memory");
  await migrate(db);
});

afterAll(async () => {
  await db?.close();
  await chain?.stop();
});

const wallet = () =>
  createPrivyWallet({ accountId: ACCOUNT, address: ACCOUNT, signRawHash, rpcUrl: chain.rpcUrl });

test("the_login_s_wallet_signs_and_sends_a_tender_call_that_succeeds_on_chain", async () => {
  const call = storageDepositCall(chain.contractId, SETUP_DEPOSIT);
  const outcomes = await wallet().signAndSendTransactions({
    transactions: [{ receiverId: call.receiverId, actions: [toConnectorAction(call)] }],
  });

  expect(outcomes).toHaveLength(1);
  const [outcome] = outcomes as Array<{
    status: unknown;
    transaction: { hash: string; signer_id: string };
    receipts_outcome: Parameters<typeof receiptsFromTx>[0]["receipts_outcome"];
  }>;
  expect(outcome?.status).toHaveProperty("SuccessValue");
  expect(outcome?.transaction.signer_id).toBe(ACCOUNT);
  // The event the web app reads from what a wallet gives back, from a receipt that succeeded.
  const events = extractEvents(receiptsFromTx(outcome as never), chain.contractId);
  expect(events.map((event) => event.event)).toEqual(["storage_deposit"]);
  // And the chain says so.
  expect(await reader.storageBalanceOf(ACCOUNT)).not.toBeNull();
}, 120_000);

test("the_login_s_wallet_creates_an_agent_s_implicit_account_with_a_transfer", async () => {
  const agentKey = KeyPair.fromRandom("ed25519").getPublicKey().toString();
  const agent = implicitAccountOf(agentKey) as string;
  const [outcome] = (await wallet().signAndSendTransactions({
    transactions: [{ receiverId: agent, actions: implicitAccountActions() }],
  })) as Array<{ status: unknown }>;
  expect(outcome?.status).toHaveProperty("SuccessValue");
  // The chain made the account with the agent's key as its one full-access key.
  expect(await reader.viewAccessKey(agent, agentKey)).toEqual(
    expect.objectContaining({ permission: "FullAccess" }),
  );
}, 120_000);

test("the_login_s_nep413_sign_in_is_accepted_by_the_tender_api_for_that_account", async () => {
  const app = createApp({
    db,
    client: reader,
    network: "sandbox",
    contractId: chain.contractId,
    publicUrl: "http://api.test",
    teamAccounts: [],
    webOrigins: [],
  });
  const challenge = (await (
    await app.request("/v1/auth/challenge", { method: "POST" })
  ).json()) as {
    nonce: string;
    message: string;
    recipient: string;
  };
  expect(challenge.message).toBe(SIGN_IN_MESSAGE);

  const signed = await wallet().signMessage({
    message: challenge.message,
    recipient: challenge.recipient,
    nonce: Uint8Array.from(atob(challenge.nonce), (char) => char.charCodeAt(0)),
  });
  expect(signed.accountId).toBe(ACCOUNT);
  expect(signed.publicKey).toBe(key.getPublicKey().toString());

  const verified = await app.request("/v1/auth/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      account_id: signed.accountId,
      public_key: signed.publicKey,
      signature: signed.signature,
      nonce: challenge.nonce,
      message: challenge.message,
      recipient: challenge.recipient,
    }),
  });
  expect(verified.status).toBe(200);
  const body = (await verified.json()) as { token?: unknown; account_id?: unknown };
  expect(typeof body.token).toBe("string");
}, 120_000);
