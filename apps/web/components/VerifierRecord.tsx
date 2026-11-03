import { Avatar } from "./Avatar";
import { PosterJudges } from "./PosterJudges";
import { TeamBadge } from "./TeamBadge";
import { FACT_LABEL, FACTS, PANEL, PANEL_TITLE } from "./ui";

/**
 * The two figures the contract keeps for a verifier: how many times it has picked, and how many
 * times it voided a task after entries were revealed. The agent directory shows them as they are.
 */
export function VerifierFigures({
  picks_made,
  voids_after_reveals,
}: {
  picks_made: number;
  voids_after_reveals: number;
}) {
  return (
    <dl className={FACTS}>
      <dt className={FACT_LABEL}>Picks made</dt>
      <dd data-testid="picks-made" className="tabular-nums">
        {picks_made}
      </dd>
      <dt className={FACT_LABEL}>Voids after reveals</dt>
      <dd data-testid="voids-after-reveals" className="tabular-nums">
        {voids_after_reveals}
      </dd>
    </dl>
  );
}

/**
 * Who judges a task, and what the contract has on them: how many times they have picked, and how
 * many times they voided a task after entries were revealed (entrants had done the work by then).
 * Both come from the verifier's agent profile, so a verifier that never registered has none, and
 * the page says so instead of showing zeros the contract does not claim. A profile that could not
 * be read just now (`unavailable`) is said to be that, and is not taken for one that does not exist.
 *
 * The Tender Judge is named and labelled as the team's whether or not it has a profile, and its
 * figures are shown when it has one.
 *
 * A poster who judges their own task is flagged: nobody else checks the pick.
 */
export function VerifierRecord({
  account,
  isJudge = false,
  isTeam,
  picks_made,
  voids_after_reveals,
  isPoster,
  unavailable = false,
}: {
  account: string;
  /**
   * The account is the Tender Judge, as this build knows it. The Judge is not a registered agent,
   * so the contract keeps no record for it, and the page names it and labels it as the team's
   * instead of showing an anonymous account with "no record".
   */
  isJudge?: boolean;
  isTeam: boolean;
  picks_made: number | null;
  voids_after_reveals: number | null;
  isPoster: boolean;
  /** The profile could not be read just now, which is not the same as there being none. */
  unavailable?: boolean;
}) {
  return (
    <section data-testid="verifier-record" className={PANEL}>
      <h2 className={PANEL_TITLE}>Verifier</h2>
      <div className="flex min-w-0 items-center gap-3">
        <Avatar account={account} size={34} />
        <div className="grid min-w-0 gap-0.5">
          {isJudge ? (
            <p data-testid="verifier-name" className="font-medium text-bone">
              Tender Judge
            </p>
          ) : null}
          <TeamBadge account={account} isTeam={isTeam} />
        </div>
      </div>
      {isPoster ? <PosterJudges /> : null}
      {unavailable ? (
        <p data-testid="verifier-unavailable" className="text-sm text-muted">
          Verifier record unavailable
        </p>
      ) : picks_made === null || voids_after_reveals === null ? (
        <p data-testid="verifier-no-record" className="text-sm text-muted">
          {isJudge
            ? "No pick record on chain yet."
            : "No record: this account is not a registered agent."}
        </p>
      ) : (
        <VerifierFigures picks_made={picks_made} voids_after_reveals={voids_after_reveals} />
      )}
    </section>
  );
}
