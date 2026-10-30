import type { Phase, TaskEntry } from "@tender/shared";
import { linkHost, safeHref } from "../lib/links";
import { TeamBadge } from "./TeamBadge";

/**
 * The phases after the reveal window. From the reveal deadline the API serves what entrants
 * revealed, so a link to it works, and an entry that is still not revealed never will be.
 */
const REVEAL_OVER: ReadonlySet<Phase> = new Set(["judging", "fallback", "expired", "settled"]);

/**
 * Where an entry's content is, for a reader who may open it. `uri` is whatever the entrant wrote
 * on the chain: only an http(s) address becomes a link, anything else is shown as the text it is.
 * The link opens in a tab of its own, with no hold on this page, and says where it goes.
 */
function Content({ account, uri }: { account: string; uri: string | null }) {
  if (uri === null) return null;
  const href = safeHref(uri);
  if (href === undefined) {
    return <p className="text-sm wrap-anywhere">{`Content address (not a web link): ${uri}`}</p>;
  }
  return (
    <p className="text-sm">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        aria-label={`Open content of ${account}`}
        className="underline"
      >
        Open content
      </a>{" "}
      <span className="text-neutral-600 wrap-anywhere">({linkHost(uri)})</span>
    </p>
  );
}

function Status({ entry, revealOver }: { entry: TaskEntry; revealOver: boolean }) {
  const committed = `committed at block ${entry.committed_height}`;
  if (!entry.revealed || entry.content_hash === null) {
    return (
      <p className="text-sm">
        {revealOver ? `Not revealed · ${committed}` : `Sealed entry · ${committed}`}
      </p>
    );
  }
  return (
    <>
      {/* The hash is there before the content can be fetched: it is what the content will have to match. */}
      <p className="font-mono text-sm wrap-anywhere">{`Revealed · sha256 ${entry.content_hash}`}</p>
      {revealOver ? <Content account={entry.account} uri={entry.uri} /> : null}
    </>
  );
}

/**
 * The entries of a task. Until an entrant reveals, all anyone can see is that they committed, and
 * at which block. During the reveal window a revealed entry shows the hash of its content and no
 * link, because the API does not serve content before the reveal deadline. From then on the
 * revealed entries link to their content.
 *
 * `phase` is the task's phase by the clock, so a link appears when the window ends.
 */
export function EntryList({ entries, phase }: { entries: TaskEntry[]; phase: Phase }) {
  const revealOver = REVEAL_OVER.has(phase);
  const revealedCount = entries.filter((entry) => entry.revealed).length;
  return (
    <section className="grid gap-3">
      <h2 className="text-lg font-semibold">Entries</h2>
      {entries.length === 0 ? (
        <p className="text-sm">No entries yet.</p>
      ) : (
        <>
          <p data-testid="entry-summary" className="text-sm text-neutral-700">
            {`${entries.length} committed · ${revealedCount} revealed`}
          </p>
          <ul className="grid">
            {entries.map((entry) => (
              <li
                key={`${entry.account}:${entry.entry_index}`}
                data-testid="entry-row"
                className="grid gap-1 border-t border-neutral-300 py-3"
              >
                <TeamBadge account={entry.account} isTeam={entry.is_team} />
                <Status entry={entry} revealOver={revealOver} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
