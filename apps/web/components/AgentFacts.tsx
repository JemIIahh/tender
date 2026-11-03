import type { AgentSummary } from "@tender/shared";
import { Amount } from "./Amount";
import { VerifierFigures } from "./VerifierRecord";

/** What the page says of an agent the index holds no public profile for. */
export const UNNAMED_AGENT = "Unnamed agent (no public profile yet)";

/**
 * What an agent is and has done, as the contract counts it: the provider it runs under, its tags,
 * its entries, reveals and wins, what it earned and its record as a verifier. What it earned is
 * shown a token at a time: amounts of different tokens are never added together.
 *
 * The same lines are on the agent's card in the directory and on its own page. Every string here
 * was written by someone else (a profile, an account), and is shown as text.
 */
export function AgentFacts({ agent }: { agent: AgentSummary }) {
  const earned = Object.entries(agent.earned);
  return (
    <div className="grid gap-3">
      <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="text-neutral-700">Provider (ASP)</span>
        {agent.asp === null ? (
          <span data-testid="asp">none</span>
        ) : (
          <span data-testid="asp" className="font-mono wrap-anywhere">
            {agent.asp}
          </span>
        )}
      </p>

      {agent.tags.length === 0 ? null : (
        <ul className="flex flex-wrap gap-2" aria-label="Tags">
          {agent.tags.map((tag, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the contract does not make an agent's tags unique
            <li key={`${tag}-${index}`}>
              <span className="rounded border border-neutral-400 px-1.5 py-0.5 text-xs wrap-anywhere">
                {tag}
              </span>
            </li>
          ))}
        </ul>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt>Entries</dt>
        <dd data-testid="entries">{agent.entries}</dd>
        <dt>Reveals</dt>
        <dd data-testid="reveals">{agent.reveals}</dd>
        <dt>Wins</dt>
        <dd data-testid="wins">{agent.wins}</dd>
        <dt>Earned</dt>
        <dd data-testid="earned">
          {earned.length === 0 ? (
            "Nothing yet"
          ) : (
            <ul className="grid gap-1">
              {earned.map(([token, amount]) => (
                <li key={token}>
                  <Amount value={amount} token={token} />
                </li>
              ))}
            </ul>
          )}
        </dd>
      </dl>

      <div data-testid="agent-verifier-record" className="grid gap-1">
        <p className="text-sm font-medium">Verifier record</p>
        <VerifierFigures
          picks_made={agent.picks_made}
          voids_after_reveals={agent.voids_after_reveals}
        />
      </div>
    </div>
  );
}
