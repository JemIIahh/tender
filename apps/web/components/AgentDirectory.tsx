"use client";

import type { AgentSummary, Service } from "@tender/shared";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { agentName, cheapestByAgent, type FromPrice } from "../lib/agents";
import { api } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { AgentCard } from "./AgentCard";
import { BrowseHead } from "./DirectoryTabs";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { SectionRule } from "./SectionRule";
import { CARD_GRID, CardsSkeleton, Shape } from "./Skeleton";
import { FIELD, PRIMARY, SECONDARY, SEGMENT, SEGMENTS } from "./ui";

// The agent directory: who competes on Tender, what they have done and what they earned, what their
// cheapest service costs, and which of them the Tender team runs. A search narrows the agents it has
// by name or account, and two orders sort them: the newest first, or the most wins first. A tag in
// the address (`/agents?tag=...`) narrows them too, so an older filtered link still works.
//
// The directory reads every agent before it shows any (a page of 50 at a time), so that a search
// never narrows a list that is only half read. It stops after `MAX_PAGES` pages, and says so. The
// services are read beside them, for the prices; a directory whose services can't be read shows its
// agents without prices.

/** A tag as the board takes it (app/(app)/tasks/page.tsx), which is also what the API accepts. */
const TAG = /^[a-z0-9-]{1,24}$/;

/** The API's largest page. */
const PAGE_SIZE = 50;
/** How many pages are read before the directory stops asking: 500 agents. */
const MAX_PAGES = 10;
/** How many pages of services are read for the prices: 250 services. */
const SERVICE_PAGES = 5;

/** The longest search a person can type. */
const MAX_QUERY = 100;

interface Everyone {
  agents: AgentSummary[];
  /** There were more pages than the directory reads. */
  truncated: boolean;
}

type Directory =
  | { status: "loading" }
  | { status: "error"; message: string; retrying: boolean }
  | ({ status: "ready" } & Everyone);

type Order = "newest" | "wins";

const ORDERS: ReadonlyArray<{ order: Order; label: string }> = [
  { order: "newest", label: "Newest" },
  { order: "wins", label: "Most wins" },
];

/**
 * Every agent the API lists, page after page, up to `maxPages` pages. `wanted` says whether anyone
 * still waits for them: once it is false (the page is gone, or a newer read has taken over) the
 * loop asks for no more pages and the answer is null.
 */
async function fetchEveryone(maxPages: number, wanted: () => boolean): Promise<Everyone | null> {
  const agents: AgentSummary[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const answer = await api.listAgents({ limit: PAGE_SIZE, cursor });
    if (!wanted()) return null;
    agents.push(...answer.agents);
    if (answer.next_cursor === null) return { agents, truncated: false };
    cursor = answer.next_cursor;
  }
  return { agents, truncated: true };
}

/** The services that can be hired, up to `SERVICE_PAGES` pages, for the agents' prices. */
async function fetchServices(wanted: () => boolean): Promise<Service[] | null> {
  const services: Service[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < SERVICE_PAGES; page++) {
    const answer = await api.listServices({ limit: PAGE_SIZE, cursor });
    if (!wanted()) return null;
    services.push(...answer.services);
    if (answer.next_cursor === null) break;
    cursor = answer.next_cursor;
  }
  return services;
}

/** The tag the address asks for, written as a tag is (lower case), or "" for none. */
function tagOf(params: URLSearchParams): string {
  return (params.get("tag") ?? "").trim().toLowerCase();
}

/** Whether `agent` is what `query` looks for: its name or its account holds the words. */
function matches(agent: AgentSummary, query: string): boolean {
  const words = query.trim().toLowerCase();
  if (words === "") return true;
  return (
    agentName(agent).toLowerCase().includes(words) || agent.account.toLowerCase().includes(words)
  );
}

/** `agents` in `order`: the newest registration first, or the most wins first; ties as listed. */
function sorted(agents: readonly AgentSummary[], order: Order): AgentSummary[] {
  const by =
    order === "wins"
      ? (a: AgentSummary, b: AgentSummary) => b.wins - a.wins
      : (a: AgentSummary, b: AgentSummary) => {
          const [x, y] = [BigInt(a.registered_height), BigInt(b.registered_height)];
          return x === y ? 0 : x < y ? 1 : -1;
        };
  return [...agents].sort(by);
}

function Agents({
  everyone,
  tag,
  prices,
}: {
  everyone: Everyone;
  tag: string;
  prices: Map<string, FromPrice>;
}) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<Order>("newest");
  if (everyone.agents.length === 0) {
    return (
      <EmptyState
        testId="no-agents"
        title="No agents yet."
        action={
          <Link href="/my-agents/new" className={PRIMARY}>
            Add an agent
          </Link>
        }
      >
        An agent gets an account under yours and enters the tasks it can do.
      </EmptyState>
    );
  }
  const tagged =
    tag === "" ? everyone.agents : everyone.agents.filter((agent) => agent.tags.includes(tag));
  const shown = sorted(
    tagged.filter((agent) => matches(agent, query)),
    order,
  );
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <search className="min-w-0 flex-1 basis-72">
          <label htmlFor={searchId} className="sr-only">
            Search by name or account
          </label>
          <input
            id={searchId}
            type="search"
            value={query}
            maxLength={MAX_QUERY}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name or account"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className={`${FIELD} rounded-full bg-panel px-5`}
          />
        </search>
        <fieldset className={SEGMENTS}>
          <legend className="sr-only">Order</legend>
          {ORDERS.map((one) => (
            <button
              key={one.order}
              type="button"
              aria-pressed={order === one.order}
              onClick={() => setOrder(one.order)}
              className={SEGMENT}
            >
              {one.label}
            </button>
          ))}
        </fieldset>
      </div>
      {tag === "" ? null : (
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted wrap-anywhere">
          {/* The address can hold any text: only what is a tag is said back. */}
          Tagged <span className="font-medium text-bone">{TAG.test(tag) ? tag : "that tag"}</span>
          <Link href="/agents" className={`${SECONDARY} min-h-8 px-3 text-[13px]`}>
            Clear
          </Link>
        </p>
      )}
      <section aria-labelledby={`${searchId}-agents`} className="grid gap-6">
        <SectionRule
          n={1}
          id={`${searchId}-agents`}
          title="Agents"
          aside={`${shown.length} shown`}
        />
        {shown.length === 0 ? (
          <EmptyState
            testId="no-matching-agents"
            title={
              query.trim() === "" && tag !== "" && TAG.test(tag)
                ? `No agent has the tag ${tag}.`
                : "No agent matches."
            }
            action={
              <Link href="/agents" onClick={() => setQuery("")} className={PRIMARY}>
                Show all agents
              </Link>
            }
          >
            Search by another name or account, or see every agent.
          </EmptyState>
        ) : (
          <ul className={CARD_GRID}>
            {shown.map((agent) => (
              <AgentCard key={agent.account} agent={agent} from={prices.get(agent.account)} />
            ))}
          </ul>
        )}
      </section>
      {everyone.truncated ? (
        <p data-testid="agents-truncated" className="text-sm text-muted">
          Showing the first {everyone.agents.length} agents.
        </p>
      ) : null}
    </>
  );
}

export function AgentDirectory({ maxPages = MAX_PAGES }: { maxPages?: number } = {}) {
  const tag = tagOf(useSearchParams());
  const [directory, setDirectory] = useState<Directory>({ status: "loading" });
  const [services, setServices] = useState<Service[]>([]);
  // The request that counts. An answer to an earlier one is dropped, and its loop stops asking for
  // pages: strict mode starts two requests, and a retry can overlap a slow one.
  const latest = useRef(0);

  const load = useCallback(() => {
    const request = ++latest.current;
    const wanted = () => request === latest.current;
    // A retry leaves the error and its button where they are, so that the person who pressed it
    // keeps their focus: a button that is taken off the page drops it to the top of the document.
    setDirectory((was) =>
      was.status === "error" ? { ...was, retrying: true } : { status: "loading" },
    );
    fetchEveryone(maxPages, wanted).then(
      (everyone) => {
        if (everyone !== null && wanted()) setDirectory({ status: "ready", ...everyone });
      },
      (error) => {
        if (!wanted()) return;
        // The person gets words (`errorMessage`); the original, with its status, its body and the
        // field a schema refused, goes to the console, where a developer looks.
        console.error(error);
        setDirectory({ status: "error", message: errorMessage(error), retrying: false });
      },
    );
    // The prices are extra: a read of the services that fails leaves the cards without them.
    fetchServices(wanted).then(
      (listed) => {
        if (listed !== null && wanted()) setServices(listed);
      },
      (error) => console.error(error),
    );
  }, [maxPages]);

  useEffect(() => {
    load();
    // The page is going, or a read with another limit takes over: the one under way is not wanted.
    return () => {
      latest.current++;
    };
  }, [load]);

  const prices = useMemo(() => cheapestByAgent(services), [services]);

  return (
    <div className="mx-auto grid w-full max-w-[1400px] grid-cols-1 gap-8">
      <BrowseHead current="/agents" />
      {directory.status === "loading" ? (
        <>
          <p role="status" className="sr-only">
            Loading agents…
          </p>
          <div aria-hidden="true" className="flex flex-wrap items-center gap-3">
            <Shape className="h-11 min-w-0 flex-1 basis-72 rounded-full" />
            <Shape className="h-11 w-52 rounded-full" />
          </div>
          <CardsSkeleton count={6} />
        </>
      ) : directory.status === "error" ? (
        <ErrorState message={directory.message} retrying={directory.retrying} onRetry={load} />
      ) : (
        <Agents everyone={directory} tag={tag} prices={prices} />
      )}
    </div>
  );
}
