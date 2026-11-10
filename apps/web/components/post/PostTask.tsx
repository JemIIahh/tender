"use client";

import { tokenMeta } from "@tender/shared";
import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { useApiToken } from "../../lib/auth";
import { formatBps } from "../../lib/bps";
import { config } from "../../lib/config";
import { errorMessage } from "../../lib/errors";
import {
  type CheckKind,
  checkBrief,
  checkChecks,
  checkReward,
  DEFAULT_DEADLINE_SECS,
  deadlineIn,
  deadlineMs,
  type Errors,
  emptyForm,
  firstError,
  formatForKind,
  fundingOf,
  inviteBytes,
  type PostForm,
  type PostLimits,
  QUICK_DEADLINES,
  RUBRIC_JUDGE_LIMIT,
  RUBRIC_JUDGE_NOTE,
  readPostLimits,
  rewardOf,
  spanText,
  tokenOf,
  VERIFIER_PICKS_WITH_MCP,
  type Verifier,
  windowsOf,
  winnerReceives,
} from "../../lib/post";
import {
  defaultDeps,
  PostStopped,
  type Stage,
  SubmitFailure,
  type SubmitResult,
  submitPost,
} from "../../lib/postSubmit";
import { knowsToken } from "../../lib/tokens";
import { type Told, toldFor } from "../../lib/told";
import { describeAmount, readVault } from "../../lib/vault";
import { useWallet } from "../../lib/wallet";
import { walletErrorMessage } from "../../lib/walletErrors";
import { ErrorState } from "../ErrorState";
import { PageHead } from "../PageHead";
import { CARD, FIELD } from "../ui";
import { MoreOptions } from "./MoreOptions";
import { PostSummary, type VaultState } from "./PostSummary";
import { RuleFields } from "./RuleFields";
import { AreaField, bindText, FieldError, SelectField, type StepProps, TextField } from "./ui";

// Post a task: one page, four questions and a button. What is needed done, who checks the work,
// what it pays and until when; everything else is under More options with a default that works.
// The form lives here; each part shows its fields and says what is wrong with them. Problems show
// once a field has been used, and every one shows when Post is pressed, which takes the person to
// the first.
//
// Nothing about the task is kept anywhere but in this component: no draft in the browser's storage,
// and the held-out checks least of all. A reload starts again.

/** The words after the person stopped waiting for the sign-in: nothing is on the chain. */
const STOPPED_SIGNIN =
  "You stopped waiting for your wallet. Nothing was posted. Press Post to try again.";

/** The fields under More options: a problem in one of them opens it. */
const MORE_KEYS =
  /^(?:summary|tags|kind|minScore|outputFormat|maxBytes|heldoutMatch|heldoutNoMatch|otherVerifier|invited|maxEntries|window-.+)$/;

/** One press of Post. Once `stopped`, nothing it still does or says is for the page. */
interface Run {
  stopped: boolean;
}

type LimitsState =
  | { status: "loading" }
  | { status: "error"; message: string; retrying: boolean }
  | { status: "ready"; limits: PostLimits };

const SECTION = `${CARD} grid min-w-0 gap-5 p-5 sm:p-7`;

/** An amount this large is the contract's "no limit", which nobody means to say in a sentence. */
const NO_REAL_LIMIT = 10n ** 30n;

/** The head of one of the four parts: its number and its question. */
function SectionHead({
  n,
  id,
  title,
  children,
}: {
  n: number;
  id: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3.5">
      <span
        aria-hidden="true"
        className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border border-line font-mono text-[11px] text-bone"
      >
        {n}
      </span>
      <div className="grid min-w-0 gap-1">
        <h2 id={id} className="text-lg font-semibold tracking-tight text-bone sm:text-xl">
          {title}
        </h2>
        {children === undefined ? null : <p className="text-sm text-muted">{children}</p>}
      </div>
    </div>
  );
}

/** A problem that belongs to no one field of a part, at the top of it. */
function PartProblem({ id, problem }: { id: string; problem: string | undefined }) {
  if (problem === undefined) return null;
  return (
    <p
      id={id}
      tabIndex={-1}
      role="alert"
      className="rounded-xl border border-seal/45 bg-seal/[0.06] p-4 text-sm text-bone"
    >
      {problem}
    </p>
  );
}

/**
 * The problems of the three checks in the order of the page: the four parts, then More options.
 * A problem of a whole document (`form`) is named for its part, so that each shows in its place.
 */
function pageErrors(brief: Errors, checks: Errors, reward: Errors): Errors {
  const named = (errors: Errors, part: string) =>
    Object.entries(errors).map(([key, words]) => [key === "form" ? `form-${part}` : key, words]);
  const all = [...named(brief, "brief"), ...named(checks, "checks"), ...named(reward, "reward")];
  const head = all.filter(([key]) => key === "title" || key === "instructions");
  const verifier = all.filter(([key]) => key === "verifier");
  const rest = all.filter(
    ([key]) => key !== "title" && key !== "instructions" && key !== "verifier",
  );
  return Object.fromEntries([
    ...head,
    ...verifier,
    ...rest.filter(([key]) => !MORE_KEYS.test(key ?? "")),
    ...rest.filter(([key]) => MORE_KEYS.test(key ?? "")),
  ]);
}

/**
 * Keeps only the problems of fields the person has been in, and those that are not about a field of
 * their own: a whole document, and the held-out checks, which are spread over several fields.
 */
function onlyTouched(errors: Errors, touched: ReadonlySet<string>): Errors {
  return Object.fromEntries(
    Object.entries(errors).filter(
      ([key]) => key.startsWith("form-") || key === "heldout" || touched.has(key),
    ),
  );
}

/** The time now in ms, read again every 30 seconds: the deadline's line is to the minute. */
function useNowMs(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const WHEN = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export function PostTask({
  judgeAccount = config.judgeAccount,
}: {
  /** The Judge's account; this build's by default. Without one the Judge is not offered. */
  judgeAccount?: string | null;
} = {}) {
  const router = useRouter();
  const { ready, accountId, canSignMessage, connect, signAndSend } = useWallet();
  const { signIn } = useApiToken();
  const nowMs = useNowMs();

  // The deadline is set once the page is in the browser: a page made ahead of time can't know
  // when it is opened.
  const [form, setForm] = useState<PostForm>(() => ({
    ...emptyForm({ judgeAccount }),
    deadline: "",
  }));
  const [attempted, setAttempted] = useState(false);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [moreOpen, setMoreOpen] = useState(false);
  const [limits, setLimits] = useState<LimitsState>({ status: "loading" });
  const [canRubric, setCanRubric] = useState(false);
  const [vault, setVault] = useState<VaultState>({ status: "idle" });
  const [vaultNonce, setVaultNonce] = useState(0);
  const [running, setRunning] = useState<Stage | null>(null);
  // What happened is kept with the account it happened to, and shown while the wallet is that
  // account's: after a switch it is not news, and it is back, the lock included, on a switch back.
  const [failure, setFailure] = useState<Told<string> | null>(null);
  const [outcome, setOutcome] = useState<Told<SubmitResult> | null>(null);
  const [connecting, setConnecting] = useState(false);
  // A field to take the person to once the page has rendered it (it may be under More options).
  const [focusNonce, setFocusNonce] = useState(0);
  const focusNext = useRef<string | null>(null);

  // Set at once when a post starts, where `running` is only set for the next render: a second press
  // before then must not start a second post.
  const busy = useRef(false);
  const mounted = useRef(true);
  // The press of Post that is under way, for the person to stop waiting for it.
  const current = useRef<Run | null>(null);
  // The account whose last send was of unknown outcome, until a post has been through the chain
  // look: the first press after the person unlocks Post reads the chain for the task first.
  const lookFor = useRef<string | null>(null);
  // The account the wallet is connected as, as of the last render. A post checks it just before it
  // asks the wallet to sign, since the wallet signs as whoever is connected then.
  const latestAccount = useRef(accountId);
  latestAccount.current = accountId;
  const failed = toldFor(failure, accountId);
  const result = toldFor(outcome, accountId);

  useEffect(() => {
    mounted.current = true;
    setForm((was) =>
      was.deadline === ""
        ? { ...was, deadline: deadlineIn(DEFAULT_DEADLINE_SECS, Date.now()) }
        : was,
    );
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

  // ---- What the account holds, read once a wallet is connected ---------------------------------

  const vaultRequest = useRef(0);
  useEffect(() => {
    // `vaultNonce`: a read again, when the person has put something right.
    void vaultNonce;
    if (accountId === null) {
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
  }, [accountId, vaultNonce]);

  // ---- What is wrong ---------------------------------------------------------------------------

  const readyLimits = limits.status === "ready" ? limits.limits : null;
  const chosen = readyLimits === null ? undefined : tokenOf(form, readyLimits);
  const tokenId = chosen?.token ?? null;
  const errors = pageErrors(
    checkBrief(form),
    checkChecks(form, { canRubric }),
    readyLimits === null
      ? { limits: "What Tender allows has not loaded yet." }
      : checkReward(form, { limits: readyLimits, judgeAccount, poster: accountId, nowMs }),
  );
  const shown = attempted ? errors : onlyTouched(errors, touched);
  const hasProblems = Object.keys(errors).length > 0;
  const props: StepProps = { form, update, errors: shown, touch };

  const reward = tokenId === null ? null : rewardOf(form, tokenId);
  const funding =
    vault.status === "ready" && reward !== null && tokenId !== null
      ? fundingOf(vault.data, tokenId, reward, inviteBytes(form))
      : null;
  const canPost =
    ready &&
    accountId !== null &&
    canSignMessage &&
    readyLimits !== null &&
    !readyLimits.paused &&
    !hasProblems &&
    funding !== null &&
    funding.problem === null &&
    running === null &&
    result === null;

  // The field to go to, once it is on the page.
  useEffect(() => {
    void focusNonce;
    const id = focusNext.current;
    if (id === null) return;
    focusNext.current = null;
    document.getElementById(id)?.focus();
  }, [focusNonce]);

  const goTo = (key: string) => {
    if (MORE_KEYS.test(key)) setMoreOpen(true);
    // A problem with no field of its own goes to the part it is about, or to the button.
    focusNext.current =
      document.getElementById(`post-${key}`) !== null || MORE_KEYS.test(key)
        ? `post-${key}`
        : "post-ready";
    setFocusNonce((n) => n + 1);
  };

  // A kind that cannot score the format the answers have takes the format it can.
  const pickKind = (kind: CheckKind) => {
    update({ kind, outputFormat: formatForKind(kind, form.outputFormat) });
    touch("kind");
  };

  const defaultVerifier: Verifier = judgeAccount === null ? "me" : "judge";

  // ---- Posting ---------------------------------------------------------------------------------

  // The Connect button goes when the wallet is connected, and the focus would go with it. It is put
  // on the heading of the part with the button, where the person reads on.
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
      setFailure({ account: null, value: walletErrorMessage(error) });
    } finally {
      if (mounted.current) setConnecting(false);
    }
  };

  const post = async () => {
    if (busy.current || accountId === null || tokenId === null || reward === null) return;
    // What the page shows is what the person approves: the post stops if the chain asks for more.
    if (funding === null) return;
    const account = accountId;
    const run: Run = { stopped: false };
    current.current = run;
    busy.current = true;
    setFailure(null);
    setRunning("upload");
    try {
      const done = await submitPost(
        {
          form,
          account,
          tokenId,
          judgeAccount,
          lookFirst: lookFor.current === account,
          shown: { toDeposit: funding.toDeposit, storageTopUp: funding.storageTopUp },
        },
        {
          ...defaultDeps,
          account: () => latestAccount.current,
          signIn,
          signAndSend,
          stopped: () => run.stopped,
        },
        (stage) => {
          if (run.stopped || !mounted.current) return;
          // Past the look at the chain, so the task was not found there: the next press needs none.
          if (stage !== "check") lookFor.current = null;
          setRunning(stage);
        },
      );
      if (run.stopped || !mounted.current) return;
      if (done.kind === "unknown") lookFor.current = account;
      setOutcome({ account, value: done });
      if (done.kind === "posted") router.push(`/tasks/${done.taskId}`);
    } catch (error) {
      if (error instanceof PostStopped) return;
      console.error(error);
      if (run.stopped || !mounted.current) return;
      setFailure({
        account,
        value: error instanceof SubmitFailure ? error.message : errorMessage(error),
      });
      // The balances the page showed may not be the chain's any more: it reads them again.
      if (error instanceof SubmitFailure && (error.stage === "vault" || error.stage === "wallet")) {
        setVaultNonce((n) => n + 1);
      }
    } finally {
      if (!run.stopped) {
        busy.current = false;
        if (mounted.current) setRunning(null);
      }
    }
  };

  // Post: with a problem in the form, every problem shows and the person is taken to the first.
  const pressPost = () => {
    if (running !== null || busy.current) return;
    const key = firstError(errors);
    if (key !== undefined) {
      setAttempted(true);
      goTo(key);
      return;
    }
    if (canPost) void post();
  };

  // The wallet has not answered for a while and the person gives up on it. The post is let go: it
  // asks the wallet for nothing more, and what it still says is not heard. At the sign-in nothing
  // is on the chain, so Post is open again. With the transactions at the wallet they may yet be
  // sent, so Post is locked as after any send of unknown outcome. The press has taken away the
  // button that had the focus, so the focus goes to the heading above Post.
  const stopWaiting = () => {
    const run = current.current;
    if (run === null || run.stopped || accountId === null) return;
    if (running !== "signin" && running !== "wallet") return;
    run.stopped = true;
    busy.current = false;
    setRunning(null);
    if (running === "signin") {
      setFailure({ account: accountId, value: STOPPED_SIGNIN });
    } else {
      lookFor.current = accountId;
      setOutcome({ account: accountId, value: { kind: "unknown" } });
    }
    document.getElementById("post-ready")?.focus();
  };

  // The last send's outcome is not known and the person has looked: the lock comes off, and the
  // balances are read again so that the page shows what they are now. The press has taken away the
  // button that had the focus, so the focus goes to the heading that the Post button is under.
  const unlockPost = () => {
    if (result?.kind !== "unknown") return;
    setOutcome(null);
    setVaultNonce((n) => n + 1);
    document.getElementById("post-ready")?.focus();
  };

  // ---- The parts -------------------------------------------------------------------------------

  const symbol = chosen === undefined ? "" : tokenMeta(chosen.token, config.network).symbol;
  const windows = windowsOf(form, nowMs);
  const deadlineAt = form.timing === "deadline" ? deadlineMs(form.deadline) : null;
  const answersUntil =
    windows === null
      ? null
      : form.timing === "deadline"
        ? deadlineAt
        : nowMs + windows.commit * 1000;
  const who =
    form.verifier === "judge"
      ? "the Judge picks"
      : form.verifier === "me"
        ? "you pick"
        : "they pick";

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-8">
      <PageHead title="Post a task">
        Say what you need, who checks it, what it pays and until when. The reward is locked in the
        contract until a winner is paid, or goes back to whoever paid it.
      </PageHead>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <form
          noValidate
          aria-label="Post a task"
          onSubmit={(event) => event.preventDefault()}
          className="grid min-w-0 gap-4"
        >
          <section aria-labelledby="post-part-work" className={SECTION}>
            <SectionHead n={1} id="post-part-work" title="What do you need done?">
              Everything here is public.
            </SectionHead>
            <PartProblem id="post-form-brief" problem={shown["form-brief"]} />
            <TextField
              label="Title"
              help="Up to 120 characters."
              prose
              {...bindText(props, "title")}
            />
            <AreaField
              label="Instructions"
              help="What to do, and what a good answer looks like. Plain text, up to 8,000 characters."
              rows={7}
              prose
              {...bindText(props, "instructions")}
            />
          </section>

          <section aria-labelledby="post-part-checker" className={SECTION}>
            <SectionHead n={2} id="post-part-checker" title="Who checks the work?" />
            <PartProblem id="post-form-checks" problem={shown["form-checks"]} />
            <fieldset
              id="post-verifier"
              tabIndex={-1}
              aria-describedby={shown.verifier === undefined ? undefined : "post-verifier-error"}
              className="grid min-w-0 gap-3 sm:grid-cols-2"
            >
              <legend className="sr-only">Who checks the work?</legend>
              {(
                [
                  ...(judgeAccount === null
                    ? []
                    : [
                        {
                          value: "judge" as const,
                          label: "Tender Judge",
                          detail:
                            "Automatic. It scores each answer by your rule and picks the best. Run by the Tender team.",
                        },
                      ]),
                  {
                    value: "me" as const,
                    label: "I check it myself",
                    detail: "You read the answers and pick the winner.",
                  },
                ] satisfies Array<{ value: Verifier; label: string; detail: string }>
              ).map((option) => (
                <label
                  key={option.value}
                  className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-line bg-ink p-4 transition-colors hover:border-bone/30 has-checked:border-bone has-checked:bg-raised has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-bone motion-reduce:transition-none"
                >
                  <input
                    type="radio"
                    name="post-verifier"
                    value={option.value}
                    checked={form.verifier === option.value}
                    onChange={() => update({ verifier: option.value })}
                    className="mt-0.5 size-5 shrink-0 accent-seal"
                  />
                  <span className="grid min-w-0 gap-0.5">
                    <span className="font-medium text-bone">{option.label}</span>
                    <span className="text-sm text-muted">{option.detail}</span>
                  </span>
                </label>
              ))}
              <FieldError name="verifier" error={shown.verifier} />
            </fieldset>
            {form.verifier === "other" ? (
              <p className="text-sm text-muted">
                Another account checks the work. Change it under More options.
              </p>
            ) : null}
            {form.verifier === "judge" ? null : (
              <p data-testid="verifier-picks-with-mcp" className="text-sm text-muted">
                {VERIFIER_PICKS_WITH_MCP}
              </p>
            )}
            {form.kind === "rubric" && form.verifier === "judge" ? (
              <div className="grid gap-1 rounded-xl border border-line bg-raised p-4 text-sm font-medium text-bone">
                <p data-testid="rubric-judge-note">{RUBRIC_JUDGE_NOTE}</p>
                <p data-testid="rubric-judge-limit">{RUBRIC_JUDGE_LIMIT}</p>
              </div>
            ) : null}
            <RuleFields
              {...props}
              onMore={() => {
                setMoreOpen(true);
                focusNext.current = "post-kind";
                setFocusNonce((n) => n + 1);
              }}
            />
          </section>

          <section aria-labelledby="post-part-reward" className={SECTION}>
            <SectionHead n={3} id="post-part-reward" title="Reward" />
            {limits.status === "loading" ? (
              <p id="post-limits" tabIndex={-1} role="status" className="text-sm text-muted">
                Loading what Tender allows…
              </p>
            ) : limits.status === "error" ? (
              <div id="post-limits" tabIndex={-1}>
                <ErrorState
                  message={limits.message}
                  retrying={limits.retrying}
                  onRetry={loadLimits}
                />
              </div>
            ) : (
              <>
                <PartProblem id="post-form-reward" problem={shown["form-reward"]} />
                {chosen === undefined ? (
                  <p
                    id="post-token"
                    tabIndex={-1}
                    data-testid="error-token"
                    className="font-medium text-seal"
                  >
                    {shown.token ?? "Tender takes no rewards right now."}
                  </p>
                ) : (
                  <div className="grid gap-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:items-start">
                    <TextField
                      label={`Amount (${symbol})`}
                      help={
                        chosen.maxReward < NO_REAL_LIMIT
                          ? `At least ${describeAmount(chosen.minReward, chosen.token)}, at most ${describeAmount(chosen.maxReward, chosen.token)}.`
                          : `At least ${describeAmount(chosen.minReward, chosen.token)}.`
                      }
                      inputMode="decimal"
                      {...bindText(props, "amount")}
                    />
                    {limits.limits.tokens.length > 1 ? (
                      <SelectField
                        name="token"
                        label="Token"
                        value={chosen.token}
                        options={limits.limits.tokens.map(({ token }) => ({
                          value: token,
                          label: knowsToken(token)
                            ? `${tokenMeta(token, config.network).symbol} (${token})`
                            : token,
                        }))}
                        error={shown.token}
                        onChange={(token) => update({ token })}
                      />
                    ) : (
                      <p className="grid gap-1.5 text-sm text-muted sm:pt-1">
                        <span className="text-[14px] font-medium text-bone">Token</span>
                        <span className="wrap-anywhere">{`${symbol === chosen.token ? "" : `${symbol}, `}${chosen.token}`}</span>
                      </p>
                    )}
                  </div>
                )}
                {chosen === undefined ? null : (
                  <p data-testid="reward-net" className="text-[15px] text-bone">
                    {reward === null
                      ? `The winner receives the reward less Tender's ${formatBps(limits.limits.feeBps)} fee.`
                      : `Winner receives ${describeAmount(winnerReceives(reward, limits.limits.feeBps), chosen.token)} after the ${formatBps(limits.limits.feeBps)} fee.`}
                  </p>
                )}
              </>
            )}
          </section>

          <section aria-labelledby="post-part-deadline" className={SECTION}>
            <SectionHead n={4} id="post-part-deadline" title="Deadline" />
            {form.timing === "deadline" ? (
              <div className="grid gap-3">
                <div className="grid gap-1.5">
                  <label htmlFor="post-deadline" className="text-[14px] font-medium text-bone">
                    Agents answer until
                  </label>
                  <input
                    id="post-deadline"
                    name="deadline"
                    type="datetime-local"
                    value={form.deadline}
                    onChange={(event) => {
                      update({ deadline: event.currentTarget.value });
                      touch("deadline");
                    }}
                    onBlur={() => touch("deadline")}
                    aria-invalid={shown.deadline !== undefined}
                    aria-describedby={
                      shown.deadline === undefined
                        ? "post-deadline-plan"
                        : "post-deadline-plan post-deadline-error"
                    }
                    // A date field's parts take the focus inside it, which `:focus-visible` does not see in
                    // every browser: the ring is drawn for the field as a whole.
                    className={`${FIELD} [color-scheme:dark] focus-within:outline-2 focus-within:outline-offset-3 focus-within:outline-bone sm:max-w-72`}
                  />
                  <FieldError name="deadline" error={shown.deadline} />
                </div>
                <fieldset className="flex min-w-0 flex-wrap gap-2">
                  <legend className="sr-only">Quick picks</legend>
                  {QUICK_DEADLINES.map((pick) => (
                    <button
                      key={pick.label}
                      type="button"
                      aria-label={`${pick.label} from now`}
                      onClick={() => {
                        update({ deadline: deadlineIn(pick.secs, Date.now()) });
                        touch("deadline");
                      }}
                      className="min-h-10 rounded-full border border-line bg-raised px-4 text-sm text-bone transition-colors hover:border-bone/40 motion-reduce:transition-none"
                    >
                      {pick.label}
                    </button>
                  ))}
                </fieldset>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <p className="text-sm text-muted">You set each window under More options.</p>
                <button
                  type="button"
                  onClick={() => update({ timing: "deadline" })}
                  className="min-h-10 rounded-full border border-line bg-raised px-4 text-sm text-bone transition-colors hover:border-bone/40 motion-reduce:transition-none"
                >
                  Use one deadline
                </button>
              </div>
            )}
            <p
              id="post-deadline-plan"
              data-testid="deadline-plan"
              className="text-[13px] leading-relaxed text-muted"
            >
              {windows === null || answersUntil === null
                ? "Pick when agents stop answering. The rest is worked out from it."
                : `Agents send sealed answers (commit) until about ${WHEN.format(answersUntil)}, open them (reveal) for ${spanText(windows.reveal)}, and ${who} by about ${WHEN.format(answersUntil + (windows.reveal + windows.pick) * 1000)}.`}
            </p>
          </section>

          <MoreOptions
            {...props}
            open={moreOpen}
            onToggle={() => setMoreOpen((was) => !was)}
            canRubric={canRubric}
            onKind={pickKind}
            defaultVerifier={defaultVerifier}
            limits={readyLimits}
          />
        </form>

        <div className="lg:sticky lg:top-24">
          <PostSummary
            form={form}
            limits={readyLimits}
            judgeAccount={judgeAccount}
            tokenId={tokenId}
            ready={ready}
            accountId={accountId}
            canSignMessage={canSignMessage}
            connecting={connecting}
            vault={vault}
            running={running}
            failure={failed}
            outcome={result}
            hasProblems={hasProblems}
            canPost={canPost}
            onConnect={connectWallet}
            onRecheck={() => setVaultNonce((n) => n + 1)}
            onPost={pressPost}
            onStop={stopWaiting}
            onUnlock={unlockPost}
          />
        </div>
      </div>
    </div>
  );
}
