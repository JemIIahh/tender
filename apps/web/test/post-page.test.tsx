import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SIGN_IN_MESSAGE, sha256Hex } from "@tender/shared";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, type MockInstance, test, vi } from "vitest";
import { PostWizard } from "../components/post/PostWizard";
import { heldToken } from "../lib/apiToken";
import { clearApiToken } from "../lib/auth";
import { RUBRIC_JUDGE_NOTE } from "../lib/post";
import { createWalletStore, type WalletStore } from "../lib/wallet";
import { WALLET_CANNOT_SIGN_MESSAGE } from "../lib/walletErrors";
import { FakeChain, FakeNode, fakeFetch, type Outcome } from "./fakeChain";
import { JUDGE, SECRET, TOKEN } from "./postForms";
import { agent } from "./tasks";
import { type ChainWallet, chainWallet, fakeProvider } from "./walletDoubles";

// The post wizard as a person uses it: the real page over a wallet that runs on a model of the
// contract and its token (read through a fake RPC node) and an API that keeps what it is sent.
// vitest.config.ts gives the config the network testnet, the contract tender.testnet, the API
// http://api.test and the node http://rpc.test.

const CONTRACT = "tender.testnet";
const ALICE = "alice.testnet";
const BOB = "bob.testnet";
const TUSDC = (whole: number) => BigInt(whole) * 1_000_000n;
const SECOND = 1_000_000_000n;

// The page reads the wallet from `lib/wallet` and the router from Next; the tests hand it their own.
const holder = vi.hoisted(() => ({ store: undefined as unknown as WalletStore }));
vi.mock("../lib/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wallet")>();
  return { ...actual, useWallet: () => actual.useWalletStore(holder.store) };
});
const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

// ---- The world ----------------------------------------------------------------------------------

const CHALLENGE = {
  nonce: btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1))),
  message: SIGN_IN_MESSAGE,
  recipient: "http://api.test",
  expires_at: "2099-01-01T00:00:00.000Z",
};

interface ApiOptions {
  /** What `GET /v1/agents/:account` says about the connected account. */
  agentIs?: "team" | "not-team" | "unknown" | "broken";
  /** The first upload is answered 401, and the token it came with is not good again. */
  turnFirstTokenAway?: boolean;
  /** Every upload is answered 500. */
  uploadsFail?: boolean;
}

interface Upload {
  /** The bearer token the request came with. */
  token: string | null;
  text: string;
  bytes: Uint8Array;
}

interface FakeApi {
  /** Every request, in order. */
  requests: Array<{ method: string; path: string; url: string; body: string }>;
  blobs: Array<Upload & { kind: string; sha256: string }>;
  heldouts: Array<Upload & { commitment: string }>;
  challenges: number;
  /** The tokens issued, in order. */
  tokens: string[];
  route(url: URL, init?: RequestInit): Response;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * An API that issues a challenge, trades any signature for a token named for the account and its
 * place among the tokens, and keeps the documents it is sent after checking the token and the hash.
 */
function fakeApi(options: ApiOptions = {}): FakeApi {
  const revoked = new Set<string>();
  let uploads = 0;
  const api: FakeApi = {
    requests: [],
    blobs: [],
    heldouts: [],
    challenges: 0,
    tokens: [],
    route(url, init = {}) {
      const method = init.method ?? "GET";
      const body = typeof init.body === "string" ? init.body : "";
      api.requests.push({ method, path: url.pathname, url: url.href, body });

      if (method === "POST" && url.pathname === "/v1/auth/challenge") {
        api.challenges++;
        return json(200, CHALLENGE);
      }
      if (method === "POST" && url.pathname === "/v1/auth/verify") {
        const { account_id: account } = JSON.parse(body) as { account_id: string };
        const token = `tok-${account}-${api.tokens.length + 1}`;
        api.tokens.push(token);
        return json(200, {
          token,
          expires_at: "2099-01-01T00:00:00.000Z",
          key_kind: "full_access",
        });
      }

      const owner = /^\/v1\/agents\/([^/]+)$/.exec(url.pathname);
      if (method === "GET" && owner !== null) {
        const account = owner[1] ?? "";
        const is = options.agentIs ?? "not-team";
        if (is === "broken") return json(500, { error: "internal", message: "broken" });
        if (is === "unknown") return json(404, { error: "not_found", message: "no such agent" });
        return json(200, {
          agent: agent({ account, is_team: is === "team" }),
          recent_entries: [],
        });
      }

      if (method === "POST" && (url.pathname === "/v1/blobs" || url.pathname === "/v1/heldout")) {
        const headers = (init.headers ?? {}) as Record<string, string>;
        const token = headers.Authorization?.replace(/^Bearer /, "") ?? null;
        uploads++;
        if (token === null || !api.tokens.includes(token) || revoked.has(token)) {
          return json(401, { error: "unauthorized", message: "Sign in again." });
        }
        if (options.turnFirstTokenAway && uploads === 1) {
          revoked.add(token);
          return json(401, { error: "unauthorized", message: "Sign in again." });
        }
        if (options.uploadsFail) return json(500, { error: "internal", message: "down" });

        const parsed = JSON.parse(body) as Record<string, string>;
        const bytes = new Uint8Array(Buffer.from(parsed.content_base64 ?? "", "base64"));
        const upload = { token, bytes, text: new TextDecoder().decode(bytes) };
        const sha256 = sha256Hex(bytes);
        if (url.pathname === "/v1/blobs") {
          api.blobs.push({ ...upload, kind: parsed.kind ?? "", sha256 });
          return json(200, { sha256, uri: `http://api.test/v1/blobs/${sha256}` });
        }
        if (sha256 !== parsed.commitment) {
          return json(400, { error: "bad_request", message: "The hash does not match." });
        }
        api.heldouts.push({ ...upload, commitment: sha256 });
        return json(200, { ok: true });
      }
      return json(404, { error: "not_found", message: "no such route" });
    },
  };
  return api;
}

interface Options extends ApiOptions {
  /** The wallet of an earlier visit is back. True unless said. */
  connected?: boolean;
  /** Whether the wallet can sign a message. True unless said. */
  signMessage?: boolean;
  /** What the account holds in its vault, in base units. */
  vault?: bigint;
  /** What the account holds in its wallet. 20 tUSDC unless said. */
  holds?: bigint;
  /** Whether the account is set up with Tender. True unless said. */
  setUp?: boolean;
  paused?: boolean;
  /** The first read of the chain fails, as a dropped connection does. */
  limitsFailOnce?: boolean;
  /** Every read of the vault fails (the limits are read as usual). */
  vaultReadFails?: boolean;
}

interface World {
  chain: FakeChain;
  wallet: ChainWallet;
  api: FakeApi;
  user: ReturnType<typeof userEvent.setup>;
  /** Everything the page wrote with `console.error`, as text. */
  said(): string;
}

let errors: MockInstance<typeof console.error>;

beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  router.push.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearApiToken();
  sessionStorage.clear();
});

function setup(options: Options = {}): World {
  const chain = new FakeChain(CONTRACT, [
    { token: TOKEN, minReward: TUSDC(1), maxReward: TUSDC(1000) },
  ]);
  chain.give(TOKEN, ALICE, options.holds ?? TUSDC(20));
  if (options.setUp !== false) chain.fundVault(ALICE, TOKEN, options.vault ?? 0n);
  chain.paused = options.paused ?? false;
  const wallet = chainWallet(chain, ALICE, { signMessage: options.signMessage });
  holder.store = createWalletStore(async () =>
    fakeProvider({ wallet, accountId: ALICE }, { restored: options.connected !== false }),
  );

  const api = fakeApi(options);
  const route = fakeFetch("http://rpc.test", new FakeNode(chain), (url, init) =>
    api.route(url, init),
  );
  let reads = 0;
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const rpc = String(input).startsWith("http://rpc.test");
    if (options.limitsFailOnce && rpc && reads++ === 0) throw new TypeError("Failed to fetch");
    if (options.vaultReadFails && rpc && String(init?.body).includes('"balances_of"')) {
      throw new TypeError("Failed to fetch");
    }
    return route(input, init);
  });

  const said = () =>
    errors.mock.calls
      .flat()
      .map((part: unknown) =>
        part instanceof Error
          ? `${part.name}: ${part.message} ${String(part.cause ?? "")}`
          : String(part),
      )
      .join("\n");
  return { chain, wallet, api, user: userEvent.setup(), said };
}

// ---- Driving the page ---------------------------------------------------------------------------

const LONG = { timeout: 4000 };

/** Sets a field the way a paste does: at once, and as the whole value. */
function fill(label: string | RegExp, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

type User = World["user"];

const press = (user: User, name: string | RegExp) =>
  user.click(screen.getByRole("button", { name }));

const stepHeading = (name: string) => screen.findByRole("heading", { level: 2, name });

const off = (button: HTMLElement) => button.getAttribute("aria-disabled") === "true";

const testId = (id: string) => screen.getByTestId(id).textContent;

const writes = (api: FakeApi) => api.requests.filter(({ method }) => method === "POST");

function fillBrief(): void {
  fill("Title", "Regex for NEAR account ids");
  fill("Instructions", "Return a pattern and its flags.");
}

async function fillRegexChecks(user: User): Promise<void> {
  await user.click(screen.getByRole("radio", { name: /Regex cases/ }));
  fill("Should match", "alice.near\nbob.testnet");
  fill("Should not match", "-bad\nUPPER");
  fill("Held-out: should match", `${SECRET}.near\ncarol.near`);
  fill("Held-out: should not match", "dave..near\n_eve.near");
}

async function toChecks(user: User): Promise<void> {
  fillBrief();
  await press(user, "Next: Checks");
  await stepHeading("Checks");
}

async function toReward(user: User): Promise<void> {
  await toChecks(user);
  await fillRegexChecks(user);
  await press(user, "Next: Reward");
  await screen.findByLabelText("Amount (tUSDC)");
}

async function toReview(user: User, amount = "5"): Promise<void> {
  await toReward(user);
  fill("Amount (tUSDC)", amount);
  await press(user, "Review");
  await stepHeading("Review");
}

const postButton = () => screen.getByRole("button", { name: /^Post/ });

/** The Post button once the page has read the account's balances and found nothing in the way. */
async function postReady(): Promise<HTMLElement> {
  await waitFor(() => expect(off(postButton())).toBe(false), LONG);
  return postButton();
}

/** Lets the reads that are under way finish, for a test that looks for something not being there. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

// ---- Posting ------------------------------------------------------------------------------------

test("a_regex_task_is_posted_from_the_page_with_the_deposit_first", async () => {
  const { user, chain, wallet, api, said } = setup({ vault: TUSDC(2) });
  render(<PostWizard judgeAccount={JUDGE} />);

  await toReview(user);

  // The review says what will happen, in words and counts. The held-out checks are only counted.
  expect(testId("review-title")).toBe("Regex for NEAR account ids");
  expect(testId("review-reward")).toContain("5.00 tUSDC");
  expect(testId("review-answer")).toBe("A regex, as JSON, up to 4,096 bytes");
  expect(testId("review-checks")).toBe("Regex cases, pass mark 100 of 100");
  expect(testId("review-split")).toBe("4 examples");
  expect(testId("review-heldout")).toBe("4 cases");
  expect(testId("review-prize")).toBe("Winner takes all");
  expect(testId("review-windows")).toBe(
    "Commit 10m · Reveal 5m · Judge 10m · Fallback 10m. 35m in all.",
  );
  expect(testId("review-verifier")).toBe("Tender Judge (run by the Tender team) · judge.testnet");
  expect(testId("review-account")).toBe(ALICE);
  expect(document.body.textContent).not.toContain(SECRET);
  await waitFor(
    () =>
      expect(testId("review-funding")).toBe(
        "Your vault: 2.00 tUSDC. Added from your wallet first: 3.00 tUSDC.",
      ),
    LONG,
  );

  await user.click(await postReady());
  await waitFor(() => expect(router.push).toHaveBeenCalledWith("/tasks/1"), LONG);
  expect(testId("post-done")).toBe("Posted. Opening your task. Open it now");
  expect(within(screen.getByTestId("post-done")).getByRole("link").getAttribute("href")).toBe(
    "/tasks/1",
  );
  expect(off(postButton())).toBe(true);

  // Signed in once, then the documents went up one after the other, the held-out last.
  expect(writes(api).map(({ path }) => path)).toEqual([
    "/v1/auth/challenge",
    "/v1/auth/verify",
    "/v1/blobs",
    "/v1/blobs",
    "/v1/heldout",
  ]);
  expect(wallet.signRequests).toHaveLength(1);
  expect(api.blobs.map(({ kind }) => kind)).toEqual(["brief", "criteria"]);
  const [brief, criteria] = api.blobs;
  const [heldout] = api.heldouts;
  expect([...api.blobs, ...api.heldouts].every(({ token }) => token === api.tokens[0])).toBe(true);

  // One batch to the wallet: the deposit that tops the vault up, then the post.
  expect(wallet.sent).toHaveLength(1);
  expect(wallet.sent[0]?.transactions.map(({ receiverId }) => receiverId)).toEqual([
    TOKEN,
    CONTRACT,
  ]);
  expect(chain.calls.map(({ receiverId, methodName }) => `${receiverId} ${methodName}`)).toEqual([
    `${TOKEN} ft_transfer_call`,
    `${CONTRACT} post_task`,
  ]);
  const task = chain.tasks.get(1n);
  expect(task).toMatchObject({
    poster: ALICE,
    token: TOKEN,
    reward: TUSDC(5),
    verifier: JUDGE,
    briefHash: brief?.sha256,
    briefUri: `http://api.test/v1/blobs/${brief?.sha256}`,
    criteriaHash: criteria?.sha256,
    heldoutCommitment: heldout?.commitment,
    maxWinners: 1,
  });
  expect(sha256Hex(heldout?.bytes ?? new Uint8Array())).toBe(task?.heldoutCommitment);
  expect(task && task.commitDeadline - task.createdAt).toBe(600n * SECOND);
  expect(task && task.revealDeadline - task.commitDeadline).toBe(300n * SECOND);
  expect(task && task.pickDeadline - task.revealDeadline).toBe(600n * SECOND);
  expect(task && task.fallbackDeadline - task.pickDeadline).toBe(600n * SECOND);
  expect(JSON.parse(heldout?.text ?? "{}")).toEqual({
    regex_cases: {
      match: [`${SECRET}.near`, "carol.near"],
      no_match: ["dave..near", "_eve.near"],
    },
  });
  expect(JSON.parse(criteria?.text ?? "{}")).toMatchObject({
    kind: "regex_cases",
    has_heldout: true,
    examples: { match: ["alice.near", "bob.testnet"], no_match: ["-bad", "UPPER"] },
  });

  // The held-out text went to one place, and the reward left the vault for the task.
  const elsewhere = [
    ...api.requests.map(({ url }) => url),
    ...api.blobs.map(({ text }) => text),
    ...api.requests.filter(({ path }) => path !== "/v1/heldout").map(({ body }) => body),
    JSON.stringify(wallet.sent),
    JSON.stringify(router.push.mock.calls),
    document.body.textContent ?? "",
    said(),
  ].join("\n");
  expect(elsewhere).not.toContain(SECRET);
  expect(
    Object.keys(sessionStorage)
      .map((key) => sessionStorage.getItem(key) ?? "")
      .join("\n"),
  ).not.toContain(SECRET);
  expect(chain.vault.get(ALICE)?.get(TOKEN)).toBe(0n);
});

test("a_vault_that_holds_the_reward_posts_without_a_deposit", async () => {
  const { user, wallet } = setup({ vault: TUSDC(8) });
  render(<PostWizard judgeAccount={JUDGE} />);
  await toReview(user);

  await waitFor(
    () => expect(testId("review-funding")).toBe("Your vault: 8.00 tUSDC, enough already."),
    LONG,
  );
  await user.click(await postReady());
  await waitFor(() => expect(router.push).toHaveBeenCalledWith("/tasks/1"), LONG);

  expect(wallet.sent[0]?.transactions.map(({ receiverId }) => receiverId)).toEqual([CONTRACT]);
});

test("a_second_press_while_the_first_is_under_way_posts_once", async () => {
  const { user, wallet, api } = setup({ vault: TUSDC(5) });
  render(<PostWizard judgeAccount={JUDGE} />);
  await toReview(user);

  await user.dblClick(await postReady());
  await waitFor(() => expect(router.push).toHaveBeenCalled(), LONG);

  expect(router.push).toHaveBeenCalledTimes(1);
  expect(wallet.sent).toHaveLength(1);
  expect(api.challenges).toBe(1);
  expect(api.blobs).toHaveLength(2);
  expect(api.heldouts).toHaveLength(1);
});

test.each([
  { verifier: "Me", typed: null, expected: ALICE },
  { verifier: "Another account", typed: BOB, expected: BOB },
])(
  "the_verifier_$verifier_is_the_one_the_task_is_posted_with",
  async ({ verifier, typed, expected }) => {
    const { user, chain } = setup({ vault: TUSDC(5) });
    render(<PostWizard judgeAccount={JUDGE} />);
    await toReward(user);
    fill("Amount (tUSDC)", "5");
    await user.click(screen.getByRole("radio", { name: new RegExp(`^${verifier}`) }));
    if (typed !== null) fill("Their NEAR account", typed);
    await press(user, "Review");
    await stepHeading("Review");

    expect(testId("review-verifier")).toBe(typed ?? "You");
    await user.click(await postReady());
    await waitFor(() => expect(router.push).toHaveBeenCalled(), LONG);

    expect(chain.tasks.get(1n)?.verifier).toBe(expected);
  },
);

test("custom_windows_are_what_the_task_is_posted_with", async () => {
  const { user, chain } = setup({ vault: TUSDC(5) });
  render(<PostWizard judgeAccount={JUDGE} />);
  await toReward(user);
  fill("Amount (tUSDC)", "5");

  await user.click(screen.getByRole("radio", { name: /^Custom/ }));
  // Custom starts from the choice it replaces: Quick, in the largest unit that fits.
  expect((screen.getByLabelText("Commit window") as HTMLInputElement).value).toBe("10");
  fill("Commit window", "2");
  fireEvent.change(screen.getByLabelText("Commit window unit"), { target: { value: "hours" } });
  await press(user, "Review");
  await stepHeading("Review");

  expect(testId("review-windows")).toBe(
    "Commit 2h · Reveal 5m · Judge 10m · Fallback 10m. 2h 25m in all.",
  );
  await user.click(await postReady());
  await waitFor(() => expect(router.push).toHaveBeenCalled(), LONG);
  const task = chain.tasks.get(1n);
  expect(task && task.commitDeadline - task.createdAt).toBe(7200n * SECOND);
});

// ---- Money --------------------------------------------------------------------------------------

test("amount_inputs_reject_invalid_on_the_page", async () => {
  const { user, wallet, api } = setup({ vault: TUSDC(5) });
  render(<PostWizard judgeAccount={JUDGE} />);
  await toReward(user);
  const amount = screen.getByLabelText("Amount (tUSDC)");
  const forward = () => screen.getByRole("button", { name: "Review" });

  // Nothing is said before the person has typed, and nothing of a good amount.
  expect(screen.queryByTestId("error-amount")).toBeNull();
  fill("Amount (tUSDC)", "5");
  expect(screen.queryByTestId("error-amount")).toBeNull();

  const cases: Array<[string, string | RegExp]> = [
    ["", "Enter an amount."],
    ["1.2345678", "This token has 6 decimal places at most."],
    ["0", "Enter more than 0."],
    ["-1", "An amount can't be negative."],
    ["1e3", "Use digits and one point, like 12.5."],
    ["0.5", "The least for this token is 1.00 tUSDC."],
    ["1000.01", /^The most for this token is 1,?000\.00 tUSDC\.$/],
  ];
  for (const [typed, message] of cases) {
    fill("Amount (tUSDC)", typed);
    const shown = screen.getByTestId("error-amount").textContent;
    if (typeof message === "string") expect(shown, typed).toBe(message);
    else expect(shown, typed).toMatch(message);
    expect(amount.getAttribute("aria-invalid"), typed).toBe("true");
    expect(off(forward()), typed).toBe(true);
  }

  // Pressing it anyway stays on the step, with the cursor in the field.
  await user.click(forward());
  expect(screen.queryByRole("heading", { level: 2, name: "Review" })).toBeNull();
  expect(document.activeElement).toBe(amount);

  // The edges are fine: the least and the most there are.
  for (const typed of ["1", "1000", "12.345678"]) {
    fill("Amount (tUSDC)", typed);
    expect(screen.queryByTestId("error-amount"), typed).toBeNull();
    expect(off(forward()), typed).toBe(false);
  }

  // Nothing was signed in for, uploaded or sent.
  expect(writes(api)).toEqual([]);
  expect(wallet.signRequests).toEqual([]);
  expect(wallet.sent).toEqual([]);
});

test("a_paused_contract_stops_the_reward_step", async () => {
  const { user } = setup({ paused: true });
  render(<PostWizard judgeAccount={JUDGE} />);
  await toReward(user);
  fill("Amount (tUSDC)", "5");

  expect(screen.getByRole("alert").textContent).toBe("Tender isn't taking new tasks right now.");
  expect(off(screen.getByRole("button", { name: "Review" }))).toBe(true);
});

test("windows_are_held_to_what_the_contract_allows", async () => {
  const { user } = setup();
  render(<PostWizard judgeAccount={JUDGE} />);
  await toReward(user);
  fill("Amount (tUSDC)", "5");
  await user.click(screen.getByRole("radio", { name: /^Custom/ }));
  const unit = (name: string, value: string) =>
    fireEvent.change(screen.getByLabelText(`${name} window unit`), { target: { value } });
  const forward = () => screen.getByRole("button", { name: "Review" });

  fill("Commit window", "0");
  expect(testId("error-window-commit")).toBe("Use a whole number above 0.");
  unit("Commit", "seconds");
  fill("Commit window", "30");
  expect(testId("error-window-commit")).toBe("At least 1m.");
  fill("Commit window", "1.5");
  expect(testId("error-window-commit")).toBe("Use a whole number above 0.");
  unit("Commit", "days");
  fill("Commit window", "15");
  expect(testId("error-window-commit")).toBe("At most 14d.");
  expect(off(forward())).toBe(true);

  fill("Commit window", "14");
  expect(screen.queryByTestId("error-window-commit")).toBeNull();
  expect(off(forward())).toBe(false);
});

test("the_reward_step_waits_for_what_tender_allows_and_asks_again_when_it_failed", async () => {
  const { user } = setup({ limitsFailOnce: true });
  render(<PostWizard judgeAccount={JUDGE} />);
  await toChecks(user);
  await fillRegexChecks(user);
  await press(user, "Next: Reward");

  // The read failed once: the step says so, and cannot be left.
  const alert = await screen.findByTestId("error-state");
  expect(alert.textContent).toContain("Can't reach the server.");
  expect(screen.queryByLabelText("Amount (tUSDC)")).toBeNull();
  expect(off(screen.getByRole("button", { name: "Review" }))).toBe(true);

  await user.click(within(alert).getByRole("button", { name: "Retry" }));
  await screen.findByLabelText("Amount (tUSDC)");
  expect(screen.queryByTestId("error-state")).toBeNull();
});

// ---- Review: what stands in the way -------------------------------------------------------------

test("an_account_that_is_not_set_up_is_sent_to_the_wallet_page_and_nothing_is_posted", async () => {
  const { user, wallet, api, chain } = setup({ setUp: false });
  render(<PostWizard judgeAccount={JUDGE} />);
  await toReview(user);

  const blocked = await screen.findByTestId("post-blocked");
  expect(blocked.textContent).toContain(
    "Your account isn't set up with Tender yet. Set it up on the Wallet page first.",
  );
  const link = within(blocked).getByRole("link", { name: "Open the Wallet page" });
  expect(link.getAttribute("href")).toBe("/wallet");
  // A tab of its own, so that the form on this page is kept.
  expect(link.getAttribute("target")).toBe("_blank");
  expect(off(postButton())).toBe(true);

  await user.click(postButton());
  await settle();
  expect(writes(api)).toEqual([]);
  expect(wallet.sent).toEqual([]);

  // Once it is set up, "Check again" reads the balances afresh and the way is clear.
  chain.fundVault(ALICE, TOKEN, 0n);
  await user.click(within(blocked).getByRole("button", { name: "Check again" }));
  await postReady();
  expect(screen.queryByTestId("post-blocked")).toBeNull();
});

test("a_wallet_that_holds_too_little_to_fund_the_reward_says_how_much_more", async () => {
  const { user, chain, wallet } = setup({ vault: TUSDC(1), holds: TUSDC(2) });
  render(<PostWizard judgeAccount={JUDGE} />);
  await toReview(user);

  // 5 are asked, 1 is in the vault and 2 in the wallet: 2 short.
  const blocked = await screen.findByTestId("post-blocked");
  expect(blocked.textContent).toContain("You need 2.00 tUSDC more in your wallet");
  expect(off(postButton())).toBe(true);
  expect(wallet.sent).toEqual([]);

  chain.give(TOKEN, ALICE, TUSDC(2));
  await user.click(within(blocked).getByRole("button", { name: "Check again" }));
  await postReady();
  expect(screen.queryByTestId("post-blocked")).toBeNull();
});

test("an_earlier_step_that_goes_wrong_while_review_is_open_stops_the_post", async () => {
  // A team account writes a rubric and reaches Review. Its wallet is then disconnected: the page
  // can no longer say the account is the team's, so the rubric is dropped, and the Checks step has
  // nothing the Judge could accept.
  const { user, wallet } = setup({ agentIs: "team", vault: TUSDC(5) });
  render(<PostWizard judgeAccount={JUDGE} />);
  await toChecks(user);
  await user.click(await screen.findByRole("radio", { name: /^Rubric/ }));
  fill("What to look for", "Says what changed");
  await press(user, "Next: Reward");
  await screen.findByLabelText("Amount (tUSDC)");
  fill("Amount (tUSDC)", "5");
  await press(user, "Review");
  await stepHeading("Review");
  await postReady();

  await act(async () => {
    await holder.store.disconnect();
  });

  const blocked = await screen.findByTestId("post-blocked");
  expect(blocked.textContent).toBe(
    "Something on an earlier step needs fixing. Go back and check each one.",
  );
  expect(off(postButton())).toBe(true);
  expect(wallet.sent).toEqual([]);

  // Back at the Checks step, the form is as the person left it but for the kind, which is Exact
  // answer now, and which asks for an answer to accept.
  await user.click(screen.getByRole("button", { name: "2 Checks" }));
  await stepHeading("Checks");
  expect((screen.getByRole("radio", { name: /Exact answer/ }) as HTMLInputElement).checked).toBe(
    true,
  );
  expect(off(screen.getByRole("button", { name: "Next: Reward" }))).toBe(true);
});

// ---- Review: the wallet -------------------------------------------------------------------------

test("a_wallet_that_cannot_sign_a_message_cannot_post_but_steps_one_to_three_work", async () => {
  const { user, wallet, api } = setup({ signMessage: false });
  render(<PostWizard judgeAccount={JUDGE} />);

  await toReview(user);

  expect(screen.getByTestId("cannot-sign").textContent).toBe(WALLET_CANNOT_SIGN_MESSAGE);
  expect(off(postButton())).toBe(true);
  await user.click(postButton());
  await settle();
  expect(writes(api)).toEqual([]);
  expect(wallet.signRequests).toEqual([]);
  expect(wallet.sent).toEqual([]);
});

test("without_a_wallet_the_form_works_and_review_offers_connect", async () => {
  const { user } = setup({ connected: false });
  render(<PostWizard judgeAccount={JUDGE} />);

  await toReview(user);

  expect(testId("review-account")).toBe("Not connected");
  // Nothing is being read without a wallet, so the row does not say it is reading.
  expect(testId("review-funding")).toBe("—");
  expect(screen.getByRole("button", { name: "Post task" }).getAttribute("aria-disabled")).toBe(
    "true",
  );
  await user.click(screen.getByRole("button", { name: "Connect wallet" }));
  await waitFor(() => expect(testId("review-account")).toBe(ALICE), LONG);
  expect(screen.queryByRole("button", { name: "Connect wallet" })).toBeNull();
  // The button the person pressed is gone; the focus is where they read on.
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Post it" }));
  await postReady();

  // What was typed before the wallet was there is still there.
  await user.click(screen.getByRole("button", { name: "1 Brief" }));
  expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
    "Regex for NEAR account ids",
  );
});

test("a_wallet_that_refuses_keeps_the_uploads_and_the_form_and_a_second_try_goes_through", async () => {
  const { user, wallet, api, said } = setup({ vault: TUSDC(5) });
  const send = wallet.signAndSendTransactions.bind(wallet);
  let refusals = 1;
  wallet.signAndSendTransactions = async (params) => {
    if (refusals-- > 0) throw new Error("User rejected");
    return send(params);
  };
  render(<PostWizard judgeAccount={JUDGE} />);
  await toReview(user);

  await user.click(await postReady());
  const failure = await screen.findByTestId("post-failure");
  expect(failure.textContent).toBe(
    "The wallet didn't finish. A deposit may have gone through: check the Wallet page. Your documents are saved; press Post to try again.",
  );
  expect(router.push).not.toHaveBeenCalled();
  expect(wallet.sent).toEqual([]);
  // A person who turned the request down sent nothing, so there is no lock and nothing to unlock.
  expect(screen.queryByTestId("post-unknown")).toBeNull();
  expect(screen.queryByRole("button", { name: "Unlock Post" })).toBeNull();
  // The documents are saved with Tender; the form is as it was.
  expect(api.blobs).toHaveLength(2);
  expect(api.heldouts).toHaveLength(1);
  expect(off(postButton())).toBe(false);
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect((screen.getByLabelText("Amount (tUSDC)") as HTMLInputElement).value).toBe("5");

  await press(user, "Review");
  await stepHeading("Review");
  await user.click(await postReady());
  await waitFor(() => expect(router.push).toHaveBeenCalledWith("/tasks/1"), LONG);

  // The same documents went up again, to the same addresses, under the same token.
  expect(api.challenges).toBe(1);
  expect(api.blobs.map(({ sha256 }) => sha256)).toEqual([
    api.blobs[0]?.sha256,
    api.blobs[1]?.sha256,
    api.blobs[0]?.sha256,
    api.blobs[1]?.sha256,
  ]);
  expect(api.heldouts.map(({ commitment }) => commitment)).toEqual([
    api.heldouts[0]?.commitment,
    api.heldouts[0]?.commitment,
  ]);
  expect(said()).not.toContain(SECRET);
});

test("a_wallet_that_fails_without_saying_whether_it_sent_locks_post_until_the_person_unlocks_it", async () => {
  const { user, wallet, api, chain, said } = setup({ vault: TUSDC(5) });
  const send = wallet.signAndSendTransactions.bind(wallet);
  let failures = 1;
  wallet.signAndSendTransactions = async (params) => {
    // The wallet's window closes: nothing says whether it sent the transactions first.
    if (failures-- > 0) throw new Error("Wallet closed");
    return send(params);
  };
  render(<PostWizard judgeAccount={JUDGE} />);
  await toReview(user);

  await user.click(await postReady());

  // The page can't say, so it says so, and tells the person to look before posting again.
  const unknown = await screen.findByTestId("post-unknown");
  expect(unknown.querySelector("p")?.textContent).toBe(
    "We couldn't tell whether the post went through. Check the Tasks page before posting again.",
  );
  // The Tasks page opens in a tab of its own, so that the form on this page is not lost.
  const link = within(unknown).getByRole("link", { name: "Tasks" });
  expect(link.getAttribute("href")).toBe("/");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(screen.queryByTestId("post-failure")).toBeNull();
  expect(screen.queryByTestId("post-sent")).toBeNull();
  expect(router.push).not.toHaveBeenCalled();
  expect(off(postButton())).toBe(true);
  expect(said()).toContain("Wallet closed");

  // A press on the locked Post does nothing: no request, no batch.
  const before = api.requests.length;
  await user.click(postButton());
  await settle();
  expect(api.requests).toHaveLength(before);
  expect(wallet.sent).toEqual([]);
  expect(screen.getByTestId("post-unknown")).toBeDefined();

  // The person has looked and unlocks Post. The lock comes off, the balances are read again, and
  // the focus is where the person reads on.
  await user.click(screen.getByRole("button", { name: "Unlock Post" }));
  expect(screen.queryByTestId("post-unknown")).toBeNull();
  expect(screen.queryByRole("button", { name: "Unlock Post" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Post it" }));
  await user.click(await postReady());
  await waitFor(() => expect(router.push).toHaveBeenCalledWith("/tasks/1"), LONG);
  expect(chain.tasks.size).toBe(1);
  expect(wallet.sent).toHaveLength(1);
});

test("a_result_the_wallet_cannot_be_read_for_locks_post_and_a_second_press_does_nothing", async () => {
  const { user, wallet, api, chain } = setup({ vault: TUSDC(2) });
  const send = wallet.signAndSendTransactions.bind(wallet);
  wallet.signAndSendTransactions = async (params) => {
    // The batch runs on the chain, and what comes back is not an outcome the page can read.
    await send(params);
    return "not an outcome" as never;
  };
  render(<PostWizard judgeAccount={JUDGE} />);
  await toReview(user);

  await user.click(await postReady());

  // The task is on the chain and the page cannot say so: it is told to look, and not to post again.
  const sent = await screen.findByTestId("post-sent");
  expect(sent.textContent).toContain("look for it on the Tasks page");
  expect(screen.queryByTestId("post-failure")).toBeNull();
  expect(router.push).not.toHaveBeenCalled();
  expect(off(postButton())).toBe(true);
  expect(chain.tasks.size).toBe(1);

  // A second press does nothing. Without the lock it would read the emptied vault, deposit the whole
  // reward again and post the same task a second time.
  const before = { requests: api.requests.length, batches: wallet.sent.length };
  await user.click(postButton());
  await settle();
  expect(api.requests).toHaveLength(before.requests);
  expect(wallet.sent).toHaveLength(before.batches);
  expect(chain.tasks.size).toBe(1);
});

test("a_short_storage_balance_is_topped_up_in_the_same_batch_and_the_review_says_so", async () => {
  const { user, chain, wallet } = setup({ vault: TUSDC(2) });
  const byte = 10n ** 19n;
  // 1,000 bytes are free where a post needs 1,600. The vault holds some of the token, so its slot
  // is there already and the deposit adds none.
  chain.storage.set(ALICE, { total: (173n + 1_000n) * byte, usedBytes: 173n });
  render(<PostWizard judgeAccount={JUDGE} />);
  await toReview(user);

  // The 600 bytes that are missing are 0.006 NEAR, said before the wallet is asked for it.
  await waitFor(
    () => expect(testId("review-storage")).toBe("Adds 0.006 NEAR from your wallet first."),
    LONG,
  );
  await user.click(await postReady());
  await waitFor(() => expect(router.push).toHaveBeenCalledWith("/tasks/1"), LONG);

  // One batch of three transactions: the storage to Tender, the deposit to the token, the post.
  expect(wallet.sent).toHaveLength(1);
  expect(wallet.sent[0]?.transactions.map(({ receiverId }) => receiverId)).toEqual([
    CONTRACT,
    TOKEN,
    CONTRACT,
  ]);
  expect(chain.calls.map(({ receiverId, methodName }) => `${receiverId} ${methodName}`)).toEqual([
    `${CONTRACT} storage_deposit`,
    `${TOKEN} ft_transfer_call`,
    `${CONTRACT} post_task`,
  ]);
  expect(chain.calls[0]?.deposit).toBe(600n * byte);
  expect(chain.tasks.get(1n)).toMatchObject({ poster: ALICE, reward: TUSDC(5) });
});

test("a_storage_balance_that_pays_for_the_post_shows_no_storage_row_and_adds_none", async () => {
  const { user, chain, wallet } = setup({ vault: TUSDC(5) });
  render(<PostWizard judgeAccount={JUDGE} />);
  await toReview(user);

  await waitFor(() => expect(testId("review-funding")).toContain("enough already"), LONG);
  expect(screen.queryByTestId("review-storage")).toBeNull();
  await user.click(await postReady());
  await waitFor(() => expect(router.push).toHaveBeenCalled(), LONG);

  expect(chain.calls.map(({ methodName }) => methodName)).toEqual(["post_task"]);
  expect(wallet.sent[0]?.transactions).toHaveLength(1);
});

test("a_deposit_tender_could_not_take_is_worded_as_that_and_the_next_press_tops_storage_up", async () => {
  const { user, chain, wallet } = setup({ vault: 0n });
  const byte = 10n ** 19n;
  const used = 173n;
  // No slot for the token yet, and storage for exactly a post and a slot: nothing to top up.
  chain.vault.get(ALICE)?.delete(TOKEN);
  chain.storage.set(ALICE, { total: (used + 1_800n) * byte, usedBytes: used });
  const send = wallet.signAndSendTransactions.bind(wallet);
  let spoiled = false;
  wallet.signAndSendTransactions = async (params) => {
    if (!spoiled) {
      spoiled = true;
      // Something else used the storage since the page looked, so the slot cannot be paid for: the
      // contract hands the deposit back, and its transaction still ends well.
      chain.storage.set(ALICE, { total: (used + 1_800n) * byte, usedBytes: used + 1_700n });
    }
    return send(params);
  };
  render(<PostWizard judgeAccount={JUDGE} />);
  await toReview(user);
  await postReady();
  expect(screen.queryByTestId("review-storage")).toBeNull();

  await user.click(postButton());

  // The post failed for the vault. The words say what the vault holds and where the deposit went,
  // and not that the funds are in the vault.
  const failure = await screen.findByTestId("post-failure");
  expect(failure.textContent).toBe(
    "The reward wasn't in your vault. Your vault holds 0.00 tUSDC now, and a deposit Tender couldn't take went back to your wallet. Press Post to try again.",
  );
  expect(chain.view(TOKEN, "ft_balance_of", { account_id: ALICE })).toBe(String(TUSDC(20)));
  expect(chain.tasks.size).toBe(0);
  expect(off(postButton())).toBe(false);

  // The next press reads the storage again, adds the 1,700 bytes that are missing, and posts.
  await user.click(postButton());
  await waitFor(() => expect(router.push).toHaveBeenCalledWith("/tasks/1"), LONG);
  expect(wallet.sent).toHaveLength(2);
  expect(wallet.sent[0]?.transactions.map(({ receiverId }) => receiverId)).toEqual([
    TOKEN,
    CONTRACT,
  ]);
  expect(wallet.sent[1]?.transactions.map(({ receiverId }) => receiverId)).toEqual([
    CONTRACT,
    TOKEN,
    CONTRACT,
  ]);
  expect(chain.calls.find(({ methodName }) => methodName === "storage_deposit")?.deposit).toBe(
    1_700n * byte,
  );
  expect(chain.view(TOKEN, "ft_balance_of", { account_id: ALICE })).toBe(String(TUSDC(15)));
});

test("the_funding_row_says_nothing_is_read_when_the_balances_cannot_be", async () => {
  const { user } = setup({ vaultReadFails: true });
  render(<PostWizard judgeAccount={JUDGE} />);
  await toReview(user);

  // The read failed: the row has nothing to show, and does not say it is still reading.
  await screen.findByTestId("error-state");
  expect(testId("review-funding")).toBe("—");
  expect(off(postButton())).toBe(true);
});

test("an_upload_that_fails_sends_nothing_to_the_wallet", async () => {
  const { user, wallet, api } = setup({ vault: TUSDC(5), uploadsFail: true });
  render(<PostWizard judgeAccount={JUDGE} />);
  await toReview(user);

  await user.click(await postReady());

  const failure = await screen.findByTestId("post-failure");
  expect(failure.textContent).toBe(
    "The Tender API had a problem (status 500). Try again in a moment. Nothing was sent to your wallet.",
  );
  expect(wallet.sent).toEqual([]);
  expect(api.heldouts).toEqual([]);
  expect(router.push).not.toHaveBeenCalled();
  // And it can be tried again.
  expect(off(postButton())).toBe(false);
});

test("a_token_the_api_turns_away_is_signed_in_for_again_and_never_cleared_by_the_page", async () => {
  const { user, wallet, api } = setup({ vault: TUSDC(5), turnFirstTokenAway: true });
  render(<PostWizard judgeAccount={JUDGE} />);
  await toReview(user);

  await user.click(await postReady());
  await waitFor(() => expect(router.push).toHaveBeenCalledWith("/tasks/1"), LONG);

  expect(api.challenges).toBe(2);
  expect(wallet.signRequests).toHaveLength(2);
  expect(api.tokens).toHaveLength(2);
  // Everything that was stored came with the second token, which is the one that is held now.
  expect([...api.blobs, ...api.heldouts].every(({ token }) => token === api.tokens[1])).toBe(true);
  expect(heldToken()?.token).toBe(api.tokens[1]);
});

test("a_send_that_reports_no_new_task_does_not_redirect_and_cannot_be_pressed_again", async () => {
  const { user, wallet } = setup({ vault: TUSDC(5) });
  const send = wallet.signAndSendTransactions.bind(wallet);
  wallet.signAndSendTransactions = async (params) => {
    const outcomes = (await send(params)) as Outcome[];
    return outcomes.map((outcome) => ({
      ...outcome,
      receipts_outcome: outcome.receipts_outcome.map((receipt) => ({
        ...receipt,
        outcome: { ...receipt.outcome, logs: [] },
      })),
    }));
  };
  render(<PostWizard judgeAccount={JUDGE} />);
  await toReview(user);

  await user.click(await postReady());

  const sent = await screen.findByTestId("post-sent");
  expect(sent.textContent).toContain("It may well be posted");
  expect(within(sent).getByRole("link", { name: "Tasks" }).getAttribute("href")).toBe("/");
  expect(router.push).not.toHaveBeenCalled();
  expect(off(postButton())).toBe(true);
});

// ---- The steps ----------------------------------------------------------------------------------

test("pressing_next_on_a_step_with_problems_shows_every_one_and_goes_to_the_first", async () => {
  const { user } = setup();
  render(<PostWizard judgeAccount={JUDGE} />);
  await stepHeading("Brief");

  // A new form is not full of complaints.
  expect(screen.queryByTestId("error-title")).toBeNull();
  expect(off(screen.getByRole("button", { name: "Next: Checks" }))).toBe(true);

  await press(user, "Next: Checks");

  expect(testId("error-title")).toBe("Give the task a title.");
  expect(testId("error-instructions")).toBe("Tell agents what to do.");
  expect(document.activeElement).toBe(screen.getByLabelText("Title"));
  expect(screen.queryByRole("heading", { level: 2, name: "Checks" })).toBeNull();

  fill("Title", "A title");
  expect(screen.queryByTestId("error-title")).toBeNull();
  await press(user, "Next: Checks");
  expect(document.activeElement).toBe(screen.getByLabelText("Instructions"));

  fill("Instructions", "Do the thing.");
  expect(off(screen.getByRole("button", { name: "Next: Checks" }))).toBe(false);
  await press(user, "Next: Checks");
  await stepHeading("Checks");
  // The heading of a step takes the focus, so that a reader begins at the top of it.
  expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Checks" }));
});

test("the_stepper_goes_back_to_steps_that_are_done_and_not_forward", async () => {
  const { user } = setup();
  render(<PostWizard judgeAccount={JUDGE} />);
  const steps = within(screen.getByRole("navigation", { name: "Steps" }));

  expect(steps.queryAllByRole("button")).toEqual([]);
  expect(steps.getByText("1 Brief").getAttribute("aria-current")).toBe("step");

  await toReward(user);

  expect(steps.getAllByRole("button").map((button) => button.textContent)).toEqual([
    "1 Brief",
    "2 Checks",
  ]);
  expect(steps.getByText("3 Reward").getAttribute("aria-current")).toBe("step");
  expect(steps.queryByRole("button", { name: "4 Review" })).toBeNull();

  await user.click(steps.getByRole("button", { name: "2 Checks" }));
  await stepHeading("Checks");
  // What was typed is where it was left.
  expect((screen.getByLabelText("Held-out: should match") as HTMLTextAreaElement).value).toBe(
    `${SECRET}.near\ncarol.near`,
  );
});

test("picking_a_kind_changes_the_answer_format_it_needs_and_the_one_line_says_what_it_is", async () => {
  const { user } = setup();
  render(<PostWizard judgeAccount={JUDGE} />);
  await toChecks(user);

  expect(testId("answer-format")).toBe("Answers: plain text (set on Brief).");
  await user.click(screen.getByRole("radio", { name: /JSON shape/ }));
  expect(testId("answer-format")).toBe("Answers: JSON (set on Brief).");
  await user.click(screen.getByRole("radio", { name: /Regex cases/ }));
  expect(testId("answer-format")).toBe("Answers: a regex, as JSON (set on Brief).");
  await user.click(screen.getByRole("radio", { name: /Exact answer/ }));
  expect(testId("answer-format")).toBe("Answers: plain text (set on Brief).");
  expect(screen.queryByTestId("format-note")).toBeNull();

  // The Brief step shows the format the checks asked for.
  await user.click(screen.getByRole("radio", { name: /JSON shape/ }));
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect((screen.getByLabelText("Answer format") as HTMLSelectElement).value).toBe("json");
});

test("the_format_line_is_not_left_stale_when_the_format_is_changed_on_the_brief_step", async () => {
  const { user } = setup();
  render(<PostWizard judgeAccount={JUDGE} />);
  await toChecks(user);
  await user.click(screen.getByRole("radio", { name: /JSON shape/ }));
  expect(testId("answer-format")).toBe("Answers: JSON (set on Brief).");

  // Back to the Brief step, plain text chosen there, and on to the Checks step again.
  await user.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.change(screen.getByLabelText("Answer format"), { target: { value: "text" } });
  await press(user, "Next: Checks");
  await stepHeading("Checks");

  // The line says what the format is now, beside the problem it makes, and not what it was.
  expect(testId("answer-format")).toBe("Answers: plain text (set on Brief).");
  expect(testId("error-kind")).toBe(
    'JSON shape needs the answer format "JSON". Change it on the Brief step.',
  );
});

test("a_format_that_does_not_suit_the_kind_is_a_problem_on_the_checks_step", async () => {
  const { user } = setup();
  render(<PostWizard judgeAccount={JUDGE} />);
  await toChecks(user);
  await fillRegexChecks(user);
  await user.click(screen.getByRole("button", { name: "Back" }));

  // Changed on the Brief step, behind the checks' back.
  fireEvent.change(screen.getByLabelText("Answer format"), { target: { value: "text" } });
  await press(user, "Next: Checks");
  await stepHeading("Checks");

  expect(testId("error-kind")).toBe(
    'Regex cases needs the answer format "A regex, as JSON". Change it on the Brief step.',
  );
  expect(off(screen.getByRole("button", { name: "Next: Reward" }))).toBe(true);
});

// ---- The split ----------------------------------------------------------------------------------

test.each([
  {
    name: "exact",
    kind: /Exact answer/,
    seen: ["Ignore spaces at the start and end", "Ignore upper and lower case"],
    kept: ["Accepted answers"],
  },
  {
    name: "json_schema",
    kind: /JSON shape/,
    seen: ["JSON schema"],
    kept: ["Path", "Must equal (JSON)"],
  },
  {
    name: "regex_cases",
    kind: /Regex cases/,
    seen: ["Should match", "Should not match"],
    kept: ["Held-out: should match", "Held-out: should not match"],
  },
])(
  "the_checks_step_splits_what_agents_see_from_what_the_judge_keeps_for_$name",
  async ({ kind, seen, kept }) => {
    const { user } = setup();
    render(<PostWizard judgeAccount={JUDGE} />);
    await toChecks(user);

    await user.click(screen.getByRole("radio", { name: kind }));

    const left = screen.getByTestId("split-public");
    const right = screen.getByTestId("split-heldout");
    expect(within(left).getByRole("heading", { name: "What agents see" })).toBeDefined();
    expect(
      within(right).getByRole("heading", { name: "What the Judge keeps until payout" }),
    ).toBeDefined();
    for (const label of seen) {
      expect(within(left).getByLabelText(label), label).toBeDefined();
      expect(within(right).queryByLabelText(label), label).toBeNull();
    }
    for (const label of kept) {
      expect(within(right).getByLabelText(label), label).toBeDefined();
      expect(within(left).queryByLabelText(label), label).toBeNull();
    }
  },
);

test.each([
  { agentIs: "team", offered: true },
  { agentIs: "not-team", offered: false },
  { agentIs: "unknown", offered: false },
  { agentIs: "broken", offered: false },
] as const)(
  "the_rubric_is_offered_on_the_page_for_a_$agentIs_account_$offered",
  async ({ agentIs, offered }) => {
    const { user, api } = setup({ agentIs });
    render(<PostWizard judgeAccount={JUDGE} />);
    await toChecks(user);
    await waitFor(
      () => expect(api.requests.map(({ path }) => path)).toContain(`/v1/agents/${ALICE}`),
      LONG,
    );
    await settle();

    expect(screen.queryByRole("radio", { name: /^Rubric/ }) !== null).toBe(offered);
    // The three kinds the Judge scores today are there either way.
    for (const kind of [/Exact answer/, /JSON shape/, /Regex cases/]) {
      expect(screen.getByRole("radio", { name: kind })).toBeDefined();
    }
  },
);

test("a_team_account_that_writes_a_rubric_is_told_how_the_judge_scores_it", async () => {
  const { user, api } = setup({ agentIs: "team", vault: TUSDC(5) });
  render(<PostWizard judgeAccount={JUDGE} />);
  await toChecks(user);

  await user.click(await screen.findByRole("radio", { name: /^Rubric/ }));
  const left = screen.getByTestId("split-public");
  fill("What to look for", "Says what changed");
  expect(within(left).getByLabelText("Weight, 1 to 10")).toBeDefined();
  expect(within(screen.getByTestId("split-heldout")).getByText("Nothing.")).toBeDefined();
  await press(user, "Next: Reward");
  await screen.findByLabelText("Amount (tUSDC)");

  // With the Judge as verifier, the note says how the Judge scores a rubric; with anyone else, not.
  expect(testId("rubric-judge-note")).toBe(RUBRIC_JUDGE_NOTE);
  expect(RUBRIC_JUDGE_NOTE).toBe(
    "The Tender Judge scores rubric tasks with an AI model. Scores are subjective.",
  );
  // And that it scores the first entries only, since the wizard posts no entry limit of its own.
  expect(testId("rubric-judge-limit")).toBe("The Judge scores the first 50 entries.");
  await user.click(screen.getByRole("radio", { name: /^Me/ }));
  expect(screen.queryByTestId("rubric-judge-note")).toBeNull();
  expect(screen.queryByTestId("rubric-judge-limit")).toBeNull();

  // And the held-out part is not sent: there is none.
  fill("Amount (tUSDC)", "5");
  await press(user, "Review");
  await stepHeading("Review");
  await user.click(await postReady());
  await waitFor(() => expect(router.push).toHaveBeenCalled(), LONG);
  expect(api.heldouts).toEqual([]);
  expect(JSON.parse(api.blobs[1]?.text ?? "{}")).toMatchObject({
    kind: "rubric",
    has_heldout: false,
    rubric: [{ criterion: "Says what changed", weight: 5 }],
  });
});

/** The inputs for what each point of the rubric looks for, in the order of the points. */
const pointInputs = () => screen.getAllByLabelText("What to look for");
const fillPoint = (i: number, value: string) =>
  fireEvent.change(pointInputs()[i] as HTMLElement, { target: { value } });

async function toRubric(user: User): Promise<void> {
  await toChecks(user);
  await user.click(await screen.findByRole("radio", { name: /^Rubric/ }));
}

test("a_point_the_judge_would_refuse_is_said_where_it_is_written_and_stops_next", async () => {
  const { user } = setup({ agentIs: "team" });
  render(<PostWizard judgeAccount={JUDGE} />);
  await toRubric(user);
  fillPoint(0, "Says what changed");
  await press(user, "Add a point");
  await press(user, "Add a point");
  const next = () => screen.getByRole("button", { name: "Next: Reward" });

  // An angle bracket.
  fillPoint(1, "Names the <file> that changed");
  expect(testId("error-rubric-1-criterion")).toBe("Leave out angle brackets, like < and >.");
  expect(pointInputs()[1]?.getAttribute("aria-invalid")).toBe("true");
  // Too long, to the character: 200 is allowed and 201 is not.
  fillPoint(1, "x".repeat(201));
  expect(testId("error-rubric-1-criterion")).toBe("Use 200 characters or fewer. This has 201.");
  fillPoint(1, "x".repeat(200));
  expect(screen.queryByTestId("error-rubric-1-criterion")).toBeNull();
  // The same as another point, as the Judge reads it: case, width and spaces do not tell them apart.
  fillPoint(1, "Names the file");
  fillPoint(2, "  \uFF33\uFF21\uFF39\uFF33 what\u3000changed ");
  expect(testId("error-rubric-2-criterion")).toBe("This says the same as point 1.");
  expect(screen.queryByTestId("error-rubric-0-criterion")).toBeNull();
  expect(screen.queryByTestId("error-rubric-1-criterion")).toBeNull();

  // The step does not go on, and Next takes the person to the point to put right.
  expect(off(next())).toBe(true);
  await user.click(next());
  expect(document.activeElement).toBe(pointInputs()[2]);
  expect(screen.queryByRole("heading", { level: 2, name: "Reward" })).toBeNull();

  fillPoint(2, "Gives a reason");
  expect(screen.queryByTestId("error-rubric-2-criterion")).toBeNull();
  expect(off(next())).toBe(false);
  await user.click(next());
  await screen.findByLabelText("Amount (tUSDC)");
});

test("a_point_the_judge_would_refuse_that_is_not_the_last_one_is_found_by_its_place", async () => {
  const { user } = setup({ agentIs: "team" });
  render(<PostWizard judgeAccount={JUDGE} />);
  await toRubric(user);
  fillPoint(0, "Says what changed");
  await press(user, "Add a point");
  await press(user, "Add a point");
  fillPoint(1, "Names the file");
  fillPoint(2, "Gives a reason");

  // A point in the middle that is the same as the first is the one that is marked, and its number
  // is the number on the page.
  fillPoint(1, "says what CHANGED");
  expect(testId("error-rubric-1-criterion")).toBe("This says the same as point 1.");
  // Taking the first away leaves nothing for it to be the same as.
  await press(user, "Remove point 1");
  expect(screen.queryByTestId("error-rubric-0-criterion")).toBeNull();
  expect(screen.queryByTestId("error-rubric-1-criterion")).toBeNull();
  expect(off(screen.getByRole("button", { name: "Next: Reward" }))).toBe(false);
});

test("twenty_one_points_is_one_too_many_and_is_said_when_the_twenty_first_is_added", async () => {
  const { user } = setup({ agentIs: "team" });
  render(<PostWizard judgeAccount={JUDGE} />);
  await toRubric(user);
  for (let i = 1; i < 20; i++) {
    fireEvent.click(screen.getByRole("button", { name: "Add a point" }));
  }
  expect(pointInputs()).toHaveLength(20);
  for (let i = 0; i < 20; i++) fillPoint(i, `Point number ${i + 1}`);
  // Twenty is allowed.
  expect(screen.queryByTestId("error-rubric")).toBeNull();
  expect(off(screen.getByRole("button", { name: "Next: Reward" }))).toBe(false);

  await press(user, "Add a point");
  expect(pointInputs()).toHaveLength(21);
  expect(testId("error-rubric")).toBe("Use at most 20 points.");
  fillPoint(20, "Point number 21");
  expect(off(screen.getByRole("button", { name: "Next: Reward" }))).toBe(true);

  // Next goes to the list as a whole, since no one point is the wrong one.
  await press(user, "Next: Reward");
  expect(testId("error-rubric")).toBe("Use at most 20 points.");
  expect(document.activeElement).toBe(document.getElementById("post-rubric"));
  expect(screen.queryByRole("heading", { level: 2, name: "Reward" })).toBeNull();

  await press(user, "Remove point 21");
  expect(screen.queryByTestId("error-rubric")).toBeNull();
  await press(user, "Next: Reward");
  await screen.findByLabelText("Amount (tUSDC)");
});

test("a_rubric_is_dropped_when_the_account_stops_being_the_teams", async () => {
  const { user } = setup({ agentIs: "team" });
  render(<PostWizard judgeAccount={JUDGE} />);
  await toChecks(user);
  await user.click(await screen.findByRole("radio", { name: /^Rubric/ }));
  expect((screen.getByRole("radio", { name: /^Rubric/ }) as HTMLInputElement).checked).toBe(true);

  await act(async () => {
    await holder.store.disconnect();
  });

  await waitFor(() => expect(screen.queryByRole("radio", { name: /^Rubric/ })).toBeNull(), LONG);
  expect((screen.getByRole("radio", { name: /Exact answer/ }) as HTMLInputElement).checked).toBe(
    true,
  );
});

// ---- The Judge ----------------------------------------------------------------------------------

test("the_judge_is_the_default_verifier_when_the_build_knows_its_account", async () => {
  const { user } = setup();
  render(<PostWizard judgeAccount={JUDGE} />);
  await toReward(user);

  const judge = screen.getByRole("radio", { name: /^Tender Judge \(run by the Tender team\)/ });
  expect((judge as HTMLInputElement).checked).toBe(true);
});

test("without_a_judge_account_the_judge_is_not_offered_and_the_poster_verifies", async () => {
  const { user } = setup();
  render(<PostWizard judgeAccount={null} />);
  await toReward(user);

  expect(screen.queryByRole("radio", { name: /Tender Judge/ })).toBeNull();
  expect((screen.getByRole("radio", { name: /^Me/ }) as HTMLInputElement).checked).toBe(true);
  fill("Amount (tUSDC)", "5");
  await press(user, "Review");
  await stepHeading("Review");
  expect(testId("review-verifier")).toBe("You");
});

test("another_account_as_the_verifier_has_to_be_an_account", async () => {
  const { user } = setup();
  render(<PostWizard judgeAccount={JUDGE} />);
  await toReward(user);
  fill("Amount (tUSDC)", "5");
  await user.click(screen.getByRole("radio", { name: /^Another account/ }));

  fill("Their NEAR account", "Not An Account");
  expect(testId("error-otherVerifier")).toBe("Enter a NEAR account, like name.near.");
  expect(off(screen.getByRole("button", { name: "Review" }))).toBe(true);

  fill("Their NEAR account", BOB);
  expect(screen.queryByTestId("error-otherVerifier")).toBeNull();
  expect(off(screen.getByRole("button", { name: "Review" }))).toBe(false);
});

test("a_public_document_over_what_the_api_keeps_is_said_on_the_checks_step_and_nothing_is_sent", async () => {
  const { user, api, wallet } = setup();
  render(<PostWizard judgeAccount={JUDGE} />);
  await toChecks(user);
  await user.click(screen.getByRole("radio", { name: /JSON shape/ }));
  fill("Path", "$.total");
  fill("Must equal (JSON)", "1");

  // A pasted schema of 300 KB: more than the 256 KiB the API keeps.
  fill("JSON schema", JSON.stringify({ type: "object", description: "x".repeat(300_000) }));

  const alert = screen.getByRole("alert");
  expect(alert.textContent).toBe("The public checks are too long. The limit is 256 KiB.");
  const forward = screen.getByRole("button", { name: "Next: Reward" });
  expect(off(forward)).toBe(true);
  await user.click(forward);
  expect(screen.queryByLabelText("Amount (tUSDC)")).toBeNull();
  expect(document.activeElement).toBe(alert);

  fill("JSON schema", '{"type":"object"}');
  expect(screen.queryByRole("alert")).toBeNull();
  expect(off(screen.getByRole("button", { name: "Next: Reward" }))).toBe(false);

  // Nothing was signed in for, uploaded or sent.
  expect(writes(api)).toEqual([]);
  expect(wallet.signRequests).toEqual([]);
});

test("the_reward_step_names_each_group_once_and_puts_the_token_in_the_amounts_help", async () => {
  const { user } = setup();
  render(<PostWizard judgeAccount={JUDGE} />);
  await toReward(user);

  expect(screen.getByRole("group", { name: "Time" })).toBeDefined();
  expect(screen.getByRole("group", { name: "Who picks the winner" })).toBeDefined();
  for (const said of ["How long does each stage last?", "Verifier", "What it pays"]) {
    expect(screen.queryByText(said), said).toBeNull();
  }
  // One place says which token it is, and it is the amount's help.
  expect(screen.getByLabelText("Amount (tUSDC)").getAttribute("aria-describedby")).toBe(
    "post-amount-help",
  );
  expect(document.getElementById("post-amount-help")?.textContent).toContain(
    "Paid in tusdc.testnet. At least 1.00 tUSDC",
  );
  expect(screen.getAllByText(/Paid in/)).toHaveLength(1);
});

// ---- Source rules -------------------------------------------------------------------------------

test("the_post_files_keep_no_drafts_never_clear_the_token_and_log_only_errors", () => {
  const web = join(import.meta.dirname, "..");
  const files = [
    ...readdirSync(join(web, "components/post")).map((name) => `components/post/${name}`),
    "app/(app)/post/page.tsx",
    "lib/post.ts",
    "lib/postSubmit.ts",
  ];
  expect(files.length).toBeGreaterThanOrEqual(9);

  for (const file of files) {
    const source = readFileSync(join(web, file), "utf8");
    // The token is dropped where the wallet session ends. A page that clears it for a 401 would
    // sign the person out of every other page that holds it.
    expect(source, file).not.toMatch(/\bclearApiToken\b/);
    // A draft would keep the held-out checks in the browser after the page is closed.
    expect(source, file).not.toMatch(/\b(?:local|session)Storage\b/);
    expect(source, file).not.toMatch(/\bconsole\.(?:log|info|debug|warn|trace|dir)\b/);
  }
});
