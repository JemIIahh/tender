"use client";

import type { AgentDetailResponse, AgentSummary } from "@tender/shared";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { linkHost, safeHref } from "../lib/links";
import { AgentFacts, UNNAMED_AGENT } from "./AgentFacts";
import { AgentLineage } from "./AgentLineage";
import { ErrorState } from "./ErrorState";
import { PhaseChip } from "./PhaseChip";
import { TeamBadge } from "./TeamBadge";

type State =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string; retrying: boolean }
  | { status: "ready"; detail: AgentDetailResponse };

/**
 * Where the agent's profile document is. `profile_uri` is whatever the agent wrote on the chain:
 * only an http(s) address becomes a link, anything else is shown as the text it is.
 */
function ProfileSection({ agent }: { agent: AgentSummary }) {
  const href = safeHref(agent.profile_uri);
  return (
    <section className="grid gap-1 text-sm">
      <h2 className="text-lg font-semibold">Profile</h2>
      <p>Registered at block {agent.registered_height}</p>
      {href === undefined ? (
        <p className="wrap-anywhere">{`Profile address (not a web link): ${agent.profile_uri}`}</p>
      ) : (
        <p>
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            aria-label={`Open the profile document of ${agent.account}`}
            className="underline"
          >
            Open profile document
          </a>{" "}
          <span className="text-neutral-600 wrap-anywhere">({linkHost(agent.profile_uri)})</span>
        </p>
      )}
      <p className="font-mono wrap-anywhere">{`sha256 ${agent.profile_hash}`}</p>
    </section>
  );
}

function RecentEntries({ entries }: { entries: AgentDetailResponse["recent_entries"] }) {
  return (
    <section className="grid gap-3">
      <h2 className="text-lg font-semibold">Recent entries</h2>
      {entries.length === 0 ? (
        <p className="text-sm">No entries yet.</p>
      ) : (
        <ul className="grid">
          {entries.map((entry) => (
            <li
              key={entry.task_id}
              data-testid="recent-entry"
              className="grid gap-1 border-t border-neutral-300 py-3"
            >
              <Link href={`/tasks/${entry.task_id}`} className="underline wrap-anywhere">
                {entry.title ?? `Task #${entry.task_id}`}
              </Link>
              <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <PhaseChip phase={entry.phase} />
                <span data-testid="revealed">{`Revealed: ${entry.revealed ? "yes" : "no"}`}</span>
                <span data-testid="won">{`Won: ${entry.won ? "yes" : "no"}`}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ReadyView({ detail }: { detail: AgentDetailResponse }) {
  const { agent } = detail;
  return (
    <article className="grid gap-8">
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold wrap-anywhere">{agent.name ?? UNNAMED_AGENT}</h1>
        <p data-testid="account">
          <TeamBadge account={agent.account} isTeam={agent.is_team} />
        </p>
        <AgentFacts agent={agent} />
      </header>
      <ProfileSection agent={agent} />
      <RecentEntries entries={detail.recent_entries} />
      {/* After the agent is known to exist: the tasks it posted are asked for by its account. */}
      <AgentLineage account={agent.account} />
    </article>
  );
}

/**
 * An agent's page: its profile, the entries it made most recently, and the tasks it posted (its
 * lineage). An account that is no agent is "not found", which is no error; a string that is no
 * account is not asked about at all (`api.getAgent`). The posted tasks are asked for only once the
 * agent is known, so that an address that holds anything else never reaches them.
 */
export function AgentView({ account }: { account: string }) {
  const [state, setState] = useState<State>({ status: "loading" });
  // The request that counts. An answer to an earlier one is dropped: strict mode starts two
  // requests, and a retry can overlap a slow one.
  const latest = useRef(0);

  const load = useCallback(() => {
    const request = ++latest.current;
    // A retry leaves the error and its button where they are, so that the person who pressed it
    // keeps their focus.
    setState((was) =>
      was.status === "error" ? { ...was, retrying: true } : { status: "loading" },
    );
    api.getAgent(account).then(
      (detail) => {
        if (request !== latest.current) return;
        setState(detail === null ? { status: "missing" } : { status: "ready", detail });
      },
      (error) => {
        if (request !== latest.current) return;
        // The person gets words; the original goes to the console, where a developer looks.
        console.error(error);
        setState({ status: "error", message: errorMessage(error), retrying: false });
      },
    );
  }, [account]);

  useEffect(() => {
    load();
  }, [load]);

  switch (state.status) {
    case "loading":
      return <p role="status">Loading agent…</p>;
    case "missing":
      return <p>There is no agent with this account.</p>;
    case "error":
      return <ErrorState message={state.message} retrying={state.retrying} onRetry={load} />;
    case "ready":
      return <ReadyView detail={state.detail} />;
  }
}
