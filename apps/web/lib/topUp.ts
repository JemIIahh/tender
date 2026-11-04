import {
  ConfigViewSchema,
  StorageViewSchema,
  storageDepositCall,
  storageShortfall,
  TaskViewSchema,
  type TenderCall,
  topUpTaskCall,
} from "@tender/shared";
import { outcomeUnknown, sendWords } from "./actionWords";
import { config } from "./config";
import { RpcError, view } from "./rpc";
import { describeAmount, readVault, type StorageBalance } from "./vault";
import type { SendResult } from "./wallet";

// "Top up" on the task page: `top_up_task`, which moves an amount of the task's token from the
// caller's vault into its escrow and makes the caller one of its funders (a pooled bounty). The
// form holds the amount to the contract's rules, read from the chain (`get_config`, `get_task` and
// the vault): the task takes top-ups until its commit deadline, from up to 50 funders, the poster
// among them; a new funder's first top-up is at least the token's `min_reward`; the reward it makes
// is at most the token's `max_reward`; and the vault must hold the amount. A new funder's record
// takes a few bytes of its storage with Tender, and when the storage cannot hold them a storage
// deposit goes first, in the same approval.

/** The most funders a task can have, the poster among them (`MAX_FUNDERS` in the contract). */
export const MAX_FUNDERS = 50;

/**
 * The bytes a new funder's record adds to a task: the account id as Borsh writes it (a 4-byte length
 * and the id) and the u128 it paid in.
 */
export function funderRecordBytes(account: string): bigint {
  return BigInt(4 + new TextEncoder().encode(account).length + 16);
}

/** What the chain says of a top-up of one task by one account, read at one moment. */
export interface TopUpTerms {
  token: string;
  /** Whether Tender takes the token now, and whether top-ups are paused. */
  enabled: boolean;
  paused: boolean;
  minReward: bigint;
  maxReward: bigint;
  /** The task's reward now, and how many funders it has. */
  reward: bigint;
  funders: number;
  /** Whether the account funds the task already: then no minimum, and no new record. */
  isFunder: boolean;
  commitDeadline: bigint;
  settled: boolean;
  /** What the account's vault holds of the token. */
  vault: bigint;
  /** The account's storage with Tender; null if it has never set it up. */
  storage: StorageBalance | null;
}

function malformed(method: string): RpcError {
  return new RpcError(`${method} returned something other than what the contract promises`);
}

/** The terms of a top-up of `taskId` by `account`, from the chain. */
export async function readTopUpTerms(taskId: string, account: string): Promise<TopUpTerms> {
  const [configView, taskView, vault] = await Promise.all([
    view<unknown>(config.contractId, "get_config"),
    view<unknown>(config.contractId, "get_task", { task_id: taskId }),
    readVault(account),
  ]);
  const parsedConfig = ConfigViewSchema.safeParse(configView);
  if (!parsedConfig.success) throw malformed("get_config");
  const parsedTask = TaskViewSchema.safeParse(taskView);
  if (!parsedTask.success) throw malformed("get_task");
  const task = parsedTask.data;
  const limits = parsedConfig.data.tokens.find((one) => one.token === task.token);
  return {
    token: task.token,
    enabled: limits?.enabled ?? false,
    paused: parsedConfig.data.paused,
    minReward: BigInt(limits?.min_reward ?? "0"),
    maxReward: BigInt(limits?.max_reward ?? "0"),
    reward: BigInt(task.reward),
    funders: task.funders.length,
    isFunder: task.funders.some((funder) => funder.account === account),
    commitDeadline: BigInt(task.commit_deadline),
    settled: task.outcome !== null,
    vault: vault.rows.find((row) => row.token === task.token)?.vault ?? 0n,
    storage: vault.storage,
  };
}

/**
 * Why `amount` can't be added now, in words, or null. The rules are the contract's, in its order,
 * with the vault last, where the form says how much it holds. `amount` is more than 0: the field
 * refuses 0 itself (lib/vault.ts `readAmount`).
 */
export function topUpProblem(amount: bigint, terms: TopUpTerms, nowNs: bigint): string | null {
  const { token } = terms;
  if (terms.paused) return "Tender isn't taking top-ups right now.";
  if (terms.settled || nowNs >= terms.commitDeadline) {
    return "This task stopped taking top-ups: its commit window has closed.";
  }
  if (!terms.isFunder && terms.funders >= MAX_FUNDERS) {
    return `This task has ${MAX_FUNDERS} funders, the most it can have.`;
  }
  if (!terms.enabled) return "Tender isn't taking this token right now.";
  if (!terms.isFunder && amount < terms.minReward) {
    return `Your first top-up of a task must be at least ${describeAmount(terms.minReward, token)}.`;
  }
  if (terms.reward + amount > terms.maxReward) {
    return `That would take the reward past ${describeAmount(terms.maxReward, token)}, the most Tender takes for this token.`;
  }
  if (terms.storage === null) return "Set up your account on the Wallet page first.";
  if (amount > terms.vault) return "That's more than you have in the vault.";
  return null;
}

/** The NEAR, in yoctoNEAR, that goes into `account`'s storage first: 0 unless it is a new funder. */
export function topUpStorage(terms: TopUpTerms, account: string): bigint {
  if (terms.isFunder || terms.storage === null) return 0n;
  return storageShortfall(
    StorageViewSchema.parse({
      total: terms.storage.total.toString(),
      available: terms.storage.available.toString(),
      used_bytes: "0",
    }),
    funderRecordBytes(account),
  );
}

/** The calls of a top-up: a storage deposit if the record needs one, then `top_up_task`. */
export function planTopUp(input: {
  taskId: string;
  amount: bigint;
  storageTopUp: bigint;
}): TenderCall[] {
  const contract = config.contractId;
  return [
    ...(input.storageTopUp > 0n ? [storageDepositCall(contract, input.storageTopUp)] : []),
    topUpTaskCall(contract, BigInt(input.taskId), input.amount),
  ];
}

export type TopUpResult =
  /** The top-up went in: `reward` is the task's reward after it. */
  { kind: "toppedUp"; amount: string; reward: string } | { kind: "unknown" };

/** A top-up that did not happen, in words. Nothing changed on chain. */
export class TopUpFailure extends Error {
  constructor(words: string, cause?: unknown) {
    super(words, { cause });
    this.name = "TopUpFailure";
  }
}

export interface TopUpDeps {
  account(): string | null;
  readTerms(taskId: string, account: string): Promise<TopUpTerms>;
  signAndSend(calls: readonly TenderCall[]): Promise<SendResult>;
  nowNs(): bigint;
}

/**
 * Adds `amount` to task `taskId` from `account`'s vault. The terms are read again first, and a
 * top-up they refuse is not sent; neither is one whose storage deposit is more than the page showed
 * (`shownStorage`): the page reads the terms again and shows the new one.
 */
export async function submitTopUp(
  input: { taskId: string; account: string; amount: bigint; shownStorage: bigint },
  deps: TopUpDeps,
): Promise<TopUpResult> {
  const { taskId, account, amount } = input;
  let terms: TopUpTerms;
  try {
    terms = await deps.readTerms(taskId, account);
  } catch (cause) {
    throw new TopUpFailure("Couldn't read the task and your vault. Nothing was sent.", cause);
  }
  const problem = topUpProblem(amount, terms, deps.nowNs());
  if (problem !== null) throw new TopUpFailure(problem);
  const storageTopUp = topUpStorage(terms, account);
  if (storageTopUp > input.shownStorage) {
    throw new TopUpFailure("Your storage changed. Check the amounts and press Top up again.");
  }
  if (deps.account() !== account) {
    throw new TopUpFailure("The wallet was disconnected or changed, so nothing was sent.");
  }
  let sent: SendResult;
  try {
    sent = await deps.signAndSend(planTopUp({ taskId, amount, storageTopUp }));
  } catch (cause) {
    if (outcomeUnknown(cause)) {
      console.error(cause);
      return { kind: "unknown" };
    }
    throw new TopUpFailure(sendWords("topUp", cause), cause);
  }
  for (const event of sent.events) {
    if (
      event.event === "task_topped_up" &&
      event.data.task_id === taskId &&
      event.data.funder === account
    ) {
      return { kind: "toppedUp", amount: event.data.amount, reward: event.data.reward };
    }
  }
  return { kind: "unknown" };
}
