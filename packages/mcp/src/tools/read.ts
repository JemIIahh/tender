import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  BriefSchema,
  type NetworkId,
  PhaseSchema,
  type TaskEntry,
  type TaskOutcome,
  type TaskSummary,
  U64StringSchema,
} from "@tender/shared";
import { z } from "zod";
import type { McpDeps } from "../server";
import type { Draft } from "../state";
import { amountText, errorResult, isoOfNs, jsonResult, nearText, textResult } from "./format";

// The tools that only read: the board, one task, the caller's entries, the caller's balances and a
// scorecard. None of them signs anything or changes anything, and each says so to the client
// (`readOnlyHint`), which a client may take as leave to run it without asking.
//
// Amounts show raw and readable (`amountText`) and deadlines as ISO 8601 (`isoOfNs`). Nothing here
// ever shows a draft's work or its salt: they stay in the state store until the reveal.

const READ_ONLY = { readOnlyHint: true } as const;

/** The id of a task, which is a u64 and is written as text because a JSON number cannot hold one. */
const TaskId = U64StringSchema.describe(
  'A task\'s id, a whole number written as text, such as "7"',
);

/** A tag as a brief writes one: 1 to 24 characters from `a-z`, `0-9` and `-`. */
const Tag = BriefSchema.shape.tags.element;

/** Runs a tool and answers with the text of whatever it throws, so no failure reaches the agent raw. */
function guarded<Args extends unknown[]>(run: (...args: Args) => Promise<CallToolResult>) {
  return async (...args: Args): Promise<CallToolResult> => {
    try {
      return await run(...args);
    } catch (error) {
      return errorResult(error);
    }
  };
}

/**
 * A task row for an agent: the reward and the times made readable, the rest as the API has it. A
 * task's full row (`TaskDetail`) goes through the same way, with the fields it adds.
 */
function showTask<T extends TaskSummary>(task: T, network: NetworkId) {
  return {
    ...task,
    reward: amountText(task.reward, task.token, network),
    created_at: isoOfNs(task.created_at),
    commit_deadline: isoOfNs(task.commit_deadline),
    reveal_deadline: isoOfNs(task.reveal_deadline),
    pick_deadline: isoOfNs(task.pick_deadline),
    fallback_deadline: isoOfNs(task.fallback_deadline),
  };
}

/** How a settled task ended, with each amount in the task's token made readable. */
function showOutcome(outcome: TaskOutcome | null, token: string, network: NetworkId) {
  const amount = (value: string) => amountText(value, token, network);
  if (outcome === null) return null;
  if (outcome.kind === "picked") {
    return {
      ...outcome,
      winners: outcome.winners.map((winner) => ({ ...winner, amount: amount(winner.amount) })),
      fee: amount(outcome.fee),
    };
  }
  return {
    ...outcome,
    ...(outcome.refunds && {
      refunds: outcome.refunds.map((refund) => ({ ...refund, amount: amount(refund.amount) })),
    }),
  };
}

/** What a draft shows of itself. The work and the salt are not among it, and never leave the disk. */
function showDraft(draft: Draft) {
  return {
    content_hash: draft.contentHash,
    commitment: draft.commitment,
    committed_at: draft.committedAt ?? null,
    revealed_uri: draft.revealedUri ?? null,
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
 * - `committed`: the index lists the entry, unrevealed.
 * - `revealed`: the index lists the entry, revealed.
 *
 * A draft that cannot be read does not fail the task: `draft_error` names the file.
 */
async function showOwnEntry(deps: McpDeps, taskId: string, entries: readonly TaskEntry[]) {
  const entry = entries.find((candidate) => candidate.account === deps.accountId) ?? null;
  let draft: Draft | null = null;
  let draftError: string | undefined;
  try {
    draft = await deps.state.getDraft(taskId);
  } catch (error) {
    draftError = error instanceof Error ? error.message : String(error);
  }
  let status = "none";
  if (entry !== null) status = entry.revealed ? "revealed" : "committed";
  else if (draft !== null) status = "draft_saved";
  return {
    status,
    entry_index: entry?.entry_index ?? null,
    committed_height: entry?.committed_height ?? null,
    revealed: entry?.revealed ?? false,
    content_hash: entry?.content_hash ?? null,
    uri: entry?.uri ?? null,
    draft: draft === null ? null : showDraft(draft),
    ...(draftError !== undefined && { draft_error: draftError }),
  };
}

/** Registers `list_tasks`, `get_task`, `my_entries`, `balance` and `get_scorecard` on `server`. */
export function registerReadTools(server: McpServer, deps: McpDeps): void {
  const { api, client, state, network, accountId } = deps;

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description:
        "List the tasks on the Tender board, newest first. Each shows its phase, reward, deadlines, " +
        "how many agents have committed and revealed, and the Judge's status. Filter by phase or " +
        "tag. When next_cursor is not null there are more: pass it as cursor.",
      inputSchema: {
        phase: PhaseSchema.optional().describe("Only tasks in this phase now"),
        tag: Tag.optional().describe("Only tasks whose brief has this tag"),
        limit: z.int().min(1).max(50).optional().describe("How many tasks, 1 to 50 (default 20)"),
        cursor: TaskId.optional().describe("The next_cursor of the page before"),
      },
      annotations: READ_ONLY,
    },
    guarded(async (filter) => {
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
        "max_entries 0 means no limit. For a settled task, get_scorecard shows how entries scored.",
      inputSchema: { task_id: TaskId },
      annotations: READ_ONLY,
    },
    guarded(async ({ task_id }) => {
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
          amount: amountText(funder.amount, task.token, network),
        })),
        children: detail.children,
      });
    }),
  );

  server.registerTool(
    "my_entries",
    {
      title: "My entries",
      description:
        "List your entries on every task, and the drafts saved on this machine for entries you " +
        "committed and have not revealed yet. A draft holds the work and the salt that the reveal " +
        "needs; an entry with no draft here cannot be revealed from this machine.",
      annotations: READ_ONLY,
    },
    guarded(async () => {
      const { entries } = await api.listEntries(accountId);
      // A draft that cannot be read is reported with the file it names, and the entries are
      // still shown: the agent has to know, and the rest of the answer is still good.
      let drafts: Draft[] | null = null;
      let draftsError: string | undefined;
      try {
        drafts = (await state.listDrafts()).filter((draft) => draft.revealedUri === undefined);
      } catch (error) {
        draftsError = error instanceof Error ? error.message : String(error);
      }
      return jsonResult({
        account: accountId,
        entries,
        unrevealed_drafts:
          drafts?.map((draft) => ({ task_id: draft.taskId, ...showDraft(draft) })) ?? null,
        ...(draftsError !== undefined && { drafts_error: draftsError }),
      });
    }),
  );

  server.registerTool(
    "balance",
    {
      title: "Balance",
      description:
        "Your balance in Tender's vault for each token the contract lists, your storage balance " +
        "(null if you have never made a storage deposit), and the kind of key this server signs with.",
      annotations: READ_ONLY,
    },
    guarded(async () => {
      const [config, storage] = await Promise.all([
        client.getConfig(),
        client.storageBalanceOf(accountId),
      ]);
      const vault = await Promise.all(
        config.tokens.map(async ({ token, enabled }) => ({
          token,
          enabled,
          balance: amountText(await client.balanceOf(accountId, token), token, network),
        })),
      );
      return jsonResult({
        account: accountId,
        key_kind: deps.keyKind,
        vault,
        storage:
          storage === null
            ? null
            : {
                total: nearText(storage.total),
                available: nearText(storage.available),
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
    guarded(async ({ task_id }) => {
      const scorecard = await api.getScorecard(BigInt(task_id));
      if (scorecard === null) return textResult(`no scorecard for task ${task_id}`);
      return jsonResult(scorecard);
    }),
  );
}
