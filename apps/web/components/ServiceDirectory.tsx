"use client";

import type { Service } from "@tender/shared";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { matchesQuery } from "../lib/services";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { PageHead } from "./PageHead";
import { SectionRule } from "./SectionRule";
import { ServiceCard } from "./ServiceCard";
import { CARD_GRID, CardsSkeleton, Shape } from "./Skeleton";
import { CARD, FIELD, PRIMARY, SECONDARY } from "./ui";

// The Services page: what the agents on Tender do for hire, at a fixed price, and how each one's work
// is checked. The search and the tag are in the address (`/services?q=...&tag=...`), so a filtered
// view is a link. The list is every service that can be hired now, read a page of 50 at a time
// before any is shown, so that a filter never narrows a list that is only half read.

/** A tag as a listing writes one, which is also what the address may hold. */
const TAG = /^[a-z0-9-]{1,24}$/;
const PAGE_SIZE = 50;
const MAX_PAGES = 10;
/** The longest search the box takes, as the API does. */
const MAX_QUERY = 80;

interface Everything {
  services: Service[];
  truncated: boolean;
}

type Directory =
  | { status: "loading" }
  | { status: "error"; message: string; retrying: boolean }
  | ({ status: "ready" } & Everything);

async function fetchEverything(
  maxPages: number,
  wanted: () => boolean,
): Promise<Everything | null> {
  const services: Service[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const answer = await api.listServices({ limit: PAGE_SIZE, cursor });
    if (!wanted()) return null;
    services.push(...answer.services);
    if (answer.next_cursor === null) return { services, truncated: false };
    cursor = answer.next_cursor;
  }
  return { services, truncated: true };
}

/** The page's address for a search and a tag. */
function addressOf(path: string, query: string, tag: string): string {
  const search = new URLSearchParams();
  if (query.trim() !== "") search.set("q", query.trim());
  if (tag !== "") search.set("tag", tag);
  const text = search.toString();
  return text === "" ? path : `${path}?${text}`;
}

function Empty() {
  return (
    <EmptyState
      testId="no-services"
      title="No services yet"
      action={
        <Link href="/my-agents" className={PRIMARY}>
          My agents
        </Link>
      }
    >
      An agent service provider (ASP) lists what its agents do here, at a fixed price. Run agents?
      List a service for one of them from My agents.
    </EmptyState>
  );
}

function Services({
  everything,
  query,
  tag,
  onQuery,
}: {
  everything: Everything;
  query: string;
  tag: string;
  onQuery: (query: string) => void;
}) {
  const path = usePathname();
  const searchId = useId();
  if (everything.services.length === 0) return <Empty />;
  const shown = everything.services.filter(
    (service) => (tag === "" || service.tags.includes(tag)) && matchesQuery(service, query),
  );
  return (
    <>
      <div className="grid gap-4">
        <search className="grid w-full max-w-2xl">
          <label htmlFor={searchId} className="sr-only">
            Search services
          </label>
          <input
            id={searchId}
            type="search"
            value={query}
            maxLength={MAX_QUERY}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="What do you need done?"
            className={`${FIELD} rounded-full bg-panel px-5`}
          />
        </search>
        {/* No row of tags: the search is the page's one control. A tag in the address (an
            older link) still narrows the list, says so, and can be cleared. */}
        {tag === "" ? null : (
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted wrap-anywhere">
            {/* The address can hold any text: only what is a tag is said back. */}
            Tagged <span className="font-medium text-bone">{TAG.test(tag) ? tag : "that tag"}</span>
            <Link
              href={addressOf(path, query, "")}
              className={`${SECONDARY} min-h-8 px-3 text-[13px]`}
            >
              Clear
            </Link>
          </p>
        )}
      </div>
      {shown.length === 0 ? (
        <p data-testid="no-matching-services" className={`${CARD} p-6 text-muted wrap-anywhere`}>
          {/* The address can hold any text: only what is a tag is said back. */}
          {tag !== "" && TAG.test(tag)
            ? `No service with the tag ${tag} matches.`
            : "No service matches that search."}
        </p>
      ) : (
        <section aria-labelledby={`${searchId}-services`} className="grid gap-6">
          <SectionRule
            n={1}
            id={`${searchId}-services`}
            title="Services"
            aside={`${shown.length} shown`}
          />
          <ul className={CARD_GRID}>
            {shown.map((service) => (
              <ServiceCard key={service.id} service={service} />
            ))}
          </ul>
        </section>
      )}
      {everything.truncated ? (
        <p data-testid="services-truncated" className="text-sm text-muted">
          Showing the first {everything.services.length} services.
        </p>
      ) : null}
    </>
  );
}

export function ServiceDirectory({ maxPages = MAX_PAGES }: { maxPages?: number } = {}) {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const tag = (params.get("tag") ?? "").trim().toLowerCase();
  const [query, setQuery] = useState(() => (params.get("q") ?? "").slice(0, MAX_QUERY));
  const [directory, setDirectory] = useState<Directory>({ status: "loading" });
  const latest = useRef(0);

  const load = useCallback(() => {
    const request = ++latest.current;
    setDirectory((was) =>
      was.status === "error" ? { ...was, retrying: true } : { status: "loading" },
    );
    fetchEverything(maxPages, () => request === latest.current).then(
      (everything) => {
        if (everything !== null && request === latest.current) {
          setDirectory({ status: "ready", ...everything });
        }
      },
      (error) => {
        if (request !== latest.current) return;
        console.error(error);
        setDirectory({ status: "error", message: errorMessage(error), retrying: false });
      },
    );
  }, [maxPages]);

  useEffect(() => {
    load();
    return () => {
      latest.current++;
    };
  }, [load]);

  // The search goes into the address as it is typed, without a new entry in the history.
  const onQuery = (next: string) => {
    setQuery(next);
    router.replace(addressOf(path, next, tag), { scroll: false });
  };

  return (
    <div className="mx-auto grid w-full max-w-[1400px] grid-cols-1 gap-8">
      <PageHead title="Services." muted="Hire work or buy an API response.">
        For a hire, the contract holds the price and pays the agent only for work that is picked. If
        nothing is delivered, it all comes back to you. Agents buy an x402 API per call through
        Tender's MCP server, and pay its listed account directly.
      </PageHead>
      {directory.status === "loading" ? (
        <>
          <p role="status" className="sr-only">
            Loading services…
          </p>
          <Shape className="h-11 w-full max-w-2xl rounded-full" />
          <CardsSkeleton count={6} />
        </>
      ) : directory.status === "error" ? (
        <ErrorState message={directory.message} retrying={directory.retrying} onRetry={load} />
      ) : (
        <Services everything={directory} query={query} tag={tag} onQuery={onQuery} />
      )}
    </div>
  );
}
