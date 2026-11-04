import type { Page } from "@playwright/test";
import type {
  AccountEntriesResponse,
  AccountEntry,
  AgentSummary,
  ListTasksResponse,
  TaskDetailResponse,
  TaskSummary,
} from "@tender/shared";
import { base58Encode } from "../lib/agentKey";
import { agent, CREATED, detail, SECOND, summary } from "../test/tasks";
import { OTHER_TOKEN } from "./agentsApi";
import { API_URL, RPC_URL } from "./fixtures";
import { routeWalletManifest, STUB_WALLET_NAME } from "./walletStub";

// The fixture API, node and wallet of the account pages (My agents, Add an agent, Earnings), for
// alice.testnet: she is a registered agent herself and runs three agents under her account, one of
// them as wide as the data can be. Her agents have won, wait on picks, and she has posted tasks
// whose rewards are locked, paid out, refunded and due back. `bonds` adds the fields the contract's
// agent bond (Task 16b) will add to an agent. Each helper registers its route after `routeApi`,
// which is the one a request falls back to.

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

const TOKEN = "tusdc.tender-team.testnet";

export const OWNER = "alice.testnet";
export const SCOUT = `scout.${OWNER}`;
/** A sub-account as long as an account id can be: 64 characters. */
export const LONG = `${"u".repeat(50)}.${OWNER}`;
export const RETIRED = `old.${OWNER}`;
/** The largest u128. */
const MAX = "340282366920938463463374607431768211455";

/** A moment far in the future, in nanoseconds: when an unregistering agent can claim its bond. */
const CLAIMABLE = (CREATED + 14n * 86_400n * SECOND).toString();

function withBond(row: AgentSummary, status: string, amount: string, claimable?: string) {
  return {
    ...row,
    status,
    bond_token: TOKEN,
    bond_amount: amount,
    ...(claimable === undefined ? {} : { claimable_at: claimable }),
  };
}

/** The connected account's own agent record. */
const SELF = agent({
  account: OWNER,
  asp: null,
  name: "Alice Extractor",
  tags: ["extraction", "json"],
  entries: 5,
  reveals: 4,
  wins: 1,
  earned: { [TOKEN]: "1900000" },
  picks_made: 0,
  voids_after_reveals: 0,
  is_team: false,
});

/** The agents under her account, in the order of their accounts. */
const UNDER: AgentSummary[] = [
  agent({
    account: RETIRED,
    asp: OWNER,
    name: "Old Reader",
    tags: ["research"],
    entries: 2,
    reveals: 1,
    wins: 0,
    earned: {},
    picks_made: 0,
    voids_after_reveals: 0,
    is_team: false,
  }),
  agent({
    account: SCOUT,
    asp: OWNER,
    name: "Alice Scout",
    tags: ["research", "coding"],
    entries: 9,
    reveals: 8,
    wins: 1,
    earned: { [TOKEN]: "2850000" },
    picks_made: 0,
    voids_after_reveals: 0,
    is_team: false,
  }),
  agent({
    account: LONG,
    asp: OWNER,
    name: "u".repeat(64),
    tags: ["extraordinarily-long-tag", "a".repeat(24)],
    entries: 4_294_967_295,
    reveals: 4_294_967_295,
    wins: 4_294_967_295,
    earned: { [TOKEN]: MAX, [OTHER_TOKEN]: MAX },
    picks_made: 0,
    voids_after_reveals: 0,
    is_team: false,
  }),
];

/** The agents as the API lists them: with the bond fields, or as the API is today. */
export function accountAgents(bonds: boolean): { self: object; under: object[] } {
  if (!bonds) return { self: SELF, under: UNDER };
  const [retired, scout, long] = UNDER as [AgentSummary, AgentSummary, AgentSummary];
  return {
    self: withBond(SELF, "active", "5000000"),
    under: [
      withBond(retired, "retired", "5000000"),
      withBond(scout, "active", "5000000"),
      withBond(long, "unregistering", MAX, CLAIMABLE),
    ],
  };
}

const settledAt = (task: Partial<TaskSummary>): Partial<TaskSummary> => ({
  // Every window closed before the fixtures' clock: the task is decided, or past its last chance.
  created_at: (CREATED - 3_000n * SECOND).toString(),
  commit_deadline: (CREATED - 2_500n * SECOND).toString(),
  reveal_deadline: (CREATED - 2_000n * SECOND).toString(),
  pick_deadline: (CREATED - 1_500n * SECOND).toString(),
  fallback_deadline: (CREATED - 1_000n * SECOND).toString(),
  ...task,
});

/** A task an agent won, with its pick: `winners` as the contract paid them, less the fee. */
function won(
  id: string,
  title: string,
  reward: string,
  token: string,
  winners: Array<{ account: string; bps: number }>,
): TaskDetailResponse {
  const fee = (BigInt(reward) * 500n) / 10_000n;
  const net = BigInt(reward) - fee;
  return detail(
    settledAt({
      id,
      title,
      reward,
      token,
      phase: "settled",
      outcome_kind: "picked",
      outcome: {
        kind: "picked",
        task_id: id,
        by: "judge.tender-team.testnet",
        winners: winners.map(({ account, bps }) => ({
          account,
          bps,
          amount: ((net * BigInt(bps)) / 10_000n).toString(),
        })),
        fee: fee.toString(),
        scorecard_hash: "c".repeat(64),
        scorecard_uri: `${API_URL}/v1/blobs/${"c".repeat(64)}`,
      },
    } as Partial<TaskDetailResponse["task"]>),
  );
}

export const WIN_TITLES = {
  invoice: "Extract the totals from forty invoices",
  regex: "Regex for valid NEAR account IDs",
  wide: "unbroken".repeat(15),
};

const DETAILS = new Map<string, TaskDetailResponse>([
  ["21", won("21", WIN_TITLES.invoice, "2000000", TOKEN, [{ account: OWNER, bps: 10_000 }])],
  [
    "22",
    won("22", WIN_TITLES.regex, "5000000", TOKEN, [
      { account: SCOUT, bps: 6_000 },
      { account: "carol.testnet", bps: 4_000 },
    ]),
  ],
  ["23", won("23", WIN_TITLES.wide, MAX, OTHER_TOKEN, [{ account: LONG, bps: 10_000 }])],
]);

function entryOf(
  task_id: string,
  title: string | null,
  extra: Partial<AccountEntry>,
): AccountEntry {
  return {
    task_id,
    title,
    phase: "settled",
    revealed: true,
    won: false,
    entry_index: 0,
    committed_height: "100",
    content_hash: "a".repeat(64),
    uri: `${API_URL}/v1/blobs/${"a".repeat(64)}`,
    ...extra,
  };
}

const ENTRIES: Record<string, AccountEntry[]> = {
  [OWNER]: [
    entryOf("24", "Summarise the on-call handover", { phase: "judging" }),
    entryOf("21", WIN_TITLES.invoice, { won: true }),
    entryOf("2", "Regex for valid NEAR account IDs", {
      phase: "open",
      revealed: false,
      content_hash: null,
      uri: null,
    }),
  ],
  [SCOUT]: [
    entryOf("25", "Find the duplicate rows", { phase: "revealing" }),
    entryOf("22", WIN_TITLES.regex, { won: true }),
  ],
  [LONG]: [entryOf("23", WIN_TITLES.wide, { won: true })],
  [RETIRED]: [entryOf("20", null, { phase: "expired" })],
};

/** What alice posted: one open, one paid out, one refunded, one past its last window. */
export const POSTED: TaskSummary[] = [
  summary({
    id: "34",
    title: "Label five hundred receipts",
    poster: OWNER,
    reward: "750000",
    token: TOKEN,
    ...settledAt({}),
    phase: "expired",
    is_team_poster: false,
  }),
  summary({
    id: "33",
    title: "Translate the release notes",
    poster: OWNER,
    reward: "500000",
    token: TOKEN,
    ...settledAt({}),
    phase: "settled",
    outcome_kind: "voided",
    is_team_poster: false,
  }),
  summary({
    id: "32",
    title: "Extract fields from an invoice",
    poster: OWNER,
    reward: "1000000",
    token: TOKEN,
    ...settledAt({}),
    phase: "settled",
    outcome_kind: "picked",
    is_team_poster: false,
  }),
  summary({
    id: "31",
    title: "Check every rule of the account id",
    poster: OWNER,
    reward: "3000000",
    token: TOKEN,
    phase: "open",
    is_team_poster: false,
  }),
];

export interface AccountApi {
  /** Agents that registered after the page loaded: `GET /v1/agents/:account` lists them. */
  registered: Set<string>;
}

/**
 * Answers the reads of the account pages for alice. `empty`: an account that runs no agent and has
 * posted nothing. `bonds`: the agents carry the bond fields.
 */
export async function routeAccount(
  page: Page,
  options: { bonds?: boolean; empty?: boolean } = {},
): Promise<AccountApi> {
  const api: AccountApi = { registered: new Set() };
  const { self, under } = accountAgents(options.bonds === true);
  const everyone = new Map<string, object>(
    options.empty
      ? []
      : [
          [OWNER, self],
          ...under.map((row) => [(row as AgentSummary).account, row] as [string, object]),
        ],
  );

  await page.route(`${API_URL}/**`, async (route) => {
    const request = route.request();
    if (request.method() !== "GET") return route.fallback();
    const url = new URL(request.url());
    const json = (body: unknown) => route.fulfill({ status: 200, json: body, headers: CORS });

    if (url.pathname === "/v1/agents" && url.searchParams.get("asp") === OWNER) {
      return json({ agents: options.empty ? [] : under, next_cursor: null });
    }
    const one = /^\/v1\/agents\/([^/]+)$/.exec(url.pathname);
    if (one !== null) {
      const account = decodeURIComponent(one[1] ?? "");
      const found = everyone.get(account);
      if (found !== undefined) return json({ agent: found, recent_entries: [] });
      if (api.registered.has(account)) {
        return json({
          agent: agent({ account, asp: OWNER, name: null, tags: [], is_team: false }),
          recent_entries: [],
        });
      }
      if (account.endsWith(`.${OWNER}`) || account === OWNER) {
        return route.fulfill({
          status: 404,
          json: { error: "not_found", message: "no such agent" },
          headers: CORS,
        });
      }
      return route.fallback();
    }
    if (url.pathname === "/v1/entries") {
      const account = url.searchParams.get("account") ?? "";
      const body: AccountEntriesResponse = {
        entries: options.empty ? [] : (ENTRIES[account] ?? []),
      };
      return json(body);
    }
    const task = /^\/v1\/tasks\/(\d+)$/.exec(url.pathname);
    const won = task === null ? undefined : DETAILS.get(task[1] ?? "");
    if (won !== undefined) return json(won);
    if (url.pathname === "/v1/tasks" && url.searchParams.get("poster") === OWNER) {
      const body: ListTasksResponse = { tasks: options.empty ? [] : POSTED, next_cursor: null };
      return json(body);
    }
    return route.fallback();
  });
  return api;
}

/** The chain as the Add-an-agent page reads it: which accounts exist, with which keys. */
export interface AccountChain {
  /** Account id to its full-access keys. */
  accounts: Map<string, string[]>;
  /** The contract's config view. */
  config: Record<string, unknown>;
}

/**
 * Answers the page's JSON-RPC reads from `chain`: `view_account`, `view_access_key`, and the
 * contract's `get_config`, as a node does, "does not exist" included.
 */
export async function routeAccountNode(page: Page, chain: AccountChain): Promise<void> {
  await page.route(`${RPC_URL}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const body = request.postDataJSON() as { id: unknown; params: Record<string, string> };
    const params = body.params;
    const answer = (value: object) =>
      route.fulfill({
        status: 200,
        headers: CORS,
        json: { jsonrpc: "2.0", id: body.id, ...value },
      });
    const unknown = (name: string, data: string) =>
      answer({
        error: {
          name: "HANDLER_ERROR",
          cause: { name, info: {} },
          code: -32000,
          message: "Server error",
          data,
        },
      });
    if (params.request_type === "view_account") {
      return chain.accounts.has(params.account_id ?? "")
        ? answer({
            result: {
              amount: "500000000000000000000000",
              locked: "0",
              code_hash: "11111111111111111111111111111111",
              storage_usage: 182,
              block_height: 100,
            },
          })
        : unknown("UNKNOWN_ACCOUNT", `account ${params.account_id} does not exist while viewing`);
    }
    if (params.request_type === "view_access_key") {
      const keys = chain.accounts.get(params.account_id ?? "") ?? [];
      return keys.includes(params.public_key ?? "")
        ? answer({ result: { nonce: 0, permission: "FullAccess", block_height: 100 } })
        : unknown(
            "UNKNOWN_ACCESS_KEY",
            `access key ${params.public_key} does not exist while viewing`,
          );
    }
    if (params.request_type === "call_function" && params.method_name === "get_config") {
      const bytes = [...new TextEncoder().encode(JSON.stringify(chain.config))];
      return answer({ result: { result: bytes, logs: [], block_height: 100 } });
    }
    return answer({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_QUERY" } } });
  });
}

/** A transaction the account wallet was asked to send, as it got it. */
export interface SentTransaction {
  receiverId: string;
  actions: Array<{ type: string; params?: Record<string, unknown> }>;
}

/**
 * A wallet for `account`, announced the way an extension is, that sends what it is given on
 * `chain`: a transaction that creates an account makes it, with the key it adds. `refuse`: a
 * wallet that throws, as one does when the person rejects it.
 */
export async function installAccountWallet(
  page: Page,
  options: { account: string; chain: AccountChain; refuse?: boolean },
): Promise<{ sent: SentTransaction[] }> {
  const wallet = { sent: [] as SentTransaction[] };
  await routeWalletManifest(page);
  await page.exposeFunction(
    "__tenderE2eAccountSend",
    (batch: { transactions: SentTransaction[] }) => {
      if (options.refuse) throw new Error("User rejected");
      return batch.transactions.map((transaction, index) => {
        wallet.sent.push(transaction);
        const created = transaction.actions.some((action) => action.type === "CreateAccount");
        const key = transaction.actions.find((action) => action.type === "AddKey")?.params
          ?.publicKey;
        if (created)
          options.chain.accounts.set(transaction.receiverId, typeof key === "string" ? [key] : []);
        return {
          status: { SuccessValue: "" },
          transaction: { hash: `acct-tx-${wallet.sent.length}-${index}` },
          receipts_outcome: [
            {
              id: `r${index}`,
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
  );
  await page.addInitScript(
    ({ account, name }) => {
      const wallet = {
        manifest: {
          id: "e2e-account-wallet",
          name,
          icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
          description: "A wallet for the specs.",
          website: "https://e2e-wallet.test",
          version: "1.0.0",
          executor: "",
          type: "injected",
          platform: {},
          permissions: {},
          features: { signMessage: true, signAndSendTransactions: true, testnet: true },
        },
        signIn: async () => [{ accountId: account, publicKey: `ed25519:${"1".repeat(44)}` }],
        signOut: async () => {},
        getAccounts: async () => [{ accountId: account, publicKey: `ed25519:${"1".repeat(44)}` }],
        signAndSendTransactions: (batch: unknown) =>
          (
            window as unknown as Record<string, (batch: unknown) => Promise<unknown>>
          ).__tenderE2eAccountSend?.(batch),
        signMessage: async () => {
          throw new Error("this wallet signs no messages in the specs");
        },
      };
      const announce = () =>
        window.dispatchEvent(new CustomEvent("near-wallet-injected", { detail: wallet }));
      window.addEventListener("near-selector-ready", announce);
      announce();
    },
    { account: options.account, name: STUB_WALLET_NAME },
  );
  return wallet;
}

/** A public key, as `pnpm agent:init` prints one: 32 bytes in base58. */
export const AGENT_PUBLIC_KEY = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
/**
 * A private key as NEAR writes one, 64 bytes in base58: made-up bytes, no one's key. The page must
 * clear it at once.
 */
export const AGENT_SECRET_KEY = `ed25519:${base58Encode(new Uint8Array(64).fill(7))}`;
