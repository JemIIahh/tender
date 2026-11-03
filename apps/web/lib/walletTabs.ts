// The wallet store's line to the other tabs of the browser.
//
// A wallet session belongs to the whole browser: near-connect keeps which wallet is connected in
// `localStorage`, which every tab of the site reads. The API token belongs to one tab
// (lib/apiToken.ts), and a tab hears of a sign-out only from its own wallet object. So a
// Disconnect in one tab left the others showing the account, with a token that still worked. This
// is the signal between the tabs: one whose wallet session has ended, or is another one now, says
// so, and each tab that hears it ends its own session and drops its token, without asking the
// wallet again (the first tab did).
//
// The message names no account and carries no token. A `BroadcastChannel` reaches the tabs of this
// site and no one else; where the browser has none, a tab goes on alone and only that tab is
// covered.

/** What the tabs of Tender's site talk on. Near-connect's own keys are not listened to. */
const CHANNEL = "tender.wallet";

/** The one thing a tab says: the wallet session it had is over, or is another one now. */
const SESSION_CHANGED = "session-changed";

/** A tab's line to the others. */
export interface TabLink {
  /** Tells the other tabs that this tab's wallet session ended or changed. */
  tell(): void;
  /** Stops hearing the other tabs. */
  close(): void;
}

/** Opens a link: `onChanged` is called each time another tab says its session changed. */
export type OpenTabLink = (onChanged: () => void) => TabLink;

const alone: TabLink = { tell() {}, close() {} };

/** No line to the other tabs. What a store has unless it is given one. */
export const noTabs: OpenTabLink = () => alone;

function isSessionChanged(data: unknown): boolean {
  return (
    typeof data === "object" && data !== null && "type" in data && data.type === SESSION_CHANGED
  );
}

/**
 * The line to the other tabs over a `BroadcastChannel`. A tab does not hear its own message, so a
 * tab that tells is not told back. A browser with no channel, or one that will not open it, gives a
 * link that tells no one.
 */
export const linkTabs: OpenTabLink = (onChanged) => {
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(CHANNEL);
  } catch {
    // A browser with no channel, or a page it keeps from using one: the tab goes on alone.
    return alone;
  }
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (isSessionChanged(event.data)) onChanged();
  };
  return {
    tell() {
      try {
        channel.postMessage({ type: SESSION_CHANGED });
      } catch {
        // A channel that was closed: nobody is told, and the tab goes on alone.
      }
    },
    close() {
      channel.onmessage = null;
      channel.close();
    },
  };
};
