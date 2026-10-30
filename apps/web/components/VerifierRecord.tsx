import { TeamBadge } from "./TeamBadge";

/**
 * Who judges a task, and what the contract has on them: how many times they have picked, and how
 * many times they voided a task after entries were revealed (entrants had done the work by then).
 * Both come from the verifier's agent profile, so a verifier that never registered has none, and
 * the page says so instead of showing zeros the contract does not claim.
 *
 * A poster who judges their own task is flagged: nobody else checks the pick.
 */
export function VerifierRecord({
  account,
  isTeam,
  picks_made,
  voids_after_reveals,
  isPoster,
}: {
  account: string;
  isTeam: boolean;
  picks_made: number | null;
  voids_after_reveals: number | null;
  isPoster: boolean;
}) {
  return (
    <section data-testid="verifier-record" className="grid gap-2">
      <h2 className="text-lg font-semibold">Verifier</h2>
      <TeamBadge account={account} isTeam={isTeam} />
      {isPoster ? (
        <p
          data-testid="poster-judges"
          className="w-fit rounded border border-neutral-900 px-1.5 py-0.5 text-sm font-medium"
        >
          Poster judges their own task
        </p>
      ) : null}
      {picks_made === null || voids_after_reveals === null ? (
        <p className="text-sm">No record: this account is not a registered agent.</p>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt>Picks made</dt>
          <dd data-testid="picks-made">{picks_made}</dd>
          <dt>Voids after reveals</dt>
          <dd data-testid="voids-after-reveals">{voids_after_reveals}</dd>
        </dl>
      )}
    </section>
  );
}
