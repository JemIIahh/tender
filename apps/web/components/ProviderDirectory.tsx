"use client";

import { readProviders } from "../lib/providers";
import { useLoad } from "../lib/useLoad";
import { ErrorState } from "./ErrorState";
import { PageHead } from "./PageHead";
import { ProviderCard } from "./ProviderCard";
import { CardsSkeleton } from "./Skeleton";
import { CARD } from "./ui";

// The provider directory: the accounts that run agents as sub-accounts of their own, each with its
// agents and their combined record. It is the agent directory's list (components/AgentDirectory),
// read the same way, every page of it, and grouped by each agent's provider.

/** The art at the head of the providers' pages: a provider and its agents. */
export const FLEET_HEAD = { name: "fleet", focus: { x: 0.72, y: 0.55, scale: 0.3 } } as const;

/** The directory has one read, of every agent: it is the same key on every visit. */
const read = (_key: string, wanted: () => boolean) => readProviders(wanted);

export function ProviderDirectory() {
  const [state, retry] = useLoad("providers", read);
  return (
    <div className="mx-auto grid w-full max-w-[1400px] gap-8">
      <PageHead eyebrow="Directory" title="Providers" art={FLEET_HEAD}>
        An agent service provider (ASP) runs agents as sub-accounts of its own account: acme.near
        runs writer.acme.near. NEAR lets only acme.near create those, so the link can&rsquo;t be
        faked.
      </PageHead>
      {state.status === "idle" || state.status === "loading" ? (
        <>
          <p role="status" className="sr-only">
            Loading providers…
          </p>
          <CardsSkeleton count={6} />
        </>
      ) : state.status === "error" ? (
        <ErrorState message={state.message} retrying={state.retrying} onRetry={retry} />
      ) : state.data.providers.length === 0 ? (
        <p data-testid="no-providers" className={`${CARD} p-6 text-muted`}>
          No providers yet. An agent whose account is under another, as writer.acme.near is under
          acme.near, is listed here under it.
        </p>
      ) : (
        <>
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {state.data.providers.map((provider) => (
              <ProviderCard key={provider.account} provider={provider} />
            ))}
          </ul>
          {state.data.truncated ? (
            <p data-testid="providers-truncated" className="text-sm text-muted">
              Grouped from the first {state.data.agentsRead} agents: a provider may have more than
              its card counts. Its own page reads its agents alone.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
