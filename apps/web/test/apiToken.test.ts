import { afterEach, expect, test } from "vitest";
import {
  clearApiToken,
  heldToken,
  keepToken,
  type StoredToken,
  sessionBegan,
  sessionEnded,
  signInTicket,
  subscribeToken,
} from "../lib/apiToken";

// Whose the API token is and when it goes (lib/apiToken.ts). The wallet store calls `sessionBegan`
// and `sessionEnded` as a wallet session comes and goes (test/token-session.test.tsx has the store
// and the sign-in wired to it); a sign-in takes a ticket when it starts and offers its token with it.

const ALICE = "alice.testnet";
const BOB = "bob.testnet";
const KEY = "tender.apiToken";

const tokenFor = (accountId: string): StoredToken => ({
  accountId,
  token: `tok-${accountId}`,
  expiresAtMs: Date.parse("2099-01-01T00:00:00.000Z"),
});

/** Signs in as `accountId`, as a sign-in that began in the session now under way. */
const signedInAs = (accountId: string) => keepToken(tokenFor(accountId), signInTicket());

const kept = () => [heldToken(), sessionStorage.getItem(KEY)];

afterEach(() => {
  clearApiToken();
  sessionStorage.clear();
});

test("the_end_of_a_session_drops_the_token_from_memory_and_from_the_tab", () => {
  expect(signedInAs(ALICE)).toBe(true);
  expect(heldToken()).toEqual(tokenFor(ALICE));
  expect(JSON.parse(sessionStorage.getItem(KEY) ?? "null")).toEqual(tokenFor(ALICE));

  sessionEnded();

  expect(kept()).toEqual([null, null]);
});

test("a_session_the_person_began_starts_without_a_token_even_as_the_same_account", () => {
  signedInAs(ALICE);

  // A wallet connected again signs in again: the token was of the session before.
  sessionBegan(ALICE, false);
  expect(kept()).toEqual([null, null]);

  signedInAs(ALICE);
  sessionBegan(BOB, false);
  expect(kept()).toEqual([null, null]);
});

test("a_session_taken_up_again_keeps_the_token_of_the_same_account_and_no_other", () => {
  // The wallet of an earlier visit, found again after a reload.
  signedInAs(ALICE);

  sessionBegan(ALICE, true);
  expect(heldToken()).toEqual(tokenFor(ALICE));
  expect(sessionStorage.getItem(KEY)).not.toBeNull();

  sessionBegan(BOB, true);
  expect(kept()).toEqual([null, null]);
});

test("a_token_offered_with_the_ticket_of_a_session_that_is_over_is_not_kept", () => {
  const changes: Array<[string, () => void]> = [
    ["a disconnect", sessionEnded],
    ["a new session", () => sessionBegan(ALICE, false)],
    ["a session taken up again", () => sessionBegan(ALICE, true)],
    ["a token cleared", clearApiToken],
  ];
  for (const [name, change] of changes) {
    const ticket = signInTicket();
    change();

    expect(keepToken(tokenFor(ALICE), ticket), name).toBe(false);

    expect(kept(), name).toEqual([null, null]);
  }
});

test("a_ticket_taken_in_the_session_under_way_is_good_until_that_session_changes", () => {
  const ticket = signInTicket();
  expect(signInTicket()).toBe(ticket);
  expect(keepToken(tokenFor(ALICE), ticket)).toBe(true);
  // The same ticket again: another token of the same sign-in is as good as the first.
  expect(keepToken(tokenFor(ALICE), ticket)).toBe(true);

  sessionEnded();
  expect(keepToken(tokenFor(ALICE), ticket)).toBe(false);
});

test("listeners_hear_when_a_token_is_kept_or_dropped_and_not_of_one_turned_away", () => {
  let heard = 0;
  const stop = subscribeToken(() => heard++);

  signedInAs(ALICE);
  expect(heard).toBe(1);
  sessionEnded();
  expect(heard).toBe(2);

  // A token offered too late is not kept, and nobody is told of it.
  const ticket = signInTicket();
  sessionBegan(ALICE, true);
  expect(keepToken(tokenFor(ALICE), ticket)).toBe(false);
  expect(heard).toBe(2);

  stop();
  signedInAs(ALICE);
  expect(heard).toBe(2);
});
