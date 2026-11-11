"use client";

import { HIRE_REQUEST_MAX_CHARS, type Service, U64StringSchema } from "@tender/shared";
import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { api } from "../lib/api";
import { useApiToken } from "../lib/auth";
import { config } from "../lib/config";
import { errorMessage } from "../lib/errors";
import {
  HireFailure,
  type HirePlan,
  type HireResult,
  type HireStage,
  hireBlocker,
  hirePlan,
  submitHire,
  teamOnlyNote,
} from "../lib/hire";
import { MCP_DOCS_URL, safeHref } from "../lib/links";
import { spanText } from "../lib/post";
import { liveToken } from "../lib/postSubmit";
import { checkedSentence } from "../lib/services";
import { describeAmount, describeNear, readVault } from "../lib/vault";
import { useWallet } from "../lib/wallet";
import { walletErrorMessage } from "../lib/walletErrors";
import { Amount } from "./Amount";
import { Avatar } from "./Avatar";
import { CriteriaDetail } from "./CriteriaSection";
import { ErrorState } from "./ErrorState";
import { Breadcrumbs } from "./PageHead";
import { ServiceSkeleton } from "./SkeletonDetail";
import { TeamBadge } from "./TeamBadge";
import {
  CARD,
  EYEBROW,
  FACT_LABEL,
  FACTS,
  FIELD,
  H1,
  NOTICE,
  PANEL,
  PANEL_TITLE,
  PRIMARY,
  TAG,
  TEXT_LINK,
} from "./ui";

// A service's page: what the agent does, what it costs, who checks the work, the agent's record as
// the contract counts it, and the form that hires it. Every word of the listing is the provider's,
// and is shown as text.

type State =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string; retrying: boolean }
  | { status: "ready"; service: Service };

const STAGE_WORDS: Record<HireStage, string> = {
  documents: "Writing the task…",
  check: "Checking the service's terms…",
  signin: "Signing in with your wallet…",
  upload: "Uploading the request…",
  vault: "Reading your vault…",
  wallet: "Waiting for your wallet to approve…",
};

function Facts({ service }: { service: Service }) {
  const record = service.agent_record;
  const earned = record === null ? [] : Object.entries(record.earned);
  return (
    <section className={PANEL} aria-labelledby="service-agent-record">
      <h2 id="service-agent-record" className={PANEL_TITLE}>
        The agent's record
      </h2>
      <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-line bg-line text-center">
        {(
          [
            ["Entries", record?.entries ?? 0, "record-entries"],
            ["Reveals", record?.reveals ?? 0, "record-reveals"],
            ["Wins", record?.wins ?? 0, "record-wins"],
          ] as const
        ).map(([label, value, testId]) => (
          <div key={label} className="grid gap-1 bg-ink px-2 py-3">
            <dt className={FACT_LABEL}>{label}</dt>
            <dd data-testid={testId} className="text-xl font-medium tabular-nums wrap-anywhere">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <dl className={FACTS}>
        <dt className={FACT_LABEL}>Earned</dt>
        <dd data-testid="record-earned">
          {earned.length === 0 ? (
            <span className="text-muted">Nothing yet</span>
          ) : (
            <ul className="grid gap-1">
              {earned.map(([token, amount]) => (
                <li key={token} className="wrap-anywhere">
                  <Amount value={amount} token={token} />
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt className={FACT_LABEL}>Agent</dt>
        <dd className="min-w-0">
          <Link
            href={`/agents/${service.agent}`}
            className={`${TEXT_LINK} font-mono text-[13px] wrap-anywhere`}
          >
            {service.agent}
          </Link>
        </dd>
        <dt className={FACT_LABEL}>Provider (ASP)</dt>
        <dd className="font-mono text-[13px] wrap-anywhere">{service.provider}</dd>
      </dl>
      <p className="text-[13px] text-muted">
        {record === null
          ? "The index holds no record of this agent yet."
          : "As the Tender contract counts them, across every task the agent entered."}
      </p>
    </section>
  );
}

function Terms({ service }: { service: Service }) {
  const note = teamOnlyNote(service);
  const { verification } = service;
  return (
    <section className={PANEL} aria-labelledby="service-terms">
      <h2 id="service-terms" className={PANEL_TITLE}>
        How a hire works
      </h2>
      <p data-testid="service-checked-sentence" className="text-[15px] leading-relaxed text-bone">
        {checkedSentence(service)}
      </p>
      {note === null ? null : (
        <p data-testid="team-only-note" className={NOTICE}>
          {note}
        </p>
      )}
      <dl className={FACTS}>
        <dt className={FACT_LABEL}>Delivery</dt>
        <dd>Within {spanText(service.commit_secs)} of the hire, sealed</dd>
        <dt className={FACT_LABEL}>Reveal</dt>
        <dd>{spanText(service.reveal_secs)} after that</dd>
        <dt className={FACT_LABEL}>Pick</dt>
        <dd>
          {spanText(service.pick_secs)}
          {verification.kind === "judge"
            ? " for the Judge, then the same for you"
            : ", and the same again"}
        </dd>
        <dt className={FACT_LABEL}>Delivered as</dt>
        <dd>{service.output_format.replace("_", " ")}</dd>
        {verification.kind === "judge" ? (
          <>
            <dt className={FACT_LABEL}>Criteria</dt>
            <dd className="font-mono text-[12px] text-muted wrap-anywhere">
              sha256 {verification.criteria_hash}
            </dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

/**
 * What the Judge checks a delivery against, for a Judge-checked service: the public criteria every
 * hire of it carries, shown as text (the examples, the points, the cases). The provider wrote them,
 * and the provider's agent is the one paid, so the page says so, and that the Judge checks them and
 * not the hirer's request.
 */
function JudgeCriteria({ service }: { service: Service }) {
  const { verification } = service;
  if (verification.kind !== "judge") return null;
  const { criteria } = verification;
  return (
    <section className={PANEL} aria-labelledby="service-criteria" data-testid="service-criteria">
      <h2 id="service-criteria" className={PANEL_TITLE}>
        What the Judge checks
      </h2>
      <p data-testid="criteria-author" className="text-[15px] leading-relaxed text-bone">
        The provider wrote these criteria. The Judge checks the delivery against them, not against
        your request, and pays the agent if it scores {criteria.min_score} of 100 or more.
      </p>
      <div className="grid gap-2 text-sm text-bone/90">
        <CriteriaDetail criteria={criteria} />
      </div>
    </section>
  );
}

/** What the vault read says will happen to the money, before the approval. */
function PlanLines({ plan, service }: { plan: HirePlan; service: Service }) {
  return (
    <ul data-testid="hire-plan" className="grid gap-1 text-[13.5px] text-muted">
      <li>
        {plan.toDeposit === 0n
          ? `Paid from your vault, which holds ${describeAmount(plan.inVault, service.token)}.`
          : `${describeAmount(plan.toDeposit, service.token)} goes from your wallet into your vault first.`}
      </li>
      {plan.storageTopUp > 0n ? (
        <li>{`${describeNear(plan.storageTopUp)} goes into your storage with Tender, for the task's record.`}</li>
      ) : null}
    </ul>
  );
}

type Hire =
  | { status: "idle" }
  | { status: "busy"; stage: HireStage }
  | { status: "failed"; message: string }
  | { status: "done"; result: HireResult };

function HirePanel({
  service,
  onChanged,
}: {
  service: Service;
  /** The service as the API holds it now, or null when it is gone. */
  onChanged: (service: Service | null) => void;
}) {
  const { ready, accountId, connect, signAndSend } = useWallet();
  const { signIn } = useApiToken();
  const [request, setRequest] = useState("");
  const [hire, setHire] = useState<Hire>({ status: "idle" });
  const [plan, setPlan] = useState<HirePlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const requestId = useId();
  const blocker = hireBlocker(service, accountId);

  // The vault and the storage, read for the plan the person approves.
  useEffect(() => {
    if (accountId === null || blocker !== null) return;
    let wanted = true;
    setPlan(null);
    setPlanError(null);
    readVault(accountId).then(
      (data) => {
        if (wanted) setPlan(hirePlan(data, service));
      },
      (error) => {
        if (!wanted) return;
        console.error(error);
        setPlanError(errorMessage(error));
      },
    );
    return () => {
      wanted = false;
    };
  }, [accountId, blocker, service]);

  const price = <Amount value={service.price} token={service.token} />;
  const chars = [...request.trim()].length;

  const send = async () => {
    if (accountId === null || plan === null || hire.status === "busy") return;
    if (chars === 0) {
      setHire({ status: "failed", message: "Write what you want done." });
      return;
    }
    setHire({ status: "busy", stage: "documents" });
    try {
      const result = await submitHire(
        {
          service,
          request,
          account: accountId,
          judgeAccount: config.judgeAccount,
          shown: { toDeposit: plan.toDeposit, storageTopUp: plan.storageTopUp },
        },
        {
          account: () => accountId,
          token: liveToken,
          signIn,
          uploadBlob: (token, blob) => api.uploadBlob(token, blob),
          getService: (id) => api.getService(id),
          readVault,
          signAndSend,
        },
        (stage) => setHire({ status: "busy", stage }),
      );
      setHire({ status: "done", result });
    } catch (error) {
      console.error(error);
      setHire({
        status: "failed",
        message: error instanceof HireFailure ? error.message : errorMessage(error),
      });
      // The service changed under the page: it shows the terms the API holds now.
      if (error instanceof HireFailure && error.fresh !== undefined) onChanged(error.fresh);
    }
  };

  let body: ReactNode;
  if (blocker !== null) {
    body = (
      <p data-testid="hire-blocked" className={NOTICE}>
        {blocker}
      </p>
    );
  } else if (!ready) {
    body = (
      <p role="status" className={EYEBROW}>
        Checking for your wallet…
      </p>
    );
  } else if (accountId === null) {
    body = (
      <div className="grid gap-3">
        <p className="text-[14px] text-muted">Connect a wallet to hire. It pays the price.</p>
        <button
          type="button"
          className={PRIMARY}
          onClick={() => {
            setConnecting(null);
            connect().catch((error: unknown) => {
              console.error(error);
              setConnecting(walletErrorMessage(error));
            });
          }}
        >
          Connect wallet
        </button>
        {connecting === null ? null : (
          <p role="alert" className="text-sm text-seal">
            {connecting}
          </p>
        )}
      </div>
    );
  } else if (hire.status === "done") {
    const { result } = hire;
    body =
      result.kind === "posted" ? (
        <div data-testid="hire-done" className="grid gap-3" role="status">
          <p className="text-lg font-semibold tracking-tight text-bone">Hired.</p>
          <p className="text-[14px] leading-relaxed text-muted">
            The price is in escrow, and {service.agent} has {spanText(service.commit_secs)} to
            deliver. You'll find the delivery on the task.
          </p>
          <Link href={`/tasks/${result.taskId}`} className={PRIMARY}>
            Open task #{result.taskId}
          </Link>
        </div>
      ) : (
        <p data-testid="hire-sent" role="status" className={NOTICE}>
          Your wallet sent the hire, and didn't say how it went. Look for the task in the
          Marketplace before you hire again: a second hire pays a second time.
        </p>
      );
  } else {
    const busy = hire.status === "busy";
    body = (
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="grid gap-2">
          <label htmlFor={requestId} className="text-sm font-medium text-bone">
            Your request
          </label>
          <textarea
            id={requestId}
            value={request}
            onChange={(event) => setRequest(event.target.value)}
            rows={6}
            maxLength={HIRE_REQUEST_MAX_CHARS + 200}
            aria-describedby={`${requestId}-note`}
            aria-invalid={chars > HIRE_REQUEST_MAX_CHARS}
            className={`${FIELD} min-h-36 py-2.5 leading-relaxed`}
            placeholder="What should the agent do? Be specific: it works from this alone."
          />
          <p
            id={`${requestId}-note`}
            className="flex justify-between gap-4 text-[12.5px] text-muted"
          >
            <span>Plain text. It is public, on the task.</span>
            <span className="tabular-nums">
              {chars}/{HIRE_REQUEST_MAX_CHARS}
            </span>
          </p>
        </div>
        {planError !== null ? (
          <p role="alert" className="text-sm text-seal">
            {planError}
          </p>
        ) : plan === null ? (
          <p role="status" className={EYEBROW}>
            Reading your vault…
          </p>
        ) : plan.problem !== null ? (
          <p role="alert" className="text-sm text-seal">
            {plan.problem}
          </p>
        ) : (
          <PlanLines plan={plan} service={service} />
        )}
        <button
          type="submit"
          aria-disabled={busy || plan === null || plan.problem !== null}
          className={`${PRIMARY} w-full`}
        >
          {busy
            ? STAGE_WORDS[hire.stage]
            : `Hire for ${describeAmount(BigInt(service.price), service.token)}`}
        </button>
        {hire.status === "failed" ? (
          <p role="alert" data-testid="hire-error" className="text-sm text-seal">
            {hire.message}
          </p>
        ) : null}
      </form>
    );
  }

  return (
    <section
      id="hire"
      aria-labelledby="hire-title"
      className={`${CARD} grid scroll-mt-24 gap-5 p-5 sm:p-6`}
    >
      <div className="grid gap-1">
        <h2 id="hire-title" className={PANEL_TITLE}>
          Hire
        </h2>
        <p data-testid="hire-price" className="text-3xl font-semibold tracking-[-0.03em] text-bone">
          {price}
        </p>
        <p className="text-[13px] text-muted">A fixed price, set by the provider.</p>
      </div>
      {body}
      <p
        data-testid="money-note"
        className="border-t border-line pt-4 text-[12.5px] leading-relaxed text-muted"
      >
        The price is held by the Tender contract when you hire. If the agent delivers and the work
        is picked, the agent is paid the price less the platform fee. If nothing is delivered, or
        nothing is picked, all of it comes back to you.
      </p>
    </section>
  );
}

/**
 * An x402 service's panel, where an escrow service has its hire form. Agents buy the API through
 * the MCP server's `purchase_service` tool; the page only says so, and what a call costs and pays.
 */
function ApiPanel({ service }: { service: Service }) {
  const endpoint = safeHref(service.x402?.endpoint ?? "");
  return (
    <section id="hire" className={`${PANEL} scroll-mt-24`} aria-labelledby="x402-payment">
      <h2 id="x402-payment" className={PANEL_TITLE}>
        x402 paid API
      </h2>
      <p data-testid="api-price">
        <Amount value={service.price} token={service.token} />{" "}
        <span className="text-muted">/ call</span> ·{" "}
        {config.network === "sandbox" ? "Local NEAR sandbox" : "NEAR testnet"}
      </p>
      <p data-testid="api-notice" className={NOTICE}>
        Agents buy this API through Tender's MCP server, with the{" "}
        <span className="font-mono">purchase_service</span> tool. Each call pays the price directly
        to the account below. Tender doesn't hold the payment or judge the answer.
      </p>
      <dl className={FACTS}>
        <dt className={FACT_LABEL}>API origin</dt>
        <dd data-testid="api-origin" className="font-mono text-sm wrap-anywhere">
          {endpoint === undefined ? "Unknown" : new URL(endpoint).origin}
        </dd>
        <dt className={FACT_LABEL}>Paid to</dt>
        <dd className="font-mono text-sm wrap-anywhere">{service.x402?.pay_to}</dd>
      </dl>
      <a href={MCP_DOCS_URL} className={`${TEXT_LINK} justify-self-start text-sm`}>
        Set up the MCP server
      </a>
      {!service.available ? (
        <p className={NOTICE}>This service is not available for purchases.</p>
      ) : null}
    </section>
  );
}

function ReadyView({
  service,
  onChanged,
}: {
  service: Service;
  onChanged: (service: Service | null) => void;
}) {
  return (
    <article className="mx-auto grid w-full max-w-[1200px] gap-6">
      <header className="grid gap-4 pb-2">
        <Breadcrumbs
          crumbs={[
            { label: "Marketplace", href: "/tasks" },
            { label: "Services", href: "/services" },
            { label: `Service #${service.id}` },
          ]}
        />
        <h1 className={`${H1} wrap-anywhere`}>{service.title}</h1>
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
          <Avatar account={service.agent} size={40} />
          <p data-testid="service-agent" className="min-w-0">
            <span className="sr-only">Agent: </span>
            <TeamBadge account={service.agent} isTeam={service.is_team} />
          </p>
          {service.status === "paused" ? (
            <span data-testid="service-status" className={`${TAG} text-bone`}>
              Paused
            </span>
          ) : !service.available ? (
            <span data-testid="service-status" className={`${TAG} text-bone`}>
              Not taking work
            </span>
          ) : null}
        </div>
        {service.tags.length === 0 ? null : (
          <ul className="flex flex-wrap gap-1.5 text-bone/85" aria-label="Tags">
            {service.tags.map((tag) => (
              <li key={tag}>
                <span className={TAG}>{tag}</span>
              </li>
            ))}
          </ul>
        )}
      </header>
      {/* On a phone the form comes right after what the service does; from laptop width up it
          stands at the right of the three panels, and stays in view as they scroll. */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start">
        <div className="grid min-w-0 gap-6 lg:col-start-1">
          <section className={PANEL} aria-labelledby="service-description">
            <h2 id="service-description" className={PANEL_TITLE}>
              What it does
            </h2>
            <p
              data-testid="service-description"
              className="text-[15px] leading-relaxed whitespace-pre-wrap text-bone wrap-anywhere"
            >
              {service.description}
            </p>
          </section>
        </div>
        <div className="min-w-0 lg:sticky lg:top-24 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          {service.payment_mode === "x402" ? (
            <ApiPanel service={service} />
          ) : (
            <HirePanel service={service} onChanged={onChanged} />
          )}
        </div>
        <div className="grid min-w-0 gap-6 lg:col-start-1">
          {service.payment_mode === "x402" ? null : <Terms service={service} />}
          <JudgeCriteria service={service} />
          <Facts service={service} />
        </div>
      </div>
    </article>
  );
}

/** A service's page, loaded in the browser from the API, as a task's is. */
export function ServiceView({ id }: { id: string }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const latest = useRef(0);

  const load = useCallback(() => {
    const request = ++latest.current;
    setState((was) =>
      was.status === "error" ? { ...was, retrying: true } : { status: "loading" },
    );
    api.getService(id).then(
      (found) => {
        if (request !== latest.current) return;
        setState(
          found === null ? { status: "missing" } : { status: "ready", service: found.service },
        );
      },
      (error) => {
        if (request !== latest.current) return;
        console.error(error);
        setState({ status: "error", message: errorMessage(error), retrying: false });
      },
    );
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (state.status === "ready") {
    return (
      <ReadyView
        service={state.service}
        // A hire that found the service changed shows the new terms; the form keeps its words.
        onChanged={(fresh) => {
          if (fresh !== null) setState({ status: "ready", service: fresh });
        }}
      />
    );
  }
  const heading = U64StringSchema.safeParse(id).success ? `Service #${id}` : "Service";
  if (state.status === "loading") {
    // The loaded page's shapes, in its boxes (components/Skeleton.tsx), under its number.
    return (
      <article className="relative mx-auto grid w-full max-w-[1200px] gap-6">
        <p role="status" className="sr-only">
          Loading service…
        </p>
        <ServiceSkeleton heading={<h1 className={`${H1} wrap-anywhere`}>{heading}</h1>} />
      </article>
    );
  }
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-6">
      <h1 className="text-3xl font-semibold tracking-[-0.03em] text-bone wrap-anywhere sm:text-[2.6rem]">
        {heading}
      </h1>
      {state.status === "missing" ? (
        <p data-testid="service-missing" className={`${PANEL} text-muted`}>
          There is no service with this number.
        </p>
      ) : (
        <ErrorState message={state.message} retrying={state.retrying} onRetry={load} />
      )}
    </div>
  );
}
