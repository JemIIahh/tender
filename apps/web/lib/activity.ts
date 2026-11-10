import { isHireTask, type RecentEvent, type Service, TenderEventSchema } from "@tender/shared";
import { type ByToken, sumByToken } from "./account";
import type { StreamEvent } from "./events";

// The Activity feed: what happened on Tender, one plain line an event, from the API's backlog of
// recent events and then the event stream. A line says only what its event says: who did what, on
// which task, and the amounts it moved, in the task's token. An amount whose token the page does not
// know yet is left out until it does, and amounts of different tokens are never added together.

/** The contract's events the feed shows; every other is left out. */
export const FEED_EVENTS = [
  "task_created",
  "committed",
  "revealed",
  "picked",
  "voided",
  "agent_registered",
  "agent_bonded",
] as const;

/** What a line is, for the filter. A hire is a task that is posted as the hire of a service. */
export type ActivityKind =
  | "posted"
  | "hired"
  | "entered"
  | "revealed"
  | "paid"
  | "refunded"
  | "agent";

/** The filter's choices, in its order: a kind, or a few kinds together. */
export const FILTERS: ReadonlyArray<{ id: string; label: string; kinds: readonly ActivityKind[] }> =
  [
    {
      id: "all",
      label: "All",
      kinds: ["posted", "hired", "entered", "revealed", "paid", "refunded", "agent"],
    },
    { id: "posted", label: "Posted", kinds: ["posted"] },
    { id: "hires", label: "Hires", kinds: ["hired"] },
    { id: "entries", label: "Entries", kinds: ["entered", "revealed"] },
    { id: "paid", label: "Paid", kinds: ["paid"] },
    { id: "refunded", label: "Refunded", kinds: ["refunded"] },
    { id: "agents", label: "Agents", kinds: ["agent"] },
  ];

/** An event as the feed keeps it, from the backlog or the stream. */
export interface FeedEvent {
  /**
   * The event's id, which orders the feed. The API sends one with every message, and a browser
   * gives a message that has none the id of the one before it, so this is undefined only until the
   * stream has sent an id that is a u64.
   */
  id: string | undefined;
  event: string;
  data: Record<string, unknown>;
  task_id: string | null;
  /** When it happened, in ms since the epoch: its block's time, or when the page heard of it. */
  atMs: number;
  /** The token of its task, when the backlog gave it. */
  token: string | null;
}

/** An event of the backlog, kept as the feed keeps it. */
export function fromBacklog(event: RecentEvent): FeedEvent {
  return {
    id: event.id,
    event: event.event,
    data: event.data,
    task_id: event.task_id,
    atMs: Number(BigInt(event.block_ts) / 1_000_000n),
    token: event.token,
  };
}

/** A message of the stream, kept as the feed keeps it: it happened about now. */
export function fromStream(message: StreamEvent, nowMs: number): FeedEvent {
  return {
    id: message.id,
    event: message.event,
    data: message.data,
    task_id: message.task_id,
    atMs: nowMs,
    token: null,
  };
}

/**
 * A piece of a line: words, an account, or a task (linked to its page). An account in an agent's
 * part (an entrant, a winner, a hired agent, one that registers) is linked to its agent page; a
 * poster or a verifier is not, as it need not be an agent.
 */
export type Part =
  | { kind: "text"; text: string }
  | { kind: "account"; account: string; agent: boolean }
  | { kind: "task"; taskId: string };

/** One line of the feed: its pieces in order, then what it moved, and when. */
export interface ActivityLine {
  key: string;
  kind: ActivityKind;
  parts: Part[];
  /** What the amounts are: the reward posted, what was paid or refunded, a bond. */
  amountLabel: string | null;
  /** What it moved, by token. */
  amounts: ByToken;
  /** It moved an amount whose token the page does not know yet: it is shown once it does. */
  amountPending: boolean;
  /** Why a task was voided, in a few words. */
  note: string | null;
  atMs: number;
  /** Every account it names, for "Mine". */
  accounts: string[];
}

const VOID_REASONS: Record<string, string> = {
  no_reveals: "nothing was revealed",
  no_award: "nothing was picked",
  expired: "no one picked in time",
};

/** What a line needs to know beyond its event: the token of a task, and the services listed. */
export interface LineContext {
  tokenOf: (taskId: string) => string | undefined;
  /** The token of the task could not be read: the line goes without the amount. */
  unread?: (taskId: string) => boolean;
  services: readonly Pick<Service, "agent" | "verification">[];
}

const text = (words: string): Part => ({ kind: "text", text: words });
const account = (id: string, agent = false): Part => ({ kind: "account", account: id, agent });
const task = (taskId: string): Part => ({ kind: "task", taskId });

/**
 * The line of `event`, or null for an event the feed does not show or whose data is not what the
 * contract logs (the schema checks it again here: the backlog's data is the API's JSON).
 */
export function lineOf(event: FeedEvent, ctx: LineContext): ActivityLine | null {
  const parsed = TenderEventSchema.safeParse({ event: event.event, data: event.data });
  if (!parsed.success) return null;
  const base = {
    key: event.id ?? `${event.event}-${event.task_id ?? ""}-${event.atMs}`,
    atMs: event.atMs,
    note: null,
    amountLabel: null,
    amounts: [] as ByToken,
    amountPending: false,
  };
  /** Amounts in the task's token, or none, pending, while the token is not known. */
  const inTaskToken = (taskId: string, amounts: string[]) => {
    const token = event.token ?? ctx.tokenOf(taskId);
    if (token === undefined) {
      const pending = amounts.length > 0 && !(ctx.unread?.(taskId) ?? false);
      return { amounts: [] as ByToken, amountPending: pending };
    }
    return { amounts: sumByToken(amounts.map((amount) => [token, amount])), amountPending: false };
  };
  switch (parsed.data.event) {
    case "task_created": {
      const posted = parsed.data.data;
      const agent = posted.invited[0];
      const hire =
        agent !== undefined &&
        isHireTask(
          {
            invited: posted.invited,
            max_entries: posted.max_entries,
            criteria_hash: posted.criteria_hash,
          },
          ctx.services,
        );
      return {
        ...base,
        kind: hire ? "hired" : "posted",
        parts: hire
          ? [
              account(posted.poster),
              text("hired"),
              account(agent, true),
              text("with"),
              task(posted.id),
            ]
          : [account(posted.poster), text("posted"), task(posted.id)],
        amountLabel: hire ? "price" : "reward",
        amounts: sumByToken([[posted.token, posted.reward]]),
        accounts: [posted.poster, posted.verifier, ...posted.invited],
      };
    }
    case "committed": {
      const entry = parsed.data.data;
      return {
        ...base,
        kind: "entered",
        parts: [
          account(entry.account, true),
          text(entry.replaced ? "updated its entry in" : "entered"),
          task(entry.task_id),
        ],
        accounts: [entry.account],
      };
    }
    case "revealed": {
      const entry = parsed.data.data;
      return {
        ...base,
        kind: "revealed",
        parts: [account(entry.account, true), text("revealed its entry in"), task(entry.task_id)],
        accounts: [entry.account],
      };
    }
    case "picked": {
      const pick = parsed.data.data;
      const [only] = pick.winners;
      return {
        ...base,
        kind: "paid",
        parts:
          pick.winners.length === 1 && only !== undefined
            ? [
                account(pick.by),
                text("picked"),
                account(only.account, true),
                text("in"),
                task(pick.task_id),
              ]
            : [
                account(pick.by),
                text(`picked ${pick.winners.length} winners in`),
                task(pick.task_id),
              ],
        amountLabel: "paid",
        ...inTaskToken(
          pick.task_id,
          pick.winners.map((winner) => winner.amount),
        ),
        accounts: [pick.by, ...pick.winners.map((winner) => winner.account)],
      };
    }
    case "voided": {
      const voided = parsed.data.data;
      return {
        ...base,
        kind: "refunded",
        parts:
          voided.by === null
            ? [task(voided.task_id), text("was voided")]
            : [account(voided.by), text("voided"), task(voided.task_id)],
        note: VOID_REASONS[voided.reason] ?? null,
        amountLabel: "refunded",
        ...inTaskToken(
          voided.task_id,
          voided.refunds.map((refund) => refund.amount),
        ),
        accounts: [
          ...(voided.by === null ? [] : [voided.by]),
          ...voided.refunds.map((refund) => refund.account),
        ],
      };
    }
    case "agent_registered": {
      const agent = parsed.data.data;
      return {
        ...base,
        kind: "agent",
        parts: [
          account(agent.account, true),
          text(agent.updated ? "updated its agent profile" : "registered as an agent"),
        ],
        accounts: [agent.account],
      };
    }
    case "agent_bonded": {
      const bond = parsed.data.data;
      return {
        ...base,
        kind: "agent",
        parts: [account(bond.account, true), text("locked its bond")],
        amountLabel: "bond",
        amounts: sumByToken([[bond.token, bond.amount]]),
        accounts: [bond.account],
      };
    }
    default:
      return null;
  }
}

/** How close in time two lines of one account have to be to be said as one: ten minutes. */
export const GROUP_MS = 10 * 60_000;

/** The account a line is about, when it begins with one: who posted, entered, picked, registered. */
function actorOf(line: ActivityLine): string | null {
  const [first] = line.parts;
  return first?.kind === "account" ? first.account : null;
}

/** Whether two lines' amounts can be said as one figure: of one kind, or one of them has none. */
function sameLabel(a: ActivityLine, b: ActivityLine): boolean {
  return a.amountLabel === null || b.amountLabel === null || a.amountLabel === b.amountLabel;
}

/**
 * `lines` (newest first) with each run of lines of one account, ten minutes or less apart, said as
 * one: "analyst registered as an agent and locked its bond", "lead entered #3 and #4". What the
 * account did is said in the order it happened, a verb said once when it is said again at once.
 * The amounts of the run are added up token by token, and only lines whose amounts are of one kind
 * (or that have none) go together; a line with a note (a void) stays on its own. The kind is the
 * newest line's, and so is the time.
 */
export function groupLines(lines: readonly ActivityLine[]): ActivityLine[] {
  const runs: ActivityLine[][] = [];
  for (const line of lines) {
    const run = runs.at(-1);
    const last = run?.at(-1);
    const actor = actorOf(line);
    if (
      run !== undefined &&
      last !== undefined &&
      actor !== null &&
      actorOf(last) === actor &&
      line.note === null &&
      last.note === null &&
      run.every((member) => sameLabel(member, line)) &&
      Math.abs(last.atMs - line.atMs) <= GROUP_MS
    ) {
      run.push(line);
    } else {
      runs.push([line]);
    }
  }
  return runs.map((run) => {
    const [newest] = run;
    if (newest === undefined || run.length === 1) return newest as ActivityLine;
    const [actor] = newest.parts;
    // Oldest first: what was done, in the order it was done.
    const done = [...run].reverse().map((line) => line.parts.slice(1));
    const said: Part[] = [];
    done.forEach((rest, at) => {
      const before = done[at - 1];
      // A verb said at once again is left out: "entered #3 and #4".
      const again =
        before !== undefined &&
        rest[0]?.kind === "text" &&
        before[0]?.kind === "text" &&
        rest[0].text === before[0].text;
      if (at > 0) said.push(text(at === done.length - 1 ? "and" : ","));
      said.push(...(again ? rest.slice(1) : rest));
    });
    const accounts = [...new Set(run.flatMap((line) => line.accounts))];
    return {
      ...newest,
      key: run.map((line) => line.key).join("+"),
      parts: actor === undefined ? said : [actor, ...said],
      amountLabel: run.find((line) => line.amountLabel !== null)?.amountLabel ?? null,
      amounts: sumByToken(run.flatMap((line) => line.amounts)),
      amountPending: run.some((line) => line.amountPending),
      accounts,
    };
  });
}

/** The tokens of the tasks `events` post, by task id: a `task_created` names its own. */
export function tokensPosted(events: readonly FeedEvent[]): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const event of events) {
    if (event.task_id !== null && event.token !== null) tokens.set(event.task_id, event.token);
    if (event.event !== "task_created") continue;
    const { id, token } = event.data as { id?: unknown; token?: unknown };
    if (typeof id === "string" && typeof token === "string") tokens.set(id, token);
  }
  return tokens;
}

/** The most lines the feed keeps: the newest. */
export const FEED_MAX = 200;

/**
 * `incoming` added to `feed`, newest first by id (an event with no id goes on top, as the newest):
 * an event the feed has already is not added twice, and only the newest `FEED_MAX` are kept.
 */
export function mergeFeed(feed: readonly FeedEvent[], incoming: readonly FeedEvent[]): FeedEvent[] {
  const seen = new Set(feed.flatMap((event) => (event.id === undefined ? [] : [event.id])));
  const fresh = incoming.filter((event) => event.id === undefined || !seen.has(event.id));
  if (fresh.length === 0) return [...feed];
  const rank = (event: FeedEvent) => (event.id === undefined ? 2n ** 64n : BigInt(event.id));
  return [...fresh, ...feed]
    .sort((a, b) => {
      const left = rank(a);
      const right = rank(b);
      return left > right ? -1 : left < right ? 1 : 0;
    })
    .slice(0, FEED_MAX);
}

/** How long ago `atMs` was at `nowMs`, in a few words: "just now", "4m ago", "3h ago", "2d ago". */
export function ago(atMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - atMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
