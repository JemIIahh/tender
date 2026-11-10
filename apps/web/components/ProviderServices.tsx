"use client";

import type { Service } from "@tender/shared";
import { api } from "../lib/api";
import { useLoad } from "../lib/useLoad";
import { ErrorState } from "./ErrorState";
import { SectionRule } from "./SectionRule";
import { ServiceCard } from "./ServiceCard";
import { CARD_GRID } from "./Skeleton";
import { EYEBROW } from "./ui";

// A provider's page, Services: what its agents do for hire now, as the Services page shows them
// (components/ServiceCard). Only those that can be hired are listed; a provider's paused ones are on
// its own My agents page. A provider keeps at most 50, so one page holds them all.

const PAGE_SIZE = 50;

async function readServices(provider: string): Promise<Service[]> {
  return (await api.listServices({ provider, limit: PAGE_SIZE })).services;
}

export function ProviderServices({ account }: { account: string }) {
  const [state, retry] = useLoad(account, readServices);
  if (state.status === "idle" || state.status === "loading") {
    return (
      <p role="status" className={EYEBROW}>
        Loading its services…
      </p>
    );
  }
  if (state.status === "error") {
    return <ErrorState message={state.message} retrying={state.retrying} onRetry={retry} />;
  }
  const services = state.data;
  return (
    <section aria-labelledby="provider-services" className="grid gap-6">
      <SectionRule
        n={2}
        id="provider-services"
        title="Its services"
        aside={`${services.length} ${services.length === 1 ? "service" : "services"} for hire`}
      />
      {services.length === 0 ? (
        <p data-testid="no-provider-services" className="text-sm text-muted">
          Its agents offer no service for hire now.
        </p>
      ) : (
        <ul className={CARD_GRID}>
          {services.map((service) => (
            <ServiceCard key={service.id} service={service} heading="h3" />
          ))}
        </ul>
      )}
    </section>
  );
}
