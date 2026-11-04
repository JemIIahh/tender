"use client";

import {
  HAND_PICK_REASON_MAX,
  type PickWinner,
  revealedForPick,
  splitReward,
  type TaskDetailResponse,
  type TaskEntry,
} from "@tender/shared";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import { useApiToken } from "../../lib/auth";
import { formatBps } from "../../lib/bps";
import { PickFailure, type PickResult, type PickStage, submitPick } from "../../lib/pick";
import { liveToken } from "../../lib/postSubmit";
import { equalShares, equalSplitNote, readShare, shareText, shareTotal } from "../../lib/shares";
import { describeAmount } from "../../lib/vault";
import type { UseWallet } from "../../lib/wallet";
import { Amount } from "../Amount";
import { Countdown } from "../Countdown";
import { TeamBadge } from "../TeamBadge";
import { FACT_LABEL, FIELD, NOTICE, PRIMARY, SECONDARY } from "../ui";
import { Delivery } from "./Delivery";

const STAGE_WORDS: Record<PickStage, string> = {
  check: "Checking the task…",
  signin: "Signing in with your wallet…",
  upload: "Publishing the scorecard…",
  wallet: "Waiting for your wallet to approve…",
};

type Run =
  | { status: "idle" }
  | { status: "busy"; stage: PickStage }
  | { status: "failed"; message: string }
  | { status: "done"; result: PickResult };

/**
 * The entries a person picks from (the shared rule, `revealedForPick`: the ones the scorecard lists),
 * in the order the scorecard's tie-break puts equal scores: block, then account.
 */
function revealedEntries(entries: readonly TaskEntry[]): TaskEntry[] {
  return revealedForPick(entries).sort((a, b) => {
    const x = BigInt(a.committed_height);
    const y = BigInt(b.committed_height);
    if (x !== y) return x < y ? -1 : 1;
    return a.account < b.account ? -1 : a.account > b.account ? 1 : 0;
  });
}

/** How a reveal time reads: `29 Oct, 20:54:59 UTC`, the same wherever the page is opened. */
const REVEAL_TIME = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

/** When an entry was revealed, if the API says (the block time of its reveal), as a `<time>`. */
function RevealedAt({ ns }: { ns: string | null | undefined }) {
  if (ns === null || ns === undefined) return null;
  const at = new Date(Number(BigInt(ns) / 1_000_000n));
  return (
    <>
      {"Revealed "}
      <time dateTime={at.toISOString()}>{`${REVEAL_TIME.format(at)} UTC`}</time>
      {" · "}
    </>
  );
}

/** What the person has chosen, as `pick` takes it, or why it can't be sent yet. */
function winnersOf(
  chosen: readonly string[],
  shares: Readonly<Record<string, string>>,
): { winners: PickWinner[]; problem: string | null; fieldErrors: Record<string, string> } {
  if (chosen.length === 0) return { winners: [], problem: "Choose a winner.", fieldErrors: {} };
  if (chosen.length === 1) {
    return { winners: [{ account: chosen[0] ?? "", bps: 10_000 }], problem: null, fieldErrors: {} };
  }
  const fieldErrors: Record<string, string> = {};
  const winners: PickWinner[] = [];
  for (const account of chosen) {
    const read = readShare(shares[account] ?? "");
    if (read.ok) winners.push({ account, bps: read.bps });
    else fieldErrors[account] = read.message;
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { winners, problem: "Fix the shares marked below.", fieldErrors };
  }
  const total = shareTotal(winners.map((winner) => winner.bps));
  return { winners, problem: total.message, fieldErrors };
}

/**
 * Picking a task's winners, for the account whose window is open: the verifier's, or the poster's
 * after it. Each revealed entry is listed with its delivery, read through the API and shown as
 * text, and the person chooses who wins. One winner gets all of it; several split it equally
 * unless the person changes the shares, which must come to exactly 100%, with any rounding said.
 * The payout is worked out as the contract makes it, with the fee the task was posted with. "Pick
 * nobody" asks first, since it pays no agent. The scorecard is written from the choice, published in
 * the picker's name, and the pick is one wallet approval (lib/pick.ts).
 */
export function PickPanel({
  data,
  as,
  nowNs,
  judgeAccount,
  wallet,
  onSent,
}: {
  data: TaskDetailResponse;
  as: "verifier" | "poster";
  nowNs: bigint;
  judgeAccount: string | null;
  wallet: UseWallet;
  onSent: (result: PickResult) => void;
}) {
  const { task } = data;
  const { signIn } = useApiToken();
  const entries = useMemo(() => revealedEntries(data.entries), [data.entries]);
  const most = task.max_winners;
  const single = most === 1;
  const [chosen, setChosen] = useState<string[]>([]);
  const [shares, setShares] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [run, setRun] = useState<Run>({ status: "idle" });
  const confirmRef = useRef<HTMLFieldSetElement>(null);
  const accountRef = useRef(wallet.accountId);
  accountRef.current = wallet.accountId;
  // The page's clock, which the pick's window is looked at by again when it is sent.
  const nowRef = useRef(nowNs);
  nowRef.current = nowNs;
  // A try again of the same pick writes the same scorecard: the time it was written is kept for as
  // long as the choice is the same.
  const written = useRef<{ key: string; at: Date } | null>(null);
  // A second press before the page has drawn the first as busy sends nothing more.
  const sending = useRef(false);
  const id = useId();

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  const account = wallet.accountId ?? "";
  const deadline = BigInt(as === "verifier" ? task.pick_deadline : task.fallback_deadline);
  const busy = run.status === "busy";

  /** Chooses or drops `who`, and splits the shares equally again among those chosen. */
  function toggle(who: string, on: boolean) {
    const next = single
      ? on
        ? [who]
        : []
      : on
        ? entries.map((entry) => entry.account).filter((a) => a === who || chosen.includes(a))
        : chosen.filter((a) => a !== who);
    setChosen(next);
    setShares(splitEqually(next));
    setRun({ status: "idle" });
  }

  function splitEqually(accounts: readonly string[]): Record<string, string> {
    const equal = equalShares(accounts.length);
    return Object.fromEntries(accounts.map((a, i) => [a, shareText(equal[i] ?? 0)]));
  }

  const choice = winnersOf(chosen, shares);
  const payout =
    choice.problem === null
      ? splitReward(
          BigInt(task.reward),
          task.fee_bps,
          choice.winners.map((winner) => winner.bps),
        )
      : null;
  const equalNote =
    chosen.length > 1 &&
    choice.winners.length === chosen.length &&
    chosen.every((a, i) => shares[a] === shareText(equalShares(chosen.length)[i] ?? 0))
      ? equalSplitNote(chosen.length)
      : null;

  async function send(winners: readonly PickWinner[]) {
    if (busy || sending.current || wallet.accountId === null) return;
    sending.current = true;
    const key = JSON.stringify([winners, reasons]);
    if (written.current?.key !== key) written.current = { key, at: new Date() };
    const writtenAt = written.current.at;
    setRun({ status: "busy", stage: "check" });
    try {
      const result = await submitPick(
        {
          taskId: task.id,
          account: wallet.accountId,
          judgeAccount,
          winners,
          reasons,
          writtenAt,
        },
        {
          account: () => accountRef.current,
          token: liveToken,
          signIn,
          getTask: (taskId) => api.getTask(taskId),
          uploadBlob: (token, blob) => api.uploadBlob(token, blob),
          signAndSend: wallet.signAndSend,
          nowNs: () => nowRef.current,
        },
        (stage) => setRun({ status: "busy", stage }),
      );
      setRun({ status: "done", result });
      setConfirming(false);
      onSent(result);
    } catch (error) {
      console.error(error);
      setRun({
        status: "failed",
        message:
          error instanceof PickFailure
            ? error.message
            : "Something went wrong before the pick was sent. Nothing was paid.",
      });
    } finally {
      sending.current = false;
    }
  }

  const windowLine = (
    <p className="text-[14px] text-muted">
      {as === "verifier"
        ? "You're the verifier. Your window to pick closes in "
        : "The verifier didn't pick in time, so you, the poster, can. Your window closes in "}
      <Countdown toNs={deadline} nowNs={nowNs} />.
    </p>
  );

  if (!wallet.canSignMessage) {
    return (
      <div className="grid gap-3">
        {windowLine}
        <p data-testid="pick-blocked" className={NOTICE}>
          This wallet can't sign messages, and the scorecard is published under a sign-in to Tender.
          Switch to a wallet that signs messages to pick.
        </p>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="grid gap-3">
        {windowLine}
        <p data-testid="pick-none-revealed" className={NOTICE}>
          No entry was revealed, so there is no one to pick. Anyone can refund the funders: see
          Refund below.
        </p>
      </div>
    );
  }

  const funders = data.funders;
  return (
    <div className="grid gap-5">
      {windowLine}

      <fieldset className="grid gap-3" aria-describedby={`${id}-rule`}>
        <legend className={FACT_LABEL}>
          {single ? "Choose the winner" : `Choose up to ${most} winners`}
        </legend>
        <p id={`${id}-rule`} className="text-[13px] text-muted">
          {single
            ? "This task pays one winner, who gets all of the reward after the fee."
            : "Winners split the reward after the fee equally, unless you change their shares."}
        </p>
        <ul className="grid gap-3">
          {entries.map((entry) => {
            const on = chosen.includes(entry.account);
            const full = !single && !on && chosen.length >= most;
            const shareId = `${id}-share-${entry.entry_index}`;
            const reasonId = `${id}-reason-${entry.entry_index}`;
            // The fields are named by their visible labels, and described by whose entry it is.
            const whoId = `${id}-who-${entry.entry_index}`;
            const fieldError = choice.fieldErrors[entry.account];
            return (
              <li
                key={entry.account}
                data-testid="pick-entry"
                data-chosen={on}
                className={`grid gap-3 rounded-xl border p-4 transition-colors motion-reduce:transition-none ${on ? "border-bone/50 bg-raised" : "border-line bg-ink/40"}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <label className="flex min-w-0 cursor-pointer items-start gap-3">
                    <input
                      type={single ? "radio" : "checkbox"}
                      name={single ? `${id}-winner` : undefined}
                      checked={on}
                      disabled={busy || full}
                      onChange={(event) => toggle(entry.account, event.target.checked)}
                      aria-label={`Winner: ${entry.account}`}
                      className="mt-1 size-4 shrink-0 accent-[var(--color-seal)]"
                    />
                    <span className="grid min-w-0 gap-1">
                      <span id={whoId}>
                        <TeamBadge account={entry.account} isTeam={entry.is_team} />
                      </span>
                      <span data-testid="pick-entry-when" className="text-[12.5px] text-muted">
                        <RevealedAt ns={entry.revealed_at} />
                        {`${entry.revealed_at == null ? "Committed" : "committed"} at block ${entry.committed_height}`}
                      </span>
                    </span>
                  </label>
                  {on ? (
                    <span className="rounded-full border border-seal/60 px-2.5 py-1 font-mono text-[10.5px] tracking-[0.14em] text-bone uppercase">
                      Winner
                    </span>
                  ) : null}
                </div>

                <Delivery
                  account={entry.account}
                  contentHash={entry.content_hash ?? ""}
                  uri={entry.uri}
                />

                <div className="grid gap-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
                  {on && chosen.length > 1 ? (
                    <div className="grid content-start gap-1.5">
                      <label htmlFor={shareId} className="text-[13px] text-bone">
                        Share (%)
                      </label>
                      <input
                        id={shareId}
                        inputMode="decimal"
                        value={shares[entry.account] ?? ""}
                        disabled={busy}
                        onChange={(event) =>
                          setShares({ ...shares, [entry.account]: event.target.value })
                        }
                        aria-invalid={fieldError !== undefined}
                        aria-describedby={
                          fieldError === undefined ? whoId : `${whoId} ${shareId}-error`
                        }
                        className={`${FIELD} tabular-nums`}
                      />
                      {fieldError === undefined ? null : (
                        <p id={`${shareId}-error`} role="alert" className="text-[12.5px] text-seal">
                          {fieldError}
                        </p>
                      )}
                    </div>
                  ) : null}
                  <div
                    className={`grid content-start gap-1.5 ${on && chosen.length > 1 ? "" : "sm:col-span-2"}`}
                  >
                    <label htmlFor={reasonId} className="text-[13px] text-bone">
                      Reason (optional, public)
                    </label>
                    <input
                      id={reasonId}
                      value={reasons[entry.account] ?? ""}
                      maxLength={HAND_PICK_REASON_MAX}
                      disabled={busy}
                      onChange={(event) =>
                        setReasons({ ...reasons, [entry.account]: event.target.value })
                      }
                      aria-describedby={whoId}
                      className={FIELD}
                      placeholder="One line on why, for the scorecard"
                    />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </fieldset>

      <div className="grid gap-3 rounded-xl border border-line bg-ink p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h3 className={FACT_LABEL}>What gets paid</h3>
          {chosen.length > 1 ? (
            <button
              type="button"
              onClick={() => setShares(splitEqually(chosen))}
              disabled={busy}
              className="font-mono text-[11px] tracking-[0.12em] text-muted uppercase underline decoration-muted/40 underline-offset-4 hover:text-bone"
            >
              Split equally
            </button>
          ) : null}
        </div>
        {/* Only where the shares stand is announced as it changes, not every amount. */}
        <p aria-live="polite" className="text-sm text-muted empty:hidden">
          {payout === null ? (
            <span data-testid="pick-problem">{choice.problem}</span>
          ) : chosen.length > 1 ? (
            "The shares add up to 100%."
          ) : null}
        </p>
        {payout === null ? null : (
          <>
            <p className="text-[13.5px] text-muted">
              {"Reward "}
              <Amount value={task.reward} token={task.token} />
              {` · platform fee ${formatBps(task.fee_bps)}, `}
              <Amount value={payout.fee.toString()} token={task.token} />
              {" · each winner gets their share of the rest."}
            </p>
            <ul className="grid">
              {choice.winners.map((winner, i) => (
                <li
                  key={winner.account}
                  data-testid="pick-payout"
                  className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-line py-2.5 first:border-t-0 first:pt-0 last:pb-0"
                >
                  <span className="min-w-0 font-mono text-[13px] text-bone wrap-anywhere">
                    {winner.account}
                  </span>
                  <span className="text-muted tabular-nums">{formatBps(winner.bps)}</span>
                  <span className="ml-auto text-bone tabular-nums">
                    <Amount value={(payout.amounts[i] ?? 0n).toString()} token={task.token} />
                  </span>
                </li>
              ))}
            </ul>
            {equalNote === null ? null : (
              <p data-testid="pick-rounding-shares" className="text-[12.5px] text-muted">
                {equalNote}
              </p>
            )}
            {payout.dust > 0n ? (
              <p data-testid="pick-rounding" className="text-[12.5px] text-muted">
                {`Rounding down leaves ${describeAmount(payout.dust, task.token)}: the contract gives it to ${choice.winners[0]?.account}, the first winner, as shown.`}
              </p>
            ) : null}
          </>
        )}
      </div>

      {run.status === "done" ? null : (
        <div className="grid gap-3">
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              aria-disabled={busy || payout === null}
              onClick={() => {
                if (payout === null) return;
                // The winners are sent, so the question about picking nobody is closed.
                setConfirming(false);
                void send(choice.winners);
              }}
              className={PRIMARY}
            >
              {busy && !confirming
                ? STAGE_WORDS[run.stage]
                : chosen.length > 1
                  ? `Pick ${chosen.length} winners`
                  : "Pick the winner"}
            </button>
            <button
              type="button"
              aria-disabled={busy}
              aria-expanded={confirming}
              onClick={() => {
                if (!busy) setConfirming(true);
              }}
              className={SECONDARY}
            >
              Pick nobody
            </button>
          </div>

          {confirming ? (
            <div className="rounded-xl border border-seal/50 bg-raised p-4">
              <fieldset
                ref={confirmRef}
                tabIndex={-1}
                data-testid="pick-nobody-confirm"
                className="grid min-w-0 gap-3 outline-none"
              >
                <legend className="mb-3 font-medium text-bone">
                  Pick nobody? The agents are not paid.
                </legend>
                <p className="text-[13.5px] text-muted">
                  The whole reward, <Amount value={task.reward} token={task.token} />, goes back to
                  the funders, with no fee taken. The scorecard is published with every entry at 0.
                </p>
                {funders.length === 0 ? null : (
                  <ul className="grid gap-1 text-[13px]">
                    {funders.map((funder) => (
                      <li key={funder.account} className="flex flex-wrap gap-x-3">
                        <span className="font-mono text-bone wrap-anywhere">{funder.account}</span>
                        <span className="text-muted tabular-nums">
                          gets back <Amount value={funder.amount} token={task.token} />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-[13px] text-muted">
                  {`Entries were revealed, so if ${account} is a registered agent, its public record counts one more empty pick after reveals.`}
                </p>
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    aria-disabled={busy}
                    onClick={() => void send([])}
                    className={PRIMARY}
                  >
                    {busy ? STAGE_WORDS[run.stage] : "Yes, pick nobody"}
                  </button>
                  <button
                    type="button"
                    aria-disabled={busy}
                    onClick={() => {
                      if (!busy) setConfirming(false);
                    }}
                    className={SECONDARY}
                  >
                    Cancel
                  </button>
                </div>
              </fieldset>
            </div>
          ) : null}

          {run.status === "failed" ? (
            <p role="alert" data-testid="pick-error" className="text-sm text-seal">
              {run.message}
            </p>
          ) : null}
          {task.heldout_commitment === null ? null : (
            <p data-testid="pick-heldout-note" className="text-[12.5px] leading-relaxed text-muted">
              This page doesn't publish the task's held-out checks: the scorecard shows them as not
              published. A pick with Tender's MCP tools (pick_winners) can publish them.
            </p>
          )}
          <p className="text-[12.5px] leading-relaxed text-muted">
            {`One approval in your wallet. The scorecard is published in the name of ${account} with the pick. Sign with a key of ${account} itself: a delegate key can't pick.`}
          </p>
        </div>
      )}
    </div>
  );
}
