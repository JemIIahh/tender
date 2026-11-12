import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SIGN_IN_MESSAGE } from "@tender/shared";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TelegramView } from "../components/TelegramView";
import { clearApiToken } from "../lib/auth";
import { createWalletStore, type Session, type WalletStore } from "../lib/wallet";
import { WALLET_CANNOT_SIGN_MESSAGE, WalletError } from "../lib/walletErrors";
import { FakeChain } from "./fakeChain";
import { type ChainWallet, chainWallet, fakeProvider } from "./walletDoubles";

// The Telegram page, as a person uses it: the real hook and store over a wallet double and a fake
// API. The link the API makes holds a code that is a secret until it is spent, so the tests look
// for it in everything the page writes to the console. vitest.config.ts gives the config the API
// address http://api.test.

const ALICE = "alice.testnet";
const BOB = "bob.testnet";
const CODE = "q3Zk_8-nP0aXw2YtLmB5Rg";
const LINK = `https://t.me/tender_bot?start=${CODE}`;
// A link is made for now: the page says it has expired once the clock is past this, so a fixed date
// would be a link that has run out by the time a test reads it.
const EXPIRES = new Date(Date.now() + 60 * 60_000).toISOString();
const NONCE = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)));
const CHALLENGE = {
  nonce: NONCE,
  message: SIGN_IN_MESSAGE,
  recipient: "http://api.test",
  expires_at: "2026-10-30T12:00:00.000Z",
};

// The page reads the wallet from `lib/wallet`; the tests hand it a store of their own.
const holder = vi.hoisted(() => ({ store: undefined as unknown as WalletStore }));
vi.mock("../lib/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wallet")>();
  return { ...actual, useWallet: () => actual.useWalletStore(holder.store) };
});

// A minute is too long to wait in a test: the page waits 150 ms before it offers to stop waiting.
// The minute itself is the default of `useWaitedLong`, and has a test of its own (waiting.test.tsx).
vi.mock("../lib/waiting", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/waiting")>();
  return { ...actual, useWaitedLong: (what: string | null) => actual.useWaitedLong(what, 150) };
});

const CONSOLE = ["error", "warn", "log", "info", "debug"] as const;

beforeEach(() => {
  for (const method of CONSOLE) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearApiToken();
  sessionStorage.clear();
});

/** Everything the page wrote to the console, as text: what a developer would read there. */
function consoleText(): string {
  return CONSOLE.flatMap((method) => vi.mocked(console[method]).mock.calls)
    .flat()
    .map((arg) =>
      arg instanceof Error
        ? `${arg.name}: ${arg.message}\n${arg.stack ?? ""}\n${JSON.stringify(arg)}`
        : typeof arg === "string"
          ? arg
          : JSON.stringify(arg),
    )
    .join("\n");
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const made = () => json({ url: LINK, expires_at: EXPIRES });

type LinkAnswer = (call: number) => Response | Promise<Response>;

interface FakeApi {
  /** `METHOD /path` of each request, in order. */
  requests: string[];
  /** The tokens the API gave, in order: `tok-1`, `tok-2`... */
  tokens: string[];
  /** The `Authorization` header of each request for a link, in order. */
  authorizations: (string | null)[];
  /** How many links were asked for. */
  links(): number;
}

/**
 * An API that issues the sign-in challenge, trades any signature for a token and answers each
 * request for a link with `link`, which is told how many there have been (from 1).
 */
function fakeApi(link: LinkAnswer = made): FakeApi {
  const api: FakeApi = {
    requests: [],
    tokens: [],
    authorizations: [],
    links: () => api.authorizations.length,
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname;
    api.requests.push(`${init.method ?? "GET"} ${path}`);
    if (path === "/v1/auth/challenge") return json(CHALLENGE);
    if (path === "/v1/auth/verify") {
      const token = `tok-${api.tokens.length + 1}`;
      api.tokens.push(token);
      return json({ token, expires_at: "2099-01-01T00:00:00.000Z", key_kind: "full_access" });
    }
    if (path === "/v1/telegram/link") {
      api.authorizations.push(new Headers(init.headers).get("Authorization"));
      return link(api.authorizations.length);
    }
    return json({ error: "not_found", message: "no such route" }, 404);
  });
  return api;
}

/** A gate: what waits on `opens` goes on when `open` is called. */
function gate() {
  let open: () => void = () => {};
  const opens = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opens, open: () => open() };
}

/** A wallet for `accountId` on a chain of its own, and the session it makes. */
function sessionFor(accountId: string, options: { signMessage?: boolean } = {}) {
  const wallet = chainWallet(new FakeChain("tender.testnet", []), accountId, options);
  return { wallet, accountId } satisfies Session & { wallet: ChainWallet };
}

/**
 * The page's store over a wallet for Alice. `connected`: her wallet is back from an earlier visit,
 * and otherwise the person has to connect. `window.open` is a spy.
 */
function setup(options: { connected?: boolean; signMessage?: boolean } = {}) {
  const alice = sessionFor(ALICE, { signMessage: options.signMessage });
  const provider = fakeProvider(alice, { restored: options.connected });
  holder.store = createWalletStore(async () => provider);
  return {
    wallet: alice.wallet,
    provider,
    user: userEvent.setup(),
    open: vi.spyOn(window, "open").mockImplementation(() => null),
  };
}

const button = (name: string | RegExp) => screen.findByRole("button", { name });

/** The page, with Alice's wallet connected and the link button there. */
async function openConnected(options: { signMessage?: boolean } = {}) {
  const page = setup({ connected: true, ...options });
  render(<TelegramView />);
  await button("Link Telegram");
  return page;
}

// ---- The page before anything is pressed --------------------------------------------------------

test("telegram_page_explains_the_alerts_in_three_lines_and_asks_nothing_when_signed_out", async () => {
  setup();
  const api = fakeApi();

  render(<TelegramView />);

  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Telegram alerts");
  // Until the wallet from an earlier visit is looked for, nothing is claimed either way.
  expect(screen.getByRole("status").textContent).toBe("Checking if you're signed in…");
  await button("Sign in");
  expect(screen.queryByRole("button", { name: "Link Telegram" })).toBeNull();
  const lines = within(screen.getByTestId("alert-lines")).getAllByRole("listitem");
  expect(lines).toHaveLength(3);
  expect(lines[0]?.textContent).toMatch(/Messages about tasks you posted or your agents entered/);
  expect(lines[1]?.textContent).toMatch(/\/watch research/);
  expect(lines[2]?.textContent).toMatch(/signs a message: no transaction, no fee/);
  // Nothing is signed or asked of the API, and no state of a link is claimed, until it is pressed.
  expect(api.requests).toEqual([]);
  expect(screen.queryByTestId("link-state")).toBeNull();
  expect(screen.queryByTestId("link-error")).toBeNull();
});

test("telegram_page_says_the_bot_has_not_run_on_telegram_and_promises_no_alert", async () => {
  setup();
  fakeApi();

  render(<TelegramView />);

  // The bot is built and tested against a fake Telegram server and has not run against Telegram
  // (docs/LIMITS.md, "Telegram"), so the page says that first and promises no message.
  expect(screen.getByTestId("telegram-status").textContent).toBe(
    "Tender's bot, in a Telegram chat of your own. It is built and tested, and has not run on Telegram yet, so linking and alerts may not work.",
  );
  expect(screen.getByTestId("alert-lines").textContent).not.toMatch(/\bGet messages\b/);
  await button("Sign in");
});

// ---- The link ---------------------------------------------------------------------------------

test("the_button_connects_signs_in_asks_for_the_link_and_opens_it", async () => {
  const { wallet, user, open } = setup();
  const api = fakeApi();
  render(<TelegramView />);

  await user.click(await button("Sign in"));

  // The same button, now for the next step, and it still has the keyboard focus.
  const link = await button("Link Telegram");
  expect((await screen.findByTestId("account-id")).textContent).toBe(ALICE);
  expect(document.activeElement).toBe(link);
  expect(api.requests).toEqual([]);

  await user.click(link);

  await screen.findByTestId("link-state");
  expect(wallet.signRequests).toHaveLength(1);
  expect(wallet.signRequests[0]).toMatchObject({
    message: SIGN_IN_MESSAGE,
    recipient: "http://api.test",
  });
  expect(api.requests).toEqual([
    "POST /v1/auth/challenge",
    "POST /v1/auth/verify",
    "POST /v1/telegram/link",
  ]);
  expect(api.authorizations).toEqual(["Bearer tok-1"]);
  expect(open).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledWith(LINK, "_blank", "noopener,noreferrer");
  // The link is told as a state: when it stops working, and a way to open it again.
  const state = screen.getByTestId("link-state");
  expect(state.textContent).toMatch(/^Your link is made\. It works once, until .*\d.*\./);
  expect(state.querySelector("time")?.getAttribute("datetime")).toBe(EXPIRES);
  const anchor = within(state).getByRole("link", { name: "Open Telegram" });
  expect(anchor.getAttribute("href")).toBe(LINK);
  expect(anchor.getAttribute("target")).toBe("_blank");
  expect(anchor.getAttribute("rel")).toBe("noopener noreferrer");
  expect(screen.queryByTestId("link-error")).toBeNull();
  // The code is a secret until it is spent: it is not written anywhere a developer reads.
  expect(consoleText()).not.toContain(CODE);
  expect(console.error).not.toHaveBeenCalled();
});

test("a_token_the_page_holds_is_used_without_signing_in_again", async () => {
  const { wallet, user, open } = await openConnected();
  const api = fakeApi();

  await user.click(await button("Link Telegram"));
  await screen.findByTestId("link-state");
  await user.click(await button("Link Telegram"));
  await waitFor(() => expect(open).toHaveBeenCalledTimes(2));

  expect(wallet.signRequests).toHaveLength(1);
  expect(api.requests).toEqual([
    "POST /v1/auth/challenge",
    "POST /v1/auth/verify",
    "POST /v1/telegram/link",
    "POST /v1/telegram/link",
  ]);
  expect(api.authorizations).toEqual(["Bearer tok-1", "Bearer tok-1"]);
});

test("a_second_press_while_the_link_is_being_made_asks_for_nothing_more", async () => {
  const wait = gate();
  const api = fakeApi(async () => {
    await wait.opens;
    return made();
  });
  const { wallet, user, open } = await openConnected();

  await user.click(await button("Link Telegram"));
  const busy = await button("Linking…");
  expect(busy.getAttribute("aria-disabled")).toBe("true");
  await user.click(busy);
  await user.keyboard("{Enter}");
  wait.open();

  await screen.findByTestId("link-state");
  expect(api.links()).toBe(1);
  expect(wallet.signRequests).toHaveLength(1);
  expect(open).toHaveBeenCalledTimes(1);
});

// ---- A wallet that does not answer -------------------------------------------------------------

test("a_link_that_takes_too_long_can_be_given_up_on_and_is_not_opened_when_it_comes", async () => {
  const wait = gate();
  const api = fakeApi(async () => {
    await wait.opens;
    return made();
  });
  const { user, open } = await openConnected();

  await user.click(await button("Link Telegram"));
  await button("Linking…");
  // Not at once: a wallet takes a while.
  expect(screen.queryByRole("button", { name: "Stop waiting" })).toBeNull();
  await user.click(await button("Stop waiting"));

  // The button is open again, and the words say nothing was linked.
  expect((await button("Link Telegram")).getAttribute("aria-disabled")).toBe("false");
  expect(screen.getByTestId("link-error").textContent).toBe(
    "You stopped waiting for your wallet. Nothing was linked. Press the button to try again.",
  );
  expect(screen.queryByRole("button", { name: "Stop waiting" })).toBeNull();

  // The link comes late, to a person who gave up: it is not opened, and not shown.
  wait.open();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  expect(open).not.toHaveBeenCalled();
  expect(screen.queryByTestId("link-state")).toBeNull();
  expect(screen.getByTestId("link-error").textContent).toContain("You stopped waiting");
  expect(api.links()).toBe(1);
});

test("a_wallet_that_never_connects_can_be_given_up_on", async () => {
  const wait = gate();
  const { provider, user } = setup();
  provider.connect = async () => {
    await wait.opens;
    return null;
  };
  fakeApi();
  render(<TelegramView />);

  await user.click(await button("Sign in"));
  await button("Signing in…");
  await user.click(await button("Stop waiting"));

  expect((await button("Sign in")).getAttribute("aria-disabled")).toBe("false");
  expect(screen.getByTestId("link-error").textContent).toContain("You stopped waiting");
  wait.open();
});

// ---- A wallet that can't sign -----------------------------------------------------------------

test("a_wallet_that_cannot_sign_gets_words_and_a_button_that_does_nothing", async () => {
  const api = fakeApi();
  const { wallet, user, open } = await openConnected({ signMessage: false });

  const note = await screen.findByTestId("cannot-sign");
  expect(note.textContent).toBe(WALLET_CANNOT_SIGN_MESSAGE);
  expect(note.getAttribute("role")).toBe("status");
  // The wallet page is where the wallet is disconnected, to connect another.
  expect(
    screen.getByRole("link", { name: "Disconnect it on the Wallet page" }).getAttribute("href"),
  ).toBe("/wallet");
  const link = await button("Link Telegram");
  expect(link.getAttribute("aria-disabled")).toBe("true");
  await user.click(link);
  await user.keyboard("{Enter}");

  expect(wallet.signRequests).toEqual([]);
  expect(api.requests).toEqual([]);
  expect(open).not.toHaveBeenCalled();
  expect(screen.queryByTestId("link-state")).toBeNull();
});

test("a_wallet_that_can_sign_is_not_told_it_cannot", async () => {
  fakeApi();
  await openConnected();

  expect(screen.queryByTestId("cannot-sign")).toBeNull();
  expect(screen.queryByRole("link", { name: /Wallet page/ })).toBeNull();
  expect((await button("Link Telegram")).getAttribute("aria-disabled")).toBe("false");
});

// ---- A link that runs out ---------------------------------------------------------------------

test("a_link_says_it_has_expired_once_its_time_has_passed_and_is_not_offered_any_more", async () => {
  // Only the clock is pinned: the timers the page and the Testing Library wait on stay real.
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-10-30T12:00:00.000Z"));
  // The first link works for ten minutes, as the API's do, and the second one is made later.
  const api = fakeApi((call) =>
    json({
      url: LINK,
      expires_at: call === 1 ? "2026-10-30T12:10:00.000Z" : "2026-10-30T12:20:30.000Z",
    }),
  );
  const { user, open } = await openConnected();

  await user.click(await button("Link Telegram"));
  const state = await screen.findByTestId("link-state");
  expect(state.textContent).toMatch(/^Your link is made\. It works once, until /);
  expect(within(state).getByRole("link", { name: "Open Telegram" })).toBeTruthy();

  // A second before it runs out it still works.
  await act(() => vi.advanceTimersByTimeAsync(9 * 60_000 + 59_000));
  expect(screen.getByTestId("link-state").textContent).toMatch(/It works once/);
  expect(screen.getByRole("link", { name: "Open Telegram" })).toBeTruthy();

  // Past its time the box says so, and there is no link left in it to open.
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  const expired = screen.getByTestId("link-state");
  expect(expired.textContent).toBe("That link has expired. Press Link Telegram for a new one.");
  expect(within(expired).queryByRole("link")).toBeNull();
  expect(expired.querySelector("time")).toBeNull();

  // Pressing the button makes a new link, and that one is offered.
  expect(open).toHaveBeenCalledTimes(1);
  await user.click(await button("Link Telegram"));
  await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  expect(api.links()).toBe(2);
  expect(screen.getByTestId("link-state").textContent).toMatch(/^Your link is made/);
});

// ---- A link that is not a Telegram link -----------------------------------------------------

test("a_link_that_is_not_a_t_me_start_link_is_not_opened", async () => {
  const answers = [
    `https://evil.test/tender_bot?start=${CODE}`,
    `http://t.me/tender_bot?start=${CODE}`,
    `javascript:alert("${CODE}")`,
    `https://t.me/tender_bot?start=${CODE}&next=https://evil.test`,
  ];
  fakeApi((call) => json({ url: answers[call - 1], expires_at: EXPIRES }));
  const { user, open } = await openConnected();

  for (const [index] of answers.entries()) {
    await user.click(await button("Link Telegram"));
    await waitFor(() => expect(console.error).toHaveBeenCalledTimes(index + 1));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Link Telegram" }).getAttribute("aria-disabled"),
      ).toBe("false"),
    );
    expect(screen.getByTestId("link-error").textContent).toBe(
      "Tender sent a link that is not a Telegram link, so it was not opened.",
    );
  }

  // None was opened, none is offered as a link to press, and the address is not written down.
  expect(open).not.toHaveBeenCalled();
  expect(screen.queryByTestId("link-state")).toBeNull();
  expect(document.body.innerHTML).not.toContain("evil.test");
  expect(consoleText()).not.toContain(CODE);
  expect(consoleText()).not.toContain("evil.test");
});

// ---- Failures, in words ---------------------------------------------------------------------

test("a_server_without_a_bot_and_a_rate_limit_are_told_in_words", async () => {
  fakeApi((call) =>
    call === 1
      ? json({ error: "unavailable", message: "Telegram linking is not set up" }, 503)
      : json(
          { error: "rate_limited", message: "Too many links. Try again in a few minutes." },
          429,
        ),
  );
  const { user, open } = await openConnected();

  await user.click(await button("Link Telegram"));
  expect((await screen.findByTestId("link-error")).textContent).toBe(
    "Telegram linking isn't available on this server.",
  );
  await user.click(await button("Link Telegram"));
  await waitFor(() =>
    expect(screen.getByTestId("link-error").textContent).toBe(
      "Too many links. Try again in a few minutes.",
    ),
  );

  expect(open).not.toHaveBeenCalled();
  expect(screen.queryByTestId("link-state")).toBeNull();
  expect(console.error).toHaveBeenCalledTimes(2);
});

test("an_answer_the_page_cannot_read_is_told_in_words_and_its_link_is_not_logged", async () => {
  // A 200 without `expires_at`: the API's answer is not the shape it promises. The answer carries
  // the link, so the error must not.
  fakeApi(() => json({ url: LINK }));
  const { user, open } = await openConnected();

  await user.click(await button("Link Telegram"));

  expect((await screen.findByTestId("link-error")).textContent).toBe(
    "The Tender API sent an answer this page can't read.",
  );
  expect(open).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledTimes(1);
  expect(consoleText()).not.toContain(CODE);
});

test("a_wallet_that_will_not_connect_is_told_in_words", async () => {
  const { provider, user } = setup();
  provider.connect = async () => {
    throw new WalletError("connect", new Error("closed"));
  };
  render(<TelegramView />);

  await user.click(await button("Sign in"));

  expect((await screen.findByTestId("link-error")).textContent).toBe(
    "Couldn't sign in. Try again.",
  );
  expect((await button("Sign in")).getAttribute("aria-disabled")).toBe("false");
  expect(console.error).toHaveBeenCalledTimes(1);
});

// ---- A token the API turns away --------------------------------------------------------------

test("a_token_the_api_turns_away_is_replaced_by_signing_in_again", async () => {
  const api = fakeApi((call) =>
    call === 1 ? json({ error: "unauthorized", message: "The token is not valid." }, 401) : made(),
  );
  const { wallet, user, open } = await openConnected();

  await user.click(await button("Link Telegram"));
  await screen.findByTestId("link-state");

  // The first token was refused, the person signed in again, and the new token got the link.
  expect(wallet.signRequests).toHaveLength(2);
  expect(api.requests).toEqual([
    "POST /v1/auth/challenge",
    "POST /v1/auth/verify",
    "POST /v1/telegram/link",
    "POST /v1/auth/challenge",
    "POST /v1/auth/verify",
    "POST /v1/telegram/link",
  ]);
  expect(api.authorizations).toEqual(["Bearer tok-1", "Bearer tok-2"]);
  expect(open).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId("link-error")).toBeNull();

  // The new token is the one the page holds from then on.
  await user.click(await button("Link Telegram"));
  await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  expect(api.authorizations).toEqual(["Bearer tok-1", "Bearer tok-2", "Bearer tok-2"]);
  expect(wallet.signRequests).toHaveLength(2);
});

test("a_token_that_is_turned_away_again_after_a_fresh_sign_in_is_told_and_not_retried", async () => {
  const api = fakeApi(() =>
    json({ error: "unauthorized", message: "The token is not valid." }, 401),
  );
  const { wallet, user, open } = await openConnected();

  await user.click(await button("Link Telegram"));

  expect((await screen.findByTestId("link-error")).textContent).toBe("The token is not valid.");
  expect(api.links()).toBe(2);
  expect(wallet.signRequests).toHaveLength(2);
  expect(open).not.toHaveBeenCalled();
});

test("the_page_does_not_clear_the_token_it_is_the_wallet_that_drops_it", () => {
  const source = readFileSync(join(import.meta.dirname, "../components/TelegramView.tsx"), "utf8");

  expect(source).not.toContain("clearApiToken");
});

// ---- A wallet that goes while the page waits ------------------------------------------------

test("a_wallet_that_is_disconnected_while_the_api_answers_gets_no_link", async () => {
  const wait = gate();
  const api = fakeApi(async () => {
    await wait.opens;
    return made();
  });
  const { user, open } = await openConnected();

  await user.click(await button("Link Telegram"));
  await waitFor(() => expect(api.links()).toBe(1));
  await act(async () => {
    await holder.store.disconnect();
  });
  wait.open();

  // The page waits for the request to end before it takes the button back.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Sign in" }).getAttribute("aria-disabled")).toBe(
      "false",
    ),
  );
  expect(open).not.toHaveBeenCalled();
  expect(screen.queryByTestId("link-state")).toBeNull();
  expect(screen.queryByTestId("link-error")).toBeNull();
  expect(consoleText()).not.toContain(CODE);
});

test("a_press_that_ends_after_the_person_has_left_the_page_opens_nothing", async () => {
  const wait = gate();
  let answered = false;
  const api = fakeApi(async () => {
    await wait.opens;
    answered = true;
    return made();
  });
  const { user, open } = await openConnected();
  await user.click(await button("Link Telegram"));
  await waitFor(() => expect(api.links()).toBe(1));

  // The person leaves while the API is still answering, and the answer comes after they have gone.
  cleanup();
  wait.open();
  await waitFor(() => expect(answered).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(open).not.toHaveBeenCalled();
  expect(consoleText()).not.toContain(CODE);
});

test("a_link_made_for_one_account_is_not_shown_for_another", async () => {
  const { provider, user } = setup({ connected: true });
  const bob = sessionFor(BOB);
  provider.connect = async () => bob;
  fakeApi();
  render(<TelegramView />);
  await user.click(await button("Link Telegram"));
  await screen.findByTestId("link-state");

  await act(async () => {
    await holder.store.disconnect();
  });
  expect(screen.queryByTestId("link-state")).toBeNull();
  await user.click(await button("Sign in"));

  expect((await screen.findByTestId("account-id")).textContent).toBe(BOB);
  expect(screen.queryByTestId("link-state")).toBeNull();
  expect(screen.queryByTestId("link-error")).toBeNull();
});
