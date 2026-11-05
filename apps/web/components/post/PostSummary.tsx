"use client";

import { type ReactNode, useMemo } from "react";
import { READING_BALANCES } from "../../lib/copy";
import {
  fundingOf,
  heldoutFile,
  inviteBytes,
  judgeVerifies,
  type PostForm,
  type PostLimits,
  rewardOf,
} from "../../lib/post";
import type { Stage, SubmitResult } from "../../lib/postSubmit";
import { describeAmount, describeNear, type VaultData } from "../../lib/vault";
import { useWaitedLong } from "../../lib/waiting";
import { WALLET_CANNOT_SIGN_MESSAGE } from "../../lib/walletErrors";
import { ErrorState } from "../ErrorState";
import { CARD, NOTICE, TEXT_LINK } from "../ui";
import { PRIMARY, SECONDARY } from "./ui";

/** What the page knows of the account's balances. */
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
 * page (the API's private store is read by the Judge only), so this is the one copy: the checker
 * needs the file to score entries and to pick, and can publish it with the scorecard, where anyone
 * can hash it and compare with the commitment on chain: `pick_winners` does, the task page's pick
 * (a scorecard written by hand) does not.
 */
function HeldoutDownload({ file, verifier }: { file: Uint8Array; verifier: string | null }) {
  return (
    <div
      data-testid="heldout-download"
      className="grid gap-3 rounded-xl border border-seal/45 bg-seal/[0.04] p-4 text-sm text-bone"
    >
      <p>
        {verifier === null
          ? "You pick, so you need the secret checks: save the file. A pick with pick_winners can publish it with the scorecard; the task page's pick doesn't. This page can't show it again."
          : `${verifier} needs the secret checks to pick: save the file and send it to them. A pick with pick_winners can publish it with the scorecard; the task page's pick doesn't. This page can't show it again.`}
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
    <div className="grid gap-0.5">
      <dt className="font-mono text-[10.5px] tracking-[0.14em] text-muted uppercase">{label}</dt>
      <dd data-testid={id} className="min-w-0 text-sm text-bone wrap-anywhere">
        {children}
      </dd>
    </div>
  );
}

/**
 * The end of the form: what posting will do with the person's money, and the one button that does
 * it. Without a wallet the button connects one; once it is connected the balances are read, and
 * Post task sends what this shows and nothing more.
 */
export function PostSummary(props: {
  form: PostForm;
  limits: PostLimits | null;
  judgeAccount: string | null;
  tokenId: string | null;
  ready: boolean;
  accountId: string | null;
  canSignMessage: boolean;
  connecting: boolean;
  vault: VaultState;
  running: Stage | null;
  failure: string | null;
  outcome: SubmitResult | null;
  /** Whether the form has a problem the person has to put right. */
  hasProblems: boolean;
  /** Whether Post can be pressed to post. */
  canPost: boolean;
  onConnect(): void;
  onRecheck(): void;
  onPost(): void;
  /** The person gives up on a wallet that has not answered: offered after a wait at the wallet. */
  onStop(): void;
  /** The person has looked and lifts the lock that a send of unknown outcome put on Post. */
  onUnlock(): void;
}) {
  const { form, limits, judgeAccount, tokenId, ready, accountId, canSignMessage, vault } = props;
  const reward = tokenId === null ? null : rewardOf(form, tokenId);
  const funding =
    vault.status === "ready" && reward !== null && tokenId !== null
      ? fundingOf(vault.data, tokenId, reward, inviteBytes(form))
      : null;

  // With the Judge as checker, the checks are in its hands. With anyone else they are on this page
  // only, and the person is given them as a file.
  const judgePicks = judgeVerifies(form, judgeAccount, accountId);
  const heldout = useMemo(() => heldoutFile(form), [form]);

  // "—" where there is nothing to read: no wallet connected, or a read that failed. The words about
  // reading are for a read that is under way.
  const paidFrom =
    funding !== null && tokenId !== null
      ? funding.toDeposit === 0n
        ? `Your vault: ${describeAmount(funding.inVault, tokenId)}, enough already.`
        : `Your vault: ${describeAmount(funding.inVault, tokenId)}. Added from your wallet first: ${describeAmount(funding.toDeposit, tokenId)}.`
      : reward !== null && vault.status === "loading"
        ? READING_BALANCES
        : "—";

  const fundingProblem = funding?.problem ?? null;
  // A wallet that does not answer leaves Post off: after a while there is a way out.
  const waitedLong = useWaitedLong(
    props.running === "signin" || props.running === "wallet" ? props.running : null,
  );

  const blocked: string | null = !ready
    ? null
    : limits?.paused
      ? "Tender isn't taking new tasks right now."
      : accountId === null || !canSignMessage || props.hasProblems
        ? null
        : fundingProblem;

  const verifierText =
    form.verifier === "judge"
      ? `Tender Judge (run by the Tender team)${judgeAccount === null ? "" : ` · ${judgeAccount}`}`
      : form.verifier === "me"
        ? "You"
        : form.otherVerifier.trim();

  return (
    <section aria-labelledby="post-ready" className={`${CARD} grid gap-5 p-5 sm:p-6`}>
      <h2
        id="post-ready"
        tabIndex={-1}
        className="text-lg font-semibold tracking-tight text-bone sm:text-xl"
      >
        Post it
      </h2>

      <dl className="grid gap-3.5">
        <Row id="review-reward" label="Reward">
          {reward === null || tokenId === null ? "—" : describeAmount(reward, tokenId)}
        </Row>
        <Row id="review-funding" label="Paid from">
          {paidFrom}
        </Row>
        {funding === null || funding.storageTopUp === 0n ? null : (
          <Row id="review-storage" label="Storage">
            {`Adds ${describeNear(funding.storageTopUp)} from your wallet first.`}
          </Row>
        )}
        <Row id="review-verifier" label="Checked by">
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

      {!ready ? (
        <p role="status" className="text-sm text-muted">
          Checking for your wallet…
        </p>
      ) : accountId === null ? null : !canSignMessage ? (
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

      {ready && accountId === null ? (
        <div className="grid gap-2">
          <button
            key="connect"
            type="button"
            aria-disabled={props.connecting}
            onClick={props.onConnect}
            className={`${PRIMARY} w-full`}
          >
            {props.connecting ? "Waiting for your wallet…" : "Connect wallet"}
          </button>
          <p className="text-[13px] text-muted">Connect your wallet to see what posting costs.</p>
        </div>
      ) : (
        // `aria-disabled` does not stop a press: with a problem in the form, a press shows each one
        // and takes the person to the first. The page's handler has the rest of the condition.
        <button
          key="post"
          type="button"
          aria-disabled={!props.canPost}
          onClick={props.onPost}
          className={`${PRIMARY} w-full`}
        >
          {props.running === null ? "Post task" : "Posting…"}
        </button>
      )}
      <p className="text-[13px] text-muted">
        Your wallet may ask you to sign in to Tender first. The deposit and the post are then one
        approval. Once posted, the terms can&rsquo;t change.
      </p>
    </section>
  );
}
