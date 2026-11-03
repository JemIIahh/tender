"use client";

import type { ReactNode } from "react";
import { formatBps } from "../../lib/bps";
import {
  FORMAT_LABEL,
  filledAssertions,
  filledRubric,
  fundingOf,
  KINDS,
  linesOf,
  type PostForm,
  type PostLimits,
  rewardOf,
  spanText,
  totalSecs,
  windowsOf,
  windowsText,
} from "../../lib/post";
import type { Stage, SubmitResult } from "../../lib/postSubmit";
import { describeAmount, describeNear, type VaultData } from "../../lib/vault";
import { WALLET_CANNOT_SIGN_MESSAGE } from "../../lib/walletErrors";
import { ErrorState } from "../ErrorState";
import { PRIMARY, SECONDARY } from "./ui";

/** What the Review step knows of the account's balances. */
export type VaultState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string; retrying: boolean }
  | { status: "ready"; data: VaultData };

const PROGRESS: Record<Stage, string> = {
  signin: "Signing in to Tender. Approve the message in your wallet.",
  upload: "Saving your task's documents with Tender.",
  vault: "Reading your balances.",
  wallet: "Waiting for your wallet. Approve the transactions there.",
};

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * What the checks come to, in counts. Never their text: the held-out checks are a secret, and this
 * is the one place they are summed up on the page.
 */
export function checkCounts(form: PostForm): { seen: string; kept: string } {
  switch (form.kind) {
    case "exact":
      return {
        seen: `${plural([form.trim, form.lowercase, form.collapseWs].filter(Boolean).length, "clean-up step")} before comparing`,
        kept: plural(linesOf(form.expected).length, "accepted answer"),
      };
    case "json_schema":
      return {
        seen: "A JSON schema",
        kept: `${plural(filledAssertions(form).length, "value")} to check`,
      };
    case "regex_cases": {
      const held = linesOf(form.heldoutMatch).length + linesOf(form.heldoutNoMatch).length;
      return {
        seen: plural(
          linesOf(form.examplesMatch).length + linesOf(form.examplesNoMatch).length,
          "example",
        ),
        kept: held === 0 ? "None: scored on the examples" : plural(held, "case"),
      };
    }
    case "rubric":
      return { seen: plural(filledRubric(form).length, "point"), kept: "None" };
  }
}

function Row({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-neutral-700">{label}</dt>
      <dd data-testid={id} className="min-w-0 wrap-anywhere">
        {children}
      </dd>
    </>
  );
}

/** Step 4: the task in plain words, what posting will do, and the button that does it. */
export function ReviewStep(props: {
  form: PostForm;
  limits: PostLimits;
  judgeAccount: string | null;
  tokenId: string;
  ready: boolean;
  accountId: string | null;
  canSignMessage: boolean;
  connecting: boolean;
  vault: VaultState;
  running: Stage | null;
  failure: string | null;
  outcome: SubmitResult | null;
  /** Whether an earlier step has something wrong with it now. */
  earlierProblem: boolean;
  onConnect(): void;
  onRecheck(): void;
  onBack(): void;
  onPost(): void;
}) {
  const { form, limits, judgeAccount, tokenId, ready, accountId, canSignMessage, vault } = props;
  const reward = rewardOf(form, tokenId);
  const windows = windowsOf(form);
  const counts = checkCounts(form);
  const kind = KINDS.find(({ kind: candidate }) => candidate === form.kind);
  const funding =
    vault.status === "ready" && reward !== null ? fundingOf(vault.data, tokenId, reward) : null;

  // "—" where there is nothing to read: no wallet connected, or a read that failed. The words about
  // reading are for a read that is under way.
  const paidFrom =
    funding !== null
      ? funding.toDeposit === 0n
        ? `Your vault: ${describeAmount(funding.inVault, tokenId)}, enough already.`
        : `Your vault: ${describeAmount(funding.inVault, tokenId)}. Added from your wallet first: ${describeAmount(funding.toDeposit, tokenId)}.`
      : reward !== null && vault.status === "loading"
        ? "Reading your balances…"
        : "—";

  // Why Post is off, in the order a person can put it right. A wallet that is not connected, or
  // cannot sign, has its own words below.
  const fundingProblem = funding?.problem ?? null;
  const blocked: string | null = !ready
    ? null
    : limits.paused
      ? "Tender isn't taking new tasks right now."
      : props.earlierProblem
        ? "Something on an earlier step needs fixing. Go back and check each one."
        : accountId === null || !canSignMessage
          ? null
          : fundingProblem;

  const canPost =
    ready &&
    accountId !== null &&
    canSignMessage &&
    !limits.paused &&
    !props.earlierProblem &&
    funding !== null &&
    funding.problem === null &&
    props.running === null &&
    props.outcome === null;

  const verifierText =
    form.verifier === "judge"
      ? `Tender Judge (run by the Tender team)${judgeAccount === null ? "" : ` · ${judgeAccount}`}`
      : form.verifier === "me"
        ? "You"
        : form.otherVerifier.trim();

  return (
    <div className="grid gap-6">
      <p>Once posted, the terms can't change.</p>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        <Row id="review-title" label="Title">
          {form.title.trim()}
        </Row>
        <Row id="review-reward" label="Reward">
          {reward === null ? "—" : describeAmount(reward, tokenId)}
          {` · Tender keeps ${formatBps(limits.feeBps)} when it is paid out.`}
        </Row>
        <Row id="review-funding" label="Paid from">
          {paidFrom}
        </Row>
        {funding === null || funding.storageTopUp === 0n ? null : (
          <Row id="review-storage" label="Storage">
            {`Adds ${describeNear(funding.storageTopUp)} from your wallet first.`}
          </Row>
        )}
        <Row id="review-answer" label="Answers">
          {`${FORMAT_LABEL[form.outputFormat]}, up to ${Number(form.maxBytes.trim()).toLocaleString("en-US")} bytes`}
        </Row>
        <Row id="review-checks" label="Checks">
          {`${kind?.label ?? form.kind}, pass mark ${form.minScore.trim()} of 100`}
        </Row>
        <Row id="review-split" label="Agents see">
          {counts.seen}
        </Row>
        <Row id="review-heldout" label="Judge keeps">
          {counts.kept}
        </Row>
        <Row id="review-prize" label="Prize">
          Winner takes all
        </Row>
        <Row id="review-windows" label="Time">
          {windows === null
            ? "—"
            : `${windowsText(windows)}. ${spanText(totalSecs(windows))} in all.`}
        </Row>
        <Row id="review-verifier" label="Picks the winner">
          {verifierText}
        </Row>
        <Row id="review-account" label="Posting as">
          {accountId ?? "Not connected"}
        </Row>
      </dl>

      <section aria-labelledby="post-ready" className="grid gap-3">
        <h3 id="post-ready" tabIndex={-1} className="text-lg font-semibold">
          Post it
        </h3>
        {!ready ? (
          <p role="status">Checking for your wallet…</p>
        ) : accountId === null ? (
          <>
            <p>Connect your wallet to post.</p>
            <button
              key="connect"
              type="button"
              aria-disabled={props.connecting}
              onClick={props.onConnect}
              className={PRIMARY}
            >
              {props.connecting ? "Waiting for your wallet…" : "Connect wallet"}
            </button>
          </>
        ) : !canSignMessage ? (
          <p role="status" data-testid="cannot-sign">
            {WALLET_CANNOT_SIGN_MESSAGE}
          </p>
        ) : vault.status === "loading" || vault.status === "idle" ? (
          <p role="status">Reading your balances…</p>
        ) : vault.status === "error" ? (
          <ErrorState message={vault.message} retrying={vault.retrying} onRetry={props.onRecheck} />
        ) : null}

        {blocked === null ? null : (
          <div
            data-testid="post-blocked"
            className="grid gap-2 rounded border border-neutral-900 p-3"
          >
            <p>{blocked}</p>
            {fundingProblem !== null && blocked === fundingProblem ? (
              <div className="flex flex-wrap gap-2">
                {/* A tab of its own, so that the form on this page is not lost. */}
                <a
                  href="/wallet"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-11 items-center rounded border border-neutral-900 px-4"
                >
                  Open the Wallet page
                </a>
                <button type="button" onClick={props.onRecheck} className={SECONDARY}>
                  Check again
                </button>
              </div>
            ) : null}
          </div>
        )}

        {props.running === null ? null : (
          <p role="status" data-testid="post-progress">
            {PROGRESS[props.running]}
          </p>
        )}
        {props.failure === null ? null : (
          <p
            role="alert"
            data-testid="post-failure"
            className="rounded border border-neutral-900 p-3"
          >
            {props.failure}
          </p>
        )}
        {props.outcome?.kind === "posted" ? (
          <p role="status" data-testid="post-done">
            Posted. Opening your task.{" "}
            <a href={`/tasks/${props.outcome.taskId}`} className="underline">
              Open it now
            </a>
          </p>
        ) : null}
        {props.outcome?.kind === "sent" ? (
          <p role="status" data-testid="post-sent">
            Your wallet sent it, but Tender hasn't reported the new task. It may well be posted:
            look for it on the{" "}
            <a href="/" className="underline">
              Tasks
            </a>{" "}
            page before you try again.
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <button
            key="back"
            type="button"
            aria-disabled={props.running !== null}
            onClick={() => {
              if (props.running === null) props.onBack();
            }}
            className={SECONDARY}
          >
            Back
          </button>
          {/* `aria-disabled` does not stop a press, so the handler has the same condition. */}
          <button
            key="post"
            type="button"
            aria-disabled={!canPost}
            onClick={() => {
              if (canPost) props.onPost();
            }}
            className={PRIMARY}
          >
            {props.running === null ? "Post task" : "Posting…"}
          </button>
        </div>
      </section>
    </div>
  );
}
