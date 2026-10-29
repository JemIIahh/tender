import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { type Phase, phaseAt, phaseOfTaskView, type TaskView, TaskViewSchema } from "../src/index";

const FIXTURES = new URL("./fixtures/", import.meta.url);

/** The real `get_task` sample, captured from the contract's wasm. It is settled by a `pick`. */
const real: TaskView = TaskViewSchema.parse(
  JSON.parse(readFileSync(new URL("task_view.json", FIXTURES), "utf8")),
);

const U64_MAX = 2n ** 64n - 1n;

/** The real sample's four deadlines, 120 seconds apart, in nanoseconds. */
const commitAt = BigInt(real.commit_deadline);
const revealAt = BigInt(real.reveal_deadline);
const pickAt = BigInt(real.pick_deadline);
const fallbackAt = BigInt(real.fallback_deadline);

/** An unsettled task with the real sample's deadlines. */
const windows = {
  commit_deadline: real.commit_deadline,
  reveal_deadline: real.reveal_deadline,
  pick_deadline: real.pick_deadline,
  fallback_deadline: real.fallback_deadline,
  settled: false,
};

// For each deadline: the phase just before it, and the phase from it on. These are written out by
// hand from `phase` in contract/tender/src/tasks.rs, not worked out with `phaseAt`.
const edges = [
  ["commit_deadline", "open", "revealing"],
  ["reveal_deadline", "revealing", "judging"],
  ["pick_deadline", "judging", "fallback"],
  ["fallback_deadline", "fallback", "expired"],
] as const;

test("phase_windows_are_half_open_at_every_deadline", () => {
  for (const [field, before, from] of edges) {
    const deadline = BigInt(windows[field]);
    expect(phaseAt(windows, deadline - 1n), `${field} - 1`).toBe(before);
    expect(phaseAt(windows, deadline), field).toBe(from);
    expect(phaseAt(windows, deadline + 1n), `${field} + 1`).toBe(from);
  }
});

test("phase_covers_the_whole_timeline", () => {
  // The task's first and last moments, and the middle of each window.
  const mid = (a: bigint, b: bigint) => a + (b - a) / 2n;
  expect(phaseAt(windows, 0n)).toBe("open");
  expect(phaseAt(windows, mid(0n, commitAt))).toBe("open");
  expect(phaseAt(windows, mid(commitAt, revealAt))).toBe("revealing");
  expect(phaseAt(windows, mid(revealAt, pickAt))).toBe("judging");
  expect(phaseAt(windows, mid(pickAt, fallbackAt))).toBe("fallback");
  expect(phaseAt(windows, mid(fallbackAt, U64_MAX))).toBe("expired");
  expect(phaseAt(windows, U64_MAX)).toBe("expired");
});

test("settled_overrides_time", () => {
  const settled = { ...windows, settled: true };
  const moments = [
    0n,
    commitAt - 1n,
    commitAt,
    revealAt,
    pickAt,
    fallbackAt - 1n,
    fallbackAt,
    fallbackAt + 1n,
    U64_MAX,
  ];
  for (const now of moments) {
    expect(phaseAt(settled, now), `now = ${now}`).toBe("settled");
  }
});

test("phase_at_deadlines_near_u64_max", () => {
  const late = {
    commit_deadline: (U64_MAX - 3n).toString(),
    reveal_deadline: (U64_MAX - 2n).toString(),
    pick_deadline: (U64_MAX - 1n).toString(),
    fallback_deadline: U64_MAX.toString(),
    settled: false,
  };
  const rows: [bigint, Phase][] = [
    [0n, "open"],
    [U64_MAX - 4n, "open"],
    [U64_MAX - 3n, "revealing"],
    [U64_MAX - 2n, "judging"],
    [U64_MAX - 1n, "fallback"],
    [U64_MAX, "expired"],
  ];
  for (const [now, phase] of rows) {
    expect(phaseAt(late, now), `now = ${now}`).toBe(phase);
  }
  expect(phaseAt({ ...late, settled: true }, U64_MAX)).toBe("settled");
});

test("phase_compares_bigints_not_numbers", () => {
  // Above 2^53 a Number skips every other integer, so 2^53 + 1 reads as 2^53, and a task would
  // leave `open` a nanosecond early. The deadlines below are 2 apart and `now` steps by 1.
  const base = 2n ** 53n;
  expect(Number(base + 1n)).toBe(Number(base));
  const t = {
    commit_deadline: (base + 1n).toString(),
    reveal_deadline: (base + 3n).toString(),
    pick_deadline: (base + 5n).toString(),
    fallback_deadline: (base + 7n).toString(),
    settled: false,
  };
  const rows: [bigint, Phase][] = [
    [base, "open"],
    [base + 1n, "revealing"],
    [base + 2n, "revealing"],
    [base + 3n, "judging"],
    [base + 4n, "judging"],
    [base + 5n, "fallback"],
    [base + 6n, "fallback"],
    [base + 7n, "expired"],
  ];
  for (const [now, phase] of rows) {
    expect(phaseAt(t, now), `now = 2^53 + ${now - base}`).toBe(phase);
  }
});

test("phase_rejects_a_deadline_that_is_not_a_u64_string", () => {
  // `BigInt` alone reads "" as 0n and " 7 " as 7n, which would be a wrong phase, not an error.
  const arabicIndicThree = String.fromCodePoint(0x0663);
  const bad = ["", " 7", "7 ", "-1", "+1", "1.5", "1e18", "0x10", "007", "abc", arabicIndicThree];
  bad.push((U64_MAX + 1n).toString());
  for (const field of Object.keys(windows).filter((key) => key !== "settled")) {
    for (const value of bad) {
      const label = `${field} = ${JSON.stringify(value)}`;
      expect(() => phaseAt({ ...windows, [field]: value }, 0n), label).toThrow(
        `${field} must be a u64 as a decimal string`,
      );
      // Checked whether or not the task is settled, so a bad row shows up the first time it is read.
      expect(() => phaseAt({ ...windows, settled: true, [field]: value }, 0n), label).toThrow(
        TypeError,
      );
    }
  }
  // A JS number has already lost digits by the time it gets here.
  const number = Number(commitAt) as unknown as string;
  expect(() => phaseAt({ ...windows, commit_deadline: number }, 0n)).toThrow(TypeError);
});

test("phase_matches_a_counting_reference_on_small_numbers", () => {
  // Every four non-decreasing deadlines from 0 to 4 (equal deadlines make an empty window), at
  // every time from 0 to 5. The reference counts the deadlines at or before `now`: that many
  // windows are over, which is the index of the phase `now` is in.
  const phases: Phase[] = ["open", "revealing", "judging", "fallback", "expired"];
  let checked = 0;
  for (let a = 0; a <= 4; a++) {
    for (let b = a; b <= 4; b++) {
      for (let c = b; c <= 4; c++) {
        for (let d = c; d <= 4; d++) {
          const t = {
            commit_deadline: String(a),
            reveal_deadline: String(b),
            pick_deadline: String(c),
            fallback_deadline: String(d),
            settled: false,
          };
          for (let now = 0; now <= 5; now++) {
            const over = [a, b, c, d].filter((deadline) => deadline <= now).length;
            expect(phaseAt(t, BigInt(now)), `[${a},${b},${c},${d}] at ${now}`).toBe(phases[over]);
            checked++;
          }
        }
      }
    }
  }
  expect(checked).toBe(70 * 6);
});

// ---------------------------------------------------------------------------------------------
// phaseOfTaskView
// ---------------------------------------------------------------------------------------------

test("phase_of_task_view_matches_the_real_task_view", () => {
  // The sample is settled by a pick, and the contract reports "settled" for it at any block time.
  expect(real.outcome?.kind).toBe("picked");
  expect(real.phase).toBe("settled");
  // Moments from the pick window onward are the ones the sample can have been served at; the
  // earlier ones show that the outcome, not the clock, decides.
  const moments: [string, bigint][] = [
    ["created_at", BigInt(real.created_at)],
    ["just before commit_deadline", commitAt - 1n],
    ["pick window", pickAt - 1n],
    ["at pick_deadline", pickAt],
    ["fallback window", fallbackAt - 1n],
    ["at fallback_deadline", fallbackAt],
    ["long after", U64_MAX],
  ];
  for (const [label, now] of moments) {
    expect(phaseOfTaskView(real, now), label).toBe(real.phase);
  }
});

test("phase_of_task_view_matches_an_unsettled_task_derived", () => {
  // Derived: the real task as it looked before any pick, with `outcome` null. Its `phase` is what
  // the contract's rule gives at each moment, written out by hand from tasks.rs.
  const rows: [string, bigint, Phase][] = [
    ["created_at", BigInt(real.created_at), "open"],
    ["just before commit_deadline", commitAt - 1n, "open"],
    ["at commit_deadline", commitAt, "revealing"],
    ["just before reveal_deadline", revealAt - 1n, "revealing"],
    ["at reveal_deadline", revealAt, "judging"],
    ["just before pick_deadline", pickAt - 1n, "judging"],
    ["at pick_deadline", pickAt, "fallback"],
    ["just before fallback_deadline", fallbackAt - 1n, "fallback"],
    ["at fallback_deadline", fallbackAt, "expired"],
    ["long after", U64_MAX, "expired"],
  ];
  for (const [label, now, phase] of rows) {
    const derived: TaskView = { ...real, outcome: null, phase };
    expect(phaseOfTaskView(derived, now), label).toBe(derived.phase);
  }
});

test("phase_of_task_view_reads_settled_from_the_outcome_derived", () => {
  const early = commitAt - 1n;
  // The real task has an outcome, so it is settled even before its first deadline.
  expect(phaseOfTaskView(real, early)).toBe("settled");
  // Derived: the real task with no outcome. The clock decides, and it says open.
  expect(phaseOfTaskView({ ...real, outcome: null, phase: "open" }, early)).toBe("open");
  // Derived: a voided task has an outcome too.
  const voided: TaskView = {
    ...real,
    outcome: { kind: "voided", reason: "expired", scorecard_hash: null, scorecard_uri: null },
    phase: "settled",
  };
  expect(phaseOfTaskView(voided, early)).toBe("settled");
});

test("phase_of_task_view_ignores_the_stale_phase_field_derived", () => {
  // Derived: the real task as a view served while it was open. The field is a snapshot from that
  // block; the phase now comes from the clock.
  const served: TaskView = { ...real, outcome: null, phase: "open" };
  expect(phaseOfTaskView(served, commitAt - 1n)).toBe("open");
  expect(phaseOfTaskView(served, revealAt)).toBe("judging");
  expect(phaseOfTaskView(served, fallbackAt)).toBe("expired");

  // Derived, and never what the contract sends: a `phase` that disagrees with `outcome`. Only the
  // outcome settles a task, so the field is ignored in both directions.
  const early = commitAt - 1n;
  expect(phaseOfTaskView({ ...real, outcome: null, phase: "settled" }, early)).toBe("open");
  expect(phaseOfTaskView({ ...real, phase: "open" }, fallbackAt)).toBe("settled");
});
