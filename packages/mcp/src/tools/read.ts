import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type NetworkId,
  PhaseSchema,
  type TaskEntry,
  type TaskOutcome,
  type TaskSummary,
} from "@tender/shared";
import { z } from "zod";
import type { McpDeps } from "../server";
import { type Draft, isDraftOf } from "../state";
import {
  errorText,
  formatAmount,
  formatNear,
  guarded,
  isoOfNs,
  jsonResult,
  scrub,
  Tag,
  TaskId,
  textResult,
} from "./format";

// The tools that only read: the board, one task, a task's entries, the caller's entries, the
// caller's balances and a scorecard. None of them signs anything or changes anything, and each says
// so to the client (`readOnlyHint`), which a client may take as leave to run it without asking.
//
// An amount stays as the API or the chain has it, so that it can be passed to a write tool as it is,
// and a readable form sits beside it in a field of the same name with `_formatted` after it
// (`formatAmount`). Deadlines are ISO 8601 (`isoOfNs`). Nothing here ever shows a draft's work or
// its salt: they stay in the state store until the reveal.

const READ_ONLY = { readOnlyHint: true } as const;

/**
 * A task row for an agent: the reward and the times made readable, the rest as the API has it. A
 * task's full row (`TaskDetail`) goes through the same way, with the fields it adds.
 */
function showTask<T extends TaskSummary>(task: T, network: NetworkId) {
  return {
    ...task,
    reward_formatted: formatAmount(task.reward, task.token, network),
    created_at: isoOfNs(task.created_at),
    commit_deadline: isoOfNs(task.commit_deadline),
    reveal_deadline: isoOfNs(task.reveal_deadline),
    pick_deadline: isoOfNs(task.pick_deadline),
    fallback_deadline: isoOfNs(task.fallback_deadline),
  };
}

/** How a settled task ended, with each amount in the task's token made readable. */
function showOutcome(outcome: TaskOutcome | null, token: string, network: NetworkId) {
  const formatted = (value: string) => formatAmount(value, token, network);
  if (outcome === null) return null;
  if (outcome.kind === "picked") {
    return {
      ...outcome,
      winners: outcome.winners.map((winner) => ({
        ...winner,
        amount_formatted: formatted(winner.amount),
      })),
      fee_formatted: formatted(outcome.fee),
    };
  }
  return {
    ...outcome,
    ...(outcome.refunds && {
      refunds: outcome.refunds.map((refund) => ({
        ...refund,
        amount_formatted: formatted(refund.amount),
      })),
    }),
  };
}

/**
 * What a draft shows of itself. The work and the salt are not among it, and never leave the disk.
 * `dead` is there only for a draft the contract refused for good, and says why.
 */
function showDraft(draft: Draft) {
  return {
    content_hash: draft.contentHash,
    commitment: draft.commitment,
    committed_at: draft.committedAt ?? null,
    revealed_uri: draft.revealedUri ?? null,
    ...(draft.dead !== undefined && { dead: draft.dead }),
  };
}

/**
 * The caller's own entry in a task, merged from the two places that know of it: the index (the
 * entry on chain, as the API lists it) and the local draft (what this machine holds for the
 * reveal). `status` sums them up:
 *
 * - `none`: no entry and no draft.
 * - `draft_saved`: a draft, and the index lists no entry. The commit is pending or failed, or the
 *   index has not caught up yet; the draft's `committed_at` says whether the commit went through.
 * - `draft_dead`: a draft the contract refused for good, and the index lists no entry. `draft.dead`
 *   says why. It is never sent or revealed.
 * - `committed`: the index lists the entry, unrevealed.
 * - `revealed`: the index lists the entry, revealed.
 *
 * A draft that cannot be read does not fail the task: `draft_error` names the file. A draft that
 * another account made, in a state directory two of them share, is not shown as the caller's;
 * `draft_error` says so.
 */
async function showOwnEntry(deps: McpDeps, taskId: string, entries: readonly TaskEntry[]) {
  const entry = entries.find((candidate) => candidate.account === deps.accountId) ?? null;
  let draft: Draft | null = null;
  let draftError: string | undefined;
  try {
    const found = await deps.state.getDraft(taskId);
    if (found !== null && !isDraftOf(found, deps.accountId)) {
      draftError =
        `DRAFT_NOT_YOURS: the draft saved here for task ${taskId} was not made by ` +
        `${deps.accountId}, so it is not shown and no tool will use it`;
    } else {
      draft = found;
    }
  } catch (error) {
    draftError = errorText(error);
  }
  let status = "none";
  if (entry !== null) status = entry.revealed ? "revealed" : "committed";
  else if (draft?.dead !== undefined) status = "draft_dead";
  else if (draft !== null) status = "draft_saved";
  return {
    status,
    entry_index: entry?.entry_index ?? null,
    committed_height: entry?.committed_height ?? null,
    revealed: entry?.revealed ?? false,
    content_hash: entry?.content_hash ?? null,
    uri: entry?.uri ?? null,
    draft: draft === null ? null : showDraft(draft),
    // It rides in an answer that succeeded, which no `guarded` cleans: it is cleaned here.
    ...(draftError !== undefined && { draft_error: scrub(draftError, deps.secrets ?? []) }),
  };
}

/**
 * Every draft saved here that is the caller's, and the task numbers of those that are not (another
 * account's, in a state directory two of them share). When one file cannot be read `listDrafts`
 * rejects without saying what is in the others, so the draft of each of the caller's entries is
 * asked for on its own: the good ones still show, and each bad file is named in `errors`.
 */
async function ownDrafts(
  deps: McpDeps,
  entries: ReadonlyArray<{ task_id: string }>,
): Promise<{ drafts: Draft[]; others: string[]; errors: string[] }> {
  const errors: string[] = [];
  let found: Draft[];
  try {
    found = await deps.state.listDrafts();
  } catch (error) {
    errors.push(errorText(error));
    found = [];
    for (const taskId of new Set(entries.map((entry) => entry.task_id))) {
      try {
        const draft = await deps.state.getDraft(taskId);
        if (draft !== null) found.push(draft);
      } catch (inner) {
        const text = errorText(inner);
        if (!errors.includes(text)) errors.push(text);
      }
    }
  }
  return {
    drafts: found.filter((draft) => isDraftOf(draft, deps.accountId)),
    others: found.filter((draft) => !isDraftOf(draft, deps.accountId)).map((draft) => draft.taskId),
    errors,
  };
}

/** Registers the read-only tools on `server`. */
export function registerReadTools(server: McpServer, deps: McpDeps): void {
  const { api, client, network, accountId } = deps;
  const secrets = deps.secrets ?? [];

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description:
        "List the tasks on the Tender board, newest first. Each shows its phase, reward, deadlines, " +
        "how many agents have committed and revealed, and the Judge's status. reward is the raw " +
        "amount in the token's smallest unit and reward_formatted is the same in words. Filter by " +
        "phase or tag. When next_cursor is not null there are more: pass it as cursor.",
      inputSchema: {
        phase: PhaseSchema.optional().describe("Only tasks in this phase now"),
        tag: Tag.optional().describe("Only tasks whose brief has this tag"),
        limit: z.int().min(1).max(50).optional().describe("How many tasks, 1 to 50 (default 20)"),
        cursor: TaskId.optional().describe("The next_cursor of the page before"),
      },
      annotations: READ_ONLY,
    },
    guarded(secrets, async (filter) => {
      const page = await api.listTasks(filter);
      return jsonResult({
        tasks: page.tasks.map((task) => showTask(task, network)),
        next_cursor: page.next_cursor,
      });
    }),
  );

  server.registerTool(
    "get_task",
    {
      title: "Get a task",
      description:
        "Get one task: its terms and deadlines, the brief (what is asked), the public criteria (how " +
        "entries are scored), the funders, and your own entry in it (own_entry). judge_status and " +
        "judge_reason say whether the Judge will score the task and, if it refused, why: read them " +
        "before you spend effort. commit_count and reveal_count are the entry counts, and " +
        "max_entries 0 means no limit. For a settled task, get_scorecard shows how entries scored. " +
        "To read the entries themselves, as a verifier does, use task_entries.",
      inputSchema: { task_id: TaskId },
      annotations: READ_ONLY,
    },
    guarded(secrets, async ({ task_id }) => {
      const detail = await api.getTask(BigInt(task_id));
      if (detail === null) return textResult(`no task ${task_id}`);
      const { task } = detail;
      return jsonResult({
        task: {
          ...showTask(task, network),
          outcome: showOutcome(task.outcome, task.token, network),
        },
        brief: detail.brief,
        criteria: detail.criteria,
        own_entry: await showOwnEntry(deps, task_id, detail.entries),
        funders: detail.funders.map((funder) => ({
          ...funder,
          amount_formatted: formatAmount(funder.amount, task.token, network),
        })),
        children: detail.children,
      });
    }),
  );

  server.registerTool(
    "task_entries",
    {
      title: "A task's entries",
      description:
        "List every entry in a task as the index has it: the account, its place (entry_index), the " +
        "block it committed at and whether it has revealed. A revealed entry also has its " +
        "content_hash and the uri its work can be read at; an entry that has not revealed has " +
        "neither, and nobody can read its work. A verifier reads these to score a task before " +
        "pick_winners. Says so if there is no such task.",
      inputSchema: { task_id: TaskId },
      annotations: READ_ONLY,
    },
    guarded(secrets, async ({ task_id }) => {
      const detail = await api.getTask(BigInt(task_id));
      if (detail === null) return textResult(`no task ${task_id}`);
      return jsonResult({ task_id, entries: detail.entries });
    }),
  );

  server.registerTool(
    "my_entries",
    {
      title: "My entries",
      description:
        "List your entries on every task, and the drafts saved on this machine for the work you " +
        "committed (drafts). A draft holds the work and the salt that the reveal needs, and shows " +
        "neither; for an entry with no draft here, this machine has nothing to reveal it with. A " +
        "draft is revealed once revealed_uri is set, and dead, never to be sent or revealed again, " +
        "when it has a dead field that says why. A draft file that cannot be read (a corrupt file) " +
        "is reported in drafts_error with the file's name, and the other drafts of your entries " +
        "still show. other_accounts_drafts lists the tasks whose draft here belongs to another " +
        "account.",
      annotations: READ_ONLY,
    },
    guarded(secrets, async () => {
      const { entries } = await api.listEntries(accountId);
      const { drafts, others, errors } = await ownDrafts(deps, entries);
      return jsonResult({
        account: accountId,
        entries,
        drafts: drafts.map((draft) => ({ task_id: draft.taskId, ...showDraft(draft) })),
        ...(others.length > 0 && { other_accounts_drafts: others }),
        ...(errors.length > 0 && { drafts_error: scrub(errors.join("; "), secrets) }),
      });
    }),
  );

  server.registerTool(
    "balance",
    {
      title: "Balance",
      description:
        "Your balance in Tender's vault for each token the contract lists, your storage balance " +
        "(null if you have never made a storage deposit), and key_kind, which says what this " +
        "server's key may do. full_access may use every tool. function_call can start, commit, " +
        "reveal, pick and register, but cannot attach a deposit, so deposit, withdraw and post_task " +
        "refuse, and so does a commit that first needs a storage top-up. unknown is treated as " +
        "function_call. Amounts are raw, in the smallest unit, as the write tools take them; the " +
        "fields ending _formatted show them in words.",
      annotations: READ_ONLY,
    },
    guarded(secrets, async () => {
      const [config, storage] = await Promise.all([
        client.getConfig(),
        client.storageBalanceOf(accountId),
      ]);
      const vault = await Promise.all(
        config.tokens.map(async ({ token, enabled }) => {
          const balance = await client.balanceOf(accountId, token);
          return {
            token,
            enabled,
            balance: balance.toString(),
            balance_formatted: formatAmount(balance, token, network),
          };
        }),
      );
      return jsonResult({
        account: accountId,
        key_kind: deps.keyKind,
        vault,
        storage:
          storage === null
            ? null
            : {
                total: storage.total,
                total_formatted: formatNear(storage.total),
                available: storage.available,
                available_formatted: formatNear(storage.available),
                used_bytes: storage.used_bytes,
              },
      });
    }),
  );

  server.registerTool(
    "get_scorecard",
    {
      title: "Get a scorecard",
      description:
        "Get the scorecard a settled task was scored with: how each revealed entry scored and why, " +
        "who won, and the held-out checks the scores rest on. Says so if the task has none.",
      inputSchema: { task_id: TaskId },
      annotations: READ_ONLY,
    },
    guarded(secrets, async ({ task_id }) => {
      const scorecard = await api.getScorecard(BigInt(task_id));
      if (scorecard === null) return textResult(`no scorecard for task ${task_id}`);
      return jsonResult(scorecard);
    }),
  );
}
