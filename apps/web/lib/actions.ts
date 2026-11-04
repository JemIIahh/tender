import type { Phase, TaskDetail } from "@tender/shared";
import { isJudgeAccount } from "./judge";
import { phaseOfTask } from "./phase";

// Who may do what on a task's page, by the contract's own rules: pick (`pick` in
// contract/tender/src/settle.rs), refund (`void_task`, same file) and top up (`top_up_task` in
// tasks.rs). The phase is the shared one (`phaseAt`), worked out from the deadlines for the moment
// given. The chain has the last word: what the page offers here, it offers because the contract
// would take it at that moment, and a call the contract refuses all the same is answered in words
// (lib/actionWords.ts).

/** The ids of the action controls on a task page, which other pages link to (`/tasks/7#pick`). */
export const ACTION_ANCHORS = ["pick", "refund", "top-up"] as const;
export type ActionAnchor = (typeof ACTION_ANCHORS)[number];

/** What a task's page shows under `#pick`, if anything. */
export type PickView =
  /** The Judge is the verifier and its window is open: no controls, only its state. */
  | { kind: "judge" }
  /**
   * The connected account may pick now: as the verifier in its window, or as the poster in the
   * fallback window after it. A poster who is also the verifier has both windows.
   */
  | { kind: "pick"; as: "verifier" | "poster" }
  /** Nobody is connected, and `account` may pick now. */
  | { kind: "connect"; account: string };

/** What a task's page shows under `#refund`, if anything. */
export type RefundView =
  /** `void_task` would go through now: anyone may send it. */
  | { kind: "open" }
  /**
   * It will go through from `atNs`, if nothing changes first: if nothing is revealed by then
   * (`ifNothingRevealed`), or if nobody picks by then.
   */
  | { kind: "opens"; atNs: bigint; ifNothingRevealed: boolean };

type Task = Pick<
  TaskDetail,
  | "created_at"
  | "commit_deadline"
  | "reveal_deadline"
  | "pick_deadline"
  | "fallback_deadline"
  | "outcome_kind"
  | "poster"
  | "verifier"
  | "reveal_count"
>;

/** The phase of `task` at `nowNs`, by the shared rule. */
export const phaseNow = (task: Task, nowNs: bigint): Phase => phaseOfTask(task, nowNs);

/**
 * What `#pick` shows to `account` (null: nobody is connected) at `nowNs`. The verifier picks from
 * the reveal deadline up to the pick deadline (`judging`), and the poster from there up to the
 * fallback deadline (`fallback`). The Judge's window shows its state to everyone, and no controls:
 * the Judge picks with its own key. Once the fallback deadline passes nobody can pick, and the
 * task can only be refunded.
 */
export function pickView(
  task: Task,
  account: string | null,
  judgeAccount: string | null,
  nowNs: bigint,
): PickView | null {
  const phase = phaseNow(task, nowNs);
  if (phase === "judging") {
    if (isJudgeAccount(task.verifier, judgeAccount)) return { kind: "judge" };
    if (account === null) return { kind: "connect", account: task.verifier };
    return account === task.verifier ? { kind: "pick", as: "verifier" } : null;
  }
  if (phase === "fallback") {
    if (account === null) return { kind: "connect", account: task.poster };
    return account === task.poster ? { kind: "pick", as: "poster" } : null;
  }
  return null;
}

/**
 * Whether `void_task` goes through for `task` at `nowNs`: it is not settled, and either its reveal
 * window is over with nothing revealed, or its fallback window is over. The windows are half-open,
 * so at the reveal deadline itself the reveal window is over.
 */
export function canRefund(task: Task, nowNs: bigint): boolean {
  if (task.outcome_kind !== null) return false;
  if (task.reveal_count === 0 && nowNs >= BigInt(task.reveal_deadline)) return true;
  return nowNs >= BigInt(task.fallback_deadline);
}

/**
 * What `#refund` shows at `nowNs`: nothing for a settled task, or one still in its commit window
 * (which takes top-ups, and whose entrants have not had their turn); else whether a refund can be
 * sent now, or from when it can be if nothing changes: the reveal deadline while nothing is
 * revealed, and the fallback deadline once something is.
 */
export function refundView(task: Task, nowNs: bigint): RefundView | null {
  if (task.outcome_kind !== null) return null;
  if (phaseNow(task, nowNs) === "open") return null;
  if (canRefund(task, nowNs)) return { kind: "open" };
  return task.reveal_count === 0
    ? { kind: "opens", atNs: BigInt(task.reveal_deadline), ifNothingRevealed: true }
    : { kind: "opens", atNs: BigInt(task.fallback_deadline), ifNothingRevealed: false };
}

/**
 * Whether `#top-up` shows at `nowNs`: the task takes top-ups until its commit deadline, from anyone
 * with the token in their vault. The rules about the amount are the form's (lib/topUp.ts).
 */
export function topUpOpen(task: Task, nowNs: bigint): boolean {
  return task.outcome_kind === null && phaseNow(task, nowNs) === "open";
}

/** The action a page's address asks for (`#pick`), if it names one. */
export function anchorOf(hash: string): ActionAnchor | null {
  const name = hash.startsWith("#") ? hash.slice(1) : hash;
  return (ACTION_ANCHORS as readonly string[]).includes(name) ? (name as ActionAnchor) : null;
}
