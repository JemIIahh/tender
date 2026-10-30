import type { Page } from "@playwright/test";
import type { ListTasksResponse, TaskSummary } from "@tender/shared";

// A fixture API for the specs that need no chain. The web server is started with `API_URL`
// (playwright.config.ts), and `routeApi` answers what the browser asks of it, so a spec sees the
// rows below and the real API never runs. 06-T1b adds the specs that run against a local chain.

/**
 * `.test` never resolves (RFC 6761). A request that `routeApi` does not answer fails to connect
 * instead of reaching a real server.
 */
export const API_URL = "http://api.test";

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

/**
 * Answers the API's reads for `page` from the fixture: `GET /v1/tasks` with `tasks`, and a 404 in
 * the API's own error body for any other path, so that a request the fixture does not cover shows
 * up as an error in the page.
 */
export async function routeApi(page: Page, tasks: TaskSummary[] = TASKS): Promise<void> {
  await page.route(`${API_URL}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.pathname === "/v1/tasks") {
      const body: ListTasksResponse = { tasks, next_cursor: null };
      await route.fulfill({ status: 200, json: body, headers: CORS });
      return;
    }
    await route.fulfill({
      status: 404,
      json: { error: "not_found", message: "no such route" },
      headers: CORS,
    });
  });
}
