/**
 * An account, and the label "Run by Tender team" when the team runs it. The team's accounts are
 * labelled as ours wherever they appear; `isTeam` comes from the API (`is_team_poster`, `is_team`).
 */
export function TeamBadge({ account, isTeam }: { account: string; isTeam: boolean }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-mono text-sm wrap-anywhere">{account}</span>
      {isTeam ? (
        <span
          data-testid="team-badge"
          className="rounded border border-neutral-900 px-1.5 py-0.5 text-xs font-medium"
        >
          Run by Tender team
        </span>
      ) : null}
    </span>
  );
}
