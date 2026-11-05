import type {
  AccountEntry,
  AgentSummary,
  Service,
  TaskDetailResponse,
  TaskSummary,
} from "@tender/shared";
import { vi } from "vitest";
import { base58Encode } from "../lib/agentKey";
import type { Session, SigningWallet } from "../lib/wallet";
import { agent, detail } from "./tasks";

// A fake API and node for the account pages' tests (My agents, Add an agent, Earnings), and a
// wallet that can make accounts. vitest.config.ts gives the config http://api.test and
// http://rpc.test.

export const ALICE = "alice.testnet";
export const SCOUT = `scout.${ALICE}`;
export const TOKEN = "tusdc.tender-team.testnet";

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const notFound = () => json({ error: "not_found", message: "no such thing" }, 404);

/** An agent row as the API sends it, with any extra fields (the bond's). */
export const row = (overrides: Partial<AgentSummary> & Record<string, unknown> = {}) => ({
  ...agent({ is_team: false, picks_made: 0, voids_after_reveals: 0, tags: [] }),
  ...overrides,
});

/** One entry of an account, as `GET /v1/entries` lists it. */
export const entryRow = (task_id: string, extra: Partial<AccountEntry> = {}): AccountEntry => ({
  task_id,
  title: `Task ${task_id}`,
  phase: "settled",
  revealed: true,
  won: false,
  entry_index: 0,
  committed_height: "1",
  content_hash: null,
  uri: null,
  ...extra,
});

/** A task picked with `winners`, fee 5%. */
export function pickedTask(
  id: string,
  reward: bigint,
  winners: Array<[string, number]>,
  token = TOKEN,
): TaskDetailResponse {
  const fee = (reward * 500n) / 10_000n;
  return detail({
    id,
    title: `Task ${id}`,
    token,
    reward: reward.toString(),
    phase: "settled",
    outcome_kind: "picked",
    fee_bps: 500,
    outcome: {
      kind: "picked",
      task_id: id,
      by: "judge.tender-team.testnet",
      winners: winners.map(([account, bps]) => ({
        account,
        bps,
        amount: (((reward - fee) * BigInt(bps)) / 10_000n).toString(),
      })),
      fee: fee.toString(),
      scorecard_hash: "c".repeat(64),
      scorecard_uri: "http://api.test/v1/blobs/c",
    },
  });
}

/** What the fake API and node hold; a test changes it as the world changes. */
export interface World {
  /** `GET /v1/agents/:account`, by account. */
  agents: Map<string, object>;
  /** `GET /v1/agents?asp=`, by provider. */
  under: Map<string, object[]>;
  entries: Map<string, AccountEntry[]>;
  tasks: Map<string, TaskDetailResponse>;
  posted: Map<string, TaskSummary[]>;
  /** The chain's accounts, with their full-access keys. */
  accounts: Map<string, string[]>;
  /** The contract's config view. */
  config: Record<string, unknown>;
  /** A path that answers 500, as `/v1/agents`. */
  failing: Set<string>;
  /** `GET /v1/services?provider=`, the provider's services, newest first; a write changes them. */
  services: Service[];
  /** The `Authorization` header of each write to `/v1/services`. */
  serviceAuth: Array<string | null>;
  /** Every request, as `GET /v1/path?query` or `RPC view_account x`. */
  requests: string[];
  /** Every request body sent, as text: what left the page. */
  bodies: string[];
  /** `GET /v1/connect/implicit` (signed in): the agents set up as implicit accounts. */
  implicit: object[];
}

export function world(): World {
  return {
    agents: new Map(),
    under: new Map(),
    entries: new Map(),
    tasks: new Map(),
    posted: new Map(),
    accounts: new Map([[ALICE, []]]),
    config: { owner: "tender.testnet", fee_bps: 500 },
    failing: new Set(),
    services: [],
    serviceAuth: [],
    requests: [],
    bodies: [],
    implicit: [],
  };
}

const rpcError = (name: string, data: string) =>
  json({
    jsonrpc: "2.0",
    id: "x",
    error: { name: "HANDLER_ERROR", cause: { name, info: {} }, message: "Server error", data },
  });

/** `fetch`, answered from `state`. */
export function serve(state: World): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (init.body !== undefined) state.bodies.push(String(init.body));
    if (url.origin === "http://rpc.test") {
      const { params } = JSON.parse(String(init.body)) as { params: Record<string, string> };
      state.requests.push(`RPC ${params.request_type} ${params.account_id}`);
      if (params.request_type === "view_account") {
        return state.accounts.has(params.account_id ?? "")
          ? json({ jsonrpc: "2.0", id: "x", result: { amount: "1" } })
          : rpcError("UNKNOWN_ACCOUNT", "does not exist while viewing");
      }
      if (params.request_type === "view_access_key") {
        return (state.accounts.get(params.account_id ?? "") ?? []).includes(params.public_key ?? "")
          ? json({ jsonrpc: "2.0", id: "x", result: { nonce: 0, permission: "FullAccess" } })
          : rpcError("UNKNOWN_ACCESS_KEY", "does not exist while viewing");
      }
      const bytes = [...new TextEncoder().encode(JSON.stringify(state.config))];
      return json({ jsonrpc: "2.0", id: "x", result: { result: bytes, logs: [] } });
    }
    state.requests.push(`${init.method ?? "GET"} ${url.pathname}${url.search}`);
    if (state.failing.has(url.pathname)) return json({ error: "boom", message: "down" }, 500);
    const agentPath = /^\/v1\/agents\/([^/]+)$/.exec(url.pathname);
    if (agentPath !== null) {
      const found = state.agents.get(agentPath[1] ?? "");
      return found === undefined ? notFound() : json({ agent: found, recent_entries: [] });
    }
    if (url.pathname === "/v1/connect/implicit") {
      const signedIn = new Headers(init.headers).get("Authorization") !== null;
      return signedIn
        ? json({ agents: state.implicit })
        : json({ error: "unauthorized", message: "sign in" }, 401);
    }
    if (url.pathname === "/v1/agents") {
      return json({
        agents: state.under.get(url.searchParams.get("asp") ?? "") ?? [],
        next_cursor: null,
      });
    }
    if (url.pathname === "/v1/entries") {
      return json({ entries: state.entries.get(url.searchParams.get("account") ?? "") ?? [] });
    }
    const taskPath = /^\/v1\/tasks\/(\d+)$/.exec(url.pathname);
    if (taskPath !== null) {
      const found = state.tasks.get(taskPath[1] ?? "");
      return found === undefined ? notFound() : json(found);
    }
    if (url.pathname === "/v1/tasks") {
      return json({
        tasks: state.posted.get(url.searchParams.get("poster") ?? "") ?? [],
        next_cursor: null,
      });
    }
    if (url.pathname.startsWith("/v1/services")) return serveServices(state, url, init);
    return notFound();
  });
}

/**
 * The provider's services: the list, and the two writes, which change `state.services` as the API
 * would (a listing is the provider's, a change merges into the service).
 */
function serveServices(state: World, url: URL, init: RequestInit): Response {
  const method = init.method ?? "GET";
  if (method === "GET" && url.pathname === "/v1/services") {
    const provider = url.searchParams.get("provider");
    return json({
      services: state.services.filter((one) => provider === null || one.provider === provider),
      next_cursor: null,
    });
  }
  if (method !== "POST") return notFound();
  const headers = new Headers(init.headers);
  state.serviceAuth.push(headers.get("authorization"));
  const body = JSON.parse(String(init.body ?? "{}")) as Partial<Service> & { status?: string };
  const id = /^\/v1\/services\/(\d+)$/.exec(url.pathname)?.[1];
  if (id === undefined) {
    const made = {
      ...(state.services[0] ?? ({} as Service)),
      ...body,
      id: String(100 + state.services.length),
      provider: ALICE,
      status: "active",
      available: true,
      verification: { kind: "hirer" },
    } as Service;
    state.services.unshift(made);
    return json({ service: made });
  }
  const at = state.services.findIndex((one) => one.id === id);
  const was = state.services[at];
  if (was === undefined) return notFound();
  const changed = {
    ...was,
    ...body,
    verification: was.verification,
    available: (body.status ?? was.status) === "active",
  } as Service;
  state.services[at] = changed;
  return json({ service: changed });
}

/** A transaction an account wallet was asked to send. */
export interface Sent {
  receiverId: string;
  actions: Array<{ type: string; params?: Record<string, unknown> }>;
}

/**
 * Alice's wallet. `accountActions`: its manifest says it signs and sends whole transactions, and
 * one that creates an account makes it on `state`'s chain with the key its setup call adds.
 * `refuse`: it throws.
 */
export function accountWallet(
  state: World,
  options: { accountActions?: boolean; refuse?: boolean } = {},
): Session & { wallet: SigningWallet; sent: Sent[] } {
  const sent: Sent[] = [];
  const wallet: SigningWallet = {
    manifest: {
      features: { signMessage: true, signAndSendTransactions: options.accountActions ?? true },
    },
    async signAndSendTransactions({ transactions }) {
      if (options.refuse) throw new Error("User rejected");
      return (transactions as unknown as Sent[]).map((transaction, index) => {
        sent.push(transaction);
        // The setup code adds the key it is called with (contract/agent-setup).
        const setup = transaction.actions.find(
          (action) => action.type === "FunctionCall" && action.params?.methodName === "setup",
        );
        const key = (setup?.params?.args as { public_key?: unknown } | undefined)?.public_key;
        if (transaction.actions.some((action) => action.type === "CreateAccount")) {
          state.accounts.set(transaction.receiverId, typeof key === "string" ? [key] : []);
        }
        return {
          status: { SuccessValue: "" },
          transaction: { hash: `tx${index}` },
          receipts_outcome: [
            {
              id: "r",
              outcome: {
                executor_id: transaction.receiverId,
                logs: [],
                status: { SuccessValue: "" },
              },
            },
          ],
        };
      });
    },
    async signMessage() {
      throw new Error("not asked");
    },
  };
  return { wallet, accountId: ALICE, sent };
}

/** A private key as NEAR writes one, 64 bytes in base58: made-up bytes, no one's key. */
export const MADE_UP_SECRET = `ed25519:${base58Encode(new Uint8Array(64).fill(7))}`;

/** Made-up words in the shape of a seed phrase (BIP-39 words are lower-case English words). */
const words = (n: number) =>
  Array.from({ length: n }, (_, i) => ["river", "candle", "orbit", "maple"][i % 4]).join(" ");

/**
 * Every shape of key material a person could paste by mistake beside `publicKey`, by name, each
 * one made up: the page must clear each from the field at once.
 */
export function secretShapes(publicKey: string): Record<string, string> {
  const secret = MADE_UP_SECRET;
  return {
    "a private key": secret,
    "a private key without its prefix": secret.slice(8),
    "a private key with its prefix in capitals": `ED25519:${secret.slice(8)}`,
    "a private key with one more character": `${secret}x`,
    "NEAR's credentials file": JSON.stringify({
      account_id: "scout.alice.testnet",
      public_key: publicKey,
      private_key: secret,
    }),
    "a secret_key line": `secret_key: ${secret}`,
    "a secretKey field": `{"secretKey":"x"}`,
    "the public key and then the private key": `${publicKey}\n${secret}`,
    "words that name a private key": "my private key is in the file",
    "a 12-word seed phrase": words(12),
    "a 24-word seed phrase": words(24),
    "a base58 blob of 33 bytes": `ed25519:${base58Encode(new Uint8Array(33).fill(9))}`,
    "a base58 blob of 48 bytes, no prefix": base58Encode(new Uint8Array(48).fill(5)),
    "a seed in hex": "ab".repeat(32),
  };
}
