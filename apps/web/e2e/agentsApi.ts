import type { Page, Route } from "@playwright/test";
import {
  type AgentDetailResponse,
  type AgentRecentEntry,
  type AgentSummary,
  type ChallengeResponse,
  canonicalBase,
  type ListAgentsResponse,
  type ListTasksResponse,
  SIGN_IN_MESSAGE,
  type TaskSummary,
  type TelegramLinkResponse,
} from "@tender/shared";
import { agent, summary } from "../test/tasks";
import { API_URL } from "./fixtures";

// More of the fixture API (e2e/fixtures.ts) for the agent and Telegram pages: the directory, the
// agents' own pages, the tasks an agent posted, and the three requests that link a Telegram chat.
// Both helpers register their route after `routeApi`, which is the one a request falls back to,
// so a spec calls `routeApi(page)` first.

const CORS = { "access-control-allow-origin": "*" };
const PREFLIGHT = {
  ...CORS,
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

const TEAM = "tender-team.testnet";
const TEST_TOKEN = `tusdc.${TEAM}`;
/** A token this app knows no decimals for: its amounts show as raw units, with the account id. */
export const OTHER_TOKEN = "5f3a9c0e".repeat(8);

export const JUDGE = `judge.${TEAM}`;
export const SCOUT = `scout.${TEAM}`;
export const ALICE = "alice.testnet";
export const CAROL = "carol.testnet";
export const PROVIDER = "provider.testnet";
/** An implicit account (64 hex characters, nowhere to break), as wide as an agent can be. */
export const WIDE = "c0ffee13".repeat(8);
/**
 * The widest provider an agent can have: an account of two labels (an implicit account, of one, is
 * never a provider), 64 characters with nowhere to break but its one dot.
 */
export const WIDE_PROVIDER = `${"c0ffee13".repeat(7)}.testnet`;

/** The Telegram bot of the services' test run (`TELEGRAM_BOT_USERNAME=tender_test_bot`). */
export const TELEGRAM_BOT = "tender_test_bot";

/** What the directory lists, in the order of the accounts (byte order), as the API does. */
export const AGENTS: AgentSummary[] = [
  agent({
    account: ALICE,
    asp: PROVIDER,
    name: "Alice Extractor",
    tags: ["extraction", "json"],
    entries: 5,
    reveals: 4,
    wins: 2,
    earned: { [TEST_TOKEN]: "2500000", [OTHER_TOKEN]: "7" },
    picks_made: 0,
    voids_after_reveals: 0,
    is_team: false,
  }),
  // As wide as the data can be: 64 unbroken characters of name, accounts of 64 hex characters, the
  // largest counts and amounts, and tags of 24 characters.
  agent({
    account: WIDE,
    asp: WIDE_PROVIDER,
    name: "u".repeat(64),
    tags: ["extraordinarily-long-tag", "a".repeat(24)],
    entries: 4_294_967_295,
    reveals: 4_294_967_295,
    wins: 4_294_967_295,
    earned: {
      [TEST_TOKEN]: "340282366920938463463374607431768211455",
      [OTHER_TOKEN]: "340282366920938463463374607431768211455",
    },
    picks_made: 4_294_967_295,
    voids_after_reveals: 4_294_967_295,
    is_team: false,
  }),
  agent({
    account: CAROL,
    asp: null,
    name: "Carol Research",
    tags: ["research", "summaries"],
    entries: 12,
    reveals: 12,
    wins: 6,
    earned: { [TEST_TOKEN]: "9000000" },
    picks_made: 3,
    voids_after_reveals: 0,
    is_team: false,
  }),
  agent({ account: JUDGE }),
  agent({
    account: SCOUT,
    asp: null,
    name: "Tender Scout",
    tags: ["research", "coding"],
    entries: 9,
    reveals: 9,
    wins: 4,
    earned: { [TEST_TOKEN]: "6000000" },
    picks_made: 0,
    voids_after_reveals: 0,
    is_team: true,
  }),
];

/** The names of the agents that carry the team's label. */
export const TEAM_NAMES = AGENTS.filter((entry) => entry.is_team).map((entry) => entry.name);

const LONG_TITLE = "unbroken".repeat(15);

/** An agent's latest entries, newest first, as the agent's page lists them. */
const RECENT: Record<string, AgentRecentEntry[]> = {
  [ALICE]: [
    {
      task_id: "2",
      title: "Regex for valid NEAR account IDs",
      phase: "open",
      revealed: false,
      won: false,
    },
    {
      task_id: "1",
      title: "Extract fields from an invoice",
      phase: "settled",
      revealed: true,
      won: true,
    },
    { task_id: "9", title: null, phase: "expired", revealed: false, won: false },
  ],
  [WIDE]: [{ task_id: "3", title: LONG_TITLE, phase: "settled", revealed: true, won: true }],
};

/** The tasks an agent posted, newest first: a task of its own, and a subtask of the regex task. */
const POSTED: Record<string, TaskSummary[]> = {
  [ALICE]: [
    summary({
      id: "12",
      title: "Check every rule of the account id",
      poster: ALICE,
      is_team_poster: false,
      parent: "2",
      phase: "revealing",
      reward: "400000",
      token: TEST_TOKEN,
    }),
    summary({
      id: "11",
      title: "Collect sample invoices",
      poster: ALICE,
      is_team_poster: false,
      parent: null,
      phase: "settled",
      reward: "250000",
      token: TEST_TOKEN,
    }),
  ],
  [WIDE]: [
    summary({
      id: "13",
      title: LONG_TITLE,
      poster: WIDE,
      is_team_poster: false,
      parent: "3",
      reward: "340282366920938463463374607431768211455",
      token: OTHER_TOKEN,
    }),
  ],
};

function detailOf(account: string): AgentDetailResponse | undefined {
  const found = AGENTS.find((entry) => entry.account === account);
  return found === undefined ? undefined : { agent: found, recent_entries: RECENT[account] ?? [] };
}

/**
 * Answers `GET /v1/agents` (narrowed by `tag` and `asp`), the agents' own pages for the agents
 * above, `GET /v1/tasks?poster=` for the tasks they posted, and `GET /v1/services` with none.
 * Anything else, the Judge's own page included, is left to `routeApi`.
 */
export async function routeAgents(page: Page): Promise<void> {
  await page.route(`${API_URL}/**`, async (route) => {
    const request = route.request();
    if (request.method() !== "GET") return route.fallback();
    const url = new URL(request.url());
    const json = (body: unknown) => route.fulfill({ status: 200, json: body, headers: CORS });

    if (url.pathname === "/v1/agents") {
      const tag = url.searchParams.get("tag");
      const asp = url.searchParams.get("asp");
      const agents = AGENTS.filter(
        (entry) =>
          (tag === null || entry.tags.includes(tag)) && (asp === null || entry.asp === asp),
      );
      const body: ListAgentsResponse = { agents, next_cursor: null };
      return json(body);
    }

    const one = /^\/v1\/agents\/([^/]+)$/.exec(url.pathname);
    const found = one === null ? undefined : detailOf(decodeURIComponent(one[1] ?? ""));
    if (found !== undefined) return json(found);

    // No agent here lists a service (servicesApi.ts has those): the directory's prices and an
    // agent's page read an empty list.
    if (url.pathname === "/v1/services") return json({ services: [], next_cursor: null });

    const poster = url.searchParams.get("poster");
    if (url.pathname === "/v1/tasks" && poster !== null) {
      const body: ListTasksResponse = { tasks: POSTED[poster] ?? [], next_cursor: null };
      return json(body);
    }

    return route.fallback();
  });
}

// ---- Linking a Telegram chat ------------------------------------------------------------------

/** 32 bytes in base64, as the API's challenge has them. */
const NONCE = Buffer.alloc(32, 7).toString("base64");
const TOKEN = "e2e-token";

/** What the fixture API saw of the sign-in and the link, to look at after the page has run. */
export interface TelegramApi {
  /** Every request answered, as `POST /v1/telegram/link`, in order. */
  requests: string[];
  /** The body of each request to verify a signature. */
  verifies: Array<Record<string, unknown>>;
  /** The `Authorization` header of each request for a link. */
  linkAuthorization: Array<string | undefined>;
  /** The links made, in order. */
  links: TelegramLinkResponse[];
}

/**
 * Answers the three requests of linking a chat: the sign-in challenge, the verification of the
 * signed one (it is turned away if the page changed the challenge or signed as another account), and
 * the link, for a request that carries the token. Nothing here reaches Telegram: the link names the
 * test bot, and a spec answers the address itself.
 */
export async function routeTelegram(page: Page, account: string): Promise<TelegramApi> {
  const seen: TelegramApi = { requests: [], verifies: [], linkAuthorization: [], links: [] };

  await page.route(`${API_URL}/v1/auth/**`, async (route) => answer(route));
  await page.route(`${API_URL}/v1/telegram/link`, async (route) => answer(route));

  async function answer(route: Route): Promise<void> {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: PREFLIGHT });
    }
    const { pathname } = new URL(request.url());
    seen.requests.push(`${request.method()} ${pathname}`);
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, json: body, headers: CORS });

    if (pathname === "/v1/auth/challenge") {
      const body: ChallengeResponse = {
        nonce: NONCE,
        message: SIGN_IN_MESSAGE,
        recipient: canonicalBase(API_URL),
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      };
      return json(200, body);
    }

    if (pathname === "/v1/auth/verify") {
      const body = request.postDataJSON() as Record<string, unknown>;
      seen.verifies.push(body);
      const fits =
        body.account_id === account &&
        body.nonce === NONCE &&
        body.message === SIGN_IN_MESSAGE &&
        body.recipient === canonicalBase(API_URL);
      if (!fits) return json(401, { error: "unauthorized", message: "That sign-in is not valid." });
      return json(200, {
        token: TOKEN,
        expires_at: "2099-01-01T00:00:00.000Z",
        key_kind: "full_access",
      });
    }

    if (pathname === "/v1/telegram/link") {
      const authorization = request.headers().authorization;
      seen.linkAuthorization.push(authorization);
      if (authorization !== `Bearer ${TOKEN}`) {
        return json(401, { error: "unauthorized", message: "Sign in first." });
      }
      // 16 random bytes in base64url, 22 characters, as the API makes them.
      const code = Buffer.alloc(16, seen.links.length + 1).toString("base64url");
      const link: TelegramLinkResponse = {
        url: `https://t.me/${TELEGRAM_BOT}?start=${code}`,
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      };
      seen.links.push(link);
      return json(200, link);
    }

    return json(404, { error: "not_found", message: "no such route" });
  }

  return seen;
}
