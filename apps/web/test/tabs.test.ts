import { afterEach, expect, test, vi } from "vitest";
import {
  clearApiToken,
  heldToken,
  keepToken,
  type StoredToken,
  signInTicket,
} from "../lib/apiToken";
import { createWalletStore, type Session } from "../lib/wallet";
import { WalletError } from "../lib/walletErrors";
import { FakeChain } from "./fakeChain";
import { rejection } from "./support";
import { chainWallet, type FakeProvider, fakeProvider, fakeTabs } from "./walletDoubles";

// The wallet session is the browser's and the API token is the tab's, so a session that ends or
// changes in one tab has to reach the others (lib/walletTabs.ts, lib/wallet.ts). The first half
// holds the store to what it tells and what it does when told, on a line the test holds both ends
// of. The second half is the store and the real channel together: tabs that are stores on it, each
// with its own copy of the modules, as each tab has its own page. (The line alone is in
// walletTabs.test.ts.)

const ALICE = "alice.testnet";
const BOB = "bob.testnet";
const FAR_OFF = Date.parse("2099-01-01T00:00:00.000Z");

/** The lines and channels a test opened, which it closes. */
const lines: Array<{ close(): void }> = [];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearApiToken();
  sessionStorage.clear();
  for (const line of lines.splice(0)) line.close();
});

/** Waits for what a message should bring about, on a machine that may be busy. */
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 5000, interval: 10 });

function sessionFor(accountId: string): Session {
  return { wallet: chainWallet(new FakeChain("tender.testnet", []), accountId), accountId };
}

const tokenFor = (accountId: string): StoredToken => ({
  accountId,
  token: `tok-${accountId}`,
  expiresAtMs: FAR_OFF,
});

/**
 * A provider whose restore waits for the test: `found` and `failed` settle it, once `asked()` says
 * the store has called it.
 */
function slowRestore(session: Session) {
  const provider = fakeProvider(session);
  let asked = 0;
  let settle: { found: (found: Session | null) => void; failed: (error: Error) => void } = {
    found: () => {},
    failed: () => {},
  };
  provider.restore = () =>
    new Promise((resolve, reject) => {
      asked++;
      settle = { found: resolve, failed: reject };
    });
  return {
    provider,
    asked: () => asked,
    found: (found: Session | null) => settle.found(found),
    failed: (error: Error) => settle.failed(error),
  };
}

// ---- What a store tells the other tabs ---------------------------------------------------------

test("the_store_opens_its_line_to_the_other_tabs_when_it_starts_and_once", async () => {
  const tabs = fakeTabs();
  const store = createWalletStore(async () => fakeProvider(sessionFor(ALICE)), tabs.open);
  expect(tabs.opened).toBe(0);

  await store.start();
  await store.connect();
  await store.disconnect();

  expect(tabs.opened).toBe(1);
});

test("a_wallet_the_person_connects_is_told_to_the_other_tabs_as_whoever_it_is", async () => {
  for (const accountId of [ALICE, BOB]) {
    const tabs = fakeTabs();
    const store = createWalletStore(async () => fakeProvider(sessionFor(accountId)), tabs.open);
    await store.start();
    // (A restore that found no wallet told no one.)
    expect(tabs.told).toBe(0);

    await store.connect();

    expect(store.getSnapshot().accountId).toBe(accountId);
    expect(tabs.told, accountId).toBe(1);
  }
});

test("a_dialog_closed_without_a_wallet_tells_no_one", async () => {
  const tabs = fakeTabs();
  const store = createWalletStore(
    async () => fakeProvider(sessionFor(ALICE), { connect: "closed" }),
    tabs.open,
  );
  await store.start();

  await store.connect();

  expect(store.getSnapshot().accountId).toBeNull();
  expect(tabs.told).toBe(0);
});

test("a_disconnect_tells_the_other_tabs_once_whether_or_not_the_wallet_reports_its_sign_out", async () => {
  for (const reports of [false, true]) {
    const tabs = fakeTabs();
    const provider = fakeProvider(sessionFor(ALICE), { restored: true });
    // near-connect says `wallet:signOut` from inside its disconnect. Another wallet may not.
    if (reports) {
      provider.disconnect = async () => {
        provider.disconnects++;
        provider.signOut();
      };
    }
    const store = createWalletStore(async () => provider, tabs.open);
    await store.start();
    expect(tabs.told).toBe(0);

    await store.disconnect();

    expect(store.getSnapshot().accountId, `reports ${reports}`).toBeNull();
    expect(provider.disconnects, `reports ${reports}`).toBe(1);
    expect(tabs.told, `reports ${reports}`).toBe(1);
  }
});

test("a_wallet_that_signs_itself_out_is_told_to_the_other_tabs", async () => {
  const tabs = fakeTabs();
  const provider = fakeProvider(sessionFor(ALICE), { restored: true });
  const store = createWalletStore(async () => provider, tabs.open);
  await store.start();

  provider.signOut();

  expect(store.getSnapshot().accountId).toBeNull();
  expect(tabs.told).toBe(1);
});

test("a_disconnect_the_wallet_refuses_tells_no_one_because_the_wallet_session_is_still_there", async () => {
  const tabs = fakeTabs();
  const provider = fakeProvider(sessionFor(ALICE), { restored: true });
  const refusal = new WalletError("disconnect", new Error("popup blocked"));
  provider.disconnect = async () => {
    throw refusal;
  };
  const store = createWalletStore(async () => provider, tabs.open);
  await store.start();

  expect(await rejection(store.disconnect())).toBe(refusal);

  expect(store.getSnapshot().accountId).toBe(ALICE);
  expect(tabs.told).toBe(0);
});

test("a_wallet_found_again_after_a_reload_tells_no_one", async () => {
  const tabs = fakeTabs();
  const store = createWalletStore(
    async () => fakeProvider(sessionFor(ALICE), { restored: true }),
    tabs.open,
  );

  await store.start();

  expect(store.getSnapshot().accountId).toBe(ALICE);
  expect(tabs.told).toBe(0);
});

test("a_restore_that_fails_tells_no_one_but_this_tab_goes_on_without_the_token_it_kept", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const tabs = fakeTabs();
  const failure = new Error("the wallet list did not load");
  const slow = slowRestore(sessionFor(ALICE));
  const store = createWalletStore(async () => slow.provider, tabs.open);
  keepToken(tokenFor(ALICE), signInTicket());
  const starting = store.start();
  await eventually(() => expect(slow.asked()).toBe(1));

  slow.failed(failure);
  await starting;

  // The wallet was not looked at, so nothing says the session is over for the other tabs.
  expect(tabs.told).toBe(0);
  expect(log).toHaveBeenCalledWith(failure);
  expect(store.getSnapshot()).toEqual({ ready: true, accountId: null, canSignMessage: false });
  expect(heldToken()).toBeNull();
});

test("a_provider_that_cannot_be_made_tells_no_one_and_this_tab_goes_on_without_the_token", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const tabs = fakeTabs();
  const store = createWalletStore(async () => {
    throw new Error("the wallet library did not load");
  }, tabs.open);
  keepToken(tokenFor(ALICE), signInTicket());

  await store.start();

  expect(tabs.told).toBe(0);
  expect(store.getSnapshot().ready).toBe(true);
  expect(heldToken()).toBeNull();
});

test("a_restore_still_on_its_way_when_the_page_stops_waiting_tells_no_one_and_keeps_the_token", async () => {
  vi.useFakeTimers();
  const tabs = fakeTabs();
  const slow = slowRestore(sessionFor(ALICE));
  const store = createWalletStore(async () => slow.provider, tabs.open);
  keepToken(tokenFor(ALICE), signInTicket());

  const starting = store.start();
  await vi.advanceTimersByTimeAsync(9000);
  await starting;

  expect(store.getSnapshot()).toEqual({ ready: true, accountId: null, canSignMessage: false });
  expect(tabs.told).toBe(0);
  expect(heldToken()?.token).toBe(`tok-${ALICE}`);
  // And the wallet that turns up is no news to the other tabs.
  slow.found(sessionFor(ALICE));
  await vi.advanceTimersByTimeAsync(0);
  expect(store.getSnapshot().accountId).toBe(ALICE);
  expect(tabs.told).toBe(0);
  expect(heldToken()?.token).toBe(`tok-${ALICE}`);
});

// ---- What a store does when another tab tells it -----------------------------------------------

test("a_tab_told_by_another_ends_its_session_and_drops_its_token_without_asking_the_wallet_or_telling_back", async () => {
  const tabs = fakeTabs();
  const provider = fakeProvider(sessionFor(ALICE), { restored: true });
  const store = createWalletStore(async () => provider, tabs.open);
  await store.start();
  keepToken(tokenFor(ALICE), signInTicket());
  const seen: string[] = [];
  store.subscribe(() => seen.push(JSON.stringify(store.getSnapshot())));

  tabs.hear();

  expect(store.getSnapshot()).toEqual({ ready: true, accountId: null, canSignMessage: false });
  expect(seen).toHaveLength(1);
  expect(heldToken()).toBeNull();
  expect(provider.disconnects).toBe(0);
  // Telling back would end the sessions of the tabs that did not need to hear it again.
  expect(tabs.told).toBe(0);
});

test("a_tab_told_before_its_wallet_is_found_drops_the_token_it_kept", async () => {
  vi.useFakeTimers();
  const tabs = fakeTabs();
  const slow = slowRestore(sessionFor(ALICE));
  const store = createWalletStore(async () => slow.provider, tabs.open);
  keepToken(tokenFor(ALICE), signInTicket());
  const starting = store.start();
  await vi.advanceTimersByTimeAsync(9000);
  await starting;
  expect(heldToken()).not.toBeNull();

  tabs.hear();

  expect(heldToken()).toBeNull();
  expect(tabs.told).toBe(0);
});

test("a_tab_that_was_told_can_connect_again_and_then_tells_the_others", async () => {
  const tabs = fakeTabs();
  const provider = fakeProvider(sessionFor(ALICE), { restored: true });
  const store = createWalletStore(async () => provider, tabs.open);
  await store.start();
  tabs.hear();

  await store.connect();

  expect(provider.connects).toBe(1);
  expect(store.getSnapshot().accountId).toBe(ALICE);
  expect(tabs.told).toBe(1);
});

// ---- The tabs, on the real channel -------------------------------------------------------------

/** What a tab of the browser has: its store and its own copy of the token module. */
interface Tab {
  store: ReturnType<typeof createWalletStore>;
  provider: FakeProvider;
  /** What this tab's copy of lib/apiToken.ts holds. */
  token(): StoredToken | null;
  /** The tab has signed in as `accountId`. */
  signIn(accountId: string): void;
}

/**
 * A tab: a store over `provider`, with its line on the real channel, in modules of its own. (The
 * tabs share this test's `sessionStorage`, so a tab's token is read from its module, not from it.)
 */
async function openTab(provider: FakeProvider): Promise<Tab> {
  vi.resetModules();
  const wallet = await import("../lib/wallet");
  const apiToken = await import("../lib/apiToken");
  const tabs = await import("../lib/walletTabs");
  const store = wallet.createWalletStore(
    async () => provider,
    (changed) => {
      const line = tabs.linkTabs(changed);
      lines.push(line);
      return line;
    },
  );
  return {
    store,
    provider,
    token: () => apiToken.heldToken(),
    signIn: (accountId) => {
      apiToken.keepToken(tokenFor(accountId), apiToken.signInTicket());
    },
  };
}

/** A tab that has the wallet connected as Alice and has signed in. */
async function connectedTab(): Promise<Tab> {
  const tab = await openTab(fakeProvider(sessionFor(ALICE)));
  await tab.store.connect();
  tab.signIn(ALICE);
  return tab;
}

/** A tab opened later, which finds the wallet connected as Alice and signs in. */
async function laterTab(): Promise<Tab> {
  const tab = await openTab(fakeProvider(sessionFor(ALICE), { restored: true }));
  await tab.store.start();
  tab.signIn(ALICE);
  expect(tab.store.getSnapshot().accountId).toBe(ALICE);
  return tab;
}

const NO_SESSION = { ready: true, accountId: null, canSignMessage: false };

/** Lets what was posted so far arrive: for what a test expects not to happen. */
const arrive = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

test("a_disconnect_in_one_tab_leaves_the_other_with_no_session_and_no_token", async () => {
  const one = await connectedTab();
  const two = await laterTab();
  expect(two.token()?.token).toBe(`tok-${ALICE}`);

  await one.store.disconnect();

  await eventually(() => expect(two.store.getSnapshot()).toEqual(NO_SESSION));
  expect(two.token()).toBeNull();
  expect(one.token()).toBeNull();
  // Each wallet was asked what its own tab did, and by no one else: the second was never asked.
  expect(one.provider.disconnects).toBe(1);
  expect(two.provider.disconnects).toBe(0);
});

test("a_wallet_that_signs_itself_out_in_one_tab_leaves_the_other_with_no_session_and_no_token", async () => {
  const one = await connectedTab();
  const two = await laterTab();

  one.provider.signOut();

  await eventually(() => expect(two.store.getSnapshot()).toEqual(NO_SESSION));
  expect(two.token()).toBeNull();
  expect(one.store.getSnapshot()).toEqual(NO_SESSION);
  expect(one.token()).toBeNull();
  expect(one.provider.disconnects).toBe(0);
  expect(two.provider.disconnects).toBe(0);
});

for (const accountId of [ALICE, BOB]) {
  test(`a_connect_as_${accountId.split(".")[0]}_in_one_tab_leaves_the_other_with_no_session_and_no_token`, async () => {
    // The first tab has no wallet yet (its Connect button is showing); the second has Alice's.
    const one = await openTab(fakeProvider(sessionFor(accountId)));
    await one.store.start();
    const two = await laterTab();

    await one.store.connect();

    await eventually(() => expect(two.store.getSnapshot()).toEqual(NO_SESSION));
    expect(two.token()).toBeNull();
    expect(two.provider.disconnects).toBe(0);
    expect(two.provider.connects).toBe(0);
    // The tab that connected has the wallet it connected.
    expect(one.store.getSnapshot().accountId).toBe(accountId);
  });
}

test("a_restore_that_finds_no_wallet_leaves_the_session_and_token_of_another_tab_alone", async () => {
  const one = await connectedTab();
  // One more listener on the channel, which keeps everything posted on it.
  const heard: unknown[] = [];
  const watcher = new BroadcastChannel("tender.wallet");
  lines.push(watcher);
  watcher.onmessage = (event) => heard.push(event.data);
  // A tab that loads with the token of the visit before, and finds no wallet.
  const two = await openTab(fakeProvider(sessionFor(ALICE)));
  two.signIn(ALICE);

  await two.store.start();

  // It has no session and no token of its own any more...
  expect(two.store.getSnapshot()).toEqual(NO_SESSION);
  expect(two.token()).toBeNull();
  // ...and told no one: a message posted now arrives after anything it posted on the way.
  const probe = new BroadcastChannel("tender.wallet");
  lines.push(probe);
  probe.postMessage("probe");
  await eventually(() => expect(heard).toContain("probe"));
  await arrive();
  expect(heard).toEqual(["probe"]);
  expect(one.store.getSnapshot().accountId).toBe(ALICE);
  expect(one.token()?.token).toBe(`tok-${ALICE}`);
  expect(one.provider.disconnects).toBe(0);
});

test("a_session_that_ends_is_told_once_and_the_tabs_that_hear_it_do_not_tell_again", async () => {
  const one = await connectedTab();
  const two = await laterTab();
  const three = await laterTab();
  // A listener on the channel, as one more tab, which counts every message.
  const heard: unknown[] = [];
  const channel = new BroadcastChannel("tender.wallet");
  lines.push(channel);
  channel.onmessage = (event) => heard.push(event.data);

  await one.store.disconnect();

  await eventually(() => {
    expect(two.store.getSnapshot()).toEqual(NO_SESSION);
    expect(three.store.getSnapshot()).toEqual(NO_SESSION);
  });
  await arrive();
  expect(heard).toEqual([{ type: "session-changed" }]);

  // Connecting again is not undone by an echo of the first tab's own message either.
  await one.store.connect();
  await eventually(() => expect(heard).toHaveLength(2));
  await arrive();
  expect(heard).toHaveLength(2);
  expect(one.store.getSnapshot().accountId).toBe(ALICE);
});

test("a_tab_that_was_told_asks_nothing_of_its_wallet_and_connects_again_on_its_own", async () => {
  const one = await connectedTab();
  const two = await laterTab();
  await one.store.disconnect();
  await eventually(() => expect(two.store.getSnapshot()).toEqual(NO_SESSION));

  await two.store.connect();

  expect(two.provider.connects).toBe(1);
  expect(two.provider.disconnects).toBe(0);
  expect(two.store.getSnapshot().accountId).toBe(ALICE);
});

test("where_the_browser_has_no_channel_a_tab_still_ends_its_own_session_and_the_others_are_not_reached", async () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  const one = await connectedTab();
  const two = await laterTab();

  await one.store.disconnect();

  expect(one.store.getSnapshot()).toEqual(NO_SESSION);
  expect(one.token()).toBeNull();
  await arrive();
  expect(two.store.getSnapshot().accountId).toBe(ALICE);
  expect(two.token()?.token).toBe(`tok-${ALICE}`);
});
