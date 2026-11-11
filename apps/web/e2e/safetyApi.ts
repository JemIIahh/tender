import type { Page } from "@playwright/test";
import {
  type AgentDetailResponse,
  type DelegateView,
  type ListServicesResponse,
  type ListTasksResponse,
  MODEL_AGENT_POLICY,
  type Service,
} from "@tender/shared";
import { agent } from "../test/tasks";
import { API_URL, RPC_URL } from "./fixtures";

// The fixture API and RPC node for the Safety section of an agent's page (e2e/safety.spec.ts): three
// agents, and the chain's side of them. The analyst is the team's and named as run with a model, so
// the API sends the team's runner's defaults for it. The lead is the team's but not named so (its
// own code decides what it takes on), and hires with a delegate key. Dora is not the team's. The
// node answers the keys on each account, the contract's config (the bond's cooldown) and the
// delegate record of the lead's hiring key. Dora lists one x402 API. Register after `routeApi`, which
// is the route a request falls back to.

const CORS = { "access-control-allow-origin": "*" };
const TEAM = "tender-team.testnet";
/** NEXT_PUBLIC_CONTRACT in playwright.config.ts. */
const CONTRACT = `tender.${TEAM}`;
const TEST_TOKEN = `tusdc.${TEAM}`;

/** An agent the team runs with a model, as the deployment names it (`TEAM_MODEL_AGENTS`). */
export const ANALYST = `analyst.${TEAM}`;
/** An agent the team runs that is not named so, and hires with a delegate key. */
export const LEAD = `lead.${TEAM}`;
/** An agent the team does not run. */
export const DORA = "dora.testnet";

const OWNER_KEY = "ed25519:5F6aKb2oEB8kYyN3f5f7wTqZZQ5mBqBuJ7Yr5Kc6Xh8d";
const RUNNER_KEY = "ed25519:8hSHprDq2StXwMtNd43wDTXQYsjXcD4MJTXQYsjXcD4M";
export const DELEGATE_KEY = "ed25519:4YDb73cBbuU92xWx2CKDhaArzPChE2bP5ck1V54nXvyF";

const fullAccess = (publicKey: string) => ({
  public_key: publicKey,
  access_key: { nonce: 1, permission: "FullAccess" },
});
const limited = (publicKey: string, methods: string[]) => ({
  public_key: publicKey,
  access_key: {
    nonce: 1,
    permission: {
      FunctionCall: {
        allowance: "250000000000000000000000",
        receiver_id: CONTRACT,
        method_names: methods,
      },
    },
  },
});

const KEYS: Record<string, unknown[]> = {
  [ANALYST]: [fullAccess(OWNER_KEY), limited(RUNNER_KEY, ["commit", "reveal"])],
  [LEAD]: [
    fullAccess(OWNER_KEY),
    limited(RUNNER_KEY, ["commit", "reveal"]),
    limited(DELEGATE_KEY, ["post_task", "top_up_task", "commit", "reveal"]),
  ],
  [DORA]: [fullAccess(OWNER_KEY), limited(RUNNER_KEY, ["commit", "reveal"])],
};

/** The bond terms in force: 1 tUSDC, 14 days from leaving to claiming, as on testnet. */
const CONFIG = {
  agent_bond_token: TEST_TOKEN,
  agent_bond_amount: "1000000",
  agent_bond_cooldown_secs: String(14 * 86_400),
};

const DELEGATES: Record<string, DelegateView> = {
  [`${LEAD} ${DELEGATE_KEY}`]: {
    token: TEST_TOKEN,
    per_task_cap: "2000000",
    total_cap: "6000000",
    spent: "6000000",
  },
};

const bonded = { status: "active", bond_token: TEST_TOKEN, bond_amount: "1000000" } as const;

export const DETAILS: Record<string, AgentDetailResponse> = {
  [ANALYST]: {
    agent: agent({
      account: ANALYST,
      asp: TEAM,
      name: "Tender Analyst",
      tags: ["research", "analysis"],
      entries: 8,
      reveals: 8,
      wins: 5,
      picks_made: 0,
      voids_after_reveals: 0,
      is_team: true,
      claimable_at: null,
      ...bonded,
    }),
    recent_entries: [],
    runner_policy: {
      verifiers: MODEL_AGENT_POLICY.verifiers,
      daily_entries: MODEL_AGENT_POLICY.dailyEntries,
      daily_judged_hires: MODEL_AGENT_POLICY.dailyJudgedHires,
      max_poster_voids: MODEL_AGENT_POLICY.maxPosterVoids,
    },
  },
  [LEAD]: {
    agent: agent({
      account: LEAD,
      asp: TEAM,
      name: "Tender Lead",
      tags: ["research", "coding"],
      entries: 6,
      reveals: 6,
      wins: 3,
      picks_made: 3,
      voids_after_reveals: 0,
      is_team: true,
      claimable_at: null,
      ...bonded,
    }),
    recent_entries: [],
    runner_policy: null,
  },
  [DORA]: {
    agent: agent({
      account: DORA,
      asp: null,
      name: "Dora Summaries",
      tags: ["summaries"],
      entries: 2,
      reveals: 1,
      wins: 1,
      picks_made: 0,
      voids_after_reveals: 0,
      is_team: false,
      claimable_at: null,
      ...bonded,
    }),
    recent_entries: [],
    runner_policy: null,
  },
};

/** Dora's one listing: an x402 API, paid at once, outside the contract, with no checker. */
const DORA_API: Service = {
  id: "21",
  provider: DORA,
  agent: DORA,
  title: "Summary API",
  description: "Summarises a page of text per call.",
  tags: ["summaries"],
  category: "research",
  output_format: "json",
  token: TEST_TOKEN,
  price: "1000",
  commit_secs: 0,
  reveal_secs: 0,
  pick_secs: 0,
  verification: { kind: "none" },
  payment_mode: "x402",
  x402: {
    endpoint: "https://dora.example/summary",
    network: "near:testnet",
    pay_to: DORA,
    max_timeout_seconds: 60,
  },
  status: "active",
  available: true,
  is_team: false,
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-01T00:00:00.000Z",
  agent_record: null,
};

/** Answers the three agents' pages, with Dora's x402 API as the one service and no posted tasks. */
export async function routeSafetyAgents(page: Page): Promise<void> {
  await page.route(`${API_URL}/**`, async (route) => {
    const request = route.request();
    if (request.method() !== "GET") return route.fallback();
    const url = new URL(request.url());
    const json = (body: unknown) => route.fulfill({ status: 200, json: body, headers: CORS });
    const one = /^\/v1\/agents\/([^/]+)$/.exec(url.pathname);
    const found = one === null ? undefined : DETAILS[decodeURIComponent(one[1] ?? "")];
    if (found !== undefined) return json(found);
    if (url.pathname === "/v1/services") {
      const agent = url.searchParams.get("agent");
      const body: ListServicesResponse = {
        services: [DORA_API].filter((service) => agent === null || service.agent === agent),
        next_cursor: null,
      };
      return json(body);
    }
    if (url.pathname === "/v1/tasks" && url.searchParams.has("poster")) {
      const body: ListTasksResponse = { tasks: [], next_cursor: null };
      return json(body);
    }
    return route.fallback();
  });
}

/** What the node was asked: `view_access_key_list <account>`, or `<method> <args>`. */
export type NodeCalls = string[];

/** Answers the page's reads of the chain, as a node does. */
export async function routeSafetyNode(page: Page): Promise<NodeCalls> {
  const calls: NodeCalls = [];
  await page.route(`${RPC_URL}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const body = request.postDataJSON() as { id: unknown; params: Record<string, string> };
    const { params } = body;
    const answer = (value: object) =>
      route.fulfill({
        status: 200,
        headers: CORS,
        json: { jsonrpc: "2.0", id: body.id, ...value },
      });
    if (params.request_type === "view_access_key_list") {
      calls.push(`view_access_key_list ${params.account_id}`);
      const keys = KEYS[params.account_id ?? ""];
      return keys === undefined
        ? answer({
            error: {
              name: "HANDLER_ERROR",
              cause: { name: "UNKNOWN_ACCOUNT", info: {} },
              data: `account ${params.account_id} does not exist while viewing`,
            },
          })
        : answer({ result: { keys, block_height: 100 } });
    }
    if (params.request_type === "call_function") {
      const args = Buffer.from(params.args_base64 ?? "", "base64").toString();
      calls.push(`${params.method_name} ${args}`);
      const { account_id, public_key } = JSON.parse(args || "{}") as Record<string, string>;
      const views: Record<string, () => unknown> = {
        get_config: () => CONFIG,
        get_delegate: () => DELEGATES[`${account_id} ${public_key}`] ?? null,
      };
      const view = views[params.method_name ?? ""];
      if (view !== undefined) {
        const bytes = [...new TextEncoder().encode(JSON.stringify(view()))];
        return answer({ result: { result: bytes, logs: [], block_height: 100 } });
      }
    }
    return answer({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_QUERY" } } });
  });
  return calls;
}
