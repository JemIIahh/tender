import { formatTokenAmount, type NetworkId, tokenMeta, U64StringSchema } from "@tender/shared";
import type { Alert } from "./alerts";

/** What `renderAlert` needs besides the alert. */
export interface RenderContext {
  /** Where the web app is served, such as `https://tender.example`. A trailing slash is fine. */
  webUrl: string;
  /** The network the task lives on. The symbol and decimals of a token depend on it. */
  network: NetworkId;
  /** What the relative times, such as "2 h 5 min", count from. */
  now: Date;
}

const ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

/**
 * `s` as plain text for a message sent with Telegram's HTML parse mode. Telegram reads `<`, `>` and
 * `&` as markup, and a `"` would end an attribute, so each becomes one of the four entities that
 * Telegram knows. Text that already looks like an entity, such as `&lt;`, is escaped too, so it
 * shows as typed.
 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (char) => ENTITIES[char] ?? char);
}

const VOID_REASON_TEXT: Record<Extract<Alert, { kind: "task_voided" }>["reason"], string> = {
  no_reveals: "no entry was revealed",
  no_award: "no entry met the criteria",
  expired: "nobody picked a winner in time",
};

const NS_PER_MS = 1_000_000n;
const MS_PER_MINUTE = 60_000n;
const MINUTES_PER_HOUR = 60n;
const MINUTES_PER_DAY = 1_440n;

/**
 * How far `deadlineNs` is from `now`, in whole minutes: "9 min", "2 h 5 min", "1 d 1 h". A day or
 * more drops the minutes. Under a minute, and a deadline that has passed, read "under 1 min".
 * Throws a `SyntaxError` on a deadline that is not a u64 as a decimal string.
 */
function timeLeft(deadlineNs: string, now: Date): string {
  if (!U64StringSchema.safeParse(deadlineNs).success) {
    throw new SyntaxError(
      `a deadline is nanoseconds as a decimal string, got ${JSON.stringify(deadlineNs)}`,
    );
  }
  const minutes = (BigInt(deadlineNs) / NS_PER_MS - BigInt(now.getTime())) / MS_PER_MINUTE;
  if (minutes < 1n) return "under 1 min";
  if (minutes >= MINUTES_PER_DAY) {
    const days = minutes / MINUTES_PER_DAY;
    const hours = (minutes % MINUTES_PER_DAY) / MINUTES_PER_HOUR;
    return hours === 0n ? `${days} d` : `${days} d ${hours} h`;
  }
  if (minutes >= MINUTES_PER_HOUR) {
    const hours = minutes / MINUTES_PER_HOUR;
    const rest = minutes % MINUTES_PER_HOUR;
    return rest === 0n ? `${hours} h` : `${hours} h ${rest} min`;
  }
  return `${minutes} min`;
}

/**
 * `raw`, a count of `token`'s smallest unit, as people write it: "1.25 USDC". A token that the
 * shared table does not know shows raw units and its account id. Throws if `raw` is not digits.
 */
function money(raw: string, token: string, network: NetworkId): string {
  const { symbol, decimals } = tokenMeta(token, network);
  return `${formatTokenAmount(raw, decimals)} ${escapeHtml(symbol)}`;
}

/**
 * `uri` as the URL parser writes it, if it is an http(s) link, else null. The verifier picks the
 * scorecard URI, and Telegram opens more than web pages: a `tg://` link acts on the reader's
 * account.
 */
function webLink(uri: string): string | null {
  const url = URL.parse(uri);
  return url !== null && (url.protocol === "https:" || url.protocol === "http:") ? url.href : null;
}

/** The lines of the message above its task link. */
function bodyLines(a: Alert, ctx: RenderContext): string[] {
  const title = escapeHtml(a.title);
  switch (a.kind) {
    case "new_task":
      return [
        `<b>New task</b> · ${title}`,
        [
          money(a.reward, a.token, ctx.network),
          ...a.tags.map((tag) => escapeHtml(tag)),
          `entries close in ${timeLeft(a.commitDeadline, ctx.now)}`,
        ].join(" · "),
      ];
    case "agent_started":
      return [`<b>Agent working</b> · ${escapeHtml(a.agent)} started “${title}”`];
    case "entry_committed": {
      const entries = a.count === 1 ? "entry" : "entries";
      return [`<b>Entry received</b> · ${title} now has ${a.count} sealed ${entries}`];
    }
    case "reveal_open": {
      const left = timeLeft(a.revealDeadline, ctx.now);
      return [`<b>Reveal now</b> · ${title} · reveal window closes in ${left}`];
    }
    case "reveal_closing": {
      const left = timeLeft(a.revealDeadline, ctx.now);
      return [`<b>Reveal closing</b> · ${title} · ${left} left to reveal`];
    }
    case "winner_paid": {
      const scorecard = webLink(a.scorecardUri);
      return [
        `<b>Paid</b> · ${title}`,
        ...a.winners.map(
          (winner) =>
            `${escapeHtml(winner.account)} won ${money(winner.amount, a.token, ctx.network)}`,
        ),
        ...(scorecard === null ? [] : [`<a href="${escapeHtml(scorecard)}">Scorecard</a>`]),
      ];
    }
    case "task_voided":
      return [`<b>Refunded</b> · ${title} · ${VOID_REASON_TEXT[a.reason]}`];
    case "deadline_reminder":
      return [`<b>${a.hoursLeft} h left</b> · entries for ${title} close soon`];
    case "pool_grew": {
      const pays = money(a.reward, a.token, ctx.network);
      const backers = a.funders === 1 ? "backer" : "backers";
      return [`<b>Pool grew</b> · ${title} now pays ${pays} from ${a.funders} ${backers}`];
    }
    default: {
      const unexpected: never = a;
      throw new Error(`unknown alert: ${JSON.stringify(unexpected)}`);
    }
  }
}

/**
 * `a` as a message for Telegram's HTML parse mode: a few lines, ending with a link to the task on
 * the web app. Everything a person wrote is escaped, so a title such as `<b>&co` shows as typed.
 *
 * Throws on an amount that is not a decimal string or a deadline that is not a u64 string. The
 * contract and the database never give those, so it means the caller built the alert wrong.
 */
export function renderAlert(a: Alert, ctx: RenderContext): string {
  const taskUrl = `${ctx.webUrl.replace(/\/+$/, "")}/tasks/${a.taskId}`;
  return [...bodyLines(a, ctx), `<a href="${escapeHtml(taskUrl)}">Open task</a>`].join("\n");
}
