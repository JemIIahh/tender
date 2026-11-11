"use client";

import type { AgentDetailResponse, RunnerPolicy } from "@tender/shared";
import type { ReactNode } from "react";
import { bondOf } from "../lib/account";
import { config } from "../lib/config";
import {
  type ChainFacts,
  type ChainRead,
  chainTimeText,
  countKeys,
  DELEGATE_CHECKS,
  durationText,
  ENFORCER_WORDS,
  type Enforcer,
  keysText,
  readChainFacts,
  shortKey,
} from "../lib/safety";
import { type Loaded, useLoad } from "../lib/useLoad";
import { Amount } from "./Amount";
import { SectionRule } from "./SectionRule";
import { CARD, PANEL_TITLE } from "./ui";

// An agent's Safety section: what it can and cannot do, and who holds it to each line. Only what
// Tender can read is here, each line tagged with who enforces it: the contract (its state, read
// through its views or the API's index of its events), NEAR itself (the keys on the account), or
// the team's runner (the run-agent command's defaults, for an agent the deployment names as one the
// team runs with a model). What no one here can read is not shown.

/**
 * One line: a short label, the value, a muted line under it if it needs one, and who enforces it.
 * In a narrow card (a phone, or one of two cards side by side) the label and the tag share the top
 * row and the value has the width under them; in a wide one the three are columns. The card is the
 * container the width is measured on (`@container` on the list).
 */
function Fact({
  label,
  by,
  sub,
  testId,
  children,
}: {
  label: string;
  by: Enforcer;
  sub?: ReactNode;
  testId: string;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1 border-t border-line py-3.5 first:border-t-0 first:pt-0 last:pb-0 @xl:grid-cols-[9.5rem_minmax(0,1fr)_auto]"
    >
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className="col-span-2 row-start-2 grid min-w-0 gap-0.5 text-[15px] text-bone @xl:col-span-1 @xl:col-start-2 @xl:row-start-1">
        <span className="wrap-anywhere">{children}</span>
        {sub === undefined ? null : (
          <span className="text-[13px] leading-snug text-muted">{sub}</span>
        )}
      </dd>
      <dd
        data-testid="enforced-by"
        className="col-start-2 row-start-1 justify-self-end rounded-full border border-line px-2 py-0.5 text-[11px] leading-4 whitespace-nowrap text-muted @xl:col-start-3"
      >
        {ENFORCER_WORDS[by]}
      </dd>
    </div>
  );
}

/** What a line says of a read of the chain that is on its way, or that failed. */
function pending<T>(chain: Loaded<ChainFacts>, pick: (facts: ChainFacts) => ChainRead<T> | null) {
  if (chain.status !== "ready") return { state: "reading" as const };
  const read = pick(chain.data);
  if (read === null || !read.ok) return { state: "failed" as const };
  return { state: "read" as const, value: read.value };
}

const READING = "Reading the chain…";
const UNREADABLE = "Can’t read it from the chain now.";

function BondFact({ detail, chain }: { detail: AgentDetailResponse; chain: Loaded<ChainFacts> }) {
  const bond = bondOf(detail.agent);
  // An API from before bonds sends no status: Tender does not know, which is not "none".
  if (bond === null) {
    return (
      <Fact label="Bond" by="contract" testId="safety-bond">
        Not known
      </Fact>
    );
  }
  const amount =
    bond.token !== null && bond.amount !== null ? (
      <Amount value={bond.amount} token={bond.token} />
    ) : null;
  if (bond.status === "retired") {
    // An agent from before bonds retires with none to pay back.
    return (
      <Fact
        label="Bond"
        by="contract"
        testId="safety-bond"
        sub="Any bond it held went back to its vault."
      >
        None now
      </Fact>
    );
  }
  if (bond.status === "unregistering") {
    const at = bond.claimableAt === null ? null : chainTimeText(bond.claimableAt);
    return (
      <Fact
        label="Bond"
        by="contract"
        testId="safety-bond"
        sub={
          amount === null || at === null ? (
            "Leaving."
          ) : (
            <>
              Leaving. Claimable from <time dateTime={at.iso}>{at.text}</time>.
            </>
          )
        }
      >
        {amount ?? "None"}
      </Fact>
    );
  }
  // Active. How long a bond stays after the agent leaves is the cooldown in force when it leaves,
  // which the owner can change, or later, if it has entered an open task still taking entries then.
  const terms = pending(chain, (facts) => facts.terms);
  const set = terms.state === "read" && terms.value.state === "set" ? terms.value : null;
  if (amount === null) {
    return (
      <Fact
        label="Bond"
        by="contract"
        testId="safety-bond"
        sub={set === null ? undefined : "Until it pays one, it enters only tasks that invite it."}
      >
        None
      </Fact>
    );
  }
  const cooldown = set?.cooldownSecs ?? null;
  return (
    <Fact
      label="Bond"
      by="contract"
      testId="safety-bond"
      sub={
        cooldown === null
          ? "Held while it is active."
          : `Held while it is active. Claimable at least ${durationText(cooldown)} after it leaves, at today’s cooldown.`
      }
    >
      {amount}
    </Fact>
  );
}

/**
 * The delegate keys of the account, as the chain says: of its own keys that could spend as a
 * delegate's, the ones the contract has a record for (`get_delegate`), at most `DELEGATE_CHECKS`
 * of them asked about.
 */
function DelegateFacts({ chain }: { chain: Loaded<ChainFacts> }) {
  const read = pending(chain, (facts) => facts.delegates);
  if (read.state !== "read") {
    return (
      <Fact label="Delegate keys" by="contract" testId="safety-delegates">
        {read.state === "reading" ? READING : UNREADABLE}
      </Fact>
    );
  }
  const { found, unchecked } = read.value;
  const more =
    unchecked === 0
      ? undefined
      : `And ${unchecked} more ${unchecked === 1 ? "key" : "keys"} not checked.`;
  if (found.length === 0) {
    return (
      <Fact
        label="Delegate keys"
        by="contract"
        testId="safety-delegates"
        sub={more ?? "Every spend from its vault needs a full-access key."}
      >
        {unchecked === 0 ? "None" : `None among the ${DELEGATE_CHECKS} keys checked`}
      </Fact>
    );
  }
  return (
    <>
      {found.map(({ publicKey, view }, index) => (
        <Fact
          key={publicKey}
          label="Delegate key"
          by="contract"
          testId="safety-delegate"
          sub={
            <>
              Spent <Amount value={view.spent} token={view.token} />
              {" · "}
              <span title={publicKey} className="font-mono text-[12px]">
                {shortKey(publicKey)}
              </span>
              {more !== undefined && index === found.length - 1 ? (
                <span className="block">{more}</span>
              ) : null}
            </>
          }
        >
          <Amount value={view.per_task_cap} token={view.token} /> a post or top-up,{" "}
          <Amount value={view.total_cap} token={view.token} /> in all
        </Fact>
      ))}
    </>
  );
}

function KeysFact({ chain }: { chain: Loaded<ChainFacts> }) {
  const keys = pending(chain, (facts) => facts.keys);
  return (
    <Fact label="Keys on its account" by="near" testId="safety-keys">
      {keys.state === "reading"
        ? READING
        : keys.state === "failed"
          ? UNREADABLE
          : keys.value === null
            ? "The chain has no such account."
            : keysText(countKeys(keys.value, config.contractId))}
    </Fact>
  );
}

/**
 * Who checks a hire the agent takes on: a hire through Tender is held to the checker its service
 * names; an x402 call to its API is paid at once and has no checker. `x402Apis` is how many x402
 * APIs it lists, or null while its services are not known.
 */
function hiresCheckedText(x402Apis: number | null): string {
  const tender = "Hires through Tender: the checker its service names.";
  if (x402Apis === null || x402Apis === 0) return tender;
  return `${tender} ${x402Apis === 1 ? "Its x402 API has" : "Its x402 APIs have"} no checker.`;
}

/** What the Hiring line says under it: x402 purchases are outside the contract. */
function x402Text(x402Apis: number | null): string {
  const outside = "x402 purchases are paid directly. The contract doesn’t limit them.";
  if (x402Apis === null || x402Apis === 0) return outside;
  return `${outside} It lists ${x402Apis === 1 ? "an x402 API" : `${x402Apis} x402 APIs`}.`;
}

/** The team runner's defaults, line by line: the runner's settings, not the contract's. */
function PolicyFacts({ policy, x402Apis }: { policy: RunnerPolicy; x402Apis: number | null }) {
  const voids = policy.max_poster_voids;
  return (
    <>
      <Fact
        label="Checked by"
        by="runner"
        testId="safety-verifiers"
        sub={hiresCheckedText(x402Apis)}
      >
        {policy.verifiers === "judge" ? "The Judge only, once it accepts the task" : "Any checker"}
      </Fact>
      {policy.daily_entries === null ? null : (
        <Fact
          label="Tasks and hirer-checked hires a day"
          by="runner"
          testId="safety-daily-entries"
          sub={
            policy.daily_judged_hires === null
              ? undefined
              : "Judge-checked hires have their own cap."
          }
        >
          {`At most ${policy.daily_entries}`}
        </Fact>
      )}
      {policy.daily_judged_hires === null ? null : (
        <Fact label="Judge-checked hires a day" by="runner" testId="safety-daily-hires">
          {`At most ${policy.daily_judged_hires}`}
        </Fact>
      )}
      {voids === null ? null : (
        <Fact label="Posters" by="runner" testId="safety-poster-voids">
          {`Skips one with more than ${voids} ${voids === 1 ? "task" : "tasks"} voided after reveal (not the team’s own)`}
        </Fact>
      )}
      {policy.daily_entries === null && policy.daily_judged_hires === null ? null : (
        <Fact
          label="Count unreadable"
          by="runner"
          testId="safety-fails-closed"
          sub="When the day’s count can’t be read or saved."
        >
          It takes nothing on
        </Fact>
      )}
    </>
  );
}

/**
 * The agent's runner: the team's run-agent command, with its defaults, for an agent the deployment
 * names as run with a model; another team agent's, whose settings are not shown; or another
 * owner's, which Tender cannot see.
 */
function WorkCard({ detail, x402Apis }: { detail: AgentDetailResponse; x402Apis: number | null }) {
  const policy = detail.runner_policy ?? null;
  return (
    <div data-testid="safety-work" className={`${CARD} grid content-start gap-4 p-5 sm:p-6`}>
      <h3 className={PANEL_TITLE}>Work it takes on</h3>
      {policy !== null ? (
        <>
          <p data-testid="safety-runner-defaults" className="text-[13px] leading-snug text-muted">
            Defaults of the team&rsquo;s runner for an agent with a model. Tender can&rsquo;t see
            the flags it runs with.
          </p>
          <dl className="@container grid">
            <PolicyFacts policy={policy} x402Apis={x402Apis} />
          </dl>
        </>
      ) : detail.agent.is_team ? (
        <p data-testid="safety-runner-team" className="text-[15px] text-muted">
          The team runs it. Its runner&rsquo;s settings aren&rsquo;t shown here.
        </p>
      ) : (
        <p data-testid="safety-runner-unknown" className="text-[15px] text-muted">
          Its owner&rsquo;s runner sets which tasks it takes. Tender can&rsquo;t see those settings.
        </p>
      )}
    </div>
  );
}

/**
 * Section 04 of an agent's page. From the API: its bond (`status`, `bond_token`, `bond_amount`,
 * `claimable_at`) and, for an agent the deployment names as one the team runs with a model, the
 * team's runner's defaults. From the chain: the keys on its account, the delegate keys among them
 * with their caps and what each spent, and the bond's cooldown. From the page: how many x402 APIs
 * the agent lists, which are paid at once, outside the contract, and have no checker.
 */
export function SafetySection({
  detail,
  x402Apis = null,
}: {
  detail: AgentDetailResponse;
  /** How many x402 APIs the agent lists among its services; null while they are not known. */
  x402Apis?: number | null;
}) {
  const { agent } = detail;
  const active = agent.status === "active";
  const [chain] = useLoad(agent.account, (account) => readChainFacts(account, active));
  return (
    <section aria-labelledby="agent-safety" className="grid gap-6">
      <SectionRule n={4} id="agent-safety" title="Safety" />
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
        <div data-testid="safety-money" className={`${CARD} grid content-start gap-4 p-5 sm:p-6`}>
          <h3 className={PANEL_TITLE}>Money and keys</h3>
          <dl className="@container grid">
            <Fact
              label="Vault"
              by="contract"
              testId="safety-vault"
              sub="Withdrawing needs a full-access key."
            >
              Spends only from its own vault
            </Fact>
            <BondFact detail={detail} chain={chain} />
            <DelegateFacts chain={chain} />
            <Fact label="Hiring" by="contract" testId="safety-hiring" sub={x402Text(x402Apis)}>
              A hire through Tender pays at most its reward, held in escrow.
            </Fact>
            <KeysFact chain={chain} />
          </dl>
        </div>
        <WorkCard detail={detail} x402Apis={x402Apis} />
      </div>
    </section>
  );
}
