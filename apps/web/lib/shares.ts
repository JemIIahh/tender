import { PICK_BPS_WHOLE } from "@tender/shared";
import { formatBps } from "./bps";

// The winners' shares of a pick, as the page asks for them: in percent, to two decimal places,
// which is one basis point. The contract takes the shares in basis points and only when they add
// up to exactly 10,000, so the page never rounds a share behind the person's back: a split that
// does not come out even says where the odd basis points go, and shares that do not add up are
// refused with what is missing or over.

/**
 * `count` equal shares of 10,000 basis points. When 10,000 does not divide by `count`, the first
 * shares take one more each until the total is exact: 3 winners are 33.34%, 33.33% and 33.33%.
 */
export function equalShares(count: number): number[] {
  if (!Number.isInteger(count) || count < 1) return [];
  const base = Math.floor(PICK_BPS_WHOLE / count);
  const left = PICK_BPS_WHOLE - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < left ? 1 : 0));
}

/**
 * What an equal split rounds, in words, or null when it comes out even: `10,000 basis points don't
 * divide by 3, so the first winner gets 0.01% more.`
 */
export function equalSplitNote(count: number): string | null {
  const left = PICK_BPS_WHOLE % count;
  if (count < 2 || left === 0) return null;
  const who = left === 1 ? "the first winner gets" : `the first ${left} winners get`;
  return `100% doesn't split evenly ${count} ways, so ${who} 0.01% more.`;
}

export type ShareReading = { ok: true; bps: number } | { ok: false; message: string };

/**
 * A share a person typed, in percent: more than 0, at most 100, and at most two decimal places, as
 * `33.34`. A `%` at the end is allowed. A refusal says what to change.
 */
export function readShare(text: string): ShareReading {
  const typed = text.trim().replace(/%$/, "").trim();
  if (typed === "") return { ok: false, message: "Enter a share." };
  const match = /^(\d{1,3})(?:\.(\d{0,2}))?$/.exec(typed);
  if (match === null) {
    return /^\d*\.\d{3,}$/.test(typed)
      ? { ok: false, message: "Use at most two decimal places." }
      : { ok: false, message: "Use a number, like 50 or 33.34." };
  }
  const bps = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (bps === 0) return { ok: false, message: "A share must be more than 0%." };
  if (bps > PICK_BPS_WHOLE) return { ok: false, message: "A share can't be more than 100%." };
  return { ok: true, bps };
}

/** A share as the field shows it: `33.34`, `50`. */
export function shareText(bps: number): string {
  return formatBps(bps).replace(/%$/, "");
}

/**
 * Where the shares stand: their total in basis points, and whether it is exactly 10,000. The
 * `message` says what is missing or over, in percent, when it is not.
 */
export function shareTotal(bps: readonly number[]): {
  total: number;
  ok: boolean;
  message: string | null;
} {
  const total = bps.reduce((sum, share) => sum + share, 0);
  if (total === PICK_BPS_WHOLE) return { total, ok: true, message: null };
  const gap = Math.abs(PICK_BPS_WHOLE - total);
  return {
    total,
    ok: false,
    message:
      total < PICK_BPS_WHOLE
        ? `The shares add up to ${formatBps(total)}: ${formatBps(gap)} is left to give.`
        : `The shares add up to ${formatBps(total)}: ${formatBps(gap)} too much.`,
  };
}
