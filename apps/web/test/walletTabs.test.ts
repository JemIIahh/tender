import { afterEach, expect, test, vi } from "vitest";
import { linkTabs, noTabs, type TabLink } from "../lib/walletTabs";

// The line between the tabs of a browser (lib/walletTabs.ts), on real channels: the test runs in
// jsdom on Node's own BroadcastChannel, and a channel does not hear the message it posted, as in a
// browser. The store's use of the line is in tabs.test.ts.

const open: Array<{ close(): void }> = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const channel of open.splice(0)) channel.close();
});

function link(onChanged: () => void = () => {}): TabLink {
  const made = linkTabs(onChanged);
  open.push(made);
  return made;
}

/** A channel of the site that only listens, as a tab of some other version of the page would. */
function listener(name = "tender.wallet"): unknown[] {
  const channel = new BroadcastChannel(name);
  open.push(channel);
  const heard: unknown[] = [];
  channel.onmessage = (event) => heard.push(event.data);
  return heard;
}

/** Waits for what a message should bring about, on a machine that may be busy. */
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 5000, interval: 10 });

/** Lets what was posted so far arrive: for what a test expects not to happen. */
const arrive = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

test("a_tab_tells_the_others_on_the_wallet_channel_with_a_message_that_names_no_one", async () => {
  const heard = listener();
  const elsewhere = listener("selected-wallet");

  link().tell();

  await eventually(() => expect(heard).toHaveLength(1));
  // The one thing it says, and nothing a tab could use: no account, no token.
  expect(heard[0]).toEqual({ type: "session-changed" });
  expect(Object.keys(heard[0] as object)).toEqual(["type"]);
  expect(JSON.stringify(heard[0])).not.toMatch(/token|account|testnet|near/i);
  // Near-connect's own key is not a channel this app talks on.
  await arrive();
  expect(elsewhere).toEqual([]);
});

test("a_tab_hears_the_others_and_not_itself", async () => {
  const first = vi.fn();
  const second = vi.fn();
  const a = link(first);
  link(second);

  a.tell();

  await eventually(() => expect(second).toHaveBeenCalledTimes(1));
  await arrive();
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledTimes(1);
});

test("anything_else_on_the_channel_is_ignored", async () => {
  const changed = vi.fn();
  link(changed);
  const raw = new BroadcastChannel("tender.wallet");
  open.push(raw);

  // Not the message, however close: a string, nothing, a number, a list, an empty object, another
  // type, the right word under another key. The message itself follows, in order after them.
  for (const other of [
    "session-changed",
    null,
    7,
    [],
    {},
    { type: "other" },
    { kind: "session-changed" },
  ]) {
    raw.postMessage(other);
  }
  raw.postMessage({ type: "session-changed" });

  await eventually(() => expect(changed).toHaveBeenCalled());
  await arrive();
  expect(changed).toHaveBeenCalledTimes(1);
});

test("a_link_that_is_closed_hears_nothing_and_telling_from_it_is_not_an_error", async () => {
  const closedHears = vi.fn();
  const closed = link(closedHears);
  closed.close();
  const openHears = vi.fn();
  link(openHears);

  link().tell();

  // The link that is open is told; the one that was closed is not.
  await eventually(() => expect(openHears).toHaveBeenCalledTimes(1));
  await arrive();
  expect(closedHears).not.toHaveBeenCalled();
  expect(() => closed.tell()).not.toThrow();
});

test("where_the_browser_has_no_channel_a_tab_goes_on_alone", () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  const changed = vi.fn();

  for (const lonely of [linkTabs(changed), noTabs(changed)]) {
    expect(() => {
      lonely.tell();
      lonely.close();
    }).not.toThrow();
  }

  expect(changed).not.toHaveBeenCalled();
});

test("a_channel_the_browser_will_not_open_is_no_channel", () => {
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      constructor() {
        throw new DOMException("not allowed here", "SecurityError");
      }
    },
  );

  const lonely = linkTabs(vi.fn());

  expect(() => {
    lonely.tell();
    lonely.close();
  }).not.toThrow();
});
