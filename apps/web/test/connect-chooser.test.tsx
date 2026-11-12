import { ApiError, type GasGiftResponse } from "@tender/shared";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ConnectChooser, FOOTER_LOGIN, FOOTER_WALLETS } from "../components/ConnectChooser";
import { CODE_TRIES, codeProblem, createChooser, sendCodeProblem } from "../lib/chooser";
import type { GiftDeps } from "../lib/gasGift";
import { LAST_WAY_KEY } from "../lib/lastWay";
import type { ConnectPick, ConnectWays, LoginSteps, PrivyBridge, PrivyKit } from "../lib/privy";
import type { Session, WalletRow } from "../lib/wallet";

// Connect's one window: "Log in or sign up", with the email field, Google, and a row for each NEAR
// wallet near-connect lists, in a build with a Privy app id; the wallets alone in a build without
// one. After a login it gets the account ready to pay fees. Privy's kit and near-connect are both
// replaced here: the kit by a module that hands the bridge a kit the test drives (what Privy's
// hooks would give), near-connect by a connector that records its calls.

const ACCOUNT = "5e".repeat(32);
const GIFT = 100_000_000_000_000_000_000_000n;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const loginSession = (): Pick<Session, "accountId" | "keyHolder"> => ({
  accountId: ACCOUNT,
  keyHolder: { login: "email", exportKey: async () => {}, loginToken: async () => "login-token" },
});

/** A world for the readiness check: the balances in order, and what the gift route does. */
function giftWorld(balances: bigint[], gift: () => Promise<GasGiftResponse>) {
  const asked: string[] = [];
  const deps: GiftDeps = {
    balanceOf: async () =>
      balances.length > 1 ? (balances.shift() as bigint) : (balances[0] as bigint),
    loginToken: async () => "login-token",
    requestGift: async (token, account) => {
      asked.push(`${token} ${account}`);
      return gift();
    },
    sleep: async () => {},
    now: () => 0,
  };
  return { deps, asked };
}

const dialog = () => screen.getByRole("dialog");

/** A store whose readiness check is never run. */
const windowStore = (options?: { walletsWithinMs?: number }) =>
  createChooser(
    () => giftWorld([0n], async () => ({ status: "not_needed", balance: "1" })).deps,
    options,
  );

const ROWS: WalletRow[] = [
  {
    id: "ash-wallet",
    name: "Ash Wallet",
    icon: "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E",
    site: "wallet.ash.test",
  },
  { id: "birch-wallet", name: "Birch Wallet", icon: null, site: "birch.test" },
];

/** What a privy error looks like to the window: an error with Privy's code. */
const privyError = (code: string) => Object.assign(new Error(code), { privyErrorCode: code });

/** The window's ways, over steps that record what they were asked. */
function fakeWays(
  over: { steps?: Partial<LoginSteps>; login?: null } & Partial<
    Pick<ConnectWays, "wallets" | "lastUsed">
  > = {},
) {
  const asked: string[] = [];
  const steps: LoginSteps = {
    sendCode: async (email) => {
      asked.push(`sendCode ${email}`);
    },
    loginWithCode: async (code) => {
      asked.push(`loginWithCode ${code}`);
    },
    google: async () => {
      asked.push("google");
    },
    ...over.steps,
  };
  const ways: ConnectWays = {
    login: over.login === null ? null : async () => steps,
    wallets: over.wallets ?? (async () => ROWS),
    lastUsed: over.lastUsed ?? null,
  };
  return { ways, asked };
}

/** Opens the window of `store` over `ways`, and waits for its wallets. Gives the answer. */
async function open(
  store: ReturnType<typeof windowStore>,
  ways: ConnectWays,
): Promise<{ answer: Promise<ConnectPick | null> }> {
  let answer: Promise<ConnectPick | null> = Promise.resolve(null);
  act(() => {
    answer = store.ask(ways);
  });
  await waitFor(() => expect(within(dialog()).queryByRole("status")).toBeNull());
  return { answer };
}

/** The names of the window's buttons, in order: a label, or the words on it. */
const buttonNames = () =>
  within(dialog())
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label") ?? button.textContent);

test("the_window_offers_email_google_and_each_near_wallet_in_privy_s_order", async () => {
  const store = windowStore();
  render(<ConnectChooser store={store} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  await open(store, fakeWays().ways);

  const panel = dialog();
  expect(panel.getAttribute("aria-modal")).toBe("true");
  const heading = within(panel).getByRole("heading");
  expect(heading.textContent).toBe("Log in or sign up");
  expect(panel.getAttribute("aria-labelledby")).toBe(heading.id);
  // The email field and its Submit, Google, then one row for each wallet, with its site.
  expect(buttonNames()).toEqual([
    "Close",
    "Submit",
    "Continue with Google",
    "Ash Walletwallet.ash.test",
    "Birch Walletbirch.test",
  ]);
  const email = within(panel).getByLabelText("Email address");
  expect(email.getAttribute("placeholder")).toBe("your@email.com");
  expect(document.activeElement).toBe(email);
  expect(within(panel).getByText("or use a NEAR wallet")).toBeTruthy();
  expect(within(panel).getByText(FOOTER_LOGIN)).toBeTruthy();
  expect(FOOTER_LOGIN).toBe("Email and Google login by Privy. NEAR wallets connect directly.");
  // The wallet's own icon, and none for a wallet whose list gave none.
  const rows = within(panel).getAllByTestId("wallet-row");
  expect(rows[0]?.querySelector("img")?.getAttribute("src")).toBe(ROWS[0]?.icon);
  expect(rows[1]?.querySelector("img")).toBeNull();
  expect(within(panel).queryByTestId("last-used")).toBeNull();
});

test("without_a_login_the_window_shows_the_wallets_alone_with_the_same_look", async () => {
  const store = windowStore();
  render(<ConnectChooser store={store} />);
  await open(store, fakeWays({ login: null }).ways);

  const panel = dialog();
  expect(within(panel).getByRole("heading").textContent).toBe("Sign in with a NEAR wallet");
  expect(within(panel).queryByLabelText("Email address")).toBeNull();
  expect(within(panel).queryByText("or use a NEAR wallet")).toBeNull();
  expect(buttonNames()).toEqual(["Close", "Ash Walletwallet.ash.test", "Birch Walletbirch.test"]);
  expect(within(panel).getByText(FOOTER_WALLETS)).toBeTruthy();
  // The first wallet takes the focus once the list is there.
  await waitFor(() =>
    expect(document.activeElement).toBe(within(panel).getAllByTestId("wallet-row")[0]),
  );
});

test("an_email_gets_a_code_and_the_code_logs_in_with_the_window_kept_open", async () => {
  const store = windowStore();
  render(<ConnectChooser store={store} />);
  const { ways, asked } = fakeWays();
  const { answer } = await open(store, ways);

  await userEvent.type(screen.getByLabelText("Email address"), " ada@example.com {Enter}");
  expect(asked).toEqual(["sendCode ada@example.com"]);
  expect(within(dialog()).getByRole("heading").textContent).toBe("Check your email");
  expect(within(dialog()).getByText(/Enter the code sent to/).textContent).toBe(
    "Enter the code sent to ada@example.com",
  );
  const code = screen.getByLabelText("Code");
  await waitFor(() => expect(document.activeElement).toBe(code));
  expect(code.getAttribute("autocomplete")).toBe("one-time-code");
  expect(code.getAttribute("inputmode")).toBe("numeric");

  // A code pasted as the email shows it, with a space: all six digits, and it goes at once.
  expect(code.getAttribute("maxlength")).toBeNull();
  await userEvent.click(code);
  await userEvent.paste("123 456");
  expect(asked).toEqual(["sendCode ada@example.com", "loginWithCode 123456"]);
  expect(await answer).toEqual({ way: "login" });
  // The window stays, getting the account ready, until the session is made and checked.
  expect(screen.getByTestId("account-preparing").textContent).toBe("Getting your account ready…");
});

test("each_email_problem_is_one_plain_line", async () => {
  // The words, by Privy's code.
  expect(sendCodeProblem(privyError("invalid_data"))).toBe("Check the email address.");
  expect(sendCodeProblem(privyError("too_many_requests"))).toBe(
    "Too many tries. Wait a few minutes, then try again.",
  );
  expect(sendCodeProblem(privyError("disallowed_login_method"))).toBe(
    "This email address can't log in here.",
  );
  expect(sendCodeProblem(new Error("offline"))).toBe("Couldn't send the code. Try again.");
  expect(codeProblem(privyError("invalid_credentials"), 1)).toBe(
    "That code is wrong or has expired.",
  );
  expect(codeProblem(privyError("invalid_credentials"), CODE_TRIES)).toBe(
    "Too many wrong codes. Send a new code.",
  );
  expect(codeProblem(privyError("too_many_requests"), 1)).toBe(
    "Too many tries. Wait a few minutes, then send a new code.",
  );
  expect(codeProblem(new Error("offline"), 1)).toBe("Couldn't log in. Try again.");

  // In the window: an empty field and an address that is not one are caught before Privy is asked.
  let refuse: string | null = "too_many_requests";
  const { ways, asked } = fakeWays({
    steps: {
      sendCode: async (email) => {
        asked.push(`sendCode ${email}`);
        if (refuse !== null) throw privyError(refuse);
      },
      loginWithCode: async (code) => {
        asked.push(`loginWithCode ${code}`);
        if (code !== "123456") throw privyError("invalid_credentials");
      },
    },
  });
  const store = windowStore();
  render(<ConnectChooser store={store} />);
  await open(store, ways);
  const submit = () => userEvent.click(screen.getByRole("button", { name: "Submit" }));
  await submit();
  expect(screen.getByRole("alert").textContent).toBe("Enter your email address.");
  await userEvent.type(screen.getByLabelText("Email address"), "ada@");
  await submit();
  expect(screen.getByRole("alert").textContent).toBe("Check the email address.");
  const field = screen.getByLabelText("Email address");
  expect(field.getAttribute("aria-invalid")).toBe("true");
  // The email row's line is under the email row, before Google's, and describes the field.
  const line = screen.getByRole("alert");
  expect(field.closest("form")?.nextElementSibling).toBe(line);
  expect(field.getAttribute("aria-describedby")).toBe(line.id);
  expect(asked).toEqual([]);
  await userEvent.type(screen.getByLabelText("Email address"), "example.com");
  await submit();
  expect(screen.getByRole("alert").textContent).toBe(
    "Too many tries. Wait a few minutes, then try again.",
  );

  // Sent; then a wrong code, which empties the field for the next.
  refuse = null;
  await submit();
  const code = () => screen.getByLabelText("Code") as HTMLInputElement;
  await userEvent.type(code(), "000000");
  expect(screen.getByRole("alert").textContent).toBe("That code is wrong or has expired.");
  expect(code().value).toBe("");
  await waitFor(() => expect(document.activeElement).toBe(code()));
  // Fewer than six digits, with Log in.
  await userEvent.type(code(), "12");
  await userEvent.click(screen.getByRole("button", { name: "Log in" }));
  expect(screen.getByRole("alert").textContent).toBe("Enter the 6-digit code.");
  // Wrong until Privy takes no more for this code.
  for (let tries = 2; tries <= CODE_TRIES; tries++) {
    await userEvent.clear(code());
    await userEvent.type(code(), "000000");
  }
  expect(screen.getByRole("alert").textContent).toBe("Too many wrong codes. Send a new code.");

  // Resend: a new code to the same address, and the count starts again.
  await userEvent.click(screen.getByRole("button", { name: "Resend code" }));
  expect(asked.filter((line) => line === "sendCode ada@example.com")).toHaveLength(3);
  expect(screen.getByRole("status").textContent).toBe("A new code is on its way.");
  expect(screen.queryByRole("alert")).toBeNull();

  // Back: the first step again, with the address still in its field.
  await userEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(within(dialog()).getByRole("heading").textContent).toBe("Log in or sign up");
  expect((screen.getByLabelText("Email address") as HTMLInputElement).value).toBe(
    "ada@example.com",
  );
});

test("google_sends_the_page_to_google_and_says_so_if_it_can_t", async () => {
  const store = windowStore();
  render(<ConnectChooser store={store} />);
  let go: () => void = () => {};
  const { ways, asked } = fakeWays({
    steps: {
      google: () => {
        asked.push("google");
        return new Promise((resolve) => {
          go = resolve;
        });
      },
    },
  });
  await open(store, ways);
  await userEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
  expect(asked).toEqual(["google"]);
  // On its way: the row says so, and a second press does nothing.
  const row = screen.getByRole("button", { name: "Opening Google…" });
  expect(row.getAttribute("aria-disabled")).toBe("true");
  await userEvent.click(row);
  expect(asked).toEqual(["google"]);
  go();
  act(() => store.close());

  // Privy refuses to start it: the window says so, and Google can be pressed again.
  const failing = windowStore();
  render(<ConnectChooser store={failing} />);
  await open(
    failing,
    fakeWays({
      steps: {
        google: async () => {
          throw privyError("disallowed_login_method");
        },
      },
    }).ways,
  );
  await userEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
  const line = screen.getByRole("alert");
  expect(line.textContent).toBe("Google sign-in didn't finish. Try again or use email.");
  const google = screen.getByRole("button", { name: "Continue with Google" });
  expect(google.getAttribute("aria-disabled")).toBeNull();
  // Google's line is under the Google row and describes it; the email field is not marked.
  expect(google.nextElementSibling).toBe(line);
  expect(google.getAttribute("aria-describedby")).toBe(line.id);
  const field = screen.getByLabelText("Email address");
  expect(field.getAttribute("aria-invalid")).toBeNull();
  expect(field.getAttribute("aria-describedby")).toBeNull();
});

test("back_from_google_the_window_says_it_is_finishing_and_then_gets_the_account_ready", async () => {
  let land: (answer: GasGiftResponse) => void = () => {};
  const world = giftWorld(
    [0n, GIFT],
    () =>
      new Promise((resolve) => {
        land = resolve;
      }),
  );
  const store = createChooser(() => world.deps);
  render(<ConnectChooser store={store} />);
  act(() => store.finishing());
  expect(within(dialog()).getByRole("heading").textContent).toBe("Your account");
  expect(screen.getByTestId("google-finishing").textContent).toBe("Finishing your Google sign-in…");
  // Nothing to press but Close, which has the focus.
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Close");

  // The login ended: the account step opens in its place.
  let prepared: Promise<void> = Promise.resolve();
  act(() => {
    prepared = store.prepare(loginSession());
  });
  expect((await screen.findByTestId("account-preparing")).textContent).toBe(
    "Getting your account ready…",
  );
  expect(screen.queryByTestId("google-finishing")).toBeNull();
  await act(async () => land({ status: "sent", amount: GIFT.toString(), tx_hash: "h" }));
  await act(() => prepared);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a_google_sign_in_that_didn_t_finish_opens_the_window_with_one_line", async () => {
  const store = windowStore();
  render(<ConnectChooser store={store} />);
  act(() => store.finishing());
  // The window asks again, with the line the provider gives it, and every way.
  await open(store, {
    ...fakeWays().ways,
    problem: "Google sign-in didn't finish. Try again or use email.",
  });
  expect(screen.getByRole("alert").textContent).toBe(
    "Google sign-in didn't finish. Try again or use email.",
  );
  expect(screen.getByLabelText("Email address")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Continue with Google" })).toBeTruthy();
  // The line goes once the person does something else.
  await userEvent.type(screen.getByLabelText("Email address"), "ada@example.com{Enter}");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a_wallet_row_picks_that_wallet_and_the_window_closes", async () => {
  const store = windowStore();
  render(<ConnectChooser store={store} />);
  const { answer } = await open(store, fakeWays().ways);
  await userEvent.click(screen.getByRole("button", { name: /Birch Wallet/ }));
  expect(await answer).toEqual({ way: "wallet", walletId: "birch-wallet" });
  // Closed at once, so that the wallet's own approval is what shows.
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("last_used_marks_the_way_this_browser_connected_with_last", async () => {
  for (const [used, row] of [
    ["email", "Email address"],
    ["google", "Continue with Google"],
    ["wallet:birch-wallet", "Birch Wallet"],
  ] as const) {
    const store = windowStore();
    const { unmount } = render(<ConnectChooser store={store} />);
    await open(store, fakeWays({ lastUsed: used }).ways);
    const badges = screen.getAllByTestId("last-used");
    expect(badges, used).toHaveLength(1);
    expect(badges[0]?.textContent).toBe("Last used");
    // In the row of that way.
    const holder = badges[0]?.closest("form, button");
    expect(holder?.textContent, used).toContain(row === "Email address" ? "Submit" : row);
    act(() => store.close());
    unmount();
  }

  // A way kept with no method ("login" or "wallet", as an earlier build kept it) marks no row.
  for (const used of ["login", "wallet"] as const) {
    const store = windowStore();
    const { unmount } = render(<ConnectChooser store={store} />);
    await open(store, fakeWays({ lastUsed: used }).ways);
    expect(screen.queryAllByTestId("last-used"), used).toEqual([]);
    act(() => store.close());
    unmount();
  }
});

test("a_list_that_can_t_be_had_is_one_row_that_opens_near_connect_s_own_window", async () => {
  for (const wallets of [
    async () => {
      throw new Error("the library did not load");
    },
    async () => [],
  ]) {
    const store = windowStore();
    const { unmount } = render(<ConnectChooser store={store} />);
    const { answer } = await open(store, fakeWays({ wallets }).ways);
    const fallback = screen.getByRole("button", { name: "NEAR wallets" });
    expect(screen.queryAllByTestId("wallet-row")).toEqual([]);
    await userEvent.click(fallback);
    expect(await answer).toEqual({ way: "wallet", walletId: null });
    unmount();
  }

  // A list that doesn't come in time: the same row, while it still may.
  vi.useFakeTimers();
  const store = windowStore({ walletsWithinMs: 1000 });
  render(<ConnectChooser store={store} />);
  act(() => {
    void store.ask(fakeWays({ wallets: () => new Promise(() => {}) }).ways);
  });
  expect(within(dialog()).getByRole("status").textContent).toBe("Loading NEAR wallets…");
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(screen.getByRole("button", { name: "NEAR wallets" })).toBeTruthy();
});

test("escape_the_close_button_and_the_backdrop_close_it_and_the_focus_goes_back", async () => {
  const store = windowStore();
  render(
    <>
      <button type="button">Sign in</button>
      <ConnectChooser store={store} />
    </>,
  );
  const opener = screen.getByRole("button", { name: "Sign in" });

  for (const close of [
    () => fireEvent.keyDown(dialog(), { key: "Escape" }),
    () => fireEvent.click(screen.getByRole("button", { name: "Close" })),
    () => fireEvent.click(screen.getByTestId("connect-chooser")),
  ]) {
    opener.focus();
    const { answer } = await open(store, fakeWays().ways);
    expect(document.activeElement).toBe(screen.getByLabelText("Email address"));
    act(close);
    expect(await answer).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  }
});

test("the_focus_stays_in_the_window_and_every_row_is_a_button", async () => {
  const store = windowStore();
  render(<ConnectChooser store={store} />);
  await open(store, fakeWays().ways);
  const close = screen.getByRole("button", { name: "Close" });
  const last = screen.getByRole("button", { name: /Birch Wallet/ });
  // Tab from the last row goes round to the first control, and Shift+Tab from it back to the last.
  last.focus();
  fireEvent.keyDown(dialog(), { key: "Tab" });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(dialog(), { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);
  // Google and every wallet are buttons; the email row is its field and its button.
  for (const row of [
    screen.getByRole("button", { name: "Continue with Google" }),
    ...screen.getAllByTestId("wallet-row"),
  ]) {
    expect(row.tagName).toBe("BUTTON");
  }
});

test("after_a_login_it_says_getting_your_account_ready_until_the_near_arrives", async () => {
  let land: (answer: GasGiftResponse) => void = () => {};
  const world = giftWorld(
    [0n, GIFT],
    () =>
      new Promise((resolve) => {
        land = resolve;
      }),
  );
  const store = createChooser(() => world.deps);
  render(<ConnectChooser store={store} />);

  let prepared: Promise<void> = Promise.resolve();
  act(() => {
    prepared = store.prepare(loginSession());
  });
  expect((await screen.findByTestId("account-preparing")).textContent).toBe(
    "Getting your account ready…",
  );
  // Nothing to press while it lands but Close, which has the focus.
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Close");

  await act(async () => land({ status: "sent", amount: GIFT.toString(), tx_hash: "h" }));
  await act(() => prepared);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(world.asked).toEqual([`login-token ${ACCOUNT}`]);
});

test("a_gift_switched_off_says_so_in_one_line_with_the_faucet_and_the_account_to_copy", async () => {
  const world = giftWorld([0n], async () => {
    throw new ApiError(503, { error: "gift_off", message: "off" });
  });
  const store = createChooser(() => world.deps);
  render(<ConnectChooser store={store} />);

  await act(() => store.prepare(loginSession()));
  const panel = dialog();
  expect(within(panel).getByTestId("account-stuck").textContent).toBe(
    "Tender isn't sending NEAR for fees right now.",
  );
  // The way on: the testnet faucet (vitest.config.ts builds for testnet), with the account.
  const faucet = within(panel).getByRole("link", { name: "Open the faucet" });
  expect(faucet.getAttribute("href")).toBe("https://near-faucet.io/");
  expect(faucet.getAttribute("target")).toBe("_blank");
  expect(within(panel).getByTestId("stuck-account").getAttribute("title")).toBe(ACCOUNT);
  expect(within(panel).getByRole("button", { name: "Copy account" })).toBeTruthy();
  expect(document.activeElement).toBe(faucet);
  // Trying again would get the same answer: there is no Try again.
  expect(within(panel).queryByRole("button", { name: "Try again" })).toBeNull();
});

test("a_failure_of_ours_offers_the_faucet_and_try_again", async () => {
  let fail = true;
  const world = giftWorld([0n], async () => {
    if (fail) throw new ApiError(400, { error: "bad_request", message: "x" });
    return { status: "not_needed", balance: GIFT.toString() };
  });
  const store = createChooser(() => world.deps);
  render(<ConnectChooser store={store} />);
  await act(() => store.prepare(loginSession()));
  expect(screen.getByTestId("account-stuck").textContent).toBe(
    "Tender couldn't send NEAR for fees just now.",
  );
  expect(screen.getByRole("link", { name: "Open the faucet" })).toBeTruthy();
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("a_transfer_that_failed_says_couldn_t_send_yet_and_try_again_takes_near_that_arrived", async () => {
  const balances = [0n];
  const world = giftWorld(balances, async () => {
    throw new ApiError(502, { error: "transfer_failed", message: "x" });
  });
  const store = createChooser(() => world.deps);
  render(<ConnectChooser store={store} />);
  await act(() => store.prepare(loginSession()));

  expect(screen.getByTestId("account-stuck").textContent).toBe(
    "Couldn't send yet. Try again in a moment.",
  );
  // Try again first, with the focus; the faucet and the account to copy as the other way.
  const again = screen.getByRole("button", { name: "Try again" });
  expect(document.activeElement).toBe(again);
  const faucet = screen.getByRole("link", { name: "Open the faucet" });
  expect(again.compareDocumentPosition(faucet) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByTestId("stuck-account").getAttribute("title")).toBe(ACCOUNT);
  expect(world.asked).toHaveLength(1);

  // The transfer had timed out at the API and landed after all: Try again reads the balance first
  // and the account is ready, without a second ask.
  balances[0] = GIFT / 4n;
  await userEvent.click(again);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(world.asked).toHaveLength(1);
});

test("the_login_check_down_for_a_moment_and_too_many_tries_ask_to_try_again", async () => {
  for (const [status, code, line] of [
    [503, "unavailable", "Tender can't send NEAR for fees right now. Try again in a moment."],
    [429, "rate_limited", "Too many tries from here. Try again in a few minutes."],
  ] as const) {
    let down = true;
    // Nothing at the first read and at Try again's; then the gift arrives.
    const world = giftWorld([0n, 0n, GIFT], async () => {
      if (down) throw new ApiError(status, { error: code, message: "x" });
      return { status: "sent", amount: GIFT.toString(), tx_hash: "h" };
    });
    const store = createChooser(() => world.deps);
    const { unmount } = render(<ConnectChooser store={store} />);
    await act(() => store.prepare(loginSession()));
    expect(screen.getByTestId("account-stuck").textContent, code).toBe(line);
    // The faucet is the other way, after Try again.
    expect(screen.getByRole("link", { name: "Open the faucet" }), code).toBeTruthy();
    down = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("dialog"), code).toBeNull());
    expect(world.asked, code).toHaveLength(2);
    unmount();
  }
});

test("each_problem_has_its_own_line_and_try_again_after_a_timeout_only_waits", async () => {
  const lines: Record<string, string> = {
    daily_limit: "Tender has sent all the NEAR for fees it sends today.",
    already_given: "Tender has already sent this account NEAR for fees once.",
  };
  for (const [code, line] of Object.entries(lines)) {
    const world = giftWorld([0n], async () => {
      throw new ApiError(code === "daily_limit" ? 429 : 409, { error: code, message: "x" });
    });
    const store = createChooser(() => world.deps);
    const { unmount } = render(<ConnectChooser store={store} />);
    await act(() => store.prepare(loginSession()));
    expect(screen.getByTestId("account-stuck").textContent).toBe(line);
    // Tender won't send today, or again: the faucet, and no Try again.
    expect(screen.getByRole("link", { name: "Open the faucet" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    unmount();
  }

  // Sent, and never arrived in time.
  const balances = [0n];
  const world = giftWorld(balances, async () => ({
    status: "sent",
    amount: GIFT.toString(),
    tx_hash: "h",
  }));
  let clock = 0;
  world.deps.sleep = async (ms) => {
    clock += ms;
  };
  world.deps.now = () => clock;
  const store = createChooser(() => world.deps);
  render(<ConnectChooser store={store} />);
  await act(() => store.prepare(loginSession()));
  expect(screen.getByTestId("account-stuck").textContent).toBe(
    "The NEAR for fees hasn't arrived yet.",
  );
  expect(world.asked).toHaveLength(1);
  // It arrives; Try again reads the node and does not ask the API again.
  balances[0] = GIFT;
  await act(() => store.retry());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(world.asked).toHaveLength(1);
});

test("closing_while_it_gets_ready_lets_the_connect_go_on_at_once", async () => {
  const world = giftWorld([0n], () => new Promise(() => {}));
  const store = createChooser(() => world.deps);
  render(<ConnectChooser store={store} />);
  let prepared: Promise<void> = Promise.resolve();
  act(() => {
    prepared = store.prepare(loginSession());
  });
  await screen.findByTestId("account-preparing");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await expect(prepared).resolves.toBeUndefined();
  expect(screen.queryByRole("dialog")).toBeNull();
});

// ---- The page's store, with and without a Privy app id -----------------------------------------

const near = vi.hoisted(() => {
  class FakeConnector {
    picked = false;
    whenManifestLoaded = Promise.resolve();
    // What near-connect lists for this app: one wallet that can send a batch.
    availableWallets = [
      {
        manifest: {
          id: "ash-wallet",
          name: "Ash Wallet",
          icon: "https://example.test/ash.png",
          website: "https://wallet.ash.test",
        },
      },
    ];
    connect = vi.fn(async (_input?: { walletId?: string }) => {
      this.picked = true;
      return {};
    });
    // Nothing from an earlier visit; once the person picked one, Alice's wallet.
    getConnectedWallet = vi.fn(async (): Promise<unknown> => {
      if (!this.picked) throw new Error("No wallet selected");
      return {
        wallet: { manifest: { features: { signMessage: true } } },
        accounts: [{ accountId: "alice.testnet" }],
      };
    });
    disconnect = vi.fn(async () => {});
    constructor() {
      near.made.push(this);
    }
    on() {}
    off() {}
  }
  const near = { made: [] as FakeConnector[], FakeConnector };
  return near;
});
vi.mock("@hot-labs/near-connect", () => ({ NearConnector: near.FakeConnector }));

// Privy's kit, as lib/privyKit.tsx would mount it: a kit the test drives, handed to the bridge.
const privy = vi.hoisted(() => ({
  bridge: null as PrivyBridge | null,
  mounted: [] as Array<{ appId: string; clientId: string | null }>,
  kit: null as PrivyKit | null,
  /** Calls of Privy's logout, and whether Privy holds a login now. */
  logouts: 0,
  authenticated: false,
  asked: [] as string[],
}));
vi.mock("../lib/privyKit", () => ({
  mountPrivyKit: (bridge: PrivyBridge, ids: { appId: string; clientId: string | null }) => {
    privy.bridge = bridge;
    privy.mounted.push(ids);
    const user = {
      linkedAccounts: [{ type: "wallet", chainType: "near", address: ACCOUNT }],
      email: { address: "x" },
    };
    const kit: PrivyKit = {
      ready: true,
      authenticated: false,
      user: null,
      sendCode: async ({ email }) => {
        privy.asked.push(`sendCode ${email}`);
      },
      // The right code logs the person in: Privy says so to the login's callback, then the hooks.
      loginWithCode: async ({ code }) => {
        privy.asked.push(`loginWithCode ${code}`);
        privy.authenticated = true;
        bridge.loginEnded({ user });
        setTimeout(() => bridge.publish({ ...kit, authenticated: true, user }), 0);
      },
      initOAuth: async ({ provider }) => {
        privy.asked.push(`initOAuth ${provider}`);
      },
      logout: async () => {
        privy.logouts++;
        privy.authenticated = false;
        bridge.publish({ ...kit, authenticated: false, user: null });
      },
      createWallet: async () => ({ wallet: { address: ACCOUNT } }),
      signRawHash: async () => ({ signature: `0x${"00".repeat(64)}` }),
      exportWallet: async () => {},
      getAccessToken: async () => "login-token",
    };
    privy.kit = kit;
    bridge.publish(kit);
  },
}));

/** `lib/wallet.ts` and `lib/chooser.ts` as a build with `env` loads them. */
async function pageModules(env: Record<string, string>) {
  vi.resetModules();
  near.made.length = 0;
  privy.mounted.length = 0;
  privy.logouts = 0;
  privy.authenticated = false;
  privy.asked.length = 0;
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const [{ walletStore }, { chooser }] = await Promise.all([
    import("../lib/wallet"),
    import("../lib/chooser"),
  ]);
  return { walletStore, chooser };
}

/** Waits for the page's window to list its wallets. */
async function listed(chooser: Awaited<ReturnType<typeof pageModules>>["chooser"]) {
  await vi.waitFor(() => {
    const state = chooser.getSnapshot();
    expect(state.step === "choose" && state.wallets.status).toBe("listed");
  });
  return chooser.getSnapshot();
}

test("without_a_privy_app_id_connect_opens_the_window_with_the_wallets_alone", async () => {
  const { walletStore, chooser } = await pageModules({});
  const connecting = walletStore.connect();
  const state = await listed(chooser);
  expect(state).toMatchObject({
    step: "choose",
    login: false,
    wallets: {
      status: "listed",
      wallets: [
        {
          id: "ash-wallet",
          name: "Ash Wallet",
          icon: "https://example.test/ash.png",
          site: "wallet.ash.test",
        },
      ],
    },
  });

  // A wallet's row connects that wallet, with no window of near-connect's.
  chooser.pickWallet("ash-wallet");
  await connecting;
  expect(near.made).toHaveLength(1);
  expect(near.made[0]?.connect.mock.calls).toEqual([[{ walletId: "ash-wallet" }]]);
  expect(walletStore.getSnapshot().accountId).toBe("alice.testnet");
  // Remembered for the window's "Last used"; and the kit is never loaded.
  expect(localStorage.getItem(LAST_WAY_KEY)).toBe("wallet:ash-wallet");
  expect(privy.mounted).toEqual([]);

  await walletStore.disconnect();
  const again = walletStore.connect();
  expect(await listed(chooser)).toMatchObject({ lastUsed: "wallet:ash-wallet" });
  // The row that opens near-connect's own list.
  chooser.pickWallet(null);
  await again;
  expect(near.made[0]?.connect.mock.calls.at(-1)).toEqual([]);
});

test("with_a_privy_app_id_the_window_offers_the_login_and_a_wallet_row_connects_that_wallet", async () => {
  const { walletStore, chooser } = await pageModules({
    NEXT_PUBLIC_PRIVY_APP_ID: "cm0app1d",
    NEXT_PUBLIC_PRIVY_CLIENT_ID: "client-1",
  });
  await walletStore.start();
  const connecting = walletStore.connect();
  expect(await listed(chooser)).toMatchObject({ step: "choose", login: true });
  // The kit was loaded with the build's ids to look for a login of an earlier visit.
  expect(privy.mounted).toEqual([{ appId: "cm0app1d", clientId: "client-1" }]);

  chooser.pickWallet("ash-wallet");
  await connecting;
  expect(near.made.at(-1)?.connect.mock.calls).toEqual([[{ walletId: "ash-wallet" }]]);
});

test("with_a_privy_app_id_google_calls_privy_s_init_oauth", async () => {
  const { walletStore, chooser } = await pageModules({ NEXT_PUBLIC_PRIVY_APP_ID: "cm0app1d" });
  await walletStore.start();
  void walletStore.connect();
  await listed(chooser);
  await chooser.google();
  expect(privy.asked).toEqual(["initOAuth google"]);
});

test("with_a_privy_app_id_the_email_login_connects_gets_the_account_ready_and_logs_out", async () => {
  const requests: string[] = [];
  let funded = false;
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.origin === "http://rpc.test") {
      requests.push("RPC view_account");
      return new Response(
        JSON.stringify(
          funded
            ? { jsonrpc: "2.0", id: "x", result: { amount: GIFT.toString() } }
            : {
                jsonrpc: "2.0",
                id: "x",
                error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" }, data: "" },
              },
        ),
      );
    }
    requests.push(
      `${init.method} ${url.pathname} ${new Headers(init.headers).get("Authorization")}`,
    );
    funded = true;
    return new Response(
      JSON.stringify({ status: "sent", amount: GIFT.toString(), tx_hash: "gifthash" }),
    );
  });
  const { walletStore, chooser } = await pageModules({ NEXT_PUBLIC_PRIVY_APP_ID: "cm0app1d" });
  await walletStore.start();
  expect(walletStore.getSnapshot().accountId).toBeNull();

  const connecting = walletStore.connect();
  await listed(chooser);
  await chooser.sendCode("ada@example.com");
  expect(chooser.getSnapshot().step).toBe("code");
  await chooser.submitCode("123456");
  await connecting;

  expect(privy.asked).toEqual(["sendCode ada@example.com", "loginWithCode 123456"]);
  expect(walletStore.getSnapshot()).toMatchObject({
    ready: true,
    accountId: ACCOUNT,
    canSignMessage: true,
  });
  expect(walletStore.getSnapshot().keyHolder?.login).toBe("email");
  expect(chooser.getSnapshot().step).toBe("closed");
  expect(localStorage.getItem(LAST_WAY_KEY)).toBe("email");
  // The balance, the gift with the login's token, and the balance again until it arrived.
  expect(requests).toEqual([
    "RPC view_account",
    "POST /v1/gas-gift Bearer login-token",
    "RPC view_account",
  ]);

  // Log out: the store's session and Privy's both end, Privy's by one call of its logout.
  expect(privy.authenticated).toBe(true);
  await walletStore.disconnect();
  expect(walletStore.getSnapshot().accountId).toBeNull();
  expect(privy.logouts).toBe(1);
  expect(privy.authenticated).toBe(false);
});
