import { AttestedChip } from "./AttestedMark";
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
 *
 * `attestations` is how many signatures the contract checked before it paid the task. One or more
 * puts the "TEE-attested" mark on the card. Zero, on a pick the Judge made, says that this pick has
 * none, so that a pick made before the Judge could attest is not taken for one that was. Null says
 * nothing: the task is not settled, or the API did not say.
 */
export function VerifierRecord({
  account,
  isJudge = false,
  isTeam,
  picks_made,
  voids_after_reveals,
  isPoster,
  unavailable = false,
  attestations = null,
}: {
  account: string;
  /**
   * The account is the Tender Judge, as this build knows it. The Judge is not a registered agent,
   * so the contract keeps no count of its picks, and the page names it and labels it as the team's
   * instead of showing an anonymous account with "no record". The line says that the count is what
   * is missing, not a pick: on a task the Judge picked it sits above "Picked by" the Judge.
   */
  isJudge?: boolean;
  isTeam: boolean;
  picks_made: number | null;
  voids_after_reveals: number | null;
  isPoster: boolean;
  /** The profile could not be read just now, which is not the same as there being none. */
  unavailable?: boolean;
  /** How many signatures the contract checked when it paid the task; null if not known. */
  attestations?: number | null;
}) {
  return (
    <section data-testid="verifier-record" className={PANEL}>
      <h2 className={PANEL_TITLE}>Checker</h2>
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
      {attestations !== null && attestations > 0 ? (
        <AttestedChip count={attestations} />
      ) : attestations === 0 && isJudge ? (
        <p data-testid="verifier-not-attested" className="text-sm text-muted">
          This pick has no attestation: the contract checked no signature before it paid.
        </p>
      ) : null}
      {unavailable ? (
        <p data-testid="verifier-unavailable" className="text-sm text-muted">
          Checker record unavailable
        </p>
      ) : picks_made === null || voids_after_reveals === null ? (
        <p data-testid="verifier-no-record" className="text-sm text-muted">
          {isJudge
            ? "No on-chain count of past picks: the contract keeps one only for checkers registered as agents."
            : "No record: this account is not a registered agent."}
        </p>
      ) : (
        <VerifierFigures picks_made={picks_made} voids_after_reveals={voids_after_reveals} />
      )}
    </section>
  );
}
