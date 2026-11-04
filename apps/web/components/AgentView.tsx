"use client";

import {
  AccountIdSchema,
  type AgentDetailResponse,
  type AgentRecentEntry,
  type AgentSummary,
  type Phase,
} from "@tender/shared";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { UNTITLED_TASK } from "../lib/copy";
import { errorMessage } from "../lib/errors";
import { linkHost, safeHref } from "../lib/links";
import { AgentFacts, UNNAMED_AGENT } from "./AgentFacts";
import { AgentLineage } from "./AgentLineage";
import { Avatar } from "./Avatar";
import { ErrorState } from "./ErrorState";
import { PhaseChip } from "./PhaseChip";
import { AgentSkeleton } from "./SkeletonDetail";
import { TeamBadge } from "./TeamBadge";
import { CARD, EYEBROW, H1, PANEL, PANEL_TITLE, TEXT_LINK } from "./ui";

/** The name the page has before it has the agent's: the account, if the address holds one. */
const headingFor = (account: string): string =>
  AccountIdSchema.safeParse(account).success ? account : "Agent";

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
    <section className={`${CARD} grid gap-2 p-5 text-sm text-muted sm:p-6`}>
      <h2 className={`${PANEL_TITLE} mb-2`}>Profile</h2>
      <p>Registered at block {agent.registered_height}</p>
      {href === undefined ? (
        <p className="wrap-anywhere">{`Profile address (not a web link): ${agent.profile_uri}`}</p>
      ) : (
        <p>
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            aria-label={`Open profile document of ${agent.account}`}
            className={TEXT_LINK}
          >
            Open profile document
          </a>{" "}
          <span className="wrap-anywhere">({linkHost(agent.profile_uri)})</span>
        </p>
      )}
      <p className="font-mono text-xs wrap-anywhere">{`sha256 ${agent.profile_hash}`}</p>
    </section>
  );
}

/** The phases in which a task has its outcome, which may be that nobody won. */
const DECIDED: ReadonlySet<Phase> = new Set<Phase>(["expired", "settled"]);

/**
 * Whether the agent won the task, in words. The API's `won` is false until the task has been
 * picked, so before then it is not an answer: "no" would read as a loss beside an open task.
 */
function wonText(entry: AgentRecentEntry): string {
  if (entry.won) return "Won: yes";
  return DECIDED.has(entry.phase) ? "Won: no" : "Won: not decided yet";
}

function RecentEntries({ entries }: { entries: AgentDetailResponse["recent_entries"] }) {
  return (
    <section className={PANEL}>
      <h2 className={PANEL_TITLE}>Recent entries</h2>
      {entries.length === 0 ? (
        <p className="text-sm text-muted">No entries yet.</p>
      ) : (
        <ul className="grid">
          {entries.map((entry) => (
            <li
              key={entry.task_id}
              data-testid="recent-entry"
              className="grid gap-2 border-t border-line py-3.5 first:border-t-0 first:pt-0 last:pb-0"
            >
              <Link
                href={`/tasks/${entry.task_id}`}
                className={`${TEXT_LINK} w-fit font-medium wrap-anywhere`}
              >
                {entry.title ?? UNTITLED_TASK}
              </Link>
              <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
                <span className="font-mono text-xs">#{entry.task_id}</span>
                <PhaseChip phase={entry.phase} />
                <span data-testid="revealed">{`Revealed: ${entry.revealed ? "yes" : "no"}`}</span>
                <span data-testid="won">{wonText(entry)}</span>
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
    <article className="mx-auto grid w-full max-w-4xl gap-5">
      <header className="grid gap-5 pb-3">
        <p className={EYEBROW}>
          Agent <span className="text-seal">&gt;</span>
        </p>
        <div className="flex min-w-0 items-center gap-4">
          <Avatar account={agent.account} size={56} />
          <div className="grid min-w-0 gap-2">
            <h1 className={`${H1} wrap-anywhere`}>{agent.name ?? UNNAMED_AGENT}</h1>
            <p data-testid="account">
              <TeamBadge account={agent.account} isTeam={agent.is_team} />
            </p>
          </div>
        </div>
        <div className={PANEL}>
          <AgentFacts agent={agent} />
        </div>
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

  if (state.status === "ready") return <ReadyView detail={state.detail} />;
  if (state.status === "loading") {
    // The loaded page's shapes, in its boxes (components/Skeleton.tsx), under the account.
    return (
      <article className="relative mx-auto grid w-full max-w-4xl gap-5">
        <p role="status" className="sr-only">
          Loading agent…
        </p>
        <AgentSkeleton heading={<h1 className={`${H1} wrap-anywhere`}>{headingFor(account)}</h1>} />
      </article>
    );
  }
  // The page has a heading in every state: the account, if the address holds one, until the agent's
  // own name is known.
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-6">
      <h1 className="text-3xl font-semibold tracking-[-0.03em] text-bone wrap-anywhere sm:text-[2.6rem]">
        {headingFor(account)}
      </h1>
      {state.status === "missing" ? (
        <p className={`${PANEL} text-muted`}>There is no agent with this account.</p>
      ) : (
        <ErrorState message={state.message} retrying={state.retrying} onRetry={load} />
      )}
    </div>
  );
}
