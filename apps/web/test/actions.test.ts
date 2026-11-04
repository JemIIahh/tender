import { expect, test } from "vitest";
import { anchorOf, canRefund, pickView, refundView, topUpOpen } from "../lib/actions";
import { AT, detail, POSTER, SECOND } from "./tasks";

// Who sees which action on a task's page, by the contract's rules: the verifier picks in its
// window, the poster in the fallback window after it, the Judge's window shows its state and no
// controls, anyone refunds once `void_task` would go through, and anyone tops up until the commit
// deadline.

const JUDGE = "judge.tender-team.testnet";
const PERSON = "person.testnet";
const STRANGER = "stranger.testnet";

/** The task of the fixtures, with its verifier and its reveal count set. */
function task(verifier: string, revealCount = 1, overrides = {}) {
  return { ...detail().task, verifier, reveal_count: revealCount, ...overrides };
}

/** A moment inside each phase of the fixtures' task. */
const IN = {
  open: AT.created + 30n * SECOND,
  revealing: AT.commit + 30n * SECOND,
  judging: AT.reveal + 30n * SECOND,
  fallback: AT.pick + 30n * SECOND,
  expired: AT.fallback + 30n * SECOND,
};

test("the_verifier_picks_in_judging_and_the_poster_in_fallback", () => {
  const byPerson = task(PERSON);
  // The verifier's window: the verifier gets the controls, nobody else does.
  expect(pickView(byPerson, PERSON, JUDGE, IN.judging)).toEqual({ kind: "pick", as: "verifier" });
  expect(pickView(byPerson, POSTER, JUDGE, IN.judging)).toBeNull();
  expect(pickView(byPerson, STRANGER, JUDGE, IN.judging)).toBeNull();
  // Nobody connected: the page says whose window it is.
  expect(pickView(byPerson, null, JUDGE, IN.judging)).toEqual({ kind: "connect", account: PERSON });
  // The fallback window is the poster's, the verifier's is over.
  expect(pickView(byPerson, POSTER, JUDGE, IN.fallback)).toEqual({ kind: "pick", as: "poster" });
  expect(pickView(byPerson, PERSON, JUDGE, IN.fallback)).toBeNull();
  expect(pickView(byPerson, null, JUDGE, IN.fallback)).toEqual({
    kind: "connect",
    account: POSTER,
  });
  // Before the reveal deadline and after the fallback deadline, nobody picks.
  for (const at of [IN.open, IN.revealing, IN.expired]) {
    for (const who of [PERSON, POSTER, null]) expect(pickView(byPerson, who, JUDGE, at)).toBeNull();
  }
  // A settled task is not picked again.
  const settled = { ...byPerson, outcome_kind: "picked" as const };
  expect(pickView(settled, PERSON, JUDGE, IN.judging)).toBeNull();
});

test("a_poster_who_is_the_verifier_picks_in_both_windows", () => {
  const own = task(POSTER);
  expect(pickView(own, POSTER, JUDGE, IN.judging)).toEqual({ kind: "pick", as: "verifier" });
  expect(pickView(own, POSTER, JUDGE, IN.fallback)).toEqual({ kind: "pick", as: "poster" });
});

test("the_judges_window_shows_its_state_to_everyone_and_no_controls", () => {
  const judged = task(JUDGE);
  for (const who of [JUDGE, POSTER, STRANGER, null]) {
    expect(pickView(judged, who, JUDGE, IN.judging)).toEqual({ kind: "judge" });
  }
  // The Judge did not pick in time: the poster may.
  expect(pickView(judged, POSTER, JUDGE, IN.fallback)).toEqual({ kind: "pick", as: "poster" });
  // A build that does not know the Judge's account treats it as any verifier.
  expect(pickView(judged, JUDGE, null, IN.judging)).toEqual({ kind: "pick", as: "verifier" });
});

test("refund_opens_at_the_reveal_deadline_when_nothing_was_revealed", () => {
  const empty = task(PERSON, 0);
  expect(canRefund(empty, AT.reveal - 1n)).toBe(false);
  expect(canRefund(empty, AT.reveal)).toBe(true);
  expect(refundView(empty, AT.reveal - 1n)).toEqual({
    kind: "opens",
    atNs: AT.reveal,
    ifNothingRevealed: true,
  });
  expect(refundView(empty, AT.reveal)).toEqual({ kind: "open" });
  // It stays open through the windows after it.
  expect(refundView(empty, IN.fallback)).toEqual({ kind: "open" });
  expect(refundView(empty, IN.expired)).toEqual({ kind: "open" });
});

test("refund_opens_at_the_fallback_deadline_once_something_was_revealed", () => {
  const entered = task(PERSON, 2);
  expect(canRefund(entered, AT.reveal)).toBe(false);
  expect(canRefund(entered, AT.fallback - 1n)).toBe(false);
  expect(canRefund(entered, AT.fallback)).toBe(true);
  expect(refundView(entered, IN.judging)).toEqual({
    kind: "opens",
    atNs: AT.fallback,
    ifNothingRevealed: false,
  });
  expect(refundView(entered, AT.fallback - 1n)).toMatchObject({ kind: "opens" });
  expect(refundView(entered, AT.fallback)).toEqual({ kind: "open" });
});

test("refund_shows_nothing_in_the_commit_window_or_once_settled", () => {
  expect(refundView(task(PERSON, 0), IN.open)).toBeNull();
  expect(refundView(task(PERSON, 0), AT.commit - 1n)).toBeNull();
  // From the commit deadline, the page says when a refund opens.
  expect(refundView(task(PERSON, 0), AT.commit)).toMatchObject({ kind: "opens" });
  const voided = task(PERSON, 0, { outcome_kind: "voided" });
  expect(canRefund(voided, IN.expired)).toBe(false);
  expect(refundView(voided, IN.expired)).toBeNull();
});

test("top_up_is_open_until_the_commit_deadline", () => {
  const open = task(PERSON);
  expect(topUpOpen(open, IN.open)).toBe(true);
  expect(topUpOpen(open, AT.commit - 1n)).toBe(true);
  expect(topUpOpen(open, AT.commit)).toBe(false);
  expect(topUpOpen(open, IN.judging)).toBe(false);
  expect(topUpOpen({ ...open, outcome_kind: "voided" as const }, IN.open)).toBe(false);
});

test("an_address_names_an_action_by_its_anchor", () => {
  expect(anchorOf("#pick")).toBe("pick");
  expect(anchorOf("#refund")).toBe("refund");
  expect(anchorOf("#top-up")).toBe("top-up");
  expect(anchorOf("top-up")).toBe("top-up");
  for (const other of ["", "#", "#questions", "#Pick", "#top_up"])
    expect(anchorOf(other)).toBeNull();
});
