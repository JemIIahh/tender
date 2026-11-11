import { ApiError, type GasGiftResponse } from "@tender/shared";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ConnectChooser } from "../components/ConnectChooser";
import { createChooser } from "../lib/chooser";
import type { GiftDeps } from "../lib/gasGift";
import type { PrivyBridge, PrivyKit } from "../lib/privy";
import type { Session } from "../lib/wallet";

// Connect's chooser: in a build with a Privy app id, Connect asks which way, the email or Google
// login first and a NEAR wallet second; after a login it gets the account ready to pay fees. In a
// build without one, Connect opens near-connect at once, as it did before. Privy's kit and
// near-connect are both replaced here: the kit by a module that hands the bridge a kit the test
// drives (what Privy's hooks would give), near-connect by a connector that records its calls.

const ACCOUNT = "5e".repeat(32);
const GIFT = 100_000_000_000_000_000_000_000n;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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

test("the_chooser_offers_the_login_first_and_a_near_wallet_second", async () => {
  const store = createChooser(
    () => giftWorld([0n], async () => ({ status: "not_needed", balance: "1" })).deps,
  );
  render(<ConnectChooser store={store} />);
  expect(screen.queryByRole("dialog")).toBeNull();

  let answer: Promise<string | null> = Promise.resolve(null);
  act(() => {
    answer = store.ask();
  });
  expect(within(dialog()).getByRole("heading").textContent).toBe("Connect to Tender");
  const buttons = within(dialog())
    .getAllByRole("button")
    .map((button) => button.textContent);
  expect(buttons).toEqual(["", "Continue with email or Google", "Use a NEAR wallet"]);
  // The one big action has the focus.
  expect(document.activeElement?.textContent).toBe("Continue with email or Google");

  await userEvent.click(screen.getByRole("button", { name: "Continue with email or Google" }));
  expect(await answer).toBe("login");
  // Closed at once, so that the login's own window is what shows.
  expect(screen.queryByRole("dialog")).toBeNull();

  act(() => {
    answer = store.ask();
  });
  await userEvent.click(screen.getByRole("button", { name: "Use a NEAR wallet" }));
  expect(await answer).toBe("wallet");
});

test("escape_the_close_button_and_the_backdrop_close_it_with_no_choice", async () => {
  const store = createChooser(
    () => giftWorld([0n], async () => ({ status: "not_needed", balance: "1" })).deps,
  );
  render(<ConnectChooser store={store} />);

  for (const close of [
    () => fireEvent.keyDown(dialog(), { key: "Escape" }),
    () => fireEvent.click(screen.getByRole("button", { name: "Close" })),
    () => fireEvent.click(screen.getByTestId("connect-chooser")),
  ]) {
    let answer: Promise<string | null> = Promise.resolve("login");
    act(() => {
      answer = store.ask();
    });
    act(close);
    expect(await answer).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
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

test("a_refused_gift_says_so_in_one_line_with_the_faucet_and_the_account_to_copy", async () => {
  let refuse = true;
  const world = giftWorld([0n], async () => {
    if (refuse) throw new ApiError(503, { error: "gift_off", message: "off" });
    return { status: "not_needed", balance: GIFT.toString() };
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

  // Try again, once the gift is on: ready, and the chooser closes.
  refuse = false;
  await userEvent.click(within(panel).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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
    connect = vi.fn(async () => {
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
      // The person logs in: Privy says so to the hooks, and to the login's callback.
      login: () => {
        bridge.publish({ ...kit, authenticated: true, user });
        bridge.loginEnded({ user });
      },
      logout: async () => bridge.publish({ ...kit, authenticated: false, user: null }),
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
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const [{ walletStore }, { chooser }] = await Promise.all([
    import("../lib/wallet"),
    import("../lib/chooser"),
  ]);
  return { walletStore, chooser };
}

test("without_a_privy_app_id_connect_opens_near_connect_at_once", async () => {
  const { walletStore, chooser } = await pageModules({});
  const opened: string[] = [];
  chooser.subscribe(() => opened.push(chooser.getSnapshot().step));

  await walletStore.connect();

  expect(near.made).toHaveLength(1);
  expect(near.made[0]?.connect).toHaveBeenCalledTimes(1);
  expect(opened).toEqual([]);
  // The kit is never loaded.
  expect(privy.mounted).toEqual([]);
});

test("with_a_privy_app_id_connect_asks_and_a_near_wallet_is_near_connect", async () => {
  const { walletStore, chooser } = await pageModules({
    NEXT_PUBLIC_PRIVY_APP_ID: "cm0app1d",
    NEXT_PUBLIC_PRIVY_CLIENT_ID: "client-1",
  });
  await walletStore.start();
  const connecting = walletStore.connect();
  await vi.waitFor(() => expect(chooser.getSnapshot().step).toBe("choose"));
  // The kit was loaded with the build's ids to look for a login of an earlier visit.
  expect(privy.mounted).toEqual([{ appId: "cm0app1d", clientId: "client-1" }]);

  chooser.choose("wallet");
  await connecting;
  expect(near.made.at(-1)?.connect).toHaveBeenCalledTimes(1);
});

test("with_a_privy_app_id_the_login_connects_gets_the_account_ready_and_logs_out", async () => {
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
  await vi.waitFor(() => expect(chooser.getSnapshot().step).toBe("choose"));
  chooser.choose("login");
  await connecting;

  expect(walletStore.getSnapshot()).toMatchObject({
    ready: true,
    accountId: ACCOUNT,
    canSignMessage: true,
  });
  expect(walletStore.getSnapshot().keyHolder?.login).toBe("email");
  expect(chooser.getSnapshot().step).toBe("closed");
  // The balance, the gift with the login's token, and the balance again until it arrived.
  expect(requests).toEqual([
    "RPC view_account",
    "POST /v1/gas-gift Bearer login-token",
    "RPC view_account",
  ]);

  // Log out: the store's session and Privy's both end.
  await walletStore.disconnect();
  expect(walletStore.getSnapshot().accountId).toBeNull();
  expect(privy.kit).not.toBeNull();
});
