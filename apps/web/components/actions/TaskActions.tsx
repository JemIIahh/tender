"use client";

import type { TaskDetailResponse } from "@tender/shared";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  type ActionAnchor,
  anchorOf,
  type PickView,
  pickView,
  refundView,
  topUpOpen,
} from "../../lib/actions";
import { heldToken, noToken, subscribeToken } from "../../lib/apiToken";
import type { PickResult } from "../../lib/pick";
import type { RefundResult } from "../../lib/refund";
import type { TopUpResult } from "../../lib/topUp";
import { describeAmount } from "../../lib/vault";
import { type UseWallet, useWallet } from "../../lib/wallet";
import { walletErrorMessage } from "../../lib/walletErrors";
import { Countdown } from "../Countdown";
import { JudgeNote } from "../JudgeNote";
import { CARD, EYEBROW, NOTICE, PANEL_TITLE, PRIMARY } from "../ui";
import { PickPanel } from "./PickPanel";
import { RefundPanel } from "./RefundPanel";
import { TopUpPanel } from "./TopUpPanel";

/** What an action came to, kept for the page until it is left. */
interface Sent {
  pick?: PickResult;
  refund?: RefundResult;
  topUp?: TopUpResult;
}

/**
 * One action's place on the page, with the id that other pages link to (`/tasks/7#pick`). A page
 * opened at that address scrolls here once the section is there: the task is loaded after the page,
 * so the browser's own scroll to the address finds nothing.
 */
function ActionSection({
  anchor,
  title,
  children,
}: {
  anchor: ActionAnchor;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (anchorOf(window.location.hash) === anchor) ref.current?.scrollIntoView();
  }, [anchor]);
  return (
    <section
      ref={ref}
      id={anchor}
      aria-labelledby={`${anchor}-title`}
      data-testid={`action-${anchor}`}
      className={`${CARD} grid scroll-mt-24 gap-4 p-5 sm:p-6`}
    >
      <h2 id={`${anchor}-title`} className={PANEL_TITLE}>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** The way in for someone with no wallet connected: a Connect button and its failure. */
function Connect({ wallet, why }: { wallet: UseWallet; why: string }) {
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <div className="grid gap-3">
      <p className="text-[14px] text-muted">{why}</p>
      <button
        type="button"
        className={PRIMARY}
        onClick={() => {
          setFailure(null);
          wallet.connect().catch((error: unknown) => {
            console.error(error);
            setFailure(walletErrorMessage(error));
          });
        }}
      >
        Connect wallet
      </button>
      {failure === null ? null : (
        <p role="alert" className="text-sm text-seal">
          {failure}
        </p>
      )}
    </div>
  );
}

/** What a sent pick came to, while the page waits for the index and once it has caught up. */
function pickNotice(result: PickResult, settled: boolean): string {
  if (result.kind === "unknown") {
    return "Your wallet sent the pick and didn't say how it went. This page updates when the chain shows it: look before you pick again.";
  }
  const what = result.kind === "picked" ? "The pick is on chain" : "The pick of nobody is on chain";
  return settled
    ? `${what}. The payouts and the scorecard are below.`
    : `${what}. This page updates as Tender's index catches up.`;
}

function refundNotice(result: RefundResult, settled: boolean): string {
  if (result.kind === "unknown") {
    return "Your wallet sent the refund and didn't say how it went. This page updates when the chain shows it.";
  }
  return settled
    ? "Refunded: each funder has what it paid in back in its vault. The payouts are below."
    : "Refunded on chain. This page updates as Tender's index catches up.";
}

function topUpNotice(result: TopUpResult, token: string): string {
  if (result.kind === "unknown") {
    return "Your wallet sent the top-up and didn't say how it went. Check the reward before you top up again.";
  }
  return `Added ${describeAmount(BigInt(result.amount), token)}. The reward is now ${describeAmount(BigInt(result.reward), token)}.`;
}

/**
 * The actions on a task's page (`#pick`, `#refund`, `#top-up`), each shown when the contract would
 * take it now (lib/actions.ts): picking for the account whose window is open, refunding for anyone
 * once it opens, and topping up for anyone while the task takes entries. With no wallet connected,
 * each says who can act and offers to connect. The wallet is looked for only if this tab signed in
 * before, or the page was opened at one of the actions' addresses: a reader loads no wallet library
 * until they press Connect.
 *
 * After an action the section says it was sent, and the page updates from the event stream, as it
 * does for anyone else's.
 */
export function TaskActions({
  data,
  nowNs,
  judgeAccount,
}: {
  data: TaskDetailResponse;
  nowNs: bigint;
  judgeAccount: string | null;
}) {
  const stored = useSyncExternalStore(subscribeToken, heldToken, noToken);
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    setAsked(anchorOf(window.location.hash) !== null);
  }, []);
  const start = stored !== null || asked;
  const wallet = useWallet({ start });
  // A store that was never started has not looked for a wallet: nobody is connected.
  const account = wallet.accountId;
  const [sent, setSent] = useState<Sent>({});
  const { task } = data;
  const settled = task.outcome_kind !== null;

  const pick: PickView | null = pickView(task, account, judgeAccount, nowNs);
  const refund = refundView(task, nowNs);
  const topUp = topUpOpen(task, nowNs);
  const looking = start && !wallet.ready;

  const sections: ReactNode[] = [];

  if (sent.pick !== undefined || pick !== null) {
    let body: ReactNode;
    if (sent.pick !== undefined) {
      body = (
        <p role="status" data-testid="pick-sent" className={NOTICE}>
          {pickNotice(sent.pick, settled)}
        </p>
      );
    } else if (pick?.kind === "judge") {
      body = (
        <div className="grid gap-2 text-[14px] text-muted" data-testid="pick-judge">
          <p className="text-bone">The Judge picks this task.</p>
          <p>
            {
              "The Tender Judge, run by the Tender team, scores the revealed entries and picks before the pick deadline, in "
            }
            <Countdown toNs={BigInt(task.pick_deadline)} nowNs={nowNs} />
            {". If it doesn't, the poster can pick after that."}
          </p>
          <JudgeNote status={task.judge_status} reason={task.judge_reason} />
        </div>
      );
    } else if (looking) {
      body = (
        <p role="status" className={EYEBROW}>
          Checking for your wallet…
        </p>
      );
    } else if (pick?.kind === "connect") {
      body = (
        <Connect
          wallet={wallet}
          why={`Picking is open for ${pick.account}. If that's you, connect your wallet to pick.`}
        />
      );
    } else if (pick?.kind === "pick") {
      body = (
        <PickPanel
          data={data}
          as={pick.as}
          nowNs={nowNs}
          judgeAccount={judgeAccount}
          wallet={wallet}
          onSent={(result) => setSent((was) => ({ ...was, pick: result }))}
        />
      );
    }
    sections.push(
      <ActionSection key="pick" anchor="pick" title="Pick the winners">
        {body}
      </ActionSection>,
    );
  }

  if (sent.refund !== undefined || refund !== null) {
    let body: ReactNode;
    if (sent.refund !== undefined) {
      body = (
        <p role="status" data-testid="refund-sent" className={NOTICE}>
          {refundNotice(sent.refund, settled)}
        </p>
      );
    } else if (refund !== null && refund.kind === "open" && account === null && !looking) {
      body = (
        <Connect
          wallet={wallet}
          why="Anyone can refund the funders now. Connect a wallet to send it."
        />
      );
    } else if (refund !== null) {
      body = (
        <RefundPanel
          data={data}
          view={refund}
          nowNs={nowNs}
          wallet={wallet}
          onSent={(result) => setSent((was) => ({ ...was, refund: result }))}
        />
      );
    }
    sections.push(
      <ActionSection key="refund" anchor="refund" title="Refund">
        {body}
      </ActionSection>,
    );
  }

  if (topUp) {
    let body: ReactNode;
    if (looking) {
      body = (
        <p role="status" className={EYEBROW}>
          Checking for your wallet…
        </p>
      );
    } else if (account === null) {
      body = (
        <Connect
          wallet={wallet}
          why="Anyone can add to this reward until the commit window closes. Connect a wallet to top up from your vault."
        />
      );
    } else {
      body = (
        <TopUpPanel
          data={data}
          nowNs={nowNs}
          wallet={wallet}
          refresh={`${task.reward}:${data.funders.length}`}
          onSent={(result) => setSent((was) => ({ ...was, topUp: result }))}
        />
      );
    }
    sections.push(
      <ActionSection key="top-up" anchor="top-up" title="Top up">
        {sent.topUp === undefined ? null : (
          <p role="status" data-testid="top-up-sent" className={NOTICE}>
            {topUpNotice(sent.topUp, task.token)}
          </p>
        )}
        {body}
      </ActionSection>,
    );
  }

  if (sections.length === 0) return null;
  return (
    <div data-testid="task-actions" className="grid gap-5">
      {sections}
    </div>
  );
}
