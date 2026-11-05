import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { Countdown } from "../components/Countdown";
import { PhaseTimeline } from "../components/PhaseTimeline";
import {
  formatDuration,
  formatSpan,
  nsAtScrub,
  phaseAt,
  phaseByClock,
  phaseOfTask,
  RULES,
  SCRUB_MAX,
  scrubOf,
  segments,
} from "../lib/phase";
import { AT, DEADLINES, SECOND, summary } from "./tasks";

// The windows of a seed task: commit 600 s, reveal 300 s, pick 600 s, fallback 600 s, from a
// creation time above 2^53 (see ./tasks.ts), so a Number would get every comparison wrong.

const open = { ...DEADLINES, settled: false };

// ---- The phase rule ---------------------------------------------------------------------------

test("phase_at_boundaries", () => {
  // Each window runs from one deadline up to, but not including, the next: at a deadline the next
  // phase has begun (the contract's rule, which `phaseAt` of @tender/shared is).
  const cases: Array<[string, bigint, string]> = [
    ["a ns before the commit deadline", AT.commit - 1n, "open"],
    ["the commit deadline", AT.commit, "revealing"],
    ["a ns before the reveal deadline", AT.reveal - 1n, "revealing"],
    ["the reveal deadline", AT.reveal, "judging"],
    ["a ns before the pick deadline", AT.pick - 1n, "judging"],
    ["the pick deadline", AT.pick, "fallback"],
    ["a ns before the fallback deadline", AT.fallback - 1n, "fallback"],
    ["the fallback deadline", AT.fallback, "expired"],
    ["long after", AT.fallback + 1_000_000n * SECOND, "expired"],
    ["the moment of creation", AT.created, "open"],
  ];
  for (const [when, now, phase] of cases) {
    expect(phaseAt(open, now), when).toBe(phase);
  }
});

test("phase_at_settled_is_settled_whatever_the_time", () => {
  for (const now of [0n, AT.created, AT.commit, AT.reveal, AT.fallback, AT.fallback + SECOND]) {
    expect(phaseAt({ ...DEADLINES, settled: true }, now)).toBe("settled");
  }
});

test("phase_at_reads_deadlines_above_2_to_the_53_exactly", () => {
  // 2^53 + 1 is not a Number: a comparison that went through one would call these equal.
  const near = { ...open, commit_deadline: "9007199254740993" };
  expect(phaseAt(near, 9007199254740992n)).toBe("open");
  expect(phaseAt(near, 9007199254740993n)).toBe("revealing");
});

test("phase_of_task_is_settled_once_the_task_has_an_outcome", () => {
  // A task row says it has an outcome with `outcome_kind`; the clock no longer matters.
  const picked = summary({ outcome_kind: "picked" });
  const voided = summary({ outcome_kind: "voided" });
  const running = summary();
  expect(phaseOfTask(picked, AT.created)).toBe("settled");
  expect(phaseOfTask(voided, AT.fallback + SECOND)).toBe("settled");
  expect(phaseOfTask(running, AT.reveal)).toBe("judging");
});

test("phase_by_clock_ignores_the_outcome", () => {
  // The what-if scrubber asks what the clock alone would say, for a settled task too.
  const picked = summary({ outcome_kind: "picked" });
  expect(phaseByClock(picked, AT.commit)).toBe("revealing");
  expect(phaseByClock(picked, AT.fallback)).toBe("expired");
});

// ---- The four windows -------------------------------------------------------------------------

test("segments_cover_four_windows", () => {
  const found = segments(summary());

  expect(found.map((s) => s.phase)).toEqual(["open", "revealing", "judging", "fallback"]);
  // They start at creation (not at 0, and not at the commit deadline) and end at the last
  // deadline, with no gap and no overlap between them.
  expect(found[0]?.startNs).toBe(AT.created);
  expect(found.map((s) => s.endNs)).toEqual([AT.commit, AT.reveal, AT.pick, AT.fallback]);
  for (let i = 1; i < found.length; i++) {
    expect(found[i]?.startNs, `segment ${i} starts where the one before ends`).toBe(
      found[i - 1]?.endNs,
    );
  }
  // The durations are the windows: 600, 300, 600 and 600 seconds.
  expect(found.map((s) => (s.endNs - s.startNs) / SECOND)).toEqual([600n, 300n, 600n, 600n]);
});

test("segments_agree_with_the_phase_rule_at_their_edges", () => {
  const task = summary();
  const found = segments(task);
  for (const [i, segment] of found.entries()) {
    expect(phaseByClock(task, segment.startNs), `${segment.phase} at its start`).toBe(
      segment.phase,
    );
    expect(phaseByClock(task, segment.endNs - 1n), `${segment.phase} at its last ns`).toBe(
      segment.phase,
    );
    const next = found[i + 1]?.phase ?? "expired";
    expect(phaseByClock(task, segment.endNs), `the phase after ${segment.phase}`).toBe(next);
  }
});

test("segments_refuse_a_deadline_that_is_no_u64", () => {
  // `BigInt("")` is 0n and `BigInt("1e3")` throws a SyntaxError: neither may stand for a time.
  expect(() => segments(summary({ commit_deadline: "" }))).toThrow(TypeError);
  expect(() => segments(summary({ created_at: "-5" }))).toThrow(TypeError);
});

// ---- Durations --------------------------------------------------------------------------------

test("format_duration_writes_whole_seconds_rounded_up", () => {
  expect(formatDuration(0n)).toBe("0s");
  expect(formatDuration(1n)).toBe("1s");
  expect(formatDuration(SECOND)).toBe("1s");
  expect(formatDuration(SECOND + 1n)).toBe("2s");
  expect(formatDuration(65n * SECOND)).toBe("1m 5s");
  expect(formatDuration(3_600n * SECOND)).toBe("1h 0m 0s");
  expect(formatDuration((2n * 86_400n + 3n * 3_600n + 4n * 60n + 5n) * SECOND)).toBe("2d 3h 4m 5s");
  // A time that has passed is no time left.
  expect(formatDuration(-5n * SECOND)).toBe("0s");
});

test("format_span_writes_a_window_compactly", () => {
  expect(formatSpan(600n * SECOND)).toBe("10m");
  expect(formatSpan(300n * SECOND)).toBe("5m");
  expect(formatSpan(5n * SECOND)).toBe("5s");
  expect(formatSpan(5_400n * SECOND)).toBe("1h 30m");
  expect(formatSpan(86_400n * SECOND)).toBe("1d");
  expect(formatSpan(1_209_600n * SECOND)).toBe("14d");
  expect(formatSpan(0n)).toBe("0s");
});

test("countdown_counts_down_to_the_deadline_and_stops_at_zero", () => {
  const { rerender } = render(<Countdown toNs={AT.commit} nowNs={AT.commit - 125n * SECOND} />);
  const timer = screen.getByRole("timer");
  expect(timer.textContent).toBe("2m 5s");
  expect(timer.getAttribute("datetime")).toBe("PT2M5S");

  rerender(<Countdown toNs={AT.commit} nowNs={AT.commit - SECOND} />);
  expect(screen.getByRole("timer").textContent).toBe("1s");

  rerender(<Countdown toNs={AT.commit} nowNs={AT.commit + 30n * SECOND} />);
  expect(screen.getByRole("timer").textContent).toBe("0s");
});

// ---- The scrubber's map of time ---------------------------------------------------------------

test("scrub_positions_run_over_five_equal_zones", () => {
  const task = summary();
  // Each zone is a fifth of the scale: the four windows, then the time after the last one.
  expect(SCRUB_MAX).toBe(100);
  expect(nsAtScrub(task, 0)).toBe(AT.created);
  expect(nsAtScrub(task, 20)).toBe(AT.commit);
  expect(nsAtScrub(task, 40)).toBe(AT.reveal);
  expect(nsAtScrub(task, 60)).toBe(AT.pick);
  expect(nsAtScrub(task, 80)).toBe(AT.fallback);
  // Inside a zone it is linear in time: half of the 300 s reveal window is 150 s.
  expect(nsAtScrub(task, 30)).toBe(AT.commit + 150n * SECOND);
  // The last zone is as long as the fallback window, and a position past the scale is its end.
  expect(nsAtScrub(task, 100)).toBe(AT.fallback + 600n * SECOND);
  expect(nsAtScrub(task, 500)).toBe(AT.fallback + 600n * SECOND);
  expect(nsAtScrub(task, -5)).toBe(AT.created);
});

test("every_scrub_position_lands_in_its_zones_phase", () => {
  const task = summary();
  const zones = ["open", "revealing", "judging", "fallback", "expired"];
  for (let position = 0; position <= SCRUB_MAX; position++) {
    const zone = Math.min(Math.floor(position / 20), 4);
    expect(phaseByClock(task, nsAtScrub(task, position)), `position ${position}`).toBe(zones[zone]);
  }
});

test("scrub_of_is_where_a_moment_sits_on_the_scale", () => {
  const task = summary();
  expect(scrubOf(task, AT.created - 99n * SECOND)).toBe(0);
  expect(scrubOf(task, AT.created)).toBe(0);
  expect(scrubOf(task, AT.commit)).toBe(20);
  expect(scrubOf(task, AT.commit + 150n * SECOND)).toBe(30);
  expect(scrubOf(task, AT.fallback)).toBe(80);
  expect(scrubOf(task, AT.fallback + 600n * SECOND)).toBe(SCRUB_MAX);
  expect(scrubOf(task, AT.fallback + 99_999n * SECOND)).toBe(SCRUB_MAX);
  // It never puts a moment in a later zone than the clock does: a ns before a deadline is still
  // inside the window it closes.
  expect(scrubOf(task, AT.commit - 1n)).toBeLessThan(20);
  expect(scrubOf(task, AT.reveal - 1n)).toBeLessThan(40);
});

test("scrub_of_undoes_ns_at_scrub", () => {
  const task = summary();
  for (let position = 0; position <= SCRUB_MAX; position++) {
    expect(scrubOf(task, nsAtScrub(task, position)), `position ${position}`).toBe(position);
  }
});

test("scrub_of_is_within_a_step_of_ns_at_scrub_for_any_window", () => {
  // Windows that do not divide by 20: the inverse can be a step short, never a step over.
  const task = summary({
    created_at: "1000000000000000000",
    commit_deadline: "1000000007000000001",
    reveal_deadline: "1000000020123456789",
    pick_deadline: "1000000033333333333",
    fallback_deadline: "1000000047777777777",
  });
  for (let position = 0; position <= SCRUB_MAX; position++) {
    const back = scrubOf(task, nsAtScrub(task, position));
    expect(back, `position ${position}`).toBeLessThanOrEqual(position);
    expect(back, `position ${position}`).toBeGreaterThanOrEqual(position - 1);
  }
});

// ---- The what-if scrubber ---------------------------------------------------------------------

const TIMELINE_TASK = summary();
const scrubber = () => screen.getByRole("slider");
const rule = () => screen.getByTestId("rule").textContent;

/** Moves the slider the way a drag does: a change event with the new position. */
const dragTo = (position: number) =>
  fireEvent.change(scrubber(), { target: { value: String(position) } });

test("scrubber_shows_rule_per_phase", () => {
  render(<PhaseTimeline task={TIMELINE_TASK} nowNs={AT.created + 10n * SECOND} />);

  // Live, the rule is the one of the phase it is now: the commit window.
  expect(rule()).toBe("answers are sealed");

  // One position in each zone, and the rule of the phase the position falls in.
  const expected: Array<[number, string]> = [
    [10, "answers are sealed"],
    [30, "open or forfeit"],
    [50, "checker picks"],
    [70, "poster may pick"],
    [90, "anyone can refund"],
  ];
  for (const [position, headline] of expected) {
    dragTo(position);
    expect(rule(), `position ${position}`).toBe(headline);
  }
});

test("scrubber_rules_are_the_ones_the_plan_names", () => {
  expect(RULES.open.headline).toBe("answers are sealed");
  expect(RULES.revealing.headline).toBe("open or forfeit");
  expect(RULES.judging.headline).toBe("checker picks");
  expect(RULES.fallback.headline).toBe("poster may pick");
  expect(RULES.expired.headline).toBe("anyone can refund");
});

test("scrubber_previews_without_changing_what_is_live", () => {
  const onScrub = vi.fn();
  const now = AT.commit + 100n * SECOND; // live: 100 s into the reveal window, 200 s left
  render(<PhaseTimeline task={TIMELINE_TASK} nowNs={now} onScrub={onScrub} />);
  const live = () => screen.getByTestId("live-status").textContent;

  // Live: the reveal window, counting down the 200 s that are left. Nothing is being previewed.
  expect(rule()).toBe("open or forfeit");
  expect(live()).toContain("3m 20s");
  expect(screen.queryByTestId("preview-status")).toBeNull();
  expect(screen.queryByRole("button", { name: /back to now/i })).toBeNull();

  dragTo(70);

  // Previewing the middle of the fallback window: 600 + 300 + 600 + 300 = 1800 s after posting.
  // The live line has not moved.
  expect(rule()).toBe("poster may pick");
  expect(screen.getByTestId("preview-status").textContent).toMatch(/preview/i);
  expect(screen.getByTestId("preview-status").textContent).toContain("30m 0s after posting");
  expect(onScrub).toHaveBeenLastCalledWith(nsAtScrub(TIMELINE_TASK, 70));
  expect(live()).toContain("3m 20s");
});

test("scrubber_goes_back_to_now", async () => {
  const onScrub = vi.fn();
  render(<PhaseTimeline task={TIMELINE_TASK} nowNs={AT.created + SECOND} onScrub={onScrub} />);

  dragTo(90);
  expect(rule()).toBe("anyone can refund");
  await userEvent.click(screen.getByRole("button", { name: /back to now/i }));

  expect(rule()).toBe("answers are sealed");
  expect(onScrub).toHaveBeenLastCalledWith(null);
  expect(screen.queryByRole("button", { name: /back to now/i })).toBeNull();
});

test("scrubber_follows_the_clock_until_it_is_touched", () => {
  const { rerender } = render(<PhaseTimeline task={TIMELINE_TASK} nowNs={AT.commit - SECOND} />);
  expect((scrubber() as HTMLInputElement).value).toBe("19");

  rerender(<PhaseTimeline task={TIMELINE_TASK} nowNs={AT.commit + 150n * SECOND} />);
  expect((scrubber() as HTMLInputElement).value).toBe("30");
  expect(rule()).toBe("open or forfeit");

  // Once it is dragged the position is the person's, and the clock moving on does not take it back.
  dragTo(5);
  rerender(<PhaseTimeline task={TIMELINE_TASK} nowNs={AT.reveal + 10n * SECOND} />);
  expect((scrubber() as HTMLInputElement).value).toBe("5");
  expect(rule()).toBe("answers are sealed");
});

test("scrubber_marks_the_live_window_and_the_previewed_one", () => {
  render(<PhaseTimeline task={TIMELINE_TASK} nowNs={AT.commit + 10n * SECOND} />);
  const state = (phase: string) =>
    within(screen.getByTestId("phase-timeline"))
      .getAllByTestId("timeline-segment")
      .find((s) => s.getAttribute("data-phase") === phase)
      ?.getAttribute("data-state");

  expect(state("open")).toBe("none");
  expect(state("revealing")).toBe("live");

  dragTo(50);

  expect(state("revealing")).toBe("live");
  expect(state("judging")).toBe("preview");
});

test("timeline_shows_four_windows_and_what_follows_them", () => {
  render(<PhaseTimeline task={TIMELINE_TASK} nowNs={AT.created + SECOND} />);

  const labels = screen.getAllByTestId("timeline-segment").map((s) => s.textContent);
  // The four windows with their lengths, then the time after them.
  expect(labels).toEqual(["Commit10m", "Reveal5m", "Judging10m", "Fallback10m", "Expired"]);
});

test("timeline_counts_down_the_window_that_is_open", () => {
  const cases: Array<[bigint, RegExp]> = [
    [AT.commit - 90n * SECOND, /answer window \(commit\) closes in\s*1m 30s/i],
    [AT.reveal - 45n * SECOND, /opening window \(reveal\) closes in\s*45s/i],
    [AT.pick - 20n * SECOND, /pick window closes in\s*20s/i],
    [AT.fallback - 30n * SECOND, /poster.*closes in\s*30s/i],
  ];
  for (const [now, text] of cases) {
    const { unmount } = render(<PhaseTimeline task={TIMELINE_TASK} nowNs={now} />);
    expect(screen.getByTestId("live-status").textContent, String(now)).toMatch(text);
    unmount();
  }
});

test("timeline_of_an_expired_task_counts_nothing_down", () => {
  render(<PhaseTimeline task={TIMELINE_TASK} nowNs={AT.fallback + 5n * SECOND} />);

  expect(screen.queryByRole("timer")).toBeNull();
  expect(rule()).toBe("anyone can refund");
  expect(screen.getByTestId("live-status").textContent).toMatch(/fallback window has closed/i);
});

test("timeline_of_a_settled_task_says_settled_and_still_previews_the_clock", () => {
  const settled = summary({ outcome_kind: "picked" });
  render(<PhaseTimeline task={settled} nowNs={AT.reveal + 5n * SECOND} />);

  expect(screen.queryByRole("timer")).toBeNull();
  expect(rule()).toBe("settled");
  expect(screen.getByTestId("live-status").textContent).toMatch(/settled/i);
  // No window is the live one.
  const states = screen.getAllByTestId("timeline-segment").map((s) => s.getAttribute("data-state"));
  expect(states.every((state) => state === "none")).toBe(true);

  // The scrubber still answers what the rule was at another moment, and says it is a what-if.
  dragTo(30);
  expect(rule()).toBe("open or forfeit");
  expect(screen.getByTestId("preview-status").textContent).toMatch(/already settled/i);
});

test("scrubber_is_a_slider_a_keyboard_can_use", () => {
  render(<PhaseTimeline task={TIMELINE_TASK} nowNs={AT.created + SECOND} />);

  const slider = scrubber() as HTMLInputElement;
  // A native range input answers the arrow keys, Home, End and Page Up and Down by itself. The
  // e2e spec presses them in Chrome; here: it is one, it has a name, and it says what it is at.
  expect(slider.type).toBe("range");
  expect(slider.min).toBe("0");
  expect(slider.max).toBe(String(SCRUB_MAX));
  expect(slider.step).toBe("1");
  // A zone is twenty presses of an arrow key, and not two hundred.
  expect(SCRUB_MAX / 5).toBe(20);
  expect(slider.disabled).toBe(false);
  expect(slider.tabIndex).toBeGreaterThanOrEqual(0);
  expect(screen.getByLabelText(/preview/i)).toBe(slider);

  dragTo(30);
  const text = slider.getAttribute("aria-valuetext") ?? "";
  expect(text).toMatch(/reveal/i);
  expect(text).toContain("open or forfeit");
});

test("scrubber_text_does_not_change_while_it_follows_the_clock", () => {
  const { rerender } = render(
    <PhaseTimeline task={TIMELINE_TASK} nowNs={AT.commit + 10n * SECOND} />,
  );
  const text = () => scrubber().getAttribute("aria-valuetext");
  const before = text();

  // The clock moves on inside the same window: the thumb may move, and what a screen reader would
  // say about it must not, or it says it every second.
  rerender(<PhaseTimeline task={TIMELINE_TASK} nowNs={AT.commit + 11n * SECOND} />);
  rerender(<PhaseTimeline task={TIMELINE_TASK} nowNs={AT.commit + 42n * SECOND} />);

  expect(text()).toBe(before);
  expect(before).toBe("Now, reveal window: open or forfeit");
  expect(before).not.toMatch(/after posting/);
});

test("scrubber_text_says_how_long_after_posting_once_a_moment_is_previewed", () => {
  render(<PhaseTimeline task={TIMELINE_TASK} nowNs={AT.commit + 10n * SECOND} />);

  // The middle of the fallback window, which the person chose, so the text can be exact.
  dragTo(70);

  expect(scrubber().getAttribute("aria-valuetext")).toBe(
    "Preview, fallback window, 30m 0s after posting: poster may pick",
  );
});
