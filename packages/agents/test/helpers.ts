import {
  type Brief,
  type Phase,
  type PublicCriteria,
  sha256Hex,
  type TaskDetail,
  type TaskDetailResponse,
  type TaskOutcome,
  type TaskSummary,
} from "@tender/shared";
import type { TaskContext } from "../src/types";

// Fixtures for the runner's tests and the solvers': the documents a task points at and the three
// shapes the API describes it in. A `TaskSpec` is the part of a task that a test cares about, and
// everything else about it is filled in the same way each time.

export const ACCOUNT = "alice.test.near";
export const OTHER = "bob.test.near";
export const POSTER = "poster.test.near";
export const JUDGE = "judge.test.near";
export const TOKEN = "tusdc.test.near";

export const BRIEF: Brief = {
  version: 1,
  title: "A regex for versions",
  summary: "Write one regex.",
  instructions: "Reply with one JSON object: the pattern and its flags.",
  category: "coding",
  tags: ["regex"],
  output: { format: "regex_json", max_bytes: 2000 },
};

export const CRITERIA: PublicCriteria = {
  version: 1,
  kind: "regex_cases",
  min_score: 100,
  split: "winner_take_all",
  has_heldout: true,
  examples: { match: ["1.2.3"], no_match: ["1.2"] },
};

export interface TaskSpec {
  id: number;
  /** The tags of the task's brief. A listing by a tag finds the task only if it is among them. */
  tags: string[];
  phase: Phase;
  judgeStatus: string | null;
  judgeReason: string | null;
  outcome: TaskOutcome | null;
  /** Whether the index holds the task's brief and criteria. Without them the API sends null. */
  documents: boolean;
  /** The brief hash the chain holds. Default: a hash of the id. */
  briefHash?: string;
}

/** The task a test asks for, with the rest as a task that has just been posted and accepted. */
export function taskSpec(spec: Partial<TaskSpec> & { id: number }): TaskSpec {
  return {
    tags: ["regex"],
    phase: "open",
    judgeStatus: "accepted",
    judgeReason: null,
    outcome: null,
    documents: true,
    ...spec,
  };
}

export function taskSummary(spec: TaskSpec): TaskSummary {
  return {
    id: String(spec.id),
    title: `Task ${spec.id}`,
    category: "coding",
    tags: spec.tags,
    token: TOKEN,
    reward: "1000000",
    phase: spec.phase,
    poster: POSTER,
    verifier: JUDGE,
    created_at: "1000000000",
    commit_deadline: "2000000000",
    reveal_deadline: "3000000000",
    pick_deadline: "4000000000",
    fallback_deadline: "5000000000",
    commit_count: 0,
    reveal_count: 0,
    working_count: 0,
    judge_status: spec.judgeStatus,
    judge_reason: spec.judgeReason,
    is_team_poster: true,
    parent: null,
    outcome_kind: spec.outcome?.kind ?? null,
  };
}

export function taskDetail(spec: TaskSpec): TaskDetail {
  return {
    ...taskSummary(spec),
    brief_uri: `https://api.test/v1/blobs/brief-${spec.id}`,
    brief_hash: spec.briefHash ?? sha256Hex(`brief of task ${spec.id}`),
    criteria_hash: sha256Hex(`criteria of task ${spec.id}`),
    heldout_commitment: null,
    max_entries: 0,
    max_winners: 1,
    invited: [],
    fee_bps: 500,
    outcome: spec.outcome,
  };
}

export function taskDetailResponse(spec: TaskSpec): TaskDetailResponse {
  return {
    task: taskDetail(spec),
    brief: spec.documents ? BRIEF : null,
    criteria: spec.documents ? CRITERIA : null,
    entries: [],
    funders: [],
    children: [],
    scorecard: null,
  };
}

export function contextOf(spec: TaskSpec): TaskContext {
  return { task: taskDetail(spec), brief: BRIEF, criteria: CRITERIA };
}

/** A pick that pays `winner` all of the reward but the fee. */
export function picked(taskId: number, winner: string, amount = "950000"): TaskOutcome {
  return {
    kind: "picked",
    task_id: String(taskId),
    by: JUDGE,
    winners: [{ account: winner, bps: 10_000, amount }],
    fee: "50000",
    scorecard_hash: sha256Hex(`scorecard of task ${taskId}`),
    scorecard_uri: `https://api.test/v1/scorecards/${taskId}`,
  };
}

/** A void with the reason it was voided for. */
export function voided(taskId: number, reason: "no_reveals" | "no_award" | "expired"): TaskOutcome {
  return {
    kind: "voided",
    task_id: String(taskId),
    reason,
    by: null,
    scorecard_hash: null,
    scorecard_uri: null,
  };
}
