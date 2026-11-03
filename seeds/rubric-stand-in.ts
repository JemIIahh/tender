import { criterionKey } from "@tender/shared";
import { completion, criteriaOf, entryOf, type LlmHandler } from "../packages/judge/test/fake-llm";

// The rubric seeds have no held-out checks and no key: a model scores them. The tests never call a
// model, so each rubric criterion gets a stand-in here: a few plain checks on the text of an entry
// (a figure it must give, a word it must not use, a limit on its length) that a person could make
// with a pencil. The fake model server below grades by them. That shows what a test can show:
//
// - the seed's rubric is one the Judge accepts and the solution is a way to meet it;
// - the solution and the weak answer differ on the points the rubric names, so the rubric tells a
//   good entry from a poor one at all;
// - every criterion is written down as something that can be met or missed.
//
// It does not show that a real model grades the same way, and no claim here rests on it.

/** One thing that a criterion asks of an entry, as a check on its text. */
export type Check = (entry: string) => boolean;

const has =
  (pattern: RegExp): Check =>
  (entry) =>
    pattern.test(entry);
const lacks =
  (pattern: RegExp): Check =>
  (entry) =>
    !pattern.test(entry);

const wordCount = (text: string): number => text.split(/\s+/).filter((word) => word !== "").length;
const atMostWords =
  (limit: number): Check =>
  (entry) =>
    wordCount(entry) <= limit;

/** The sentences of a text: the pieces that end in . ! or ? and a space or the end. */
const sentencesOf = (text: string): string[] =>
  text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence !== "");
const sentenceCountIn =
  (min: number, max: number): Check =>
  (entry) => {
    const count = sentencesOf(entry).length;
    return count >= min && count <= max;
  };
const sentencesUnder =
  (limit: number): Check =>
  (entry) =>
    sentencesOf(entry).every((sentence) => wordCount(sentence) <= limit);

/** Every number in the text, with thousands commas taken out. */
const numbersIn = (text: string): number[] =>
  (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((token) => Number(token.replaceAll(",", "")));
const numbersWithin =
  (allowed: readonly number[]): Check =>
  (entry) =>
    numbersIn(entry).every((number) => allowed.includes(number));

const times =
  (pattern: RegExp, count: number): Check =>
  (entry) =>
    (entry.match(pattern) ?? []).length === count;

/**
 * For each rubric seed, one list of checks for each criterion, in the order of the rubric. A
 * criterion scores 10 times the share of its checks that the entry passes, rounded.
 */
export const STAND_IN: Record<string, Check[][]> = {
  "release-notes-plain": [
    [has(/\/v1\/orders/), has(/api keys?/i), has(/2026-12-01|1 december 2026|december 1,? 2026/i)],
    [
      has(/\/v2\/orders/),
      has(/re-?issue|create (?:a )?new|new (?:api )?keys?|regenerate/i),
      has(/settings/i),
    ],
    [has(/time ?zone/i), has(/invoice/i), has(/dark mode/i), has(/duplicate/i)],
    [lacks(/build tooling|refactor|billing module|readme/i)],
    [lacks(/\b(?:feat|fix|chore|refactor|docs|breaking)\s*:/i)],
    [atMostWords(120)],
  ],
  "plain-terms-rewrite": [
    [has(/\b(?:any ?time|whenever)\b/i), has(/\b30\b|thirty/i), has(/notice/i)],
    [
      has(/\b(?:owe|owed|unpaid|due|still (?:have to )?pay|must (?:still )?pay)\b/i),
      has(/\b(?:up to|until|before|through|up till)\b/i),
    ],
    [
      has(
        /(?:will not|won't|cannot|can't|do not|don't|not)\s+(?:get|be|receive)[^.]*(?:back|refund)|no refund/i,
      ),
    ],
    [
      has(/breach|break|broken/i),
      has(/\b(?:fix|put (?:it )?right|remed|cure)/i),
      has(/refund/i),
      has(/\b(?:part|portion|proportion|remaining|after)\b/i),
    ],
    [
      lacks(
        /notwithstanding|hereinafter|pursuant|save where|provided that|aforesaid|thereof|\bshall\b|pro rata|subscriber/i,
      ),
      sentencesUnder(22),
    ],
    [numbersWithin([30]), lacks(/\$|%|dollar|\bfee of\b|per month/i)],
    [atMostWords(100)],
  ],
  "source-conflict-brief": [
    [has(/\b(?:grew|grow|rose|increase[ds]?|went up|up from|higher|growth)\b/i), has(/agree/i)],
    [
      has(/520,?000/),
      has(/600,?000/),
      has(/transport office|office/i),
      has(/cyclists|survey|riverside/i),
    ],
    [
      has(/14\s?(?:%|percent)/),
      has(/447,?000/),
      has(/(?:under|shorter than|less than)\s+2\s+minutes|short trips|re-?dock|between docks/i),
      has(/audit/i),
    ],
    [
      has(/\brecommend|should (?:quote|use)|\buse\b|quote|go with|trust|rely/i),
      has(/447,?000|520,?000|600,?000/),
      has(/audit/i),
      has(/because|since|comes from|rests on|\bwhy\b/i),
    ],
    [
      has(/\b300\b/),
      has(/survey|member|self-?report|own trips/i),
      has(/\b(?:only|small|just|limited)\b/i),
    ],
    [
      numbersWithin([
        2023, 2024, 2025, 2026, 410_000, 520_000, 2.9, 62, 400_000, 600_000, 3.5, 70, 300, 2, 14,
        447_000,
      ]),
    ],
    [atMostWords(150)],
  ],
  "incident-summary-plain": [
    [has(/1,?840/), has(/\b(?:19|nineteen) minutes/i), has(/09:07/), has(/09:26/)],
    [
      has(/charged twice|double[- ]charged|twice/i),
      has(/no data (?:was )?lost|data (?:was )?(?:not )?lost|lost (?:no|any) data|no data loss/i),
    ],
    [
      lacks(/connection pool|\bquery\b|\bAPI\b|db-primary|\bdeploy\b|\bpool\b|\bDB\b/i),
      has(/too much|too many|overload|ran out|strain|heavy load/i),
    ],
    [has(/\bundo|undid|undoing|roll(?:ed|ing)? back|rollback|revert/i), has(/09:30/)],
    [has(/load[- ]test|test every release|testing/i), has(/alert|warn|monitor/i)],
    [
      has(/\b(?:sorry|apolog)/i),
      lacks(/\b(?:platform team|the engineer|our engineers?|on-call)\b/i),
      times(/sorry|apolog/gi, 1),
    ],
    [sentenceCountIn(5, 7), atMostWords(140)],
  ],
  "vendor-pick-memo": [
    [
      has(
        /(?:recommend|choose|pick|select|go with)[^.]{0,40}northwind|northwind[^.]{0,40}(?:is recommended|is the (?:best|right) choice)/i,
      ),
      has(/every requirement|all (?:the )?requirements|meets/i),
    ],
    [has(/1,?440/), has(/1,?500/), has(/under|below|within|less than|inside/i)],
    [
      has(
        /brightly[^.]*\b(?:no|lacks?|without|does not (?:have|offer|support)|doesn't (?:have|offer|support))\b[^.]*(?:sso|single sign-on)/i,
      ),
    ],
    [
      has(
        /dunmore[^.]*\b(?:no|none|lacks?|without|does not (?:have|offer)|doesn't (?:have|offer))\b[^.]*export/i,
      ),
    ],
    [has(/cobalt[^.]*?(?:1,?650|over budget|exceeds?|above (?:the )?budget|too expensive)/i)],
    [has(/elmstead[^.]*?(?:99\.0|below|under|lower|short|less)/i)],
    [
      numbersWithin([
        30, 48, 39, 55, 44, 35, 99.9, 99.5, 99.95, 99, 1_500, 1_440, 1_650, 1_170, 1_320, 1_050, 24,
        7,
      ]),
    ],
    [atMostWords(150)],
  ],
};

/**
 * What a model that grades by the stand-in checks gives one criterion of a seed's rubric, from 0
 * to 10. Throws for a seed or a criterion with no checks, so that a rubric changed without them
 * does not pass quietly.
 */
export function standInScore(slug: string, index: number, entry: string): number {
  const checks = STAND_IN[slug]?.[index];
  if (checks === undefined || checks.length === 0) {
    throw new Error(`rubric seed ${slug} has no stand-in checks for criterion ${index + 1}`);
  }
  const passed = checks.filter((check) => check(entry)).length;
  return Math.round((10 * passed) / checks.length);
}

/**
 * A fake model server's handler that grades the rubric of `slug` by the stand-in checks: it reads
 * the entry and the criteria out of the request as the Judge writes them, and answers in the shape
 * the Judge asks for.
 */
export function standInGrader(slug: string, rubric: readonly { criterion: string }[]): LlmHandler {
  return (request) => {
    const entry = entryOf(request);
    const keys = rubric.map(({ criterion }) => criterionKey(criterion));
    const scores = criteriaOf(request).map(({ criterion }) => {
      const index = keys.indexOf(criterionKey(criterion));
      const score = standInScore(slug, index, entry);
      return { criterion, score, reason: `the stand-in checks gave ${score} out of 10` };
    });
    return { json: completion(JSON.stringify({ scores, addresses_grader: false })) };
  };
}
