import {
  type AgentView,
  AgentViewSchema,
  addDelegateCall,
  type ConfigView,
  ConfigViewSchema,
  claimAgentBondCall,
  cleanupCall,
  commitCall,
  depositCall,
  type EntryView,
  EntryViewSchema,
  extractEvents,
  FULL_ACCESS_ONLY_METHODS,
  NETWORKS,
  type NetworkId,
  type PostTaskInput,
  pickCall,
  postTaskCall,
  type ReceiptOutcome,
  registerAgentCall,
  removeDelegateCall,
  revealCall,
  type SpendOptions,
  type StorageView,
  StorageViewSchema,
  setAgentBondCall,
  setAgentBondCooldownCall,
  storageDepositCall,
  type TaskView,
  TaskViewSchema,
  type TenderCall,
  topUpTaskCall,
  U64StringSchema,
  U128StringSchema,
  unregisterAgentCall,
  voidTaskCall,
  withdrawCall,
} from "@tender/shared";
import {
  Account,
  actions,
  baseEncode,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  type KeyPairString,
  type Transaction,
} from "near-api-js";
import {
  AccessKeyDoesNotExistError,
  AccountDoesNotExistError,
  TransactionTimeoutError,
  UnknownTransactionError,
} from "near-api-js/rpc-errors";
import {
  DEFAULT_RPC_TIMEOUT_MS,
  DEFAULT_SEND_TIMEOUT_MS,
  timeoutOption,
  withDeadline,
} from "./deadline";
import { errorCodeOf, TenderError } from "./errors";
import type { KeyPermission } from "./nep413";
import { receiptsFromTx, type TxReceiptsOutcome } from "./outcome";
import { defaultQueue } from "./queue";

// Re-exported from near-api-js so that a package that only has to read a key (the agents' command
// takes the public half of a private key) need not depend on near-api-js for that.
export { KeyPair, type KeyPairString } from "near-api-js";

/** An account and its private key, as near-api-js writes keys: `ed25519:<base58>`. */
export interface Signer {
  accountId: string;
  privateKey: string;
}

/** What a transaction did, once it is final and succeeded. */
export interface TxResult {
  txHash: string;
  /**
   * The Tender events of the receipts that ran on the Tender contract and succeeded, in order. Each
   * carries its receipt's id and its line's index in that receipt's logs: the pair is unique, so a
   * consumer that is handed one event twice can tell.
   */
  events: ReturnType<typeof extractEvents>;
  /** What the call returned, decoded from JSON. `undefined` when it returned nothing. */
  returnValue: unknown;
  /** Every receipt of the transaction, the failed ones included. */
  receipts: ReceiptOutcome[];
}

/** The part of a final transaction outcome that `toTxResult` reads. */
export interface FinalTxOutcome extends TxReceiptsOutcome {
  status: unknown;
  transaction: { hash: string };
}

/**
 * A transaction as it was signed, before it is sent: what a caller needs to ask the chain about it
 * later (`TenderClient.txStatus`), and to know until when it can still be included.
 */
export interface SignedTx {
  /** The transaction's hash, base58: the hash that `TxResult.txHash` has once it is final. */
  txHash: string;
  signerId: string;
  /** The key it is signed with, `ed25519:<base58>`. */
  publicKey: string;
  nonce: bigint;
  /**
   * The block the transaction names as its reference, base58, and its height. The chain includes
   * the transaction only while that block is less than `transaction_validity_period` blocks behind
   * the head (86,400 on mainnet and testnet, about a day), and not at all once the key's nonce is
   * past the transaction's.
   */
  blockHash: string;
  blockHeight: bigint;
}

/** Things a caller can hook into a send. */
export interface SendHooks {
  /**
   * Called, and waited for, with each transaction once it is signed and before it is sent. If it
   * throws, nothing is sent and the send fails with what it threw, so a caller that writes the hash
   * down here has written it down before the transaction can be anywhere. A transaction that loses
   * its nonce (`InvalidNonceError`: the node refuses it, and it can never be included) is signed
   * again, and the hook hears of the new one.
   */
  beforeSend?: (tx: SignedTx) => Promise<void>;
}

/**
 * What the chain says of a transaction, by its hash (`TenderClient.txStatus`):
 *
 * - `unknown`: the node has no record of it. It was never sent, or has not reached the node yet,
 *   or is gone from the node's memory (a node keeps a few days). It is NOT a sign that the
 *   transaction cannot land.
 * - `pending`: the node has it, and it is not final.
 * - `executed`: final, and it succeeded.
 * - `failed`: final, and it failed. Nothing it did is kept; `error` has the code the contract gave.
 */
export type TxStatus =
  | { kind: "unknown" }
  | { kind: "pending" }
  | { kind: "executed"; result: TxResult }
  | { kind: "failed"; error: TenderError };

/** A signer that tells `report` of each transaction it signs, before the transaction is returned. */
class ReportingSigner extends KeyPairSigner {
  constructor(
    key: KeyPair,
    private readonly report: (signed: {
      txHash: Uint8Array;
      transaction: Transaction;
    }) => Promise<void>,
  ) {
    super(key);
  }

  override async signTransaction(transaction: Transaction) {
    const signed = await super.signTransaction(transaction);
    await this.report({ txHash: signed.txHash, transaction: signed.signedTransaction.transaction });
    return signed;
  }
}

/** NEP-145's storage balance, as a token's `storage_balance_of` returns it, in yoctoNEAR. */
export interface FtStorageBalance {
  total: string;
  available: string;
}

/** The largest page of the contract's list views: `MAX_PAGE` in contract/tender/src/types.rs. */
const MAX_PAGE = 50;

/** Every read is of the last final block; see `TenderClient`. */
const FINALITY = "final";

/**
 * What the `E_TIMEOUT` of a send says after the call and the time. The client stopped waiting, and
 * did not see the transaction fail. The message is read by people and by agents, so it says what
 * is left open and what to do about it, in plain words.
 */
const SEND_MAY_STILL_LAND =
  "The transaction may still land. Read the chain before sending it again.";

const TaskOrNull = TaskViewSchema.nullable();
const Tasks = TaskViewSchema.array();
const EntryOrNull = EntryViewSchema.nullable();
const Entries = EntryViewSchema.array();
const AgentOrNull = AgentViewSchema.nullable();
const StorageOrNull = StorageViewSchema.nullable();
const FtStorageOrNull = StorageViewSchema.pick({ total: true, available: true }).nullable();

/** The one own key of an enum value as the RPC writes it, such as `{ SuccessValue: "" }`. */
function variantOf(value: unknown): [string, unknown] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  return entries.length === 1 ? (entries[0] ?? null) : null;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** A failure's text: the panic message of a failed function call, or else the failure as JSON. */
function failureMessage(failure: unknown): string {
  const kind = field(field(failure, "ActionError"), "kind");
  const panic = field(field(kind, "FunctionCallError"), "ExecutionError");
  return typeof panic === "string" ? panic : (JSON.stringify(failure) ?? String(failure));
}

/** The error of a transaction that failed on chain: the contract's code, if it gave one. */
function failedWith(txHash: string, failure: unknown): TenderError {
  const message = failureMessage(failure);
  return new TenderError(errorCodeOf(message), message, { txHash, cause: failure });
}

/** A `SuccessValue`: base64 of what the call returned, JSON for this contract and NEP-141. */
function decodeReturnValue(base64: string): unknown {
  const text = Buffer.from(base64, "base64").toString("utf8");
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * What a final transaction outcome means for a client of `contractId`, as `send` reports it. A
 * final status of `SuccessValue` gives the transaction's Tender events (`extractEvents`), its
 * receipts and the decoded return value. A `Failure` throws a `TenderError` whose code
 * `errorCodeOf` takes from the failure's text. Any other status throws a `TenderError` with code
 * `E_UNKNOWN`: the transaction has not finished, or the RPC sent a shape it is not documented to.
 *
 * A receipt that fails on the side does not fail the transaction. A withdrawal to an account the
 * token has not registered succeeds, with a failed `ft_transfer` receipt and a `withdraw_failed`
 * event.
 */
export function toTxResult(resp: FinalTxOutcome, contractId: string): TxResult {
  const txHash = resp.transaction.hash;
  const receipts = receiptsFromTx(resp);
  const variant = variantOf(resp.status);
  if (variant?.[0] === "SuccessValue" && typeof variant[1] === "string") {
    return {
      txHash,
      events: extractEvents(receipts, contractId),
      returnValue: decodeReturnValue(variant[1]),
      receipts,
    };
  }
  if (variant?.[0] === "Failure") throw failedWith(txHash, variant[1]);
  throw new TenderError(
    "E_UNKNOWN",
    `transaction ${txHash} has no final outcome; its status is ${JSON.stringify(resp.status)}`,
    { txHash, cause: resp.status },
  );
}

/**
 * Reads Tender's state and sends its transactions on one network, through near-api-js.
 *
 * Reads are of the last final block, which trails the newest by about two blocks: what a view
 * returns cannot be undone. Views are checked against the schemas of `@tender/shared` and throw if
 * the contract answers in another shape; a view that finds nothing, such as a missing task,
 * returns null. A u64 or u128 field stays a decimal string, and the methods that return a single
 * amount or count return a bigint.
 *
 * Sending needs a `signer`. `send` waits until the transaction and all of its receipts are final,
 * so a view made after it sees what it did. A failure on chain throws a `TenderError`; an error
 * before the transaction ran, from the RPC or from near-api-js, is thrown as near-api-js throws
 * it.
 *
 * Every call to the node has a time limit, so that a node that takes a request and never answers
 * cannot hold a caller for ever. A read (a view, a key, a block) has `rpcTimeoutMs`, 30 s unless it
 * is set. A send has `sendTimeoutMs`, 120 s, for all it does: the nonce and the block it reads, the
 * transaction, and the wait for its final outcome. near-api-js's own retries of a failing node are
 * inside the time, not on top of it. A call that runs out of time is cancelled, its request and its
 * connection with it, and throws a `TenderError` with code `E_TIMEOUT`, whose message names the
 * call and the time and says nothing of the node (no URL, no key). The message of a send goes on to
 * say that the transaction may still land, and to read the chain before sending it again. The time
 * of a send starts when the send does, once it has had its turn in the queue below.
 *
 * A send that timed out may still have landed. The client stopped waiting for the answer: the node
 * may have had the transaction by then, and it can run, with its events, after the `E_TIMEOUT`. So
 * an `E_TIMEOUT` from a send is not "it failed". Read the state before sending the same thing again
 * (`getEntry` after a `commit`, `getTask` after a `pick` or a `void_task`), and send nothing that
 * would be wrong done twice. A view that timed out changed nothing.
 *
 * Every send waits its turn in `defaultQueue`, keyed by the signer's account. The transactions of
 * one account, from all its clients in this process, go one at a time in the order they were sent,
 * so they never race for a nonce; those of different accounts go at the same time. A transaction
 * that still loses its nonce (`InvalidNonceError`) is retried by near-api-js with the chain's
 * nonce, up to 10 times, and then once more by the queue after 500 ms. That happens when another
 * process signs with the same key, which nothing coordinates, and when another client of the
 * account has sent since this one last did, since each client keeps its own count of the nonce.
 */
export class TenderClient {
  readonly network: NetworkId;
  readonly contractId: string;
  readonly rpcUrl: string;
  /** How long a read of the node may take, in milliseconds. */
  readonly rpcTimeoutMs: number;
  /** How long a send may take, in milliseconds. */
  readonly sendTimeoutMs: number;
  /** The signer's account, when the client has one. */
  readonly accountId?: string;
  /** The public half of the signer's key, in `ed25519:<base58>` form, when the client has one. */
  readonly publicKey?: string;
  private readonly provider: JsonRpcProvider;
  private readonly account?: Account;
  private readonly key?: KeyPair;

  /**
   * `rpcUrl` defaults to the network's. The sandbox has none, because a local node picks its port
   * when it starts, so a client of a local chain passes `LocalChain.rpcUrl`.
   *
   * `rpcTimeoutMs` (default 30000) is how long a read of the node may take, and `sendTimeoutMs`
   * (default 120000) how long a send may take; see the class. Each is a whole number of
   * milliseconds from 1 to 2147483647, or the constructor throws a `RangeError` that names it.
   */
  constructor(opts: {
    network: NetworkId;
    contractId: string;
    rpcUrl?: string;
    signer?: Signer;
    rpcTimeoutMs?: number;
    sendTimeoutMs?: number;
  }) {
    const rpcUrl = opts.rpcUrl ?? NETWORKS[opts.network].rpcUrl;
    if (rpcUrl === "") {
      throw new Error(
        `no RPC URL for network ${opts.network}: pass rpcUrl (a local chain's is LocalChain.rpcUrl)`,
      );
    }
    this.network = opts.network;
    this.contractId = opts.contractId;
    this.rpcUrl = rpcUrl;
    this.rpcTimeoutMs = timeoutOption(
      "TenderClient: rpcTimeoutMs",
      opts.rpcTimeoutMs,
      DEFAULT_RPC_TIMEOUT_MS,
    );
    this.sendTimeoutMs = timeoutOption(
      "TenderClient: sendTimeoutMs",
      opts.sendTimeoutMs,
      DEFAULT_SEND_TIMEOUT_MS,
    );
    this.provider = new JsonRpcProvider({ url: rpcUrl });
    if (opts.signer !== undefined) {
      const { accountId, privateKey } = opts.signer;
      this.accountId = accountId;
      const signer = KeyPairSigner.fromSecretKey(privateKey as KeyPairString);
      this.key = KeyPair.fromString(privateKey as KeyPairString);
      this.publicKey = this.key.getPublicKey().toString();
      this.account = new Account(accountId, this.provider, signer);
    }
  }

  /**
   * Calls the view `method` of `contractId` with `args`, unchecked. It has `rpcTimeoutMs`, and
   * throws a `TenderError` with code `E_TIMEOUT` if the node has not answered by then.
   */
  async view<T>(contractId: string, method: string, args: object = {}): Promise<T> {
    const value: unknown = await withDeadline(
      `TenderClient.view ${method}`,
      this.rpcTimeoutMs,
      () =>
        this.provider.callFunction({
          contractId,
          method,
          args: args as Record<string, unknown>,
          blockQuery: { finality: FINALITY },
        }),
    );
    return value as T;
  }

  /**
   * Signs `call` as the signer, sends it and waits until it is final. See `toTxResult`. It goes
   * once the earlier sends of the signer's account in this process are done (`defaultQueue`), and
   * has `sendTimeoutMs` from then on. A send the node has not finished by then throws a
   * `TenderError` with code `E_TIMEOUT`, and may have landed all the same (see the class), which
   * the error's message says: it has no `txHash`, since the client does not learn it. A caller
   * that needs the hash to follow up gets it from `hooks.beforeSend`, below.
   *
   * The time is that of each try: a transaction that loses its nonce to another (`defaultQueue`)
   * is sent once more, and that try has all of `sendTimeoutMs` again.
   *
   * `hooks.beforeSend` hears of each transaction after it is signed and before it is sent, with
   * its hash, so a caller can write the hash down first and, after an `E_TIMEOUT`, ask the chain
   * what became of it (`txStatus`) instead of guessing from the time that has passed.
   */
  async send(call: TenderCall, hooks?: SendHooks): Promise<TxResult> {
    const account = this.account;
    if (account === undefined) {
      throw new Error("this TenderClient has no signer, so it cannot send transactions");
    }
    if (call.receiverId === this.contractId && FULL_ACCESS_ONLY_METHODS.has(call.methodName)) {
      await this.requireFullAccessKey(call.methodName);
    }
    const action = actions.functionCall(call.methodName, call.args, call.gas, call.deposit);
    const beforeSend = hooks?.beforeSend;
    const key = this.key;
    return defaultQueue.run(account.accountId, async () => {
      const signer =
        beforeSend === undefined || key === undefined
          ? undefined
          : new ReportingSigner(key, async (signed) => beforeSend(await this.describe(signed)));
      const resp = await withDeadline(
        `TenderClient.send ${call.methodName}`,
        this.sendTimeoutMs,
        () =>
          account.signAndSendTransaction({
            receiverId: call.receiverId,
            actions: [action],
            waitUntil: "FINAL",
            throwOnFailure: false,
            signer,
          }),
        SEND_MAY_STILL_LAND,
      );
      return toTxResult(resp, this.contractId);
    });
  }

  /** A signed transaction as `SignedTx`: its reference block's height is asked of the node. */
  private async describe(signed: {
    txHash: Uint8Array;
    transaction: Transaction;
  }): Promise<SignedTx> {
    const { transaction } = signed;
    const blockHash = baseEncode(transaction.blockHash);
    // Inside the send's time, and so under its deadline: this runs in the signer, in the send.
    const block = await this.provider.viewBlock({ blockId: blockHash });
    return {
      txHash: baseEncode(signed.txHash),
      signerId: transaction.signerId,
      publicKey: transaction.publicKey.toString(),
      nonce: transaction.nonce,
      blockHash,
      blockHeight: BigInt(block.header.height),
    };
  }

  /**
   * What the chain says of the transaction with this hash that `signerId` (default: this client's
   * account) signed: see `TxStatus`. A node that does not answer is not an answer: the call throws
   * (`E_TIMEOUT` after `rpcTimeoutMs`), and the caller asks again.
   */
  async txStatus(txHash: string, signerId: string | undefined = this.accountId): Promise<TxStatus> {
    if (signerId === undefined) {
      throw new Error("this TenderClient has no signer, so txStatus needs the account that signed");
    }
    let resp: FinalTxOutcome & { final_execution_status?: string };
    try {
      resp = (await withDeadline(`TenderClient.txStatus ${txHash}`, this.rpcTimeoutMs, () =>
        this.provider.viewTransactionStatus({ txHash, accountId: signerId, waitUntil: "NONE" }),
      )) as unknown as typeof resp;
    } catch (error) {
      if (error instanceof UnknownTransactionError) return { kind: "unknown" };
      // The node's own wait for the transaction ran out: it is not final.
      if (error instanceof TransactionTimeoutError) return { kind: "pending" };
      throw error;
    }
    if (resp.final_execution_status !== "FINAL") return { kind: "pending" };
    const variant = variantOf(resp.status);
    if (variant?.[0] === "SuccessValue") {
      return { kind: "executed", result: toTxResult(resp, this.contractId) };
    }
    if (variant?.[0] === "Failure") {
      return { kind: "failed", error: failedWith(resp.transaction.hash, variant[1]) };
    }
    return { kind: "pending" };
  }

  /**
   * Throws a `TenderError` with code `E_AUTH` unless the signer's key is a full-access key of its
   * account, as the chain reports it. `register_agent`, `unregister_agent` and `claim_agent_bond`
   * take exactly 1 yoctoNEAR, which a function-call key, a delegate key among them, cannot attach
   * (`FULL_ACCESS_ONLY_METHODS`), so the client refuses before it sends anything: `send` does for
   * those three, and a caller about to move money first (`registerWithBond`) asks it up front. A
   * node that does not answer is an error of its own and not a refusal: it is thrown as
   * `viewAccessKey` throws it. A client with no signer passes (`send` will say it has none).
   */
  async requireFullAccessKey(method: string): Promise<void> {
    const { accountId, publicKey } = this;
    if (accountId === undefined || publicKey === undefined) return;
    const key = await this.viewAccessKey(accountId, publicKey);
    if (key === null) {
      throw new TenderError(
        "E_AUTH",
        `${method} needs a full-access key of ${accountId}, and ${publicKey} is not a key of that account. Nothing was sent.`,
      );
    }
    if (key.permission !== "FullAccess") {
      throw new TenderError(
        "E_AUTH",
        `${method} needs a full-access key: it takes exactly 1 yoctoNEAR, which a function-call key ` +
          `(a delegate key too) cannot attach, and ${publicKey} is one. Nothing was sent. Use the ` +
          `account's full-access key.`,
      );
    }
  }

  // Views of the Tender contract.

  async getConfig(): Promise<ConfigView> {
    return ConfigViewSchema.parse(await this.view(this.contractId, "get_config"));
  }

  async getTask(id: bigint): Promise<TaskView | null> {
    return TaskOrNull.parse(await this.view(this.contractId, "get_task", { task_id: `${id}` }));
  }

  /** Up to `limit` (at most 50) tasks from `fromId` on, in id order. */
  async getTasks(fromId: bigint, limit: number): Promise<TaskView[]> {
    const args = { from_id: `${fromId}`, limit };
    return Tasks.parse(await this.view(this.contractId, "get_tasks", args));
  }

  /** How many tasks there are. Their ids are 1 to this number. */
  async taskCount(): Promise<bigint> {
    return BigInt(U64StringSchema.parse(await this.view(this.contractId, "task_count")));
  }

  /**
   * The entries at indexes `fromIndex` to `fromIndex + limit` (at most 50) that are left. A page
   * leaves out what `cleanup` removed, so it can be short, or empty, before the last index.
   */
  async getEntries(taskId: bigint, fromIndex: number, limit: number): Promise<EntryView[]> {
    const args = { task_id: `${taskId}`, from_index: fromIndex, limit };
    return Entries.parse(await this.view(this.contractId, "get_entries", args));
  }

  /** Every entry of the task that is left, in entrant order. None for a missing task. */
  async getAllEntries(taskId: bigint): Promise<EntryView[]> {
    const task = await this.getTask(taskId);
    if (task === null) return [];
    // `cleanup` removes entries from index 0 up, and counts them in `cleaned`. A page can be empty
    // while later ones are not, so the pages run by index up to the last one, never until a page
    // comes back empty.
    const entries: EntryView[] = [];
    for (let from = task.cleaned; from < task.commit_count; from += MAX_PAGE) {
      entries.push(...(await this.getEntries(taskId, from, MAX_PAGE)));
    }
    return entries;
  }

  async getEntry(taskId: bigint, account: string): Promise<EntryView | null> {
    const args = { task_id: `${taskId}`, account_id: account };
    return EntryOrNull.parse(await this.view(this.contractId, "get_entry", args));
  }

  /** What `account` holds of `token` in Tender's vault. */
  async balanceOf(account: string, token: string): Promise<bigint> {
    const args = { account_id: account, token };
    return BigInt(U128StringSchema.parse(await this.view(this.contractId, "balance_of", args)));
  }

  /** `account`'s storage balance with Tender, or null if it has never deposited. */
  async storageBalanceOf(account: string): Promise<StorageView | null> {
    const args = { account_id: account };
    return StorageOrNull.parse(await this.view(this.contractId, "storage_balance_of", args));
  }

  async getAgent(account: string): Promise<AgentView | null> {
    return AgentOrNull.parse(
      await this.view(this.contractId, "get_agent", { account_id: account }),
    );
  }

  // Views of a token (NEP-141 and NEP-145).

  /** What `account` holds of `token` itself, outside Tender. */
  async ftBalanceOf(token: string, account: string): Promise<bigint> {
    const args = { account_id: account };
    return BigInt(U128StringSchema.parse(await this.view(token, "ft_balance_of", args)));
  }

  /** `account`'s storage balance with `token`, or null if the token has not registered it. */
  async ftStorageBalanceOf(token: string, account: string): Promise<FtStorageBalance | null> {
    const args = { account_id: account };
    return FtStorageOrNull.parse(await this.view(token, "storage_balance_of", args));
  }

  // The chain.

  /** The height of the last final block. */
  async finalHeight(): Promise<bigint> {
    const { header } = await withDeadline("TenderClient.finalHeight", this.rpcTimeoutMs, () =>
      this.provider.viewBlock({ finality: FINALITY }),
    );
    return BigInt(header.height);
  }

  /**
   * The time of the last final block, in nanoseconds. A deadline this has reached has passed for
   * every transaction sent from now on.
   */
  async blockTimestampNs(): Promise<bigint> {
    const { header } = await withDeadline("TenderClient.blockTimestampNs", this.rpcTimeoutMs, () =>
      this.provider.viewBlock({ finality: FINALITY }),
    );
    return BigInt(header.timestamp_nanosec);
  }

  /**
   * The permission of the key `publicKey` on `accountId`, exactly as the RPC reports it, or null
   * when the account has no such key. The RPC's four variants all pass through unchanged, the two
   * gas-key ones too, so that the NEP-413 verifier is what decides which it accepts. Only a missing
   * key, or a missing account, which cannot have the key either, is null; any other RPC error is
   * thrown, never read as "no key". A node that does not answer in `rpcTimeoutMs` is one: it throws
   * a `TenderError` with code `E_TIMEOUT`.
   */
  async viewAccessKey(
    accountId: string,
    publicKey: string,
  ): Promise<{ permission: KeyPermission } | null> {
    try {
      // The last final block, like every read here, so that no answer is one a fork could undo.
      // The cost: a deleted key stops working only when its deletion is final, about two blocks
      // after the deleting transaction ran.
      const { permission } = await withDeadline(
        "TenderClient.viewAccessKey",
        this.rpcTimeoutMs,
        () =>
          this.provider.viewAccessKey({
            accountId,
            publicKey,
            finalityQuery: { finality: FINALITY },
          }),
      );
      return { permission: permission as KeyPermission };
    } catch (error) {
      if (
        error instanceof AccessKeyDoesNotExistError ||
        error instanceof AccountDoesNotExistError
      ) {
        return null;
      }
      throw error;
    }
  }

  // Senders: each builds its call with the `@tender/shared` builder of the same name and `send`s
  // it, signed by the signer. They take the builder's arguments, less the contract.

  /**
   * Posts a task, with its reward from the signer's vault. `taskId` is the new task's id. With
   * `{ delegate: true }` it attaches no deposit, for a signer whose key is a delegate key within
   * its caps (`add_delegate`); the same goes for `topUpTask`.
   */
  async postTask(
    input: PostTaskInput,
    opts?: SpendOptions,
    hooks?: SendHooks,
  ): Promise<TxResult & { taskId: bigint }> {
    const result = await this.send(postTaskCall(this.contractId, input, opts), hooks);
    return { ...result, taskId: BigInt(U64StringSchema.parse(result.returnValue)) };
  }

  topUpTask(taskId: bigint, amount: bigint, opts?: SpendOptions): Promise<TxResult> {
    return this.send(topUpTaskCall(this.contractId, taskId, amount, opts));
  }

  commit(taskId: bigint, commitment: string): Promise<TxResult> {
    return this.send(commitCall(this.contractId, taskId, commitment));
  }

  reveal(taskId: bigint, contentHash: string, salt: string, uri: string): Promise<TxResult> {
    return this.send(revealCall(this.contractId, taskId, contentHash, salt, uri));
  }

  pick(
    taskId: bigint,
    winners: readonly { account: string; bps: number }[],
    scorecardHash: string,
    scorecardUri: string,
  ): Promise<TxResult> {
    return this.send(pickCall(this.contractId, taskId, winners, scorecardHash, scorecardUri));
  }

  voidTask(taskId: bigint): Promise<TxResult> {
    return this.send(voidTaskCall(this.contractId, taskId));
  }

  /** Removes the next `limit` (1 to 50, default 50) entries; `returnValue` is how many. */
  cleanup(taskId: bigint, limit?: number): Promise<TxResult> {
    return this.send(cleanupCall(this.contractId, taskId, limit));
  }

  /** `returnValue` is whether the token paid; if not, the events hold `withdraw_failed`. */
  withdraw(token: string, amount: bigint, to?: string): Promise<TxResult> {
    return this.send(withdrawCall(this.contractId, token, amount, to));
  }

  /**
   * Moves `amount` of `tokenId` into the vault of the signer, or of `forAccount`. A deposit that
   * Tender refuses is refunded and does not fail: then there is no `deposit` event, and
   * `returnValue` (the amount Tender took) is "0".
   */
  deposit(tokenId: string, amount: bigint, forAccount?: string): Promise<TxResult> {
    return this.send(depositCall(tokenId, this.contractId, amount, forAccount));
  }

  storageDeposit(amountYocto: bigint, accountId?: string): Promise<TxResult> {
    return this.send(storageDepositCall(this.contractId, amountYocto, accountId));
  }

  /**
   * Registers the signer as an agent, or replaces its profile. A new agent, and a retired one
   * coming back, pays the contract's bond out of its vault, so the vault must hold it first
   * (`registerWithBond` tops it up). Takes exactly 1 yoctoNEAR, so only a full-access key can: with
   * another the client throws a `TenderError` with code `E_AUTH` and sends nothing.
   */
  registerAgent(
    profileUri: string,
    profileHash: string,
    tags: readonly string[],
  ): Promise<TxResult> {
    return this.send(registerAgentCall(this.contractId, profileUri, profileHash, tags));
  }

  /**
   * Starts the signer's way out: it makes no new entry in an open task from now on, and can claim
   * its bond once the cooldown is over (`claimable_at` of `getAgent`). Full-access key only, as
   * `registerAgent`.
   */
  unregisterAgent(): Promise<TxResult> {
    return this.send(unregisterAgentCall(this.contractId));
  }

  /**
   * Pays the signer's bond back into its vault and retires the agent. Only once the cooldown of
   * `unregisterAgent` is over (`E_PHASE` before). Full-access key only, as `registerAgent`.
   */
  claimAgentBond(): Promise<TxResult> {
    return this.send(claimAgentBondCall(this.contractId));
  }

  /** The owner's `set_agent_bond`: the bond that agents registering from now on pay. */
  setAgentBond(token: string, amount: bigint): Promise<TxResult> {
    return this.send(setAgentBondCall(this.contractId, token, amount));
  }

  /** The owner's `set_agent_bond_cooldown`: seconds from `unregister_agent` to the claim. */
  setAgentBondCooldown(secs: number): Promise<TxResult> {
    return this.send(setAgentBondCooldownCall(this.contractId, secs));
  }

  addDelegate(
    publicKey: string,
    token: string,
    perTaskCap: bigint,
    totalCap: bigint,
  ): Promise<TxResult> {
    return this.send(addDelegateCall(this.contractId, publicKey, token, perTaskCap, totalCap));
  }

  removeDelegate(publicKey: string): Promise<TxResult> {
    return this.send(removeDelegateCall(this.contractId, publicKey));
  }
}
