"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { useApiToken } from "../../lib/auth";
import { config } from "../../lib/config";
import { errorMessage } from "../../lib/errors";
import {
  type CheckKind,
  checkBrief,
  checkChecks,
  checkReward,
  type Errors,
  emptyForm,
  firstError,
  formatForKind,
  type PostForm,
  type PostLimits,
  readPostLimits,
  tokenOf,
} from "../../lib/post";
import {
  defaultDeps,
  type Stage,
  SubmitFailure,
  type SubmitResult,
  submitPost,
} from "../../lib/postSubmit";
import { readVault } from "../../lib/vault";
import { useWallet } from "../../lib/wallet";
import { walletErrorMessage } from "../../lib/walletErrors";
import { ErrorState } from "../ErrorState";
import { BriefStep } from "./BriefStep";
import { CriteriaStep } from "./CriteriaStep";
import { ReviewStep, type VaultState } from "./ReviewStep";
import { RewardStep } from "./RewardStep";
import { PRIMARY, SECONDARY, type StepProps } from "./ui";

// The post wizard: four steps, one after the other. The form lives here, and each step shows a part
// of it and says what is wrong with that part. A step cannot be left until it is right; pressing
// Next on a step that is not shows every problem in it and takes the person to the first one.
//
// Nothing about the task is kept anywhere but in this component: no draft in the browser's storage,
// and the held-out checks least of all. A reload starts again.

const STEPS = [
  { id: "brief", title: "Brief" },
  { id: "checks", title: "Checks" },
  { id: "reward", title: "Reward" },
  { id: "review", title: "Review" },
] as const;
type StepId = (typeof STEPS)[number]["id"];

const NEXT_LABEL: Record<StepId, string> = {
  brief: "Next: Checks",
  checks: "Next: Reward",
  reward: "Review",
  review: "",
};

type LimitsState =
  | { status: "loading" }
  | { status: "error"; message: string; retrying: boolean }
  | { status: "ready"; limits: PostLimits };

/**
 * Keeps only the problems of fields the person has been in, and those that are not about a field of
 * their own: the form as a whole, and the held-out checks, which are spread over several fields.
 */
function onlyTouched(errors: Errors, touched: ReadonlySet<string>): Errors {
  return Object.fromEntries(
    Object.entries(errors).filter(
      ([key]) => key === "form" || key === "heldout" || touched.has(key),
    ),
  );
}

export function PostWizard({
  judgeAccount = config.judgeAccount,
}: {
  /** The Judge's account; this build's by default. Without one the Judge is not offered. */
  judgeAccount?: string | null;
} = {}) {
  const router = useRouter();
  const { ready, accountId, canSignMessage, connect, signAndSend } = useWallet();
  const { signIn } = useApiToken();

  const [form, setForm] = useState<PostForm>(() => emptyForm({ judgeAccount }));
  const [step, setStep] = useState<StepId>("brief");
  const [attempted, setAttempted] = useState<ReadonlySet<StepId>>(new Set());
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [limits, setLimits] = useState<LimitsState>({ status: "loading" });
  const [canRubric, setCanRubric] = useState(false);
  const [vault, setVault] = useState<VaultState>({ status: "idle" });
  const [vaultNonce, setVaultNonce] = useState(0);
  const [running, setRunning] = useState<Stage | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<SubmitResult | null>(null);
  const [connecting, setConnecting] = useState(false);

  const heading = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef<StepId>(step);
  // Set at once when a post starts, where `running` is only set for the next render: a second press
  // before then must not start a second post.
  const busy = useRef(false);
  const mounted = useRef(true);
  // The account the wallet is connected as, as of the last render. A post checks it just before it
  // asks the wallet to sign, since the wallet signs as whoever is connected then.
  const latestAccount = useRef(accountId);
  latestAccount.current = accountId;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const update = useCallback((patch: Partial<PostForm>) => {
    setForm((was) => ({ ...was, ...patch }));
  }, []);
  const touch = useCallback((key: string) => {
    setTouched((was) => (was.has(key) ? was : new Set(was).add(key)));
  }, []);

  // ---- What Tender allows ----------------------------------------------------------------------

  const limitsRequest = useRef(0);
  const loadLimits = useCallback(() => {
    const request = ++limitsRequest.current;
    setLimits((was) =>
      was.status === "error" ? { ...was, retrying: true } : { status: "loading" },
    );
    readPostLimits().then(
      (read) => {
        if (request === limitsRequest.current) setLimits({ status: "ready", limits: read });
      },
      (error) => {
        if (request !== limitsRequest.current) return;
        console.error(error);
        setLimits({ status: "error", message: errorMessage(error), retrying: false });
      },
    );
  }, []);
  useEffect(() => {
    loadLimits();
  }, [loadLimits]);

  // ---- Whether the account is the team's: only then the rubric is offered ----------------------

  useEffect(() => {
    setCanRubric(false);
    if (accountId === null) return;
    let current = true;
    api.getAgent(accountId).then(
      (found) => {
        if (current) setCanRubric(found?.agent.is_team === true);
      },
      (error) => {
        // An agent that can't be read is not known to be the team's.
        console.error(error);
        if (current) setCanRubric(false);
      },
    );
    return () => {
      current = false;
    };
  }, [accountId]);

  useEffect(() => {
    if (!canRubric && form.kind === "rubric") {
      setForm((was) =>
        was.kind === "rubric"
          ? { ...was, kind: "exact", outputFormat: formatForKind("exact", was.outputFormat) }
          : was,
      );
    }
  }, [canRubric, form.kind]);

  // ---- What the account holds, read when the review is shown -----------------------------------

  const vaultRequest = useRef(0);
  useEffect(() => {
    // `vaultNonce`: a read again, when the person has put something right.
    void vaultNonce;
    if (step !== "review" || accountId === null) {
      vaultRequest.current++;
      setVault({ status: "idle" });
      return;
    }
    const request = ++vaultRequest.current;
    setVault((was) =>
      was.status === "error" ? { ...was, retrying: true } : { status: "loading" },
    );
    readVault(accountId).then(
      (data) => {
        if (request === vaultRequest.current) setVault({ status: "ready", data });
      },
      (error) => {
        if (request !== vaultRequest.current) return;
        console.error(error);
        setVault({ status: "error", message: errorMessage(error), retrying: false });
      },
    );
  }, [step, accountId, vaultNonce]);

  // ---- Moving between steps --------------------------------------------------------------------

  const readyLimits = limits.status === "ready" ? limits.limits : null;
  const allErrors = (id: StepId): Errors => {
    switch (id) {
      case "brief":
        return checkBrief(form);
      case "checks":
        return checkChecks(form, { canRubric });
      case "reward":
        return readyLimits === null
          ? { limits: "What Tender allows has not loaded yet." }
          : checkReward(form, { limits: readyLimits, judgeAccount });
      case "review":
        return {};
    }
  };

  const errors = allErrors(step);
  const shown = attempted.has(step) ? errors : onlyTouched(errors, touched);
  const hasProblems = Object.keys(errors).length > 0;
  const earlierProblem = (["brief", "checks", "reward"] as const).some(
    (id) => Object.keys(allErrors(id)).length > 0,
  );

  // The heading of a step takes the focus when the step is shown, so that a keyboard or a screen
  // reader begins at the top of it. Not when the page is first shown.
  useEffect(() => {
    if (shownStep.current !== step) {
      shownStep.current = step;
      heading.current?.focus();
    }
  }, [step]);

  const go = (id: StepId) => {
    if (running !== null) return;
    // What went wrong the last time Post was pressed is about the Review step as it was.
    setFailure(null);
    setStep(id);
  };

  const next = () => {
    const key = firstError(errors);
    if (key !== undefined) {
      setAttempted((was) => new Set(was).add(step));
      // A problem with no field of its own (`form`, or what has not loaded) goes to the heading.
      const target = document.getElementById(`post-${key}`) ?? heading.current;
      target?.focus();
      return;
    }
    const target = STEPS[STEPS.findIndex(({ id }) => id === step) + 1];
    if (target !== undefined) go(target.id);
  };

  const back = () => {
    const target = STEPS[STEPS.findIndex(({ id }) => id === step) - 1];
    if (target !== undefined) go(target.id);
  };

  // A kind that cannot score the format the answers have takes the format it can. The Checks step
  // says which one it is now, from the form, so there is no note to keep.
  const pickKind = (kind: CheckKind) => {
    update({ kind, outputFormat: formatForKind(kind, form.outputFormat) });
    touch("kind");
  };

  // ---- Posting ---------------------------------------------------------------------------------

  // The Connect button goes when the wallet is connected, and the focus would go with it. It is put
  // on the heading of what comes next, where the person reads on.
  const pressedConnect = useRef(false);
  useEffect(() => {
    if (accountId !== null && pressedConnect.current) {
      pressedConnect.current = false;
      document.getElementById("post-ready")?.focus();
    }
  }, [accountId]);

  const connectWallet = async () => {
    if (connecting) return;
    pressedConnect.current = true;
    setConnecting(true);
    try {
      await connect();
    } catch (error) {
      console.error(error);
      setFailure(walletErrorMessage(error));
    } finally {
      if (mounted.current) setConnecting(false);
    }
  };

  const post = async () => {
    const chosen = readyLimits === null ? undefined : tokenOf(form, readyLimits);
    if (busy.current || accountId === null || chosen === undefined) return;
    busy.current = true;
    setFailure(null);
    setRunning("upload");
    try {
      const result = await submitPost(
        { form, account: accountId, tokenId: chosen.token, judgeAccount },
        { ...defaultDeps, account: () => latestAccount.current, signIn, signAndSend },
        (stage) => {
          if (mounted.current) setRunning(stage);
        },
      );
      if (!mounted.current) return;
      setOutcome(result);
      if (result.kind === "posted") router.push(`/tasks/${result.taskId}`);
    } catch (error) {
      console.error(error);
      if (mounted.current) {
        setFailure(error instanceof SubmitFailure ? error.message : errorMessage(error));
      }
    } finally {
      busy.current = false;
      if (mounted.current) setRunning(null);
    }
  };

  // The last send's outcome is not known and the person has looked: the lock comes off, and the
  // balances are read again so that Review shows what they are now. The press has taken away the
  // button that had the focus, so the focus goes to the heading that the Post button is under.
  const unlockPost = () => {
    if (outcome?.kind !== "unknown") return;
    setOutcome(null);
    setVaultNonce((n) => n + 1);
    document.getElementById("post-ready")?.focus();
  };

  // ---- The page --------------------------------------------------------------------------------

  const index = STEPS.findIndex(({ id }) => id === step);
  const props: StepProps = { form, update, errors: shown, touch };

  // A problem that belongs to no one field: Tender is paused, or a document the step makes does not
  // fit. It is shown above the step, and Next takes the focus to it.
  const formProblem =
    shown.form === undefined ? null : (
      <p
        id="post-form"
        tabIndex={-1}
        role="alert"
        className="rounded border border-neutral-900 p-3"
      >
        {shown.form}
      </p>
    );

  const body = (() => {
    switch (step) {
      case "brief":
        return (
          <>
            {formProblem}
            <BriefStep {...props} />
          </>
        );
      case "checks":
        return (
          <>
            {formProblem}
            <CriteriaStep {...props} canRubric={canRubric} onKind={pickKind} />
          </>
        );
      case "reward":
        return limits.status === "loading" ? (
          <p role="status">Loading what Tender allows…</p>
        ) : limits.status === "error" ? (
          <ErrorState message={limits.message} retrying={limits.retrying} onRetry={loadLimits} />
        ) : (
          <>
            {formProblem}
            <RewardStep {...props} limits={limits.limits} judgeAccount={judgeAccount} />
          </>
        );
      case "review": {
        const chosen = readyLimits === null ? undefined : tokenOf(form, readyLimits);
        return readyLimits === null || chosen === undefined ? (
          <p role="status">Loading what Tender allows…</p>
        ) : (
          <ReviewStep
            form={form}
            limits={readyLimits}
            judgeAccount={judgeAccount}
            tokenId={chosen.token}
            ready={ready}
            accountId={accountId}
            canSignMessage={canSignMessage}
            connecting={connecting}
            vault={vault}
            running={running}
            failure={failure}
            outcome={outcome}
            earlierProblem={earlierProblem}
            onConnect={connectWallet}
            onRecheck={() => setVaultNonce((n) => n + 1)}
            onBack={back}
            onPost={post}
            onUnlock={unlockPost}
          />
        );
      }
    }
  })();

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">Post a task</h1>

      <nav aria-label="Steps">
        <ol className="flex flex-wrap gap-x-4 gap-y-1">
          {STEPS.map(({ id, title }, at) => {
            const label = `${at + 1} ${title}`;
            return (
              <li key={id}>
                {id === step ? (
                  <span
                    aria-current="step"
                    className="inline-block py-2 font-semibold underline underline-offset-4"
                  >
                    {label}
                  </span>
                ) : at < index ? (
                  <button
                    type="button"
                    onClick={() => go(id)}
                    className="min-h-11 underline-offset-4 hover:underline"
                  >
                    {label}
                  </button>
                ) : (
                  <span className="inline-block py-2 text-neutral-500">{label}</span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      {step === "review" ? (
        <div className="grid gap-6">
          <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold">
            Review
          </h2>
          {body}
        </div>
      ) : (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            next();
          }}
          className="grid gap-6"
        >
          <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold">
            {STEPS[index]?.title}
          </h2>
          {body}
          <div className="flex flex-wrap gap-2">
            {index === 0 ? null : (
              <button type="button" onClick={back} className={SECONDARY}>
                Back
              </button>
            )}
            {/* `aria-disabled` does not stop a press: Next still runs, and shows what is wrong. */}
            <button type="submit" aria-disabled={hasProblems} className={PRIMARY}>
              {NEXT_LABEL[step]}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
