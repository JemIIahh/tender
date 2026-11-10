import {
  canonicalJson,
  HAND_PICK_SOFTWARE,
  isJudgeBranded,
  type Scorecard as ScorecardDocument,
} from "@tender/shared";
import { useMemo } from "react";
import { formatBps } from "../lib/bps";
import { FACT_LABEL, PANEL, PANEL_TITLE, SECONDARY } from "./ui";

/**
 * The held-out checks as a download: the same bytes that were hashed into the commitment, which
 * are its canonical JSON. A reader runs `shasum -a 256` on the file and compares.
 *
 * Undefined for a document that cannot be written that way. The verifier wrote it, and JSON can
 * hold what the canonical form refuses (a lone surrogate in a string): the index may keep such a
 * document from before it asked for canonical bytes. The page shows the rest without it.
 */
function heldoutHref(heldout: unknown): string | undefined {
  try {
    const text = new TextDecoder().decode(canonicalJson(heldout));
    return `data:application/json;charset=utf-8,${encodeURIComponent(text)}`;
  } catch (error) {
    console.error("scorecard: the held-out checks cannot be written as canonical JSON", error);
    return undefined;
  }
}

/**
 * Whether published held-out checks have no salt. The held-out checks carry 32 random bytes or
 * more (`HeldoutSchema`), so that their commitment cannot be found by hashing likely answers while
 * the task is open; checks without them could have been, if they were short.
 */
function unsalted(heldout: unknown): boolean {
  return (
    typeof heldout === "object" &&
    heldout !== null &&
    !Array.isArray(heldout) &&
    !Object.hasOwn(heldout, "salt")
  );
}

/**
 * Who scored it, in a line. A scorecard whose `judge.software` carries the Judge's name is the
 * Tender Judge's: the API takes such a card from the Judge's account only (P03-R29), and a build
 * that knows the Judge's account holds the card to that too. Any other is named by what it says it
 * is. A rubric is scored by a model, which is a judgement and not a check, so it is said to be
 * subjective (spec 7.3) and the model is named. A scorecard that names `HAND_PICK_SOFTWARE` is said
 * to say that its verifier picked by hand: no one holds that name to an account.
 */
export function ScoredBy({
  scorecard,
  judgeAccount,
}: {
  scorecard: ScorecardDocument;
  judgeAccount: string | null;
}) {
  const { software, model } = scorecard.judge;
  // A pick made by hand, as the task page writes one: the scores only write a choice down. Nothing
  // holds this name to anyone, as the API holds the Judge's, so it is what the scorecard says.
  if (software === HAND_PICK_SOFTWARE) {
    return (
      <p data-testid="scored-by" className="text-sm text-muted wrap-anywhere">
        {`The scorecard says ${scorecard.verifier} picked by hand, with no software scoring the entries: each winner is listed at 100, every other entry at 0.`}
      </p>
    );
  }
  const byJudge =
    isJudgeBranded(software) && (judgeAccount === null || scorecard.verifier === judgeAccount);
  const who = byJudge ? "the Tender Judge" : software;
  const rubric = scorecard.kind === "rubric";
  return (
    <p data-testid="scored-by" className="text-sm text-muted wrap-anywhere">
      {`Scored by ${who}`}
      {rubric && model !== null ? ` with ${model}` : ""}
      {rubric ? ". Subjective: a model's judgement." : "."}
    </p>
  );
}

/**
 * The result of a pick: how each revealed entry scored and why, who won, and what a reader needs to
 * check the scores against the task's held-out checks.
 *
 * `commitment` is the task's own `heldout_commitment` from the chain, which the verifier does not
 * choose. The scorecard carries one too, and a scorecard whose commitment differs from the task's
 * is flagged. Without `commitment` the scorecard's is the one shown.
 *
 * Everything here comes from documents a verifier or an entrant wrote, and is shown as text.
 */
export function Scorecard({
  scorecard,
  commitment,
  judgeAccount = null,
}: {
  scorecard: ScorecardDocument;
  commitment?: string | null;
  /** The Tender Judge's account, if this build knows it. */
  judgeAccount?: string | null;
}) {
  const expected = commitment === undefined ? scorecard.heldout_commitment : commitment;
  const claimed = scorecard.heldout_commitment;
  // The page draws again every second, for its countdowns, and the document can be 256 KiB.
  const heldout = scorecard.heldout;
  const href = useMemo(() => (heldout === null ? undefined : heldoutHref(heldout)), [heldout]);

  return (
    <section data-testid="scorecard" className={PANEL}>
      <h2 className={PANEL_TITLE}>Scorecard</h2>
      <ScoredBy scorecard={scorecard} judgeAccount={judgeAccount} />

      {scorecard.entries.length === 0 ? (
        <p className="text-sm text-muted">No entry was scored.</p>
      ) : (
        <table className="w-full table-fixed text-sm">
          <caption className="sr-only">How each revealed entry scored</caption>
          <thead>
            <tr className="text-left text-[12px] text-muted sm:text-[13px]">
              <th scope="col" className="w-[30%] px-1 pb-2 font-normal">
                Entry
              </th>
              <th scope="col" className="w-[14%] px-1 pb-2 font-normal">
                Score
              </th>
              <th scope="col" className="w-[17%] px-1 pb-2 font-normal">
                Passed
              </th>
              <th scope="col" className="px-1 pb-2 font-normal">
                Reasons
              </th>
            </tr>
          </thead>
          <tbody>
            {scorecard.entries.map((entry, i) => (
              <tr
                // biome-ignore lint/suspicious/noArrayIndexKey: the verifier writes the document, and two rows can name the same account
                key={`${entry.account}:${i}`}
                data-testid="score-row"
                className="border-t border-line align-top"
              >
                <th
                  scope="row"
                  className="px-1 py-3 text-left font-mono text-xs font-normal text-bone wrap-anywhere sm:text-[13px]"
                >
                  {entry.account}
                </th>
                <td data-testid="score" className="px-1 py-3 text-bone tabular-nums">
                  {entry.score}
                </td>
                <td data-testid="passed" className="px-1 py-3 text-bone">
                  {entry.passed ? "Yes" : "No"}
                </td>
                <td className="px-1 py-3 text-muted">
                  <ul className="grid gap-1">
                    {entry.reasons.map((reason, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: reasons are a list in an order, and two can be the same text
                      <li key={i} className="wrap-anywhere">
                        {reason}
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="grid gap-2">
        <h3 className={FACT_LABEL}>Winners</h3>
        {scorecard.winners.length === 0 ? (
          <p className="text-sm text-muted">No winner: nothing was awarded.</p>
        ) : (
          <ul className="grid gap-1 text-sm text-bone">
            {scorecard.winners.map((winner, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: the verifier writes the document, and two winners can name the same account
                key={`${winner.account}:${i}`}
                data-testid="scorecard-winner"
                className="wrap-anywhere"
              >
                {`${winner.account} · ${formatBps(winner.bps)}`}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid gap-3 rounded-xl border border-line bg-ink p-4 text-sm text-muted">
        {expected === null ? (
          <p>This task has no held-out checks.</p>
        ) : (
          <>
            <p data-testid="recompute" className="font-mono text-[13px] text-bone/90 wrap-anywhere">
              {`Recompute: sha256(held-out) must equal ${expected}`}
            </p>
            {scorecard.heldout === null ? (
              <p>The checker has not published the held-out checks.</p>
            ) : href === undefined ? (
              <p>The held-out checks cannot be written out as a file.</p>
            ) : (
              <>
                <a href={href} download="heldout.json" className={SECONDARY}>
                  Held-out checks (JSON)
                </a>
                {unsalted(scorecard.heldout) ? (
                  <p data-testid="heldout-unsalted" className="text-seal">
                    These held-out checks have no salt, so while the task was open a short answer
                    could have been found from the hash on the task.
                  </p>
                ) : (
                  <p data-testid="heldout-salt">
                    The file includes its salt, the random value that kept the hash from giving the
                    answer away before the reveal.
                  </p>
                )}
              </>
            )}
          </>
        )}
        {claimed !== expected ? (
          <p data-testid="commitment-mismatch" className="font-medium text-seal wrap-anywhere">
            {`The scorecard names the commitment ${claimed ?? "none"}, but the task commits to ${expected ?? "none"}.`}
          </p>
        ) : null}
      </div>
    </section>
  );
}
