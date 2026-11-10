"use client";

import { type TaskDetailResponse, tokenMeta } from "@tender/shared";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { config } from "../../lib/config";
import { errorMessage } from "../../lib/errors";
import {
  readTopUpTerms,
  submitTopUp,
  TopUpFailure,
  type TopUpResult,
  type TopUpTerms,
  topUpProblem,
  topUpStorage,
} from "../../lib/topUp";
import { describeAmount, describeNear, readAmount } from "../../lib/vault";
import type { UseWallet } from "../../lib/wallet";
import { Countdown } from "../Countdown";
import { FIELD, PRIMARY, TEXT_LINK } from "../ui";

type Run =
  | { status: "idle" }
  | { status: "busy" }
  | { status: "failed"; message: string }
  | { status: "done"; result: TopUpResult };

/**
 * Adding to a task's reward from the vault, while the task takes top-ups (its commit window). The
 * field is in the task's token, beside what the vault holds of it and a way to the Wallet page to
 * deposit more. The amount is held to the contract's rules, read from the chain: a new funder's
 * first top-up is at least the token's minimum reward, the reward stays within the token's
 * maximum, the task has room for another funder, and the vault holds the amount. One approval.
 */
export function TopUpPanel({
  data,
  nowNs,
  wallet,
  refresh,
  onSent,
}: {
  data: TaskDetailResponse;
  nowNs: bigint;
  wallet: UseWallet;
  /** Changes when the task changed, so that the terms are read again. */
  refresh: string;
  onSent: (result: TopUpResult) => void;
}) {
  const { task } = data;
  const accountId = wallet.accountId;
  const [terms, setTerms] = useState<TopUpTerms | null>(null);
  const [termsError, setTermsError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [touched, setTouched] = useState(false);
  const [run, setRun] = useState<Run>({ status: "idle" });
  const [reads, setReads] = useState(0);
  const accountRef = useRef(accountId);
  accountRef.current = accountId;
  // The page's clock, which a send decides by as the form does.
  const nowRef = useRef(nowNs);
  nowRef.current = nowNs;
  // A second press before the page has drawn the first as busy sends nothing more.
  const sending = useRef(false);
  const id = useId();
  const { symbol } = tokenMeta(task.token, config.network);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `refresh` and `reads` ask for the terms again: the task changed, or a top-up was sent
  useEffect(() => {
    if (accountId === null) return;
    let wanted = true;
    setTermsError(null);
    readTopUpTerms(task.id, accountId).then(
      (read) => {
        if (wanted) setTerms(read);
      },
      (error) => {
        if (!wanted) return;
        console.error(error);
        setTermsError(errorMessage(error));
      },
    );
    return () => {
      wanted = false;
    };
  }, [accountId, task.id, refresh, reads]);

  const reading = terms === null ? null : readAmount(text, task.token, terms.vault, "vault");
  const problem =
    terms === null || reading === null
      ? null
      : reading.ok
        ? topUpProblem(reading.amount, terms, nowNs)
        : reading.message;
  const storage = terms === null || accountId === null ? 0n : topUpStorage(terms, accountId);
  const busy = run.status === "busy";
  const shownProblem = touched || run.status === "failed" ? problem : null;

  async function send() {
    setTouched(true);
    if (busy || accountId === null || terms === null || reading === null || !reading.ok) return;
    if (problem !== null || sending.current) return;
    sending.current = true;
    setRun({ status: "busy" });
    try {
      const result = await submitTopUp(
        { taskId: task.id, account: accountId, amount: reading.amount, shownStorage: storage },
        {
          account: () => accountRef.current,
          readTerms: readTopUpTerms,
          signAndSend: wallet.signAndSend,
          nowNs: () => nowRef.current,
        },
      );
      setRun({ status: "done", result });
      setText("");
      setTouched(false);
      setReads((n) => n + 1);
      onSent(result);
    } catch (error) {
      console.error(error);
      setRun({
        status: "failed",
        message:
          error instanceof TopUpFailure ? error.message : "Something went wrong. Nothing was sent.",
      });
      setReads((n) => n + 1);
    } finally {
      sending.current = false;
    }
  }

  return (
    <form
      className="grid gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <p className="text-[14px] text-muted">
        {"Add to the reward until answers close (the commit deadline), in about "}
        <Countdown toNs={BigInt(task.commit_deadline)} nowNs={nowNs} />
        {". It's paid out with the rest, after the fee, or refunded to you in full."}
      </p>
      <div className="grid gap-2">
        <label htmlFor={`${id}-amount`} className="text-sm font-medium text-bone">
          {`Amount (${symbol === task.token ? "smallest units" : symbol})`}
        </label>
        <input
          id={`${id}-amount`}
          inputMode="decimal"
          autoComplete="off"
          value={text}
          disabled={busy}
          onChange={(event) => {
            setText(event.target.value);
            if (run.status !== "busy") setRun({ status: "idle" });
          }}
          onBlur={() => setTouched(text.trim() !== "")}
          aria-invalid={shownProblem !== null}
          aria-describedby={`${id}-vault${shownProblem === null ? "" : ` ${id}-problem`}`}
          className={`${FIELD} tabular-nums`}
          placeholder="0.00"
        />
        <p id={`${id}-vault`} data-testid="top-up-vault" className="text-[13px] text-muted">
          {termsError !== null ? (
            `Couldn't read your vault. ${termsError}`
          ) : terms === null ? (
            "Reading your vault…"
          ) : (
            <>
              {`Your vault: ${describeAmount(terms.vault, task.token)}. `}
              <Link href="/wallet" className={TEXT_LINK}>
                Deposit on the Wallet page
              </Link>
              {terms.isFunder
                ? ". You fund this task already, so any amount adds to your share."
                : `. A first top-up of a task is at least ${describeAmount(terms.minReward, task.token)}.`}
            </>
          )}
        </p>
        {storage > 0n ? (
          <p className="text-[13px] text-muted">
            {`${describeNear(storage)} goes into your storage with Tender first, for your funder record, in the same approval.`}
          </p>
        ) : null}
        {shownProblem === null ? null : (
          <p
            id={`${id}-problem`}
            role="alert"
            data-testid="top-up-problem"
            className="text-sm text-seal"
          >
            {shownProblem}
          </p>
        )}
      </div>
      <button type="submit" aria-disabled={busy || terms === null} className={PRIMARY}>
        {busy ? "Waiting for your wallet to approve…" : "Top up"}
      </button>
      {run.status === "failed" && run.message !== problem ? (
        <p role="alert" data-testid="top-up-error" className="text-sm text-seal">
          {run.message}
        </p>
      ) : null}
    </form>
  );
}
