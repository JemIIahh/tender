import {
  type AgentView,
  AgentViewSchema,
  addDelegateCall,
  type ConfigView,
  ConfigViewSchema,
  cleanupCall,
  commitCall,
  depositCall,
  type EntryView,
  EntryViewSchema,
  extractEvents,
  NETWORKS,
  type NetworkId,
  type PostTaskInput,
  pickCall,
  postTaskCall,
  type ReceiptOutcome,
  registerAgentCall,
  removeDelegateCall,
  revealCall,
  type StorageView,
  StorageViewSchema,
  storageDepositCall,
  type TaskView,
  TaskViewSchema,
  type TenderCall,
  type TenderEvent,
  topUpTaskCall,
  U64StringSchema,
  U128StringSchema,
  voidTaskCall,
  withdrawCall,
} from "@tender/shared";
import { Account, actions, JsonRpcProvider, KeyPairSigner, type KeyPairString } from "near-api-js";
import { AccessKeyDoesNotExistError, AccountDoesNotExistError } from "near-api-js/rpc-errors";
import { errorCodeOf, TenderError } from "./errors";
import type { KeyPermission } from "./nep413";
import { receiptsFromTx, type TxReceiptsOutcome } from "./outcome";

/** An account and its private key, as near-api-js writes keys: `ed25519:<base58>`. */
export interface Signer {
  accountId: string;
  privateKey: string;
}

/** What a transaction did, once it is final and succeeded. */
export interface TxResult {
  txHash: string;
  /** The Tender events of the receipts that ran on the Tender contract and succeeded, in order. */
  events: TenderEvent[];
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

/** NEP-145's storage balance, as a token's `storage_balance_of` returns it, in yoctoNEAR. */
export interface FtStorageBalance {
  total: string;
  available: string;
}

/** The largest page of the contract's list views: `MAX_PAGE` in contract/tender/src/types.rs. */
const MAX_PAGE = 50;

/** Every read is of the last final block; see `TenderClient`. */
const FINALITY = "final";

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
  if (variant?.[0] === "Failure") {
    const message = failureMessage(variant[1]);
    throw new TenderError(errorCodeOf(message), message, { txHash, cause: variant[1] });
  }
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
 * it. Two transactions signed with one key at the same time, by one client or by two, can collide
 * on their nonce (`InvalidNonce`), so send from one key one transaction at a time.
 */
export class TenderClient {
  readonly network: NetworkId;
  readonly contractId: string;
  readonly rpcUrl: string;
  /** The signer's account, when the client has one. */
  readonly accountId?: string;
  private readonly provider: JsonRpcProvider;
  private readonly account?: Account;

  /**
   * `rpcUrl` defaults to the network's. The sandbox has none, because a local node picks its port
   * when it starts, so a client of a local chain passes `LocalChain.rpcUrl`.
   */
  constructor(opts: { network: NetworkId; contractId: string; rpcUrl?: string; signer?: Signer }) {
    const rpcUrl = opts.rpcUrl ?? NETWORKS[opts.network].rpcUrl;
    if (rpcUrl === "") {
      throw new Error(
        `no RPC URL for network ${opts.network}: pass rpcUrl (a local chain's is LocalChain.rpcUrl)`,
      );
    }
    this.network = opts.network;
    this.contractId = opts.contractId;
    this.rpcUrl = rpcUrl;
    this.provider = new JsonRpcProvider({ url: rpcUrl });
    if (opts.signer !== undefined) {
      const { accountId, privateKey } = opts.signer;
      this.accountId = accountId;
      const signer = KeyPairSigner.fromSecretKey(privateKey as KeyPairString);
      this.account = new Account(accountId, this.provider, signer);
    }
  }

  /** Calls the view `method` of `contractId` with `args`, unchecked. */
  async view<T>(contractId: string, method: string, args: object = {}): Promise<T> {
    const value: unknown = await this.provider.callFunction({
      contractId,
      method,
      args: args as Record<string, unknown>,
      blockQuery: { finality: FINALITY },
    });
    return value as T;
  }

  /** Signs `call` as the signer, sends it and waits until it is final. See `toTxResult`. */
  async send(call: TenderCall): Promise<TxResult> {
    if (this.account === undefined) {
      throw new Error("this TenderClient has no signer, so it cannot send transactions");
    }
    const resp = await this.account.signAndSendTransaction({
      receiverId: call.receiverId,
      actions: [actions.functionCall(call.methodName, call.args, call.gas, call.deposit)],
      waitUntil: "FINAL",
      throwOnFailure: false,
    });
    return toTxResult(resp, this.contractId);
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
    const { header } = await this.provider.viewBlock({ finality: FINALITY });
    return BigInt(header.height);
  }

  /**
   * The time of the last final block, in nanoseconds. A deadline this has reached has passed for
   * every transaction sent from now on.
   */
  async blockTimestampNs(): Promise<bigint> {
    const { header } = await this.provider.viewBlock({ finality: FINALITY });
    return BigInt(header.timestamp_nanosec);
  }

  /**
   * The permission of the key `publicKey` on `accountId`, exactly as the RPC reports it, or null
   * when the account has no such key. The RPC's four variants all pass through unchanged, the two
   * gas-key ones too, so that the NEP-413 verifier is what decides which it accepts. Only a missing
   * key, or a missing account, which cannot have the key either, is null; any other RPC error is
   * thrown, never read as "no key".
   */
  async viewAccessKey(
    accountId: string,
    publicKey: string,
  ): Promise<{ permission: KeyPermission } | null> {
    try {
      // The last final block, like every read here, so that no answer is one a fork could undo.
      // The cost: a deleted key stops working only when its deletion is final, about two blocks
      // after the deleting transaction ran.
      const { permission } = await this.provider.viewAccessKey({
        accountId,
        publicKey,
        finalityQuery: { finality: FINALITY },
      });
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

  /** Posts a task, with its reward from the signer's vault. `taskId` is the new task's id. */
  async postTask(input: PostTaskInput): Promise<TxResult & { taskId: bigint }> {
    const result = await this.send(postTaskCall(this.contractId, input));
    return { ...result, taskId: BigInt(U64StringSchema.parse(result.returnValue)) };
  }

  topUpTask(taskId: bigint, amount: bigint): Promise<TxResult> {
    return this.send(topUpTaskCall(this.contractId, taskId, amount));
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

  registerAgent(
    profileUri: string,
    profileHash: string,
    tags: readonly string[],
  ): Promise<TxResult> {
    return this.send(registerAgentCall(this.contractId, profileUri, profileHash, tags));
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
