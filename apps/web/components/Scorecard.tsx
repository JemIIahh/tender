import { canonicalJson, type Scorecard as ScorecardDocument } from "@tender/shared";
import { formatBps } from "../lib/bps";

/**
 * The held-out document as a download: the same bytes that were hashed into the commitment, which
 * are its canonical JSON. A reader runs `shasum -a 256` on the file and compares.
 */
function heldoutHref(heldout: unknown): string {
  const text = new TextDecoder().decode(canonicalJson(heldout));
  return `data:application/json;charset=utf-8,${encodeURIComponent(text)}`;
}

/**
 * The result of a pick: how each revealed entry scored and why, who won, and what a reader needs to
 * check the scores against the task's held-out document.
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
}: {
  scorecard: ScorecardDocument;
  commitment?: string | null;
}) {
  const expected = commitment === undefined ? scorecard.heldout_commitment : commitment;
  const claimed = scorecard.heldout_commitment;

  return (
    <section data-testid="scorecard" className="grid gap-4">
      <h2 className="text-lg font-semibold">Scorecard</h2>

      {scorecard.entries.length === 0 ? (
        <p className="text-sm">No entry was scored.</p>
      ) : (
        <table className="w-full table-fixed text-sm">
          <caption className="sr-only">How each revealed entry scored</caption>
          <thead>
            <tr className="text-left text-xs">
              <th scope="col" className="w-[30%] px-1 py-1 font-medium">
                Entry
              </th>
              <th scope="col" className="w-[14%] px-1 py-1 font-medium">
                Score
              </th>
              <th scope="col" className="w-[17%] px-1 py-1 font-medium">
                Passed
              </th>
              <th scope="col" className="px-1 py-1 font-medium">
                Reasons
              </th>
            </tr>
          </thead>
          <tbody>
            {scorecard.entries.map((entry) => (
              <tr
                key={entry.account}
                data-testid="score-row"
                className="border-t border-neutral-300 align-top"
              >
                <th
                  scope="row"
                  className="px-1 py-2 text-left font-mono text-xs font-normal wrap-anywhere sm:text-sm"
                >
                  {entry.account}
                </th>
                <td data-testid="score" className="px-1 py-2">
                  {entry.score}
                </td>
                <td data-testid="passed" className="px-1 py-2">
                  {entry.passed ? "Yes" : "No"}
                </td>
                <td className="px-1 py-2">
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

      <div className="grid gap-1">
        <h3 className="font-medium">Winners</h3>
        {scorecard.winners.length === 0 ? (
          <p className="text-sm">No winner: nothing was awarded.</p>
        ) : (
          <ul className="grid gap-1 text-sm">
            {scorecard.winners.map((winner) => (
              <li key={winner.account} data-testid="scorecard-winner" className="wrap-anywhere">
                {`${winner.account} · ${formatBps(winner.bps)}`}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid gap-1 text-sm">
        {expected === null ? (
          <p>This task has no held-out document.</p>
        ) : (
          <>
            <p data-testid="recompute" className="font-mono wrap-anywhere">
              {`Recompute: sha256(held-out) must equal ${expected}`}
            </p>
            {scorecard.heldout === null ? (
              <p>The verifier has not published the held-out document.</p>
            ) : (
              <a
                href={heldoutHref(scorecard.heldout)}
                download="heldout.json"
                className="w-fit underline"
              >
                Held-out document (JSON)
              </a>
            )}
          </>
        )}
        {claimed !== expected ? (
          <p data-testid="commitment-mismatch" className="font-medium wrap-anywhere">
            {`The scorecard names the commitment ${claimed ?? "none"}, but the task commits to ${expected ?? "none"}.`}
          </p>
        ) : null}
      </div>
    </section>
  );
}
