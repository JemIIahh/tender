import type { Page } from "@playwright/test";
import {
  canonicalJson,
  type ListServicesResponse,
  type PublicCriteria,
  type Service,
  sha256Hex,
} from "@tender/shared";
import { agent } from "../test/tasks";
import { API_URL } from "./fixtures";

// More of the fixture API (e2e/fixtures.ts) for the Services pages: the directory, a service's
// page, and the provider's writes from My agents. It registers its route after `routeApi`, which is
// the one a request falls back to, so a spec calls `routeApi(page)` first, and a request it has no
// answer for (the sign-in, the uploads) goes on to whatever was registered before it.

const CORS = { "access-control-allow-origin": "*" };
const PREFLIGHT = {
  ...CORS,
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

const TEAM = "tender-team.testnet";
export const TEST_TOKEN = `tusdc.${TEAM}`;
export const JUDGE = `judge.${TEAM}`;
export const ACME = "acme.testnet";
export const WRITER = "writer.acme.testnet";
export const SCOUT = `scout.${TEAM}`;
export const ALICE = "alice.testnet";
/** An implicit account (64 hex characters, nowhere to break), as wide as an agent can be. */
export const WIDE = "c0ffee13".repeat(8);

const REGEX: PublicCriteria = {
  version: 1,
  kind: "regex_cases",
  min_score: 100,
  split: "winner_take_all",
  has_heldout: false,
  examples: { match: ["2026-11-04", "1999-01-31"], no_match: ["4 Nov 2026", "2026/11/04"] },
};

/** A service with the rest as a listing of the writer's that can be hired now. */
export function service(over: Partial<Service> = {}): Service {
  return {
    id: "3",
    provider: ACME,
    agent: WRITER,
    title: "Summarise a public filing",
    description:
      "Reads an annual report or a 10-K you name and returns a plain summary: revenue, margins, debt and anything unusual, in five lines.",
    tags: ["research", "filings"],
    category: "research",
    output_format: "text",
    token: TEST_TOKEN,
    price: "2500000",
    commit_secs: 3_600,
    reveal_secs: 1_800,
    pick_secs: 3_600,
    verification: { kind: "hirer" },
    status: "active",
    available: true,
    is_team: false,
    created_at: "2026-11-04T09:00:00.000Z",
    updated_at: "2026-11-04T09:00:00.000Z",
    agent_record: agent({
      account: WRITER,
      asp: ACME,
      name: "Filing Writer",
      tags: ["research"],
      entries: 14,
      reveals: 13,
      wins: 9,
      earned: { [TEST_TOKEN]: "21375000" },
      picks_made: 0,
      voids_after_reveals: 0,
      is_team: false,
    }),
    ...over,
  };
}

/** What the directory lists, newest first, as the API does. */
export const SERVICES: Service[] = [
  service({
    id: "4",
    provider: TEAM,
    agent: SCOUT,
    title: "Extract every date from a page",
    description: "Returns one regex that matches ISO dates and nothing else. The Judge checks it.",
    tags: ["extraction", "regex"],
    category: "extraction",
    output_format: "regex_json",
    price: "900000",
    commit_secs: 600,
    reveal_secs: 300,
    pick_secs: 600,
    is_team: true,
    verification: {
      kind: "judge",
      criteria: REGEX,
      criteria_hash: sha256Hex(canonicalJson(REGEX)),
      judge: JUDGE,
    },
    agent_record: agent({
      account: SCOUT,
      asp: TEAM,
      name: "Scout",
      tags: ["extraction"],
      entries: 40,
      reveals: 40,
      wins: 31,
      earned: { [TEST_TOKEN]: "27900000" },
      picks_made: 0,
      voids_after_reveals: 0,
      is_team: true,
    }),
  }),
  service(),
  service({
    id: "2",
    provider: WIDE,
    agent: WIDE,
    title: "x".repeat(80),
    description: "y".repeat(1000),
    tags: [
      "extraordinarily-long-tag",
      "a".repeat(24),
      "b".repeat(24),
      "c".repeat(24),
      "d".repeat(24),
    ],
    price: "340282366920938463463374607431768211455",
    agent_record: agent({
      account: WIDE,
      asp: null,
      name: "Wide",
      tags: [],
      entries: 4_294_967_295,
      reveals: 4_294_967_295,
      wins: 4_294_967_295,
      earned: { [TEST_TOKEN]: "340282366920938463463374607431768211455" },
      is_team: false,
    }),
  }),
];

/** A service of the writer's that its provider paused. */
export const PAUSED = service({
  id: "5",
  title: "Translate a contract clause",
  tags: ["writing"],
  category: "writing",
  status: "paused",
  available: false,
});

export interface ServicesApi {
  /** The writes the page made, as `POST /v1/services[/:id]`, with their bodies. */
  writes: Array<{ path: string; body: Record<string, unknown>; authorization?: string }>;
}

/**
 * Answers `GET /v1/services` (every listing that can be hired, or a provider's own with
 * `status=all`), `GET /v1/services/:id`, and the provider's writes, for a request that carries a
 * token. `listed` is what the API holds; a write changes it.
 */
export async function routeServices(
  page: Page,
  listed: Service[] = [...SERVICES, PAUSED],
): Promise<ServicesApi> {
  const api: ServicesApi = { writes: [] };
  let next = 100;
  await page.route(`${API_URL}/v1/services**`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: PREFLIGHT });
      return;
    }
    const url = new URL(request.url());
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, json: body, headers: CORS });

    if (request.method() === "GET") {
      if (url.pathname === "/v1/services") {
        const all = url.searchParams.get("status") === "all";
        const provider = url.searchParams.get("provider");
        const services = listed.filter(
          (one) => (all || one.available) && (provider === null || one.provider === provider),
        );
        const body: ListServicesResponse = { services, next_cursor: null };
        return json(200, body);
      }
      const one = /^\/v1\/services\/(\d+)$/.exec(url.pathname);
      const found = listed.find((candidate) => candidate.id === one?.[1]);
      if (found === undefined) return json(404, { error: "not_found", message: "no such service" });
      return json(200, { service: found });
    }

    const authorization = (await request.allHeaders()).authorization;
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    api.writes.push({ path: url.pathname, body, authorization });
    if (authorization === undefined) {
      return json(401, { error: "unauthorized", message: "Sign in again." });
    }
    if (url.pathname === "/v1/services") {
      const made = service({
        ...(body as Partial<Service>),
        id: String(next++),
        provider: ALICE,
        verification: { kind: "hirer" },
        agent_record: null,
      });
      listed.unshift(made);
      return json(200, { service: made });
    }
    const id = /^\/v1\/services\/(\d+)$/.exec(url.pathname)?.[1];
    const at = listed.findIndex((candidate) => candidate.id === id);
    const was = listed[at];
    if (was === undefined) return json(404, { error: "not_found", message: "no such service" });
    const status = body.status === "paused" || body.status === "active" ? body.status : was.status;
    const changed: Service = {
      ...was,
      ...(body as Partial<Service>),
      verification: was.verification,
      status,
      available: status === "active",
    };
    listed[at] = changed;
    return json(200, { service: changed });
  });
  return api;
}
