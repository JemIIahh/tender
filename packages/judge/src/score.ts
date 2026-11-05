import type { HeldoutChecks } from "@tender/shared";
import type { P0Criteria } from "./intake";
import type { HeldoutOf } from "./kinds/common";
import { scoreExact } from "./kinds/exact";
import { jsonSchemaScorer } from "./kinds/json_schema";
import { scoreRegexCases } from "./kinds/regex_cases";
import { scoreTests } from "./kinds/tests";
import type { EntryScore } from "./types";

/**
 * The scorer could not be run at all, such as the regex sandbox when its engine cannot be
 * loaded, or a score worker that cannot be started. That is the Judge's trouble and not the
 * entry's, so the task is judged again on a later tick, and no entry is scored 0 for it.
 */
export class ScorerUnavailableError extends Error {
  override name = "ScorerUnavailableError";
}

/** What `scoreEntry` scores: an entry's content, against the task's checked documents. */
export interface ScoreInput {
  criteria: P0Criteria;
  /**
   * The held-out document as parsed from its bytes, or `null` when the task has none. Only its
   * checks are scored with: its salt is there to make its commitment unguessable.
   */
  heldout: HeldoutChecks | null;
  /** The bytes the entry revealed, already checked against its `content_hash`. */
  content: Uint8Array;
}

/**
 * Scores one entry by the kind of its task's criteria, on the caller's thread. The Judge never
 * calls it on its own thread: its score workers do, through `prepareScorer` (see `isolate.ts`).
 *
 * It resolves with the entry's score whatever the content is. It rejects with
 * `ScorerUnavailableError` when the scorer cannot be run at all, and with whatever else a scorer
 * throws, which the Judge scores 0 for that entry alone.
 */
export async function scoreEntry(input: ScoreInput): Promise<EntryScore> {
  return prepareScorer(input.criteria, input.heldout).score(input.content);
}

/** The scorer of one task's entries, prepared: see `prepareScorer`. */
export interface PreparedScorer {
  /**
   * Why the criteria cannot be scored with, or `null`: a `json_schema` schema that the criteria
   * check refuses (`checkJsonSchemaUsable`). The Judge does not score such a task at all; `score`
   * still scores as `scoreJsonSchema` does.
   */
  problem: string | null;
  score(content: Uint8Array): Promise<EntryScore>;
}

/**
 * The scorer of one task's entries: `scoreEntry` with the criteria and the held-out document
 * fixed, for entries scored one after another. Every scorer the Judge runs is called from here and
 * nowhere else. A `json_schema` schema is compiled now, once, and run on the check's trial
 * documents, before any entry and not again for each (`jsonSchemaScorer`), so that no entry pays
 * for any of the compile, V8's included.
 *
 * It throws `ScorerUnavailableError` when the held-out document has no part for the kind that
 * needs one, a slip of the Judge's own.
 */
export function prepareScorer(c: P0Criteria, heldout: HeldoutChecks | null): PreparedScorer {
  switch (c.kind) {
    case "exact": {
      const h = heldoutPart(heldout, "exact");
      return { problem: null, score: async (content) => scoreExact(c, h, content) };
    }
    case "json_schema": {
      const { problem, score } = jsonSchemaScorer(c, heldoutPart(heldout, "json_schema"));
      return { problem, score: async (content) => score(content) };
    }
    case "regex_cases": {
      const cases = heldout === null ? null : heldoutPart(heldout, "regex_cases");
      return {
        problem: null,
        // It rejects only when the sandbox cannot be started.
        score: (content) =>
          scoreRegexCases(c, cases, content).catch((error: unknown) => {
            throw new ScorerUnavailableError("the regex sandbox could not be started", {
              cause: error,
            });
          }),
      };
    }
    case "tests": {
      const cases = heldout === null ? null : heldoutPart(heldout, "tests");
      return {
        problem: null,
        // It rejects only when the sandbox cannot be started.
        score: (content) =>
          scoreTests(c, cases, content).catch((error: unknown) => {
            throw new ScorerUnavailableError("the tests sandbox could not be started", {
              cause: error,
            });
          }),
      };
    }
  }
}

/**
 * The part of `heldout` for `kind`. Intake checked that the document is of the criteria's kind,
 * and that `exact` and `json_schema` have one, so a missing part is a slip of the Judge's own.
 */
function heldoutPart<K extends "exact" | "json_schema" | "regex_cases" | "tests">(
  heldout: HeldoutChecks | null,
  kind: K,
): HeldoutOf<K> {
  if (heldout === null || !Object.hasOwn(heldout, kind)) {
    throw new ScorerUnavailableError(`the held-out checks have no ${kind} part`);
  }
  return (heldout as unknown as Record<K, HeldoutOf<K>>)[kind];
}
