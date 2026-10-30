/**
 * Answers that are not scores, which the rogue worker sends for `rogue:malformed:{n}`. Each is
 * checked against criteria with a pass mark of 100.
 */
export const MALFORMED: unknown[] = [
  { score: 101, passed: true, reasons: [] },
  { score: 99.5, passed: false, reasons: [] },
  { score: -1, passed: false, reasons: [] },
  { score: "100", passed: true, reasons: [] },
  // A pass that the pass mark does not give.
  { score: 50, passed: true, reasons: [] },
  { score: 100, passed: true, reasons: [], note: "one field more" },
  { score: 100, passed: true },
  { score: 0, passed: false, reasons: ["fine", 7] },
  // A hole, which is no reason.
  { score: 0, passed: false, reasons: new Array(1) },
  "ready",
  null,
  [100, true, []],
];
