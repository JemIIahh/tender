import { expect, test } from "vitest";
import { briefly, deadlineLine, featuredTaskId, roughly } from "../lib/card";
import { AT, SECOND, summary } from "./tasks";

// What a card on the board says beside its phase, and which card is the featured one (lib/card.ts).

const MINUTE = 60n * SECOND;

test("roughly_says_a_time_left_to_the_minute", () => {
  expect(roughly(0n)).toBe("under a minute");
  expect(roughly(59n * SECOND)).toBe("under a minute");
  expect(roughly(7n * MINUTE + 58n * SECOND)).toBe("7m");
  expect(roughly(60n * MINUTE)).toBe("1h");
  expect(roughly(90n * MINUTE)).toBe("1h 30m");
  expect(roughly(24n * 60n * MINUTE)).toBe("1d");
  expect(roughly(26n * 60n * MINUTE + 5n * MINUTE)).toBe("1d 2h");
});

test("deadline_line_names_the_window_that_closes_next", () => {
  const task = summary();
  // The seed windows (test/tasks.ts): commit 10m, reveal 5m, pick 10m, fallback 10m.
  expect(deadlineLine(task, AT.created + 2n * MINUTE)).toBe("Entries close in 8m");
  expect(deadlineLine(task, AT.commit + MINUTE)).toBe("Reveals close in 4m");
  expect(deadlineLine(task, AT.reveal + 30n * SECOND)).toBe("Pick due in 9m");
  expect(deadlineLine(task, AT.pick)).toBe("Poster's pick due in 10m");
  expect(deadlineLine(task, AT.fallback + SECOND)).toBe("Anyone can refund");
});

test("briefly_says_a_time_left_in_one_unit_and_never_more_than_there_is", () => {
  const HOUR = 60n * MINUTE;
  expect(briefly(0n)).toBe("under a minute");
  expect(briefly(59n * MINUTE + 59n * SECOND)).toBe("59m");
  expect(briefly(HOUR)).toBe("1h");
  expect(briefly(5n * HOUR + 59n * MINUTE)).toBe("5h");
  // Under two days, in hours: "1d" for 47 hours would be a day short.
  expect(briefly(47n * HOUR + 59n * MINUTE)).toBe("47h");
  expect(briefly(48n * HOUR)).toBe("2d");
  expect(briefly(4n * 24n * HOUR + 23n * HOUR)).toBe("4d");
});

test("deadline_line_in_short_is_the_board_card_s_wording", () => {
  const task = summary();
  expect(deadlineLine(task, AT.created + 2n * MINUTE, true)).toBe("Ends in 8m");
  expect(deadlineLine(task, AT.commit + MINUTE, true)).toBe("Reveals end in 4m");
  expect(deadlineLine(task, AT.reveal + 30n * SECOND, true)).toBe("Pick due in 9m");
  expect(deadlineLine(task, AT.pick, true)).toBe("Poster's pick due in 10m");
  expect(deadlineLine(task, AT.fallback + SECOND, true)).toBe("Anyone can refund");
});

test("deadline_line_says_how_a_settled_task_ended", () => {
  const now = AT.created + MINUTE;
  expect(deadlineLine(summary({ outcome_kind: "picked" }), now)).toBe("Paid out");
  expect(deadlineLine(summary({ outcome_kind: "voided" }), now)).toBe("Refunded");
});

test("featured_task_is_the_largest_dollar_reward_among_the_open_tasks", () => {
  const now = AT.created + MINUTE;
  const tasks = [
    summary({ id: "1", reward: "500000" }),
    summary({ id: "2", reward: "2000000" }),
    summary({ id: "3", reward: "2000000" }),
    // Not open any more: it has an outcome.
    summary({ id: "4", reward: "9000000", outcome_kind: "picked" }),
    // A token without known decimals is not compared with dollars, however large its number.
    summary({ id: "5", reward: "340282366920938463463374607431768211455", token: "odd.testnet" }),
  ];
  // The first of equals.
  expect(featuredTaskId(tasks, now, "testnet")).toBe("2");
  // Past the commit window nothing is open, and nothing is featured.
  expect(featuredTaskId(tasks, AT.commit + SECOND, "testnet")).toBeNull();
  expect(featuredTaskId([tasks[4] ?? summary()], now, "testnet")).toBeNull();
  expect(featuredTaskId([], now, "testnet")).toBeNull();
  // One open task is no top of anything: two are needed for a featured card.
  expect(featuredTaskId([tasks[1] ?? summary()], now, "testnet")).toBeNull();
  expect(featuredTaskId([tasks[1] ?? summary(), tasks[3] ?? summary()], now, "testnet")).toBeNull();
});
