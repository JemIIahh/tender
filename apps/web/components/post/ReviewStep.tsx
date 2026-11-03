"use client";

import { type ReactNode, useMemo } from "react";
import { formatBps } from "../../lib/bps";
import { READING_BALANCES } from "../../lib/copy";
import {
  FORMAT_LABEL,
  filledAssertions,
  filledRubric,
  fundingOf,
  heldoutFile,
  judgeVerifies,
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
import { useWaitedLong } from "../../lib/waiting";
import { WALLET_CANNOT_SIGN_MESSAGE } from "../../lib/walletErrors";
import { ErrorState } from "../ErrorState";
import { NOTICE, TEXT_LINK } from "../ui";
import { PRIMARY, SECONDARY } from "./ui";

/** What the Review step knows of the account's balances. */
export type VaultState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string; retrying: boolean }
  | { status: "ready"; data: VaultData };

const PROGRESS: Record<Stage, string> = {
  check: "Looking for your earlier post on the chain.",
  signin: "Signing in to Tender. Approve the message in your wallet.",
  upload: "Saving your task's documents with Tender.",
  vault: READING_BALANCES,
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

/**
 * Hands the bytes to the person as a file. The file is made when the button is pressed and given a
 * `blob:` address that goes away a moment later, so the text of the held-out checks is in no
 * attribute of the page and in no address.
 */
function saveFile(bytes: Uint8Array, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * The held-out checks of a task that the Judge does not pick, as a file. They went nowhere but this
 * page (the API's private store is read by the Judge only), so this is the one copy: the verifier
 * needs the file to score entries and to pick, and publishes it with the scorecard, where anyone
 * can hash it and compare with the commitment on chain.
 */
function HeldoutDownload({ file, verifier }: { file: Uint8Array; verifier: string | null }) {
  return (
    <div
      data-testid="heldout-download"
      className="grid gap-3 rounded-xl border border-seal/45 bg-seal/[0.04] p-4 text-sm text-bone"
    >
      <p>
        {verifier === null
          ? "You pick, so you need these held-out checks: save the file, and publish it with the scorecard. This page can't show it again."
          : `${verifier} needs these held-out checks to pick: save the file and send it to them, and they publish it with the scorecard. This page can't show it again.`}
      </p>
      <button
        type="button"
        onClick={() => saveFile(file, "heldout.json")}
        className={`${SECONDARY} min-w-0`}
      >
        Download held-out checks
      </button>
    </div>
  );
}

function Row({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <>
      <dt className="pt-0.5 font-mono text-[10.5px] tracking-[0.14em] text-muted uppercase">
        {label}
      </dt>
      <dd data-testid={id} className="min-w-0 text-bone wrap-anywhere">
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
  /** The person gives up on a wallet that has not answered: offered after a wait at the wallet. */
  onStop(): void;
  /** The person has looked and lifts the lock that a send of unknown outcome put on Post. */
  onUnlock(): void;
}) {
  const { form, limits, judgeAccount, tokenId, ready, accountId, canSignMessage, vault } = props;
  const reward = rewardOf(form, tokenId);
  const windows = windowsOf(form);
  const counts = checkCounts(form);
  const kind = KINDS.find(({ kind: candidate }) => candidate === form.kind);
  const funding =
    vault.status === "ready" && reward !== null ? fundingOf(vault.data, tokenId, reward) : null;

  // With the Judge as verifier, the checks are in its hands. With anyone else they are on this page
  // only, and the person is given them as a file.
  const judgePicks = judgeVerifies(form, judgeAccount, accountId);
  const heldout = useMemo(() => heldoutFile(form), [form]);

  // "—" where there is nothing to read: no wallet connected, or a read that failed. The words about
  // reading are for a read that is under way.
  const paidFrom =
    funding !== null
      ? funding.toDeposit === 0n
        ? `Your vault: ${describeAmount(funding.inVault, tokenId)}, enough already.`
        : `Your vault: ${describeAmount(funding.inVault, tokenId)}. Added from your wallet first: ${describeAmount(funding.toDeposit, tokenId)}.`
      : reward !== null && vault.status === "loading"
        ? READING_BALANCES
        : "—";

  // Why Post is off, in the order a person can put it right. A wallet that is not connected, or
  // cannot sign, has its own words below.
  const fundingProblem = funding?.problem ?? null;
  // A wallet that does not answer leaves Back and Post off: after a while there is a way out.
  const waitedLong = useWaitedLong(
    props.running === "signin" || props.running === "wallet" ? props.running : null,
  );

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
      <p className="text-sm text-muted">Once posted, the terms can't change.</p>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 rounded-xl border border-line bg-ink p-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-y-3 sm:p-5 [&>dd]:mb-2 sm:[&>dd]:mb-0">
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
        <Row id="review-heldout" label="Kept secret">
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

      {judgePicks || heldout === null ? null : (
        <HeldoutDownload
          file={heldout}
          verifier={form.verifier === "other" ? form.otherVerifier.trim() : null}
        />
      )}

      <section aria-labelledby="post-ready" className="grid gap-3">
        <h3
          id="post-ready"
          tabIndex={-1}
          className="text-lg font-semibold tracking-tight text-bone"
        >
          Post it
        </h3>
        {!ready ? (
          <p role="status" className="text-sm text-muted">
            Checking for your wallet…
          </p>
        ) : accountId === null ? (
          <>
            <p className="text-sm text-muted">Connect your wallet to post.</p>
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
          <p role="status" data-testid="cannot-sign" className={NOTICE}>
            {WALLET_CANNOT_SIGN_MESSAGE}
          </p>
        ) : vault.status === "loading" || vault.status === "idle" ? (
          <p role="status" className="text-sm text-muted">
            {READING_BALANCES}
          </p>
        ) : vault.status === "error" ? (
          <ErrorState message={vault.message} retrying={vault.retrying} onRetry={props.onRecheck} />
        ) : null}

        {blocked === null ? null : (
          <div data-testid="post-blocked" className={`${NOTICE} grid gap-3`}>
            <p>{blocked}</p>
            {fundingProblem !== null && blocked === fundingProblem ? (
              <div className="flex flex-wrap gap-2">
                {/* A tab of its own, so that the form on this page is not lost. */}
                <a href="/wallet" target="_blank" rel="noreferrer" className={SECONDARY}>
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
          <p role="status" data-testid="post-progress" className="text-sm text-bone">
            {PROGRESS[props.running]}
          </p>
        )}
        {waitedLong ? (
          <div>
            <button type="button" onClick={props.onStop} className={SECONDARY}>
              Stop waiting
            </button>
          </div>
        ) : null}
        {props.failure === null ? null : (
          <p
            role="alert"
            data-testid="post-failure"
            className="rounded-xl border border-seal/45 bg-seal/[0.06] p-4 text-sm text-bone"
          >
            {props.failure}
          </p>
        )}
        {props.outcome?.kind === "posted" ? (
          <p role="status" data-testid="post-done" className={NOTICE}>
            Posted. Opening your task.{" "}
            <a href={`/tasks/${props.outcome.taskId}`} className={TEXT_LINK}>
              Open it now
            </a>
          </p>
        ) : null}
        {props.outcome?.kind === "sent" ? (
          <div role="status" data-testid="post-sent" className={`${NOTICE} grid gap-3`}>
            <p>
              Your wallet sent it, but Tender hasn't reported the new task. It may well be posted:
              look for it on the{" "}
              {/* A tab of its own, as for an unknown outcome, so that the form on this page is
                  not lost. */}
              <a href="/tasks" target="_blank" rel="noreferrer" className={TEXT_LINK}>
                Tasks
              </a>{" "}
              page before you try again.
            </p>
            {props.outcome.txHashes.length === 0 ? null : (
              <ul aria-label="Transactions" className="grid gap-1 text-xs text-muted">
                {props.outcome.txHashes.map((hash, i) => (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: the wallet lists the hashes, and could list one twice
                    key={`${hash}-${i}`}
                    data-testid="post-sent-hash"
                    className="font-mono wrap-anywhere"
                  >
                    {hash}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
        {props.outcome?.kind === "unknown" ? (
          <div
            role="alert"
            data-testid="post-unknown"
            className="grid gap-3 rounded-xl border border-seal/45 bg-seal/[0.06] p-4 text-sm text-bone"
          >
            <p>
              We couldn't tell whether the post went through. Check the{" "}
              {/* A tab of its own, so that the form on this page is not lost. */}
              <a href="/tasks" target="_blank" rel="noreferrer" className={TEXT_LINK}>
                Tasks
              </a>{" "}
              page before posting again.
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={props.onUnlock} className={SECONDARY}>
                Unlock Post
              </button>
            </div>
          </div>
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
