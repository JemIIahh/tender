/**
 * What the Telegram notifier tells people, before it is words. The notifier builds one of these
 * from an indexed event or a task row, `renderAlert` (render.ts) turns it into a message, and
 * `dedupeKey` names it for the `tg_sent` table so that no chat gets it twice.
 *
 * Numbers follow the contract's JSON and the database, and are strings so that none loses digits:
 * - `taskId` is the task's id, a u64 as a decimal string.
 * - `reward` and a winner's `amount` count the token's smallest unit, a u128 as a decimal string.
 * - A deadline is a block timestamp in nanoseconds since the Unix epoch, a u64 as a decimal string.
 *
 * `title` and every other string a person chose (tags, accounts, the scorecard URI) is untrusted:
 * `renderAlert` escapes it.
 */
export type Alert =
  /**
   * A task was posted. `taskId` is the `task_created` event's `data.id`: that event carries the id
   * as `id`, where every other task event calls it `task_id`.
   */
  | {
      kind: "new_task";
      taskId: string;
      title: string;
      reward: string;
      /** The reward token's account id. */
      token: string;
      tags: string[];
      /** When entries stop, the task's `commit_deadline`. */
      commitDeadline: string;
    }
  /**
   * An agent said it started work on the task (the off-chain `working` signal). `posterHears` is
   * whether the task's poster is told: not set means yes, and the notifier sets it to false for the
   * starters of a task after its first few, who reach only the chats of their own owners.
   */
  | { kind: "agent_started"; taskId: string; title: string; agent: string; posterHears?: boolean }
  /** The task received a sealed entry; `count` is how many it has now. */
  | { kind: "entry_committed"; taskId: string; title: string; count: number }
  /** The commit window is over and entries can be revealed. */
  | {
      kind: "reveal_open";
      taskId: string;
      title: string;
      /** The task's `reveal_deadline`. */
      revealDeadline: string;
    }
  /** The reveal window is about to end. */
  | {
      kind: "reveal_closing";
      taskId: string;
      title: string;
      /** The task's `reveal_deadline`. */
      revealDeadline: string;
    }
  /** The task was settled and its winners were paid. */
  | {
      kind: "winner_paid";
      taskId: string;
      title: string;
      token: string;
      winners: { account: string; amount: string }[];
      /** Where the verifier put the scorecard. A stranger chose it: only web links get linked. */
      scorecardUri: string;
    }
  /** The task was voided and its funders were refunded. */
  | {
      kind: "task_voided";
      taskId: string;
      title: string;
      reason: "no_reveals" | "no_award" | "expired";
    }
  /** Entries for the task close in `hoursLeft` hours. */
  | { kind: "deadline_reminder"; taskId: string; title: string; hoursLeft: 24 | 1 }
  /** Someone topped the task up; `reward` is the reward after that, `funders` how many fund it. */
  | {
      kind: "pool_grew";
      taskId: string;
      title: string;
      token: string;
      reward: string;
      funders: number;
    }
  /**
   * The poster answered a question. `questionId` names the question, whose asker the recipients are
   * found from (`resolveRecipients`). The asker always hears it. The task's other entrants hear it
   * too unless `entrantsHear` is false, which the notifier sets for the answers of a task after its
   * first few (`BOARD_ROW_ALERTS`): any account can ask, so a message for each would be a flood.
   * The words of the answer are a stranger's, and the poster may hide a question that was already
   * announced, so the alert never has them.
   */
  | {
      kind: "question_answered";
      taskId: string;
      title: string;
      questionId: string;
      entrantsHear?: boolean;
    }
  /**
   * The poster posted a clarification on the board. `clarificationId` is the board row's id. The
   * task's entrants hear it, one message for each, unless `entrantsHear` is false (see above).
   */
  | {
      kind: "clarification_posted";
      taskId: string;
      title: string;
      clarificationId: string;
      entrantsHear?: boolean;
    }
  /**
   * What is new on a task's public board, in one message: the counts, never the words. Two
   * audiences hear it, each of them at most once in 30 minutes for a task and at most
   * `BOARD_DIGESTS_PER_TASK` times in all, however much is written (the notifier keeps the count in
   * `tg_board_digests`): `for: "poster"` is the poster, told how many questions are waiting, and
   * `for: "watchers"` the chats that watch one of the task's tags (a task open to everyone), told
   * how many answers and clarifications there are. `last` is whether this is the last the chat will
   * hear of the task's board, which the message says.
   */
  | {
      kind: "board_digest";
      taskId: string;
      title: string;
      for: "poster" | "watchers";
      questions: number;
      answers: number;
      clarifications: number;
      last: boolean;
    };

/**
 * The key that names `a` in `tg_sent(chat_id, dedupe_key)`: a chat gets the alert whose key it has
 * not been sent yet, so two alerts that must both be sent need two keys, and a rebuilt copy of one
 * alert needs the same key.
 *
 * It is `<kind>:<taskId>`, and then the value that tells repeats of the kind apart:
 * - `agent_started:<taskId>:<agent>`, since each agent that starts is news;
 * - `entry_committed:<taskId>:<count>`, since every new entry is news, and a restart that rebuilds
 *   the alert for entry 3 still lands on the key of entry 3;
 * - `deadline_reminder:<taskId>:<hoursLeft>`, for the 24 h and the 1 h reminder;
 * - `pool_grew:<taskId>:<reward>`, so that each top-up, which raises the reward, is news;
 * - `question_answered:<taskId>:<questionId>` and `clarification_posted:<taskId>:<clarificationId>`,
 *   since every answer and every clarification is news of its own;
 * - `board_digest:<taskId>:<for>`, which only names it: a digest is claimed in `tg_board_digests`,
 *   with its window and its cap, and not in `tg_sent`.
 *
 * The other kinds happen once per task.
 */
export function dedupeKey(a: Alert): string {
  switch (a.kind) {
    case "agent_started":
      return `${a.kind}:${a.taskId}:${a.agent}`;
    case "entry_committed":
      return `${a.kind}:${a.taskId}:${a.count}`;
    case "deadline_reminder":
      return `${a.kind}:${a.taskId}:${a.hoursLeft}`;
    case "pool_grew":
      return `${a.kind}:${a.taskId}:${a.reward}`;
    case "question_answered":
      return `${a.kind}:${a.taskId}:${a.questionId}`;
    case "clarification_posted":
      return `${a.kind}:${a.taskId}:${a.clarificationId}`;
    case "board_digest":
      return `${a.kind}:${a.taskId}:${a.for}`;
    case "new_task":
    case "reveal_open":
    case "reveal_closing":
    case "winner_paid":
    case "task_voided":
      return `${a.kind}:${a.taskId}`;
    default: {
      const unexpected: never = a;
      throw new Error(`unknown alert: ${JSON.stringify(unexpected)}`);
    }
  }
}
