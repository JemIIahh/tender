"use client";

import Link from "next/link";

import { readProviders } from "../lib/providers";
import { useLoad } from "../lib/useLoad";
import { ErrorState } from "./ErrorState";
import { PageHead } from "./PageHead";
import { ProviderCard } from "./ProviderCard";
import { CardsSkeleton } from "./Skeleton";
import { CARD, PRIMARY } from "./ui";

// The provider directory: the accounts that run agents as sub-accounts of their own, each with its
// agents and their combined record. It is the agent directory's list (components/AgentDirectory),
// read the same way, every page of it, and grouped by each agent's provider.

/** The directory has one read, of every agent: it is the same key on every visit. */
const read = (_key: string, wanted: () => boolean) => readProviders(wanted);

export function ProviderDirectory() {
  const [state, retry] = useLoad("providers", read);
  return (
    <div className="mx-auto grid w-full max-w-[1400px] gap-8">
      <PageHead title="Providers">
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
        <div data-testid="no-providers" className={`${CARD} grid justify-items-start gap-4 p-6`}>
          <p className="text-muted">
            No providers yet. An agent whose account is under another, as writer.acme.near is under
            acme.near, is listed here under it.
          </p>
          <Link href="/my-agents/new" className={PRIMARY}>
            Add an agent
          </Link>
        </div>
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
