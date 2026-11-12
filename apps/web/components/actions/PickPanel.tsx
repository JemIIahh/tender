"use client";

import {
  type PickWinner,
  revealedForPick,
  splitReward,
  type TaskDetailResponse,
  type TaskEntry,
} from "@tender/shared";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import { useApiToken } from "../../lib/auth";
import { PickFailure, type PickResult, type PickStage, submitPick } from "../../lib/pick";
import { liveToken } from "../../lib/postSubmit";
import { equalShares, equalSplitNote, readShare, shareText, shareTotal } from "../../lib/shares";
import type { UseWallet } from "../../lib/wallet";
import { Countdown } from "../Countdown";
import { FACT_LABEL, NOTICE, PRIMARY, SECONDARY } from "../ui";
import { PickEntry } from "./PickEntry";
import { PickNobody } from "./PickNobody";
import { PickPayout } from "./PickPayout";

const STAGE_WORDS: Record<PickStage, string> = {
  check: "Checking the task…",
  signin: "Confirming with your account…",
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
 *
 * This holds the choice and the send; an entry's row (PickEntry), the payout (PickPayout) and the
 * question before picking nobody (PickNobody) only show it.
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
        ? "You're the checker (the verifier). Your window to pick closes in about "
        : "The checker didn't pick in time, so you, the poster, can. Your window closes in about "}
      <Countdown toNs={deadline} nowNs={nowNs} />.
    </p>
  );

  if (!wallet.canSignMessage) {
    return (
      <div className="grid gap-3">
        {windowLine}
        <p data-testid="pick-blocked" className={NOTICE}>
          This wallet can't sign messages, and the scorecard is published under an API session.
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
            return (
              <PickEntry
                key={entry.account}
                entry={entry}
                idBase={id}
                single={single}
                on={on}
                full={!single && !on && chosen.length >= most}
                busy={busy}
                several={chosen.length > 1}
                share={shares[entry.account] ?? ""}
                reason={reasons[entry.account] ?? ""}
                fieldError={choice.fieldErrors[entry.account]}
                onToggle={(next) => toggle(entry.account, next)}
                onShare={(share) => setShares({ ...shares, [entry.account]: share })}
                onReason={(reason) => setReasons({ ...reasons, [entry.account]: reason })}
              />
            );
          })}
        </ul>
      </fieldset>

      <PickPayout
        task={task}
        chosen={chosen.length}
        winners={choice.winners}
        problem={choice.problem}
        payout={payout}
        equalNote={equalNote}
        busy={busy}
        onSplitEqually={() => setShares(splitEqually(chosen))}
      />

      {run.status === "done" ? null : (
        <div className="grid gap-3">
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              aria-disabled={busy || payout === null}
              onClick={() => {
                // A press while a send runs changes nothing: the buttons are only aria-disabled, and
                // the ref holds from the first press on, before the page has drawn it as busy.
                if (busy || sending.current || payout === null) return;
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
            <PickNobody
              focusRef={confirmRef}
              data={data}
              account={account}
              busy={busy}
              busyWords={run.status === "busy" ? STAGE_WORDS[run.stage] : null}
              onConfirm={() => void send([])}
              onCancel={() => setConfirming(false)}
            />
          ) : null}

          {run.status === "failed" ? (
            <p role="alert" data-testid="pick-error" className="text-sm text-seal">
              {run.message}
            </p>
          ) : null}
          {task.heldout_commitment === null ? null : (
            <p data-testid="pick-heldout-note" className="text-[12.5px] leading-relaxed text-muted">
              This page doesn't publish the task's held-out checks: the scorecard shows them as not
              published. A pick with Tender's MCP tools (pick_winners) can publish them, if you have
              the file.
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
