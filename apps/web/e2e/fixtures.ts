import type { Page, Route } from "@playwright/test";
import {
  type AgentDetailResponse,
  canonicalJson,
  type ListTasksResponse,
  sha256Hex,
  type TaskDetailResponse,
  type TaskOutcome,
  type TaskSummary,
} from "@tender/shared";
import { agent, detail, entry, revealed, scorecard } from "../test/tasks";

// A fixture API for the specs that need no chain. The web server is started with `API_URL`
// (playwright.config.ts), and `routeApi` answers what the browser asks of it, so a spec sees the
// rows below and the real API never runs. It also serves the event stream (`GET /v1/events`), and
// lets a spec do what agents do on the chain, a commit, a reveal or a pick, which changes what the
// API answers and tells the stream. 06-T1b adds the specs that run against a local chain.

/**
 * `.test` never resolves (RFC 6761). A request that `routeApi` does not answer fails to connect
 * instead of reaching a real server.
 */
export const API_URL = "http://api.test";
/** The same for the RPC node the browser reads the chain from (walletStub.ts answers for it). */
export const RPC_URL = "http://rpc.test";

const TEAM = "tender-team.testnet";
const TEAM_POSTER = `poster.${TEAM}`;
const JUDGE = `judge.${TEAM}`;
const TEST_TOKEN = `tusdc.${TEAM}`;

/** The first seed task: the Tender team posts it and the Judge verifies it. */
export const REGEX_TITLE = "Regex for valid NEAR account IDs";
/** The second seed task. */
export const INVOICE_TITLE = "Extract fields from an invoice";
/** A task from outside the team, written to be as wide as the data can be. */
export const COMMUNITY_TITLE =
  "Summarise the third-quarter incident report in five bullet points for the on-call handover without dropping a severity level or an owner";

/** What the badge says. */
export const TEAM_LABEL = "Run by Tender team";

// The seeds' windows (seeds/*/task.json): commit 600 s, reveal 300 s, pick 600 s, fallback 600 s.
const CREATED = 1_793_307_169_820_229_000n;
const SECOND = 1_000_000_000n;
const windows = (commit: bigint, reveal: bigint, pick: bigint, fallback: bigint) => ({
  created_at: CREATED.toString(),
  commit_deadline: (CREATED + commit * SECOND).toString(),
  reveal_deadline: (CREATED + (commit + reveal) * SECOND).toString(),
  pick_deadline: (CREATED + (commit + reveal + pick) * SECOND).toString(),
  fallback_deadline: (CREATED + (commit + reveal + pick + fallback) * SECOND).toString(),
});

const SEED_WINDOWS = windows(600n, 300n, 600n, 600n);

const REGEX_TASK: TaskSummary = {
  id: "2",
  title: REGEX_TITLE,
  category: "coding",
  tags: ["coding", "regex", "near", "validation"],
  token: TEST_TOKEN,
  reward: "1000000",
  phase: "open",
  poster: TEAM_POSTER,
  verifier: JUDGE,
  ...SEED_WINDOWS,
  commit_count: 1,
  reveal_count: 0,
  working_count: 0,
  judge_status: "accepted",
  judge_reason: null,
  is_team_poster: true,
  parent: null,
  outcome_kind: null,
};

/** What the poster of the regex task wrote, to match its title and its criteria. */
const REGEX_BRIEF: NonNullable<TaskDetailResponse["brief"]> = {
  version: 1,
  title: REGEX_TITLE,
  summary: "Write one regular expression that tells valid NEAR account IDs from invalid ones.",
  instructions:
    "Return a single regular expression, anchored at both ends.\nIt must accept every valid account ID and reject every invalid one.",
  category: "coding",
  tags: ["coding", "regex", "near", "validation"],
  output: { format: "text", max_bytes: 512 },
};

const INVOICE_TASK: TaskSummary = {
  ...REGEX_TASK,
  id: "1",
  title: INVOICE_TITLE,
  category: "extraction",
  tags: ["extraction", "json", "invoices"],
  reward: "500000",
  commit_count: 0,
};

/**
 * An implicit account (64 hex characters, no separator to break at), a token this app knows no
 * decimals for, whose amount shows as raw units, and the largest amount a u128 holds.
 */
const COMMUNITY_TASK: TaskSummary = {
  ...REGEX_TASK,
  id: "3",
  title: COMMUNITY_TITLE,
  category: "research",
  tags: ["research", "summaries"],
  token: "5f3a9c0e".repeat(8),
  reward: "340282366920938463463374607431768211455",
  poster: "c0ffee13".repeat(8),
  is_team_poster: false,
  judge_status: null,
};

/** The board lists the newest task first. */
export const TASKS: TaskSummary[] = [COMMUNITY_TASK, REGEX_TASK, INVOICE_TASK];

const CORS = { "access-control-allow-origin": "*" };

// ---- The task pages ---------------------------------------------------------------------------

/** A held-out document, and the hash a task commits to for it, as an honest verifier publishes. */
export const HELDOUT = {
  regex_cases: { match: ["alice.near", "bob.testnet"], no_match: ["-bad", "UPPER"] },
};
export const HELDOUT_COMMITMENT = sha256Hex(canonicalJson(HELDOUT));

/** An account of 64 hex characters, which has no place to break, and a hash to go with it. */
export const WIDE_ACCOUNT = "c0ffee13".repeat(8);
export const WIDE_HASH = "9f".repeat(32);

/** The Judge, registered as an agent, who verifies the seed tasks. */
const JUDGE_AGENT: AgentDetailResponse = { agent: agent({ account: JUDGE }), recent_entries: [] };

/**
 * The page of the third task (`COMMUNITY_TASK`), settled, with every part of a task page as wide as
 * its data can be: an unbroken run of letters wherever a person can write one, 64 hex characters
 * where an account goes, the largest amount a u128 holds, and addresses of 200 characters.
 */
function wideTask(): TaskDetailResponse {
  const reward = BigInt(COMMUNITY_TASK.reward);
  const fee = (reward * 500n) / 10_000n;
  const long = "unbroken".repeat(30);
  const second = "5f3a9c0e".repeat(8);
  const outcome: TaskOutcome = {
    kind: "picked",
    task_id: COMMUNITY_TASK.id,
    by: JUDGE,
    winners: [{ account: WIDE_ACCOUNT, bps: 10_000, amount: (reward - fee).toString() }],
    fee: fee.toString(),
    scorecard_hash: WIDE_HASH,
    scorecard_uri: `ipfs://${"z".repeat(200)}`,
  };
  return detail(
    {
      ...COMMUNITY_TASK,
      phase: "settled",
      outcome_kind: "picked",
      outcome,
      commit_count: 2,
      reveal_count: 2,
      judge_status: "accepted",
      judge_reason: `not judged: ${long}`,
      heldout_commitment: HELDOUT_COMMITMENT,
    },
    {
      brief: {
        version: 1,
        title: COMMUNITY_TITLE.slice(0, 120),
        summary: long,
        instructions: `${long}\n${long}`,
        category: "research",
        tags: COMMUNITY_TASK.tags,
        output: { format: "text", max_bytes: 4096 },
        attachments: [
          { name: long, uri: `https://files.test/${"q".repeat(150)}`, sha256: WIDE_HASH },
        ],
      },
      entries: [
        revealed(WIDE_ACCOUNT, WIDE_HASH, { uri: `ipfs://${"x".repeat(200)}` }),
        revealed(second, "ab".repeat(32), {
          entry_index: 1,
          uri: `https://files.test/${"y".repeat(200)}`,
        }),
      ],
      funders: [{ account: COMMUNITY_TASK.poster, amount: COMMUNITY_TASK.reward }],
      children: ["4", "5"],
      scorecard: scorecard({
        task_id: COMMUNITY_TASK.id,
        verifier: JUDGE,
        heldout: HELDOUT,
        heldout_commitment: HELDOUT_COMMITMENT,
        entries: [
          {
            account: WIDE_ACCOUNT,
            content_hash: WIDE_HASH,
            uri: `ipfs://${"x".repeat(200)}`,
            committed_at_block: "123456",
            score: 100,
            passed: true,
            reasons: [long, "matches every case"],
          },
          {
            account: second,
            content_hash: "ab".repeat(32),
            uri: `https://files.test/${"y".repeat(200)}`,
            committed_at_block: "123460",
            score: 30,
            passed: false,
            reasons: [long],
          },
        ],
        winners: [{ account: WIDE_ACCOUNT, bps: 10_000 }],
      }),
    },
  );
}

/** What `GET /v1/tasks/:id` answers to begin with: the three tasks of the board. */
function startingDetails(): Map<string, TaskDetailResponse> {
  const poster = (task: TaskSummary) => [{ account: task.poster, amount: task.reward }];
  return new Map([
    ["1", detail(INVOICE_TASK, { entries: [], funders: poster(INVOICE_TASK) })],
    [
      "2",
      detail(REGEX_TASK, {
        brief: REGEX_BRIEF,
        entries: [entry("alice.testnet"), entry("bob.testnet", { entry_index: 1 })],
        funders: poster(REGEX_TASK),
      }),
    ],
    ["3", wideTask()],
  ]);
}

/**
 * `before` after the Judge has picked: every entry scored, the first one a winner, the reward paid
 * out less the fee, and the scorecard published with the held-out document it was scored with.
 */
export function pickedPage(before: TaskDetailResponse): TaskDetailResponse {
  const { id, reward } = before.task;
  const fee = (BigInt(reward) * BigInt(before.task.fee_bps)) / 10_000n;
  const winner = before.entries[0]?.account ?? "alice.testnet";
  return detail(
    {
      ...before.task,
      phase: "settled",
      outcome_kind: "picked",
      heldout_commitment: HELDOUT_COMMITMENT,
      outcome: {
        kind: "picked",
        task_id: id,
        by: before.task.verifier,
        winners: [{ account: winner, bps: 10_000, amount: (BigInt(reward) - fee).toString() }],
        fee: fee.toString(),
        scorecard_hash: WIDE_HASH,
        scorecard_uri: `${API_URL}/v1/blobs/${WIDE_HASH}`,
      },
    },
    {
      brief: before.brief,
      criteria: before.criteria,
      entries: before.entries,
      funders: before.funders,
      scorecard: scorecard({
        task_id: id,
        verifier: before.task.verifier,
        heldout: HELDOUT,
        heldout_commitment: HELDOUT_COMMITMENT,
        winners: [{ account: winner, bps: 10_000 }],
      }),
    },
  );
}

// ---- The event stream -------------------------------------------------------------------------

/** How long the browser waits before it opens the stream again, which the stream says (`retry:`). */
const RECONNECT_MS = 100;

interface StoredEvent {
  id: number;
  name: string;
  /** The `data:` line, as the API writes it: `{ event, data, height, task_id }`. */
  data: string;
}

/** What a spec has to hand: the fixture API as a chain and an indexer would change it. */
export interface FixtureApi {
  /** What `GET /v1/tasks/:id` answers, by task id. */
  details: Map<string, TaskDetailResponse>;
  /** What `GET /v1/agents/:account` answers, by account. An account that is not here is a 404. */
  agents: Map<string, AgentDetailResponse>;
  /** Every request answered so far, as `GET /v1/tasks/2`. */
  requests: string[];
  /** An agent commits an entry: the task gains it, and the stream says `committed`. */
  commit(taskId: string, account: string): void;
  /** An agent reveals its entry: the entry gains a hash and an address, and the stream says so. */
  reveal(taskId: string, account: string, contentHash: string): void;
  /** The task is picked or voided: its page becomes `after`, and the stream says which. */
  settle(after: TaskDetailResponse): void;
  /** From now on a stream is refused with a 503 and this `Retry-After`. */
  refuseStreams(retryAfterSeconds: number): void;
  /** A stream is served again. */
  acceptStreams(): void;
  /** How many stream requests are held right now, each waiting for an event. */
  heldStreams(): number;
}

/**
 * Answers the API's reads for `page` from the fixture: `GET /v1/tasks` with `tasks` (narrowed by
 * `phase` and `tag`, as the API does), `GET /v1/tasks/:id`, `GET /v1/agents/:account`, and the
 * event stream. A path it does not know is a 404 in the API's own error body, so that a request
 * the fixture does not cover shows up as an error in the page.
 *
 * The stream is a long poll that a browser reads as a stream: the response to a request holds
 * until there is an event after the one the browser last saw, is that event, and ends with
 * `retry: 100`, so the browser asks again at once. A route cannot write a response in pieces, and
 * this is how it looks to the page that it can.
 *
 * Where the browser last was, a server learns from `Last-Event-ID`. Chrome sends that header when
 * it reconnects (a real server sees it), but adds it below the layer a route sees, so here it
 * never shows. The fixture keeps the id itself instead: the first request of the page is told at
 * once that the stream is open, and every request after it (and any with `?since=`, which the page
 * sends when it opens a new stream after a refusal) resumes from the last id it was told.
 */
export async function routeApi(page: Page, tasks: TaskSummary[] = TASKS): Promise<FixtureApi> {
  const details = startingDetails();
  const agents = new Map<string, AgentDetailResponse>([[JUDGE, JUDGE_AGENT]]);
  const requests: string[] = [];

  const events: StoredEvent[] = [];
  const waiting = new Set<() => void>();
  let gone = false;
  let held = 0;
  let refusal: number | null = null;
  /** The last event id a response has told the browser about; undefined before the first stream. */
  let told: number | undefined;
  page.on("close", () => {
    gone = true;
    for (const wake of [...waiting]) wake();
  });

  const lastId = () => events.at(-1)?.id ?? 0;

  function emit(name: string, data: Record<string, unknown>, taskId: string): void {
    const id = lastId() + 1;
    const message = { event: name, data, height: String(1000 + id), task_id: taskId };
    events.push({ id, name, data: JSON.stringify(message) });
    for (const wake of [...waiting]) wake();
  }

  /** Resolves when `condition` holds, or the page is gone. */
  function until(condition: () => boolean): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (condition() || gone) {
          waiting.delete(check);
          resolve();
        }
      };
      waiting.add(check);
      check();
    });
  }

  function detailOf(taskId: string): TaskDetailResponse {
    const found = details.get(taskId);
    if (!found) throw new Error(`the fixture has no task ${taskId}`);
    return found;
  }

  const api: FixtureApi = {
    details,
    agents,
    requests,

    commit(taskId, account) {
      const found = detailOf(taskId);
      const height = 1000 + lastId() + 1;
      found.entries.push(
        entry(account, { entry_index: found.entries.length, committed_height: String(height) }),
      );
      found.task.commit_count += 1;
      emit(
        "committed",
        {
          task_id: taskId,
          account,
          commitment: sha256Hex(`${taskId}:${account}`),
          replaced: false,
          block_height: String(height),
        },
        taskId,
      );
    },

    reveal(taskId, account, contentHash) {
      const found = detailOf(taskId);
      const mine = found.entries.find((candidate) => candidate.account === account);
      if (!mine) throw new Error(`${account} has no entry in task ${taskId}`);
      const uri = `${API_URL}/v1/blobs/${contentHash}`;
      Object.assign(mine, { revealed: true, content_hash: contentHash, uri });
      found.task.reveal_count += 1;
      emit("revealed", { task_id: taskId, account, content_hash: contentHash, uri }, taskId);
    },

    settle(after) {
      const { outcome, id } = after.task;
      if (outcome === null) throw new Error("a settled task has an outcome");
      details.set(id, after);
      if (outcome.kind === "picked") {
        emit(
          "picked",
          {
            task_id: id,
            by: outcome.by,
            winners: outcome.winners,
            fee: outcome.fee,
            scorecard_hash: outcome.scorecard_hash,
            scorecard_uri: outcome.scorecard_uri,
          },
          id,
        );
      } else {
        emit(
          "voided",
          {
            task_id: id,
            reason: outcome.reason,
            by: outcome.by,
            refunds: outcome.refunds ?? [],
            scorecard_hash: outcome.scorecard_hash,
            scorecard_uri: outcome.scorecard_uri,
          },
          id,
        );
      }
    },

    refuseStreams(retryAfterSeconds) {
      refusal = retryAfterSeconds;
    },

    acceptStreams() {
      refusal = null;
    },

    heldStreams() {
      return held;
    },
  };

  /** Answers a stream request. A route that the page has left behind is let go. */
  async function serveStream(route: Route): Promise<void> {
    const respond = async (options: Parameters<Route["fulfill"]>[0]) => {
      try {
        await route.fulfill(options);
      } catch {
        // The page closed, or the browser dropped the request, while it was held.
      }
    };
    const request = route.request();
    if (refusal !== null) {
      await respond({
        status: 503,
        headers: {
          ...CORS,
          "access-control-expose-headers": "Retry-After",
          "retry-after": String(refusal),
        },
        json: { error: "unavailable", message: "too many streams" },
      });
      return;
    }
    const stream = { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache" };
    const resume =
      request.headers()["last-event-id"] ?? new URL(request.url()).searchParams.get("since");
    if (resume === null && told === undefined) {
      // The page's first stream. It opens at once and is sent nothing that happened before it,
      // which is what the API does for a stream with no id to resume from.
      told = lastId();
      await respond({ status: 200, headers: stream, body: `: open\nretry: ${RECONNECT_MS}\n\n` });
      return;
    }
    const after = resume === null ? (told ?? 0) : Number(resume);
    held += 1;
    try {
      await until(() => lastId() > after);
    } finally {
      held -= 1;
    }
    const body = events
      .filter((event) => event.id > after)
      .map((event) => `id: ${event.id}\nevent: ${event.name}\ndata: ${event.data}\n\n`)
      .join("");
    told = lastId();
    await respond({ status: 200, headers: stream, body: `${body}retry: ${RECONNECT_MS}\n\n` });
  }

  await page.route(`${API_URL}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push(`${request.method()} ${url.pathname}${url.search}`);
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, json: body, headers: CORS });
    const notFound = () => json(404, { error: "not_found", message: "no such route" });
    if (request.method() !== "GET") return notFound();

    if (url.pathname === "/v1/events") return serveStream(route);

    if (url.pathname === "/v1/tasks") {
      const phase = url.searchParams.get("phase");
      const tag = url.searchParams.get("tag");
      const rows = tasks.filter(
        (task) =>
          (phase === null || task.phase === phase) && (tag === null || task.tags.includes(tag)),
      );
      const body: ListTasksResponse = { tasks: rows, next_cursor: null };
      return json(200, body);
    }

    const task = /^\/v1\/tasks\/(\d+)$/.exec(url.pathname);
    if (task) {
      const found = details.get(task[1] ?? "");
      return found ? json(200, found) : json(404, { error: "not_found", message: "no such task" });
    }

    const owner = /^\/v1\/agents\/([^/]+)$/.exec(url.pathname);
    if (owner) {
      const found = agents.get(decodeURIComponent(owner[1] ?? ""));
      return found ? json(200, found) : json(404, { error: "not_found", message: "no such agent" });
    }

    return notFound();
  });

  return api;
}
