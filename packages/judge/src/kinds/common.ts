import type { HeldoutChecks, PublicCriteria } from "@tender/shared";
import type { EntryScore } from "../types";

/**
 * The held-out part of the criteria of kind `K`. `HeldoutChecks` is a union, so
 * `HeldoutChecks[K]` does not compile: pick the member first.
 */
export type HeldoutOf<K extends string> = Extract<HeldoutChecks, Record<K, unknown>>[K];

/**
 * The text of `content`, or `null` when it is not valid UTF-8. Bad bytes are not repaired into
 * U+FFFD, which an answer could be spelled with. A leading byte order mark is dropped, as
 * `TextDecoder` does by default.
 */
export function decodeUtf8(content: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

/** An entry's score with the reasons for it, and whether it reaches the criteria's pass mark. */
export function scored(
  c: Pick<PublicCriteria, "min_score">,
  score: number,
  reasons: string[],
): EntryScore {
  return { score, passed: score >= c.min_score, reasons };
}

/** A score of 0 that does not pass, whatever the pass mark: it cannot be paid. */
export function zero(reason: string): EntryScore {
  return { score: 0, passed: false, reasons: [reason] };
}
