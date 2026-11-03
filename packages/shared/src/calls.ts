/**
 * Typed builders for the calls a Tender client makes. Each turns an intent (post a task, commit,
 * reveal, pick, withdraw, deposit and so on) into the exact NEAR function call to send: the
 * receiver, the method, the JSON arguments, the gas and the deposit. The Node services and the
 * browser share them.
 *
 * The argument names are the contract's own. Its change methods reject a top-level key they do not
 * take (`#[deny_unknown_arguments]`), and `post_task`'s `task` and each winner of `pick` reject an
 * unknown field, so a misspelled key fails on chain. `test/calls.test.ts` compares every name with
 * the contract source.
 *
 * The contract reads JSON, so a u64 or u128 value (a task id, an amount) is a decimal string, which
 * keeps a value above 2^53 exact, and a u8, u16 or u32 value (seconds, a count, basis points) is a
 * JSON number.
 */

/** A NEAR function call, ready to sign and send. */
export interface TenderCall {
  /** The account that runs the method: the Tender contract, or a token. */
  receiverId: string;
  methodName: string;
  /** The JSON arguments. They hold no bigint and no `undefined`, so `JSON.stringify` loses none. */
  args: Record<string, unknown>;
  /** Gas to attach, in gas units (1 Tgas is 10^12). */
  gas: bigint;
  /** NEAR to attach, in yoctoNEAR. */
  deposit: bigint;
}

const TGAS = 1_000_000_000_000n;

/**
 * Gas to attach to each call, in gas units: the Tgas figure times 10^12. The figures leave a wide
 * margin over what the built calls burn in the contract's gas suite, and gas that a call does not
 * use is refunded. `withdraw` has to carry at least the 35 Tgas the contract demands
 * (`MIN_WITHDRAW_GAS`).
 */
export const GAS = {
  postTask: 30n * TGAS,
  topUpTask: 20n * TGAS,
  commit: 15n * TGAS,
  reveal: 15n * TGAS,
  pick: 60n * TGAS,
  voidTask: 60n * TGAS,
  cleanup: 150n * TGAS,
  withdraw: 50n * TGAS,
  storageDeposit: 10n * TGAS,
  storageWithdraw: 15n * TGAS,
  registerAgent: 15n * TGAS,
  ftTransferCall: 100n * TGAS,
  tokenStorageDeposit: 10n * TGAS,
  addDelegate: 15n * TGAS,
  removeDelegate: 15n * TGAS,
} as const;

/**
 * 1 yoctoNEAR, the deposit of every call that spends from the vault or moves money out. A
 * function-call access key cannot attach a deposit, so it cannot send these calls, except that a
 * delegate key may post and top up tasks within the caps its account registered for it.
 */
export const ONE_YOCTO = 1n;

/**
 * The deposit of a call that is not `#[payable]`. The contract refuses any NEAR attached to those,
 * and a function-call key, which can attach none, may send them.
 */
const NO_DEPOSIT = 0n;

/** The default deposit to register an account with a token (NEP-145): 0.00125 NEAR in yocto. */
const TOKEN_STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n;

/**
 * How a spending call is authorised. A full-access key attaches 1 yoctoNEAR, which the contract's
 * `authorize_spend` accepts from anyone. A delegate key is a function-call key, which cannot attach
 * a deposit: with `delegate: true` the call attaches none, and the contract lets it through only
 * within the caps its account registered for that key (`add_delegate`), else `E_AUTH`.
 */
export interface SpendOptions {
  delegate?: boolean;
}

/** The deposit of a spending call: none from a delegate key, else 1 yoctoNEAR. */
const spendDeposit = (opts: SpendOptions | undefined) =>
  opts?.delegate === true ? NO_DEPOSIT : ONE_YOCTO;

/** The terms of a task. A field that is left out takes the default noted, or is sent as `null`. */
export interface PostTaskInput {
  /** The token the reward is paid in, as an account id. */
  token: string;
  /** The reward, in the token's smallest unit. */
  reward: bigint;
  briefUri: string;
  /** The SHA-256 of the brief, as 64 lowercase hex characters. */
  briefHash: string;
  /** The SHA-256 of the public criteria, as 64 lowercase hex characters. */
  criteriaHash: string;
  /** The SHA-256 of the held-out checks, as 64 lowercase hex characters. */
  heldoutCommitment?: string;
  /** Who picks the winners. The poster, when left out. */
  verifier?: string;
  /** The four windows, in seconds. */
  commitSecs: number;
  revealSecs: number;
  pickSecs: number;
  fallbackSecs: number;
  /** The most entrants. 0 (the default) is no limit; a limit is allowed only with `invited`. */
  maxEntries?: number;
  /** The most winners, 1 to 5. 1 by default. */
  maxWinners?: number;
  /** Who may enter. Empty (the default) is anyone. */
  invited?: string[];
  /**
   * The parent task, when this is a sub-task: one that exists and is not settled, that the
   * poster has entered, and whose commit window ends no earlier than this task's pick window
   * (`E_PARENT` otherwise).
   */
  parent?: bigint;
}

/**
 * `post_task`: posts a task and moves its reward from the caller's vault into escrow. It attaches
 * 1 yoctoNEAR, which the contract demands of a spend, or none with `{ delegate: true }`, for a
 * delegate key (see `SpendOptions`).
 *
 * The task is built field by field, so a property that `input` has beyond `PostTaskInput` never
 * reaches the wire, where `post_task` would reject it.
 */
export function postTaskCall(
  contractId: string,
  input: PostTaskInput,
  opts?: SpendOptions,
): TenderCall {
  return {
    receiverId: contractId,
    methodName: "post_task",
    args: {
      task: {
        token: input.token,
        reward: input.reward.toString(),
        brief_uri: input.briefUri,
        brief_hash: input.briefHash,
        criteria_hash: input.criteriaHash,
        heldout_commitment: input.heldoutCommitment ?? null,
        verifier: input.verifier ?? null,
        commit_secs: input.commitSecs,
        reveal_secs: input.revealSecs,
        pick_secs: input.pickSecs,
        fallback_secs: input.fallbackSecs,
        max_entries: input.maxEntries ?? 0,
        max_winners: input.maxWinners ?? 1,
        invited: [...(input.invited ?? [])],
        parent: input.parent?.toString() ?? null,
      },
    },
    gas: GAS.postTask,
    deposit: spendDeposit(opts),
  };
}

/**
 * `top_up_task`: adds `amount` from the caller's vault to an open task's reward. 1 yoctoNEAR, or
 * none with `{ delegate: true }`, for a delegate key (see `SpendOptions`).
 */
export function topUpTaskCall(
  contractId: string,
  taskId: bigint,
  amount: bigint,
  opts?: SpendOptions,
): TenderCall {
  return {
    receiverId: contractId,
    methodName: "top_up_task",
    args: { task_id: taskId.toString(), amount: amount.toString() },
    gas: GAS.topUpTask,
    deposit: spendDeposit(opts),
  };
}

/**
 * `commit`: enters the caller in a task with `commitment` (see `computeCommitment`), or replaces
 * the commitment it entered with. No deposit.
 */
export function commitCall(contractId: string, taskId: bigint, commitment: string): TenderCall {
  return {
    receiverId: contractId,
    methodName: "commit",
    args: { task_id: taskId.toString(), commitment },
    gas: GAS.commit,
    deposit: NO_DEPOSIT,
  };
}

/**
 * `reveal`: reveals the caller's entry. `contentHash` and `salt` are the ones its commitment was
 * made with, and `uri` is where the work can be read. No deposit.
 */
export function revealCall(
  contractId: string,
  taskId: bigint,
  contentHash: string,
  salt: string,
  uri: string,
): TenderCall {
  return {
    receiverId: contractId,
    methodName: "reveal",
    args: { task_id: taskId.toString(), content_hash: contentHash, salt, uri },
    gas: GAS.reveal,
    deposit: NO_DEPOSIT,
  };
}

/**
 * `pick`: settles a task by paying `winners`, each a share `bps` of the reward after the fee, and
 * all the shares 10_000 together. An empty `winners` awards nothing and refunds the funders.
 * `scorecardHash` is the SHA-256 of the scorecard behind the decision. No deposit.
 *
 * Each winner is rebuilt as `{ account, bps }`: `pick` rejects any other field, an `amount` beside
 * `bps` included, because only `bps` decides the payout.
 */
export function pickCall(
  contractId: string,
  taskId: bigint,
  winners: readonly { account: string; bps: number }[],
  scorecardHash: string,
  scorecardUri: string,
): TenderCall {
  return {
    receiverId: contractId,
    methodName: "pick",
    args: {
      task_id: taskId.toString(),
      winners: winners.map(({ account, bps }) => ({ account, bps })),
      scorecard_hash: scorecardHash,
      scorecard_uri: scorecardUri,
    },
    gas: GAS.pick,
    deposit: NO_DEPOSIT,
  };
}

/**
 * `void_task`: voids a task whose reveal window ended with nothing revealed, or whose fallback
 * window ended, and refunds its funders. Anyone may call it. No deposit.
 */
export function voidTaskCall(contractId: string, taskId: bigint): TenderCall {
  return {
    receiverId: contractId,
    methodName: "void_task",
    args: { task_id: taskId.toString() },
    gas: GAS.voidTask,
    deposit: NO_DEPOSIT,
  };
}

/**
 * `cleanup`: deletes the next `limit` entries (1 to 50) of a settled task and refunds their
 * storage. Anyone may call it. No deposit.
 */
export function cleanupCall(contractId: string, taskId: bigint, limit = 50): TenderCall {
  return {
    receiverId: contractId,
    methodName: "cleanup",
    args: { task_id: taskId.toString(), limit },
    gas: GAS.cleanup,
    deposit: NO_DEPOSIT,
  };
}

/**
 * `withdraw`: pays `amount` of `token` out of the caller's vault to `to`, or to the caller when
 * `to` is left out. 1 yoctoNEAR.
 */
export function withdrawCall(
  contractId: string,
  token: string,
  amount: bigint,
  to?: string,
): TenderCall {
  return {
    receiverId: contractId,
    methodName: "withdraw",
    args: { token, amount: amount.toString(), ...(to === undefined ? {} : { to }) },
    gas: GAS.withdraw,
    deposit: ONE_YOCTO,
  };
}

/**
 * `storage_deposit`: credits `amountYocto` of NEAR, attached to the call, as storage balance to
 * `accountId`, or to the caller when it is left out. An account's first deposit must be at least
 * 0.01 NEAR.
 */
export function storageDepositCall(
  contractId: string,
  amountYocto: bigint,
  accountId?: string,
): TenderCall {
  return {
    receiverId: contractId,
    methodName: "storage_deposit",
    args: accountId === undefined ? {} : { account_id: accountId },
    gas: GAS.storageDeposit,
    deposit: amountYocto,
  };
}

/**
 * `storage_withdraw`: pays the caller `amountYocto` of its unused storage balance, or all of it
 * when left out. 1 yoctoNEAR.
 */
export function storageWithdrawCall(contractId: string, amountYocto?: bigint): TenderCall {
  return {
    receiverId: contractId,
    methodName: "storage_withdraw",
    args: amountYocto === undefined ? {} : { amount: amountYocto.toString() },
    gas: GAS.storageWithdraw,
    deposit: ONE_YOCTO,
  };
}

/**
 * `ft_transfer_call` on the token (NEP-141): sends `amount` to Tender, which credits it to the
 * caller's vault, or to `forAccount` when given. The account credited needs a storage balance with
 * Tender first, or the deposit is refunded. 1 yoctoNEAR, as NEP-141 demands.
 *
 * `msg` is what Tender's `ft_on_transfer` reads: empty, or exactly `{"for":"<account>"}`.
 */
export function depositCall(
  tokenId: string,
  contractId: string,
  amount: bigint,
  forAccount?: string,
): TenderCall {
  return {
    receiverId: tokenId,
    methodName: "ft_transfer_call",
    args: {
      receiver_id: contractId,
      amount: amount.toString(),
      msg: forAccount === undefined ? "" : JSON.stringify({ for: forAccount }),
    },
    gas: GAS.ftTransferCall,
    deposit: ONE_YOCTO,
  };
}

/**
 * `storage_deposit` on the token (NEP-145): registers `accountId` so the token can hold its
 * balance. `registration_only` makes the token keep only what registering costs and refund the rest
 * of `amountYocto`, which is 0.00125 NEAR unless given.
 */
export function tokenStorageDepositCall(
  tokenId: string,
  accountId: string,
  amountYocto = TOKEN_STORAGE_DEPOSIT,
): TenderCall {
  return {
    receiverId: tokenId,
    methodName: "storage_deposit",
    args: { account_id: accountId, registration_only: true },
    gas: GAS.tokenStorageDeposit,
    deposit: amountYocto,
  };
}

/**
 * `register_agent`: creates the caller's agent profile, or replaces its URI, hash and tags. The
 * caller needs a storage balance. No deposit.
 */
export function registerAgentCall(
  contractId: string,
  profileUri: string,
  profileHash: string,
  tags: readonly string[],
): TenderCall {
  return {
    receiverId: contractId,
    methodName: "register_agent",
    args: { profile_uri: profileUri, profile_hash: profileHash, tags: [...tags] },
    gas: GAS.registerAgent,
    deposit: NO_DEPOSIT,
  };
}

/**
 * `add_delegate`: lets the access key `publicKey` post and top up tasks in `token` without a
 * deposit, up to `perTaskCap` per call and `totalCap` in all. 1 yoctoNEAR.
 */
export function addDelegateCall(
  contractId: string,
  publicKey: string,
  token: string,
  perTaskCap: bigint,
  totalCap: bigint,
): TenderCall {
  return {
    receiverId: contractId,
    methodName: "add_delegate",
    args: {
      public_key: publicKey,
      token,
      per_task_cap: perTaskCap.toString(),
      total_cap: totalCap.toString(),
    },
    gas: GAS.addDelegate,
    deposit: ONE_YOCTO,
  };
}

/** `remove_delegate`: takes back the spending caps of the access key `publicKey`. 1 yoctoNEAR. */
export function removeDelegateCall(contractId: string, publicKey: string): TenderCall {
  return {
    receiverId: contractId,
    methodName: "remove_delegate",
    args: { public_key: publicKey },
    gas: GAS.removeDelegate,
    deposit: ONE_YOCTO,
  };
}

/** The `FunctionCall` action of `@hot-labs/near-connect` 0.12.0. */
export interface ConnectorFunctionCallAction {
  type: "FunctionCall";
  params: {
    methodName: string;
    args: object;
    /** Gas, as a decimal string. */
    gas: string;
    /** The deposit in yoctoNEAR, as a decimal string. */
    deposit: string;
  };
}

/**
 * `call` as an action for a wallet connector. The action carries no receiver, so pass
 * `call.receiverId` to the connector beside it. Gas and deposit are decimal strings, because a
 * number cannot hold them: 1 NEAR is 10^24 yoctoNEAR.
 */
export function toConnectorAction(call: TenderCall): ConnectorFunctionCallAction {
  return {
    type: "FunctionCall",
    params: {
      methodName: call.methodName,
      args: call.args,
      gas: call.gas.toString(),
      deposit: call.deposit.toString(),
    },
  };
}
