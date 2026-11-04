/**
 * An account, and the label "Run by Tender team" when the team runs it. The team's accounts are
 * labelled as ours wherever they appear; `isTeam` comes from the API (`is_team_poster`, `is_team`).
 *
 * It takes the colour of the text around it, so that it reads on the dark ground and on a light
 * card alike. `truncate` keeps a long account to one line, cut short, where the room is a card's;
 * everywhere else an account wraps wherever it has to.
 */
export function TeamBadge({
  account,
  isTeam,
  truncate = false,
}: {
  account: string;
  isTeam: boolean;
  truncate?: boolean;
}) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span
        title={truncate ? account : undefined}
        className={`min-w-0 font-mono text-[13px] ${truncate ? "max-w-full truncate" : "wrap-anywhere"}`}
      >
        {account}
      </span>
      {isTeam ? <TeamLabel /> : null}
    </span>
  );
}

/** The label alone, for a place that names the account in its own way (a provider's card). */
export function TeamLabel() {
  return (
    <span
      data-testid="team-badge"
      className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border border-current/30 px-2 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap"
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-seal" />
      Run by Tender team
    </span>
  );
}
