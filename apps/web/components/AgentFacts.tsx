import type { AgentSummary } from "@tender/shared";
import Link from "next/link";
import { Amount } from "./Amount";
import { Count, EarnedNothing, FigureLine } from "./Figures";
import { FACT_LABEL, FACTS, TAG, TEXT_LINK } from "./ui";
import { VerifierFigures } from "./VerifierRecord";

/** What the page says of an agent the index holds no public profile for. */
export const UNNAMED_AGENT = "Unnamed agent (no public profile yet)";

/**
 * What an agent is and has done, as the contract counts it: the provider it runs under (a link to
 * the provider's page), its tags, its entries, reveals and wins, what it earned and its record as a
 * verifier. What it earned is shown a token at a time: amounts of different tokens are never added
 * together. An agent that has entered nothing, won nothing and earned nothing says so in one line.
 *
 * The same lines are on the agent's card in the directory and on its own page. Every string here
 * was written by someone else (a profile, an account), and is shown as text.
 */
export function AgentFacts({ agent }: { agent: AgentSummary }) {
  const earned = Object.entries(agent.earned);
  const nothingYet =
    agent.entries === 0 && agent.reveals === 0 && agent.wins === 0 && earned.length === 0;
  return (
    <div className="grid gap-4">
      {agent.tags.length === 0 ? null : (
        <ul className="flex flex-wrap gap-1.5 text-bone/85" aria-label="Tags">
          {agent.tags.map((tag, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the contract does not make an agent's tags unique
            <li key={`${tag}-${index}`} className="min-w-0">
              <span className={`${TAG} max-w-full wrap-anywhere`}>{tag}</span>
            </li>
          ))}
        </ul>
      )}

      {nothingYet ? (
        // An agent that has done nothing yet: one line, not a row of empty boxes.
        <FigureLine testId="agent-figures">
          {[
            <Count key="entries" value={0} one="entry" many="entries" testId="entries" />,
            <Count key="reveals" value={0} one="reveal" many="reveals" testId="reveals" />,
            <Count key="wins" value={0} one="win" many="wins" testId="wins" />,
            <EarnedNothing key="earned" testId="earned" />,
          ]}
        </FigureLine>
      ) : (
        /* The three counts side by side, as the landing's figures are. */
        <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-line bg-line text-center">
          <div className="grid gap-1 bg-ink px-2 py-3">
            <dt className={FACT_LABEL}>Entries</dt>
            <dd data-testid="entries" className="text-xl font-medium tabular-nums wrap-anywhere">
              {agent.entries}
            </dd>
          </div>
          <div className="grid gap-1 bg-ink px-2 py-3">
            <dt className={FACT_LABEL}>Reveals</dt>
            <dd data-testid="reveals" className="text-xl font-medium tabular-nums wrap-anywhere">
              {agent.reveals}
            </dd>
          </div>
          <div className="grid gap-1 bg-ink px-2 py-3">
            <dt className={FACT_LABEL}>Wins</dt>
            <dd data-testid="wins" className="text-xl font-medium tabular-nums wrap-anywhere">
              {agent.wins}
            </dd>
          </div>
        </dl>
      )}

      <dl className={FACTS}>
        {nothingYet ? null : (
          <>
            <dt className={FACT_LABEL}>Earned</dt>
            <dd data-testid="earned">
              {earned.length === 0 ? (
                <span className="text-muted">Nothing yet</span>
              ) : (
                <ul className="grid gap-1">
                  {earned.map(([token, amount]) => (
                    <li key={token} className="wrap-anywhere">
                      <Amount value={amount} token={token} />
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </>
        )}
        <dt className={FACT_LABEL}>Provider (ASP)</dt>
        {agent.asp === null ? (
          <dd data-testid="asp" className="text-muted">
            none
          </dd>
        ) : (
          <dd data-testid="asp" className="font-mono text-[13px] wrap-anywhere">
            {/* Above the card's own link, which stretches over the card. */}
            <Link href={`/providers/${agent.asp}`} className={`relative z-10 ${TEXT_LINK}`}>
              {agent.asp}
            </Link>
          </dd>
        )}
      </dl>

      <div data-testid="agent-verifier-record" className="grid gap-2 border-t border-line pt-4">
        <p className={FACT_LABEL}>Verifier record</p>
        <VerifierFigures
          picks_made={agent.picks_made}
          voids_after_reveals={agent.voids_after_reveals}
        />
      </div>
    </div>
  );
}
