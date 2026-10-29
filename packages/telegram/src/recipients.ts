import type { Db } from "@tender/db";
import type { Alert } from "./alerts";

/**
 * The accounts an alert can name, each as a query that returns them in a column `account`. `$1` is
 * the task's id and `$2`, in `agent_started` only, the agent.
 *
 * An entry is revealed once it has a `content_hash`. The column stays null from the commit until
 * the `revealed` event sets it, together with `uri`.
 */
const ACCOUNTS = {
  poster: "select poster as account from tasks where id = $1::numeric",
  verifier: "select verifier as account from tasks where id = $1::numeric",
  funders: "select account from funders where task_id = $1::numeric",
  committers: "select account from entries where task_id = $1::numeric",
  revealers: "select account from entries where task_id = $1::numeric and content_hash is not null",
  unrevealed: "select account from entries where task_id = $1::numeric and content_hash is null",
  agent: "select $2::text as account",
} as const;

type Role = keyof typeof ACCOUNTS;

/**
 * Who hears about an alert. The plan's table says "chats" for some roles and "owner chats" for
 * others, and the two differ:
 * - the chats of an account are the chats linked to that account;
 * - its owner chats are those, plus the chats linked to its ASP, as its row in `agents` names it.
 *   An account that never registered as an agent has no ASP, whatever its name looks like.
 */
interface Audience {
  /** The roles whose own chats hear the alert. */
  chatsOf?: readonly Role[];
  /** The roles whose owner chats hear the alert. */
  ownerChatsOf?: readonly Role[];
  /** Whether the chats watching any of the task's tags hear the alert. */
  watchers?: boolean;
}

/** The table of plan 04, Task 2, row by row. */
function audienceOf(a: Alert): Audience {
  switch (a.kind) {
    case "new_task":
      return { ownerChatsOf: ["poster"], watchers: true };
    case "agent_started":
      return { chatsOf: ["poster"], ownerChatsOf: ["agent"] };
    case "entry_committed":
      return { chatsOf: ["poster"] };
    case "reveal_open":
      // The verifier is often the Judge, a sub-account that nobody can link a chat to. Its owner
      // can link the ASP instead, so the verifier's owner chats hear, not only its own.
      return { ownerChatsOf: ["verifier", "committers"] };
    case "reveal_closing":
      return { ownerChatsOf: ["unrevealed"] };
    case "winner_paid":
      // Every revealer hears, not only the winners the alert lists.
      return { chatsOf: ["poster"], ownerChatsOf: ["verifier", "revealers"] };
    case "task_voided":
      return { chatsOf: ["poster", "funders"] };
    case "deadline_reminder":
      return { chatsOf: ["poster"], ownerChatsOf: ["committers"] };
    case "pool_grew":
      return { chatsOf: ["poster", "funders"], watchers: true };
    default: {
      const unexpected: never = a;
      throw new Error(`unknown alert: ${JSON.stringify(unexpected)}`);
    }
  }
}

const NO_ACCOUNTS = "select null::text as account where false";
const NO_CHATS = "select null::bigint as chat_id where false";

/**
 * The chats that watch one of the tags on the task's row. `tags` is a jsonb array of strings and
 * `?` asks whether it has the string as an element, so a whole tag matches and a piece of one does
 * not.
 *
 * A task with invitees (`invited` is not the empty array) is not announced to watchers, because
 * they cannot enter it. Its poster, funders and entrants hear as usual.
 */
const WATCHERS = `
  select w.chat_id
  from tg_watches w
  join tasks t on t.id = $1::numeric
  where t.tags ? w.tag and t.invited = '[]'::jsonb`;

/**
 * The one statement that finds an audience's chats: the chats linked to the accounts it names and
 * to the ASPs of its owners, plus its watchers, less every muted chat. `tg_links.muted` is the only
 * place a mute is kept, so a watching chat with no link cannot be muted.
 *
 * Nothing a caller passes is spliced into the text. The pieces are the constants above and every
 * value reaches the database as a parameter.
 */
function queryFor({ chatsOf = [], ownerChatsOf = [], watchers = false }: Audience): string {
  const accountsOf = (roles: readonly Role[]) =>
    roles.length === 0 ? NO_ACCOUNTS : roles.map((role) => ACCOUNTS[role]).join(" union ");
  return `
    with
      direct_accounts as (${accountsOf(chatsOf)}),
      owner_accounts as (${accountsOf(ownerChatsOf)}),
      candidates as (
        select chat_id from tg_links where account in (select account from direct_accounts)
        union
        select chat_id from tg_links where account in (select account from owner_accounts)
        union
        select chat_id from tg_links where account in (
          select asp from agents
          where asp is not null and account in (select account from owner_accounts)
        )
        union
        ${watchers ? WATCHERS : NO_CHATS}
      )
    select c.chat_id::text as chat_id
    from candidates c
    where not exists (select 1 from tg_links m where m.chat_id = c.chat_id and m.muted)
    order by c.chat_id`;
}

/**
 * The chats that hear about `a`: their ids as decimal strings (a chat id is a bigint), each once,
 * lowest first. It runs one query, whatever the kind. `audienceOf` says who hears what.
 *
 * - A muted chat hears nothing.
 * - Chats that watch a tag hear `new_task` and `pool_grew` only for a task open to everyone: one
 *   with invitees stays off them.
 * - The poster, verifier, committers, funders and tags all come from the database by `a.taskId`,
 *   and `new_task`'s own `tags` are not read. A task that is not in the database therefore reaches
 *   nobody, except that `agent_started` still reaches the owner chats of the agent it names.
 */
export async function resolveRecipients(db: Db, a: Alert): Promise<string[]> {
  const sql = queryFor(audienceOf(a));
  const params = a.kind === "agent_started" ? [a.taskId, a.agent] : [a.taskId];
  const rows = await db.query<{ chat_id: string }>(sql, params);
  return rows.map((row) => row.chat_id);
}
