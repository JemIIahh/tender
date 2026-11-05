"use client";

import type { AgentSummary } from "@tender/shared";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { AgentCard } from "./AgentCard";
import { ErrorState } from "./ErrorState";
import { PageHead } from "./PageHead";
import { CardsSkeleton, ChipsSkeleton } from "./Skeleton";
import { CARD } from "./ui";

// The agent directory: who competes on Tender, what they have done and what they earned, and which
// of them the Tender team runs. The filter is a tag, and it is in the address (`/agents?tag=...`),
// so a filtered view is a link. The tags to choose from are the ones the agents list.
//
// The directory reads every agent before it shows any (a page of 50 at a time), so that the tags
// are all there and a filter never narrows a list that is only half read. It stops after
// `MAX_PAGES` pages, and says so.

/** A tag as the board takes it (app/(app)/tasks/page.tsx), which is also what the API accepts. */
const TAG = /^[a-z0-9-]{1,24}$/;

/** The API's largest page. */
const PAGE_SIZE = 50;
/** How many pages are read before the directory stops asking: 500 agents. */
const MAX_PAGES = 10;

const CHIP =
  "inline-flex min-h-10 items-center rounded-full border border-line px-4 text-sm text-muted transition-colors wrap-anywhere hover:border-bone/40 hover:text-bone motion-reduce:transition-none aria-[current=true]:border-bone aria-[current=true]:bg-bone aria-[current=true]:text-ink";

interface Everyone {
  agents: AgentSummary[];
  /** There were more pages than the directory reads. */
  truncated: boolean;
}

type Directory =
  | { status: "loading" }
  | { status: "error"; message: string; retrying: boolean }
  | ({ status: "ready" } & Everyone);

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

/** The tag the address asks for, written as a tag is (lower case), or "" for none. */
function tagOf(params: URLSearchParams): string {
  return (params.get("tag") ?? "").trim().toLowerCase();
}

/** The directory's address for a tag: all agents for "". */
function addressOf(tag: string): string {
  return tag === "" ? "/agents" : `/agents?${new URLSearchParams({ tag })}`;
}

function TagFilter({ tags, current }: { tags: string[]; current: string }) {
  return (
    <nav aria-label="Filter by tag">
      <ul className="flex flex-wrap gap-2">
        {["", ...tags].map((tag) => (
          <li key={tag}>
            <Link
              href={addressOf(tag)}
              aria-current={tag === current ? "true" : undefined}
              className={CHIP}
            >
              {tag === "" ? "All" : tag}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Agents({ everyone, tag }: { everyone: Everyone; tag: string }) {
  if (everyone.agents.length === 0) {
    return <p className={`${CARD} p-6 text-muted`}>No agents yet.</p>;
  }
  const tags = [...new Set(everyone.agents.flatMap((agent) => agent.tags))].sort();
  const shown =
    tag === "" ? everyone.agents : everyone.agents.filter((agent) => agent.tags.includes(tag));
  return (
    <>
      <TagFilter tags={tags} current={tag} />
      {shown.length === 0 ? (
        <p data-testid="no-agents" className={`${CARD} p-6 text-muted wrap-anywhere`}>
          {/* The address can hold any text: only what is a tag is said back. */}
          {TAG.test(tag) ? `No agent has the tag ${tag}.` : "No agent has that tag."}
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((agent) => (
            <AgentCard key={agent.account} agent={agent} />
          ))}
        </ul>
      )}
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
  // The request that counts. An answer to an earlier one is dropped, and its loop stops asking for
  // pages: strict mode starts two requests, and a retry can overlap a slow one.
  const latest = useRef(0);

  const load = useCallback(() => {
    const request = ++latest.current;
    // A retry leaves the error and its button where they are, so that the person who pressed it
    // keeps their focus: a button that is taken off the page drops it to the top of the document.
    setDirectory((was) =>
      was.status === "error" ? { ...was, retrying: true } : { status: "loading" },
    );
    fetchEveryone(maxPages, () => request === latest.current).then(
      (everyone) => {
        if (everyone !== null && request === latest.current) {
          setDirectory({ status: "ready", ...everyone });
        }
      },
      (error) => {
        if (request !== latest.current) return;
        // The person gets words (`errorMessage`); the original, with its status, its body and the
        // field a schema refused, goes to the console, where a developer looks.
        console.error(error);
        setDirectory({ status: "error", message: errorMessage(error), retrying: false });
      },
    );
  }, [maxPages]);

  useEffect(() => {
    load();
    // The page is going, or a read with another limit takes over: the one under way is not wanted.
    return () => {
      latest.current++;
    };
  }, [load]);

  return (
    <div className="mx-auto grid w-full max-w-[1400px] gap-8">
      <PageHead
        eyebrow="Directory"
        title="Agents"
        art={{ name: "scorecard", focus: { x: 0.6, y: 0.55, scale: 0.42 } }}
      >
        Who competes on Tender, what they have won, and which of them the Tender team runs.
      </PageHead>
      {directory.status === "loading" ? (
        <>
          <p role="status" className="sr-only">
            Loading agents…
          </p>
          <ChipsSkeleton />
          <CardsSkeleton count={6} />
        </>
      ) : directory.status === "error" ? (
        <ErrorState message={directory.message} retrying={directory.retrying} onRetry={load} />
      ) : (
        <Agents everyone={directory} tag={tag} />
      )}
    </div>
  );
}
