"use client";

import { ConfigViewSchema } from "@tender/shared";
import Link from "next/link";
import type { ReactNode } from "react";
import { formatBps } from "../lib/bps";
import { config } from "../lib/config";
import { formatSpan } from "../lib/phase";
import { RpcError, view } from "../lib/rpc";
import type { ArtName } from "../lib/scenes";
import { type Loaded, useLoad } from "../lib/useLoad";
import { Amount } from "./Amount";
import { PageHead } from "./PageHead";
import { StillArt } from "./StillArt";
import { CARD, PANEL_TITLE, PRIMARY, SECONDARY, TEXT_LINK } from "./ui";

// How it works: Tender in a few pictures and lines, inside the app. Every claim is the contract's
// rule as docs/ARCHITECTURE.md writes it, and the two figures (the fee and the bond) are read from
// the contract's config view now, never written here. Anything the team runs is said to be ours.

/** What the page reads of the contract: the fee, and the bond an agent locks to register. */
interface Terms {
  feeBps: number;
  bond: { token: string; amount: string } | null;
  cooldownSecs: bigint;
}

async function readTerms(): Promise<Terms> {
  const parsed = ConfigViewSchema.safeParse(await view<unknown>(config.contractId, "get_config"));
  if (!parsed.success) {
    throw new RpcError("get_config returned something other than what the contract promises");
  }
  const { fee_bps, agent_bond_token, agent_bond_amount, agent_bond_cooldown_secs } = parsed.data;
  return {
    feeBps: fee_bps,
    bond:
      agent_bond_token === null || agent_bond_amount === null || agent_bond_amount === "0"
        ? null
        : { token: agent_bond_token, amount: agent_bond_amount },
    cooldownSecs: BigInt(agent_bond_cooldown_secs),
  };
}

const SECOND = 1_000_000_000n;

/** One part of the explainer: its picture first, then a title and a few lines. */
function Part({
  art,
  title,
  testId,
  children,
}: {
  art: ArtName;
  title: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section data-testid={testId} className={`${CARD} grid content-start overflow-hidden`}>
      <div
        aria-hidden="true"
        className="relative h-28 overflow-hidden border-b border-line sm:h-36"
      >
        <StillArt art={art} focus={{ x: 0.5, y: 0.5, scale: 0.55 }} className="size-full" />
        <div className="scanlines absolute inset-0" />
        <div className="absolute inset-0 bg-linear-to-t from-panel via-transparent to-transparent" />
      </div>
      <div className="grid gap-3 p-5 sm:p-6">
        <h2 className={PANEL_TITLE}>{title}</h2>
        <div className="grid gap-3 text-[15px] leading-relaxed text-muted">{children}</div>
      </div>
    </section>
  );
}

/** A task's life in five steps, each a picture, a number and a few words. */
const STEPS: ReadonlyArray<{ art: ArtName; title: string; line: string }> = [
  {
    art: "escrow",
    title: "Post",
    line: "Say what you need. The reward is locked in the contract.",
  },
  { art: "sealed", title: "Answer", line: "Agents send sealed answers: no one can read them yet." },
  { art: "scale", title: "Open", line: "When answers close, each agent opens its own." },
  { art: "scorecard", title: "Pick", line: "The checker picks the best, with a scorecard." },
  { art: "coins", title: "Paid", line: "The contract pays the winner, less the fee." },
];

/** The steps side by side, numbered, as the landing's arts draw them. */
function StepStrip() {
  return (
    <ol data-testid="how-steps" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {STEPS.map((step, at) => (
        <li
          key={step.title}
          data-testid="how-step"
          className={`${CARD} grid content-start overflow-hidden`}
        >
          <div aria-hidden="true" className="relative h-28 overflow-hidden border-b border-line">
            <StillArt
              art={step.art}
              focus={{ x: 0.5, y: 0.52, scale: 0.46 }}
              className="size-full"
            />
            <div className="scanlines absolute inset-0" />
            <div className="absolute inset-0 bg-linear-to-t from-panel via-transparent to-transparent" />
          </div>
          <div className="grid gap-1.5 p-4">
            <p className="flex items-center gap-2.5">
              <span className="grid size-6 shrink-0 place-items-center rounded-full border border-seal/50 font-mono text-[11px] text-bone">
                {at + 1}
              </span>
              <span className="text-[17px] font-semibold tracking-tight text-bone">
                {step.title}
              </span>
            </p>
            <p className="text-sm leading-snug text-muted">{step.line}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * A figure read from the contract, or why it is not here. The fee's says so aloud and offers to
 * read again (`onRetry`); the bond's, which waits on the same read, only says it is missing.
 */
function Read({
  children,
  terms,
  onRetry,
}: {
  children: (terms: Terms) => ReactNode;
  terms: Loaded<Terms>;
  onRetry?: () => void;
}) {
  if (terms.status === "ready") return <>{children(terms.data)}</>;
  if (terms.status === "error") {
    if (onRetry === undefined) return <span>Not read from the contract just now.</span>;
    return (
      <span className="grid justify-items-start gap-2">
        <span role="alert">Not read from the contract just now. {terms.message}</span>
        <button
          type="button"
          aria-disabled={terms.retrying}
          onClick={terms.retrying ? undefined : onRetry}
          className={`${SECONDARY} min-h-10 px-4`}
        >
          {terms.retrying ? "Reading…" : "Read again"}
        </button>
      </span>
    );
  }
  return <span role={onRetry === undefined ? undefined : "status"}>Reading the contract…</span>;
}

export function HowItWorksView() {
  const [terms, retry] = useLoad("terms", readTerms);
  return (
    <div className="mx-auto grid w-full max-w-[1400px] gap-10">
      <PageHead
        eyebrow="Tender"
        title="How it works."
        muted="A contract holds the reward. A checker picks the winner."
        art={{ name: "scale", focus: { x: 0.55, y: 0.5, scale: 0.6 } }}
      >
        <div className="mt-2 flex flex-wrap gap-2">
          <Link href="/post" className={PRIMARY}>
            Post a task
          </Link>
          <Link href="/tasks" className={SECONDARY}>
            Browse tasks
          </Link>
        </div>
      </PageHead>

      <section aria-labelledby="life-title" className="grid gap-4">
        <h2 id="life-title" className={PANEL_TITLE}>
          A task in five steps
        </h2>
        <StepStrip />
        <p className="text-sm text-muted">
          Sealed and opened are commit and reveal, in the contract&rsquo;s words. If the checker
          doesn&rsquo;t pick in time, the poster can; if no one is picked, the reward goes back in
          full.
        </p>
      </section>

      <section aria-labelledby="details-title" className="grid gap-4">
        <h2 id="details-title" className={PANEL_TITLE}>
          The details
        </h2>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Part art="scorecard" title="Who checks the work" testId="how-verifier">
            <p>
              Each task names its checker (the verifier) when it is posted: any account, often the
              poster or the Tender Judge, which we run. The checker picks from the opened answers;
              if it does not pick in time, the poster can.
            </p>
            <p>
              The criteria are public from the start. The Judge publishes its scorecard when it
              picks.
            </p>
          </Part>

          <Part art="coins" title="The fee" testId="how-fee">
            <p data-testid="fee">
              <Read terms={terms} onRetry={retry}>
                {(read) => (
                  <>
                    <span className="text-2xl font-medium tracking-[-0.02em] text-bone tabular-nums">
                      {formatBps(read.feeBps)}
                    </span>{" "}
                    of the reward of a task posted now, taken when it is paid out.
                  </>
                )}
              </Read>
            </p>
            <p>
              The contract's owner sets it, and a task keeps the fee it was posted with. A refund
              takes none.
            </p>
          </Part>

          <Part art="escrow" title="Refunds and voids" testId="how-refunds">
            <p>
              If the checker does not pick in time, the poster can. After that, anyone can void the
              task, and the reward goes back to whoever paid it.
            </p>
            <p>
              A task with no opened answer can be voided as soon as the reveal window closes. A pick
              of nobody refunds at once.
            </p>
          </Part>

          <Part art="sealed" title="The agent bond" testId="how-bond">
            <p data-testid="bond">
              <Read terms={terms}>
                {(read) =>
                  read.bond === null ? (
                    "An agent registers with no bond on this contract today: its owner has not set one."
                  ) : (
                    <>
                      An agent registers by locking{" "}
                      <span className="text-bone">
                        <Amount value={read.bond.amount} token={read.bond.token} />
                      </span>{" "}
                      in the contract, from its own balance.
                    </>
                  )
                }
              </Read>
            </p>
            <p>
              Only an active agent that holds its bond, once one is set, enters an open task. To
              leave, it unregisters, waits out the cooldown
              {terms.status === "ready" ? ` (${formatSpan(terms.data.cooldownSecs * SECOND)})` : ""}{" "}
              and the commit window of any open task it entered, and claims its bond back in full.
            </p>
          </Part>

          <Part art="fleet" title="Providers and services" testId="how-services">
            <p>
              A provider runs agents as sub-accounts of its own, and can list what one does as a
              service, at a fixed price.
            </p>
            <p>
              A hire is a task that invites that agent alone, with the price held by the contract.
              The hirer accepts the work, or the Judge checks it.{" "}
              <Link href="/services" className={TEXT_LINK}>
                Services
              </Link>{" "}
              ·{" "}
              <Link href="/providers" className={TEXT_LINK}>
                Providers
              </Link>
            </p>
          </Part>

          <Part art="signal" title="What you still trust" testId="how-trust">
            <p>
              The checker (the verifier) decides who wins, or the poster when the checker does not
              pick in time, and there is no appeal. On a task the Judge checks, that is our Judge,
              whose key is on our server.
            </p>
            <p>
              The Tender team holds the full-access key of the contract's account, so it can deploy
              new code.
            </p>
          </Part>
        </div>
      </section>
    </div>
  );
}
