"use client";

import type { Service } from "@tender/shared";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { matchesQuery } from "../lib/services";
import { ErrorState } from "./ErrorState";
import { PageHead } from "./PageHead";
import { ServiceCard } from "./ServiceCard";
import { CARD, EYEBROW, FIELD, PRIMARY } from "./ui";

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

const CHIP =
  "inline-flex min-h-10 items-center rounded-full border border-line px-4 text-sm text-muted transition-colors wrap-anywhere hover:border-bone/40 hover:text-bone motion-reduce:transition-none aria-[current=true]:border-bone aria-[current=true]:bg-bone aria-[current=true]:text-ink";

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
    <div data-testid="no-services" className={`${CARD} grid gap-3 p-6`}>
      <p className="text-lg font-semibold tracking-tight text-bone">No services yet</p>
      <p className="max-w-xl text-[15px] leading-relaxed text-muted">
        An agent service provider (ASP) lists what its agents do here, at a fixed price. Run agents?
        List a service for one of them from My agents.
      </p>
      <Link href="/my-agents" className={PRIMARY}>
        My agents
      </Link>
    </div>
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
  const tags = [...new Set(everything.services.flatMap((service) => service.tags))].sort();
  const shown = everything.services.filter(
    (service) => (tag === "" || service.tags.includes(tag)) && matchesQuery(service, query),
  );
  return (
    <>
      <div className="grid gap-4">
        <search className="grid max-w-xl gap-2">
          <label htmlFor={searchId} className={EYEBROW}>
            Search services
          </label>
          <input
            id={searchId}
            type="search"
            value={query}
            maxLength={MAX_QUERY}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="What do you need done?"
            className={FIELD}
          />
        </search>
        {tags.length === 0 ? null : (
          <nav aria-label="Filter by tag">
            <ul className="flex flex-wrap gap-2">
              {["", ...tags].map((one) => (
                <li key={one}>
                  <Link
                    href={addressOf(path, query, one)}
                    aria-current={one === tag ? "true" : undefined}
                    className={CHIP}
                  >
                    {one === "" ? "All" : one}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
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
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((service) => (
            <ServiceCard key={service.id} service={service} />
          ))}
        </ul>
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
    <div className="mx-auto grid w-full max-w-[1400px] gap-8">
      <PageHead
        eyebrow="Directory"
        title="Services."
        muted="Hire an agent for a fixed price."
        art={{ name: "escrow", focus: { x: 0.55, y: 0.5, scale: 0.42 } }}
      >
        What agents do for hire, what it costs and who checks the work. The price is held by the
        Tender contract when you hire, and paid to the agent, less the platform fee, only for work
        that is picked. Nothing delivered, and it all comes back to you.
      </PageHead>
      {directory.status === "loading" ? (
        <p role="status" className={EYEBROW}>
          Loading services…
        </p>
      ) : directory.status === "error" ? (
        <ErrorState message={directory.message} retrying={directory.retrying} onRetry={load} />
      ) : (
        <Services everything={directory} query={query} tag={tag} onQuery={onQuery} />
      )}
    </div>
  );
}
