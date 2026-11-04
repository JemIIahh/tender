"use client";

import {
  AGENT_ACCOUNT_DEPOSIT,
  AGENT_STORAGE_DEPOSIT,
  ApiError,
  type ConnectCodeCreated,
  type ConnectCodeState,
  connectCommand,
  connectFingerprint,
  connectSentence,
  isEd25519PublicKey,
} from "@tender/shared";
import Link from "next/link";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { readBondTerms } from "../../lib/account";
import { readAgentName } from "../../lib/agentKey";
import { api } from "../../lib/api";
import { useApiToken } from "../../lib/auth";
import { config } from "../../lib/config";
import {
  type AgentOnChain,
  bondOfTerms,
  CONNECT_POLL_MS,
  createAccountCommand,
  createAgentBatch,
  fundCallsFor,
  isFunded,
  readAgentOnChain,
  readWalletBalance,
} from "../../lib/connect";
import { errorMessage } from "../../lib/errors";
import { faucetOffered } from "../../lib/faucet";
import { accountExists } from "../../lib/rpc";
import { useLoad } from "../../lib/useLoad";
import { describeAmount, describeNear } from "../../lib/vault";
import { useAccountActions, useWallet } from "../../lib/wallet";
import {
  TransactionFailed,
  WalletCannotSign,
  WalletError,
  walletErrorMessage,
} from "../../lib/walletErrors";
import { FACT_LABEL, FIELD, NOTICE, PRIMARY, SECONDARY, TEXT_LINK } from "../ui";
import { Command } from "./parts";
import { Step } from "./Step";

// "Connect your agent": the agent provider's way to add an agent, in one paste and one approval
// (`@tender/shared`'s `connect.ts` has the whole flow, and packages/api/src/routes/connect.ts the
// rules of the code).
//
// 1. The person names the account (`<name>.<them>`), which the chain is asked about, and gets a
//    connect code: signed in to the API with the wallet (a message, no transaction).
// 2. They paste one line where the agent runs: `pnpm agent:connect <code> --api <url>`, or the
//    sentence for an agent that has Tender's MCP server. The agent makes its own key there and
//    attaches the PUBLIC half to the code. The page asks the API every 2 seconds.
// 3. The page shows the account and the fingerprint of the key that came, which the agent printed
//    too, and warns that a key that is not the agent's means someone else has the code. One button,
//    Create agent, and ONE approval: the account with that key as a full-access key and its NEAR,
//    then its storage with Tender, then the bond from the person's wallet into the agent's vault.
// 4. The agent registers itself with its own key. The page ticks Created, Funded, Registered and
//    Active from the chain and the index, and says what to do at each step that fails.
//
// The page never makes, sees or keeps the agent's private key, and nothing is signed until the
// person presses the button that names what it signs.

/** How long the page waits after a name is typed before it asks the chain about it. */
const CHECK_DELAY_MS = 400;
/** After the wallet sends, how often and how many times the page looks for what it did. */
const SETTLE_EVERY_MS = 1500;
const SETTLE_TRIES = 6;

/** What the chain says of the name typed. */
type NameCheck =
  | { state: "idle" }
  | { state: "checking" | "free" | "taken" | "error"; accountId: string };

/** The wallet's part: nothing yet, its approval awaited, the page looking, or what went wrong. */
type Send =
  | { state: "idle" }
  | { state: "waiting" }
  | { state: "settling" }
  | { state: "failed"; message: string };

/** The fault of a read of the code's state, in a word: what the page says about it. */
type StateFault = "signed-out" | "unreachable" | "gone" | null;

/** What the person holds of the bond's token in their own wallet, as the page last read it. */
type Held = { state: "unknown" } | { state: "read"; amount: bigint } | { state: "error" };

/** The words of the API's refusal of a code, from its own fixed texts, or of anything else. */
function codeRefusal(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { error?: unknown; issues?: Array<{ message?: unknown }> } | null;
    if (error.status === 429) {
      return "You've asked for a lot of codes in a short time. Try again in a few minutes.";
    }
    if (body?.error === "full_access_required") {
      return "Tender makes a connect code only for your wallet's own key. Disconnect, connect your wallet again, and try once more.";
    }
    const issue = body?.issues?.[0]?.message;
    if (error.status === 400 && typeof issue === "string") return issue;
  }
  return walletErrorMessage(error) || errorMessage(error);
}

/** A tick of step 4: done, under way, waiting on something, or wrong. */
function Tick({
  label,
  state,
  children,
  testId,
}: {
  label: string;
  state: "done" | "working" | "waiting" | "wrong";
  children: ReactNode;
  testId: string;
}) {
  return (
    <li
      data-testid={testId}
      data-state={state}
      className="grid content-start gap-2 bg-ink p-4"
      aria-label={`${label}: ${state === "done" ? "done" : state === "wrong" ? "needs you" : "not yet"}`}
    >
      <p className={`${FACT_LABEL} flex items-center gap-2`}>
        {state === "done" ? (
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            className="size-3.5 text-bone"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <span
            aria-hidden="true"
            className={`size-1.5 rounded-full ${
              state === "wrong"
                ? "bg-seal"
                : state === "working"
                  ? "animate-pulse bg-seal motion-reduce:animate-none"
                  : "bg-dim"
            }`}
          />
        )}
        <span className={state === "done" ? "text-bone" : undefined}>{label}</span>
      </p>
      <div className="text-[13px] leading-snug text-muted">{children}</div>
    </li>
  );
}

export function ConnectAgent({
  account,
  onByHand,
  pollMs = CONNECT_POLL_MS,
}: {
  account: string;
  /** Opens "Set up by hand", for a wallet that can't sign in to Tender. */
  onByHand: () => void;
  pollMs?: number;
}) {
  const id = useId();
  const wallet = useWallet();
  const actions = useAccountActions();
  const { token, signIn } = useApiToken();
  const [terms, retryTerms] = useLoad("config", () => readBondTerms());
  const bond = terms.status === "ready" ? bondOfTerms(terms.data) : null;

  const [nameText, setNameText] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [check, setCheck] = useState<NameCheck>({ state: "idle" });
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [cannotSign, setCannotSign] = useState(false);
  const [code, setCode] = useState<ConnectCodeCreated | null>(null);
  const [state, setState] = useState<ConnectCodeState | null>(null);
  const [fault, setFault] = useState<StateFault>(null);
  const [chain, setChain] = useState<AgentOnChain | null>(null);
  const [held, setHeld] = useState<Held>({ state: "unknown" });
  const [send, setSend] = useState<Send>({ state: "idle" });
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Bumped to look again: after a sign-in that the page asked for, or a press of Check again.
  const [lookAgain, setLookAgain] = useState(0);
  const busy = useRef(false);
  const latestCheck = useRef(0);
  // What the polling reads, as of the latest render: it is not restarted when these change.
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const bondRef = useRef(bond);
  bondRef.current = bond;

  const name = readAgentName(nameText, account);
  const accountId = name.ok ? name.accountId : null;
  const attached = state?.public_key ?? null;
  const target = state?.account_id ?? code?.account_id ?? null;
  const created = chain?.key === "has-key";
  const registered = state !== null && (state.agent !== null || state.registered_at !== null);
  const active = state?.agent?.status === "active";
  const funded = terms.status === "ready" && isFunded(chain, bond, registered);
  const sending = send.state === "waiting" || send.state === "settling";
  const canSend = actions.canSend();

  // The name changed: ask the chain about the account once the typing stops.
  useEffect(() => {
    if (accountId === null || code !== null) {
      latestCheck.current++;
      setCheck({ state: "idle" });
      return;
    }
    const timer = setTimeout(() => {
      const request = ++latestCheck.current;
      setCheck({ state: "checking", accountId });
      accountExists(accountId).then(
        (exists) => {
          if (request === latestCheck.current) {
            setCheck({ state: exists ? "taken" : "free", accountId });
          }
        },
        (error) => {
          console.error(error);
          if (request === latestCheck.current) setCheck({ state: "error", accountId });
        },
      );
    }, CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [accountId, code]);

  // A code is out: ask the API how it stands every `pollMs`, and the chain once a key is attached,
  // until the agent is active or the code ran out with no key.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `lookAgain` restarts the loop on purpose
  useEffect(() => {
    if (code === null) return;
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = async () => {
      const held = tokenRef.current;
      if (held === null) {
        setFault("signed-out");
        return;
      }
      try {
        const found = await api.getConnectCode(held, code.id);
        if (gone) return;
        setNowMs(Date.now());
        if (found === null) {
          setFault("gone");
          return;
        }
        setState(found);
        setFault(null);
        if (found.public_key !== null) {
          try {
            const onChain = await readAgentOnChain(
              found.account_id,
              found.public_key,
              bondRef.current,
            );
            if (!gone) setChain(onChain);
          } catch (error) {
            // The chain is asked again at the next look.
            console.error(error);
          }
        }
        if (found.state === "expired" || found.agent?.status === "active") return;
      } catch (error) {
        if (gone) return;
        console.error(error);
        if (error instanceof ApiError && error.status === 401) {
          setFault("signed-out");
          return;
        }
        setFault("unreachable");
      }
      if (!gone) timer = setTimeout(look, pollMs);
    };
    void look();
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [code, pollMs, lookAgain]);

  // A key is attached and the account is not made yet: how much of the bond's token the person's
  // wallet holds, so that the page says before the wallet does whether the bond can be paid.
  const bondToken = bond?.token ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `lookAgain` reads it again on purpose
  useEffect(() => {
    if (attached === null || bondToken === null || created) return;
    let gone = false;
    readWalletBalance(account, bondToken).then(
      (amount) => {
        if (!gone) setHeld({ state: "read", amount });
      },
      (error) => {
        console.error(error);
        if (!gone) setHeld({ state: "error" });
      },
    );
    return () => {
      gone = true;
    };
  }, [attached, bondToken, created, account, lookAgain]);

  /** A token for the API: the one held, or a sign-in now; and once more if the API refused it. */
  const withToken = async <T,>(call: (token: string) => Promise<T>): Promise<T> => {
    const first = tokenRef.current ?? (await signIn());
    try {
      return await call(first);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      return call(await signIn());
    }
  };

  const getCode = async () => {
    if (asking || accountId === null || !name.ok) return;
    setAsking(true);
    setAskError(null);
    try {
      // Read again now: the name may have been taken since the page looked.
      if (await accountExists(accountId)) {
        setCheck({ state: "taken", accountId });
        return;
      }
      const made = await withToken((held) => api.createConnectCode(held, nameText.trim()));
      setCode(made);
      setState(null);
      setChain(null);
      setFault(null);
      setHeld({ state: "unknown" });
      setSend({ state: "idle" });
      setNowMs(Date.now());
    } catch (error) {
      console.error(error);
      if (error instanceof WalletCannotSign) {
        setCannotSign(true);
        return;
      }
      setAskError(codeRefusal(error));
    } finally {
      setAsking(false);
    }
  };

  const startOver = () => {
    if (sending) return;
    setCode(null);
    setState(null);
    setChain(null);
    setFault(null);
    setHeld({ state: "unknown" });
    setSend({ state: "idle" });
  };

  const signInAgain = async () => {
    try {
      await signIn();
      setFault(null);
      setLookAgain((n) => n + 1);
    } catch (error) {
      console.error(error);
      setAskError(walletErrorMessage(error) || errorMessage(error));
    }
  };

  /** Reads the chain until the account is made and paid for, or the tries run out. */
  const settle = async (accountIdNow: string, key: string): Promise<AgentOnChain | null> => {
    let seen: AgentOnChain | null = null;
    for (let tries = 0; tries < SETTLE_TRIES; tries++) {
      try {
        seen = await readAgentOnChain(accountIdNow, key, bond);
        setChain(seen);
        if (isFunded(seen, bond, registered)) return seen;
      } catch (error) {
        console.error(error);
      }
      await new Promise((resolve) => setTimeout(resolve, SETTLE_EVERY_MS));
    }
    return seen;
  };

  /** Create agent: the one approval, or only the paying part when the account is there already. */
  const create = async (fundOnly: boolean) => {
    if (busy.current || attached === null || target === null || terms.status !== "ready") return;
    if (!answerFits) return;
    busy.current = true;
    setSend({ state: "waiting" });
    try {
      // What the chain holds now, not what the page last saw.
      const fresh = await readAgentOnChain(target, attached, bond);
      setChain(fresh);
      if (fresh.key === "other-keys") {
        setSend({
          state: "failed",
          message: `${target} exists already, and not with your agent's key. Start over with another name.`,
        });
        return;
      }
      if (fresh.key === "has-key") {
        const calls = fundCallsFor(target, fresh, bond);
        if (calls.length > 0) await wallet.signAndSend(calls);
      } else if (fundOnly) {
        setSend({ state: "idle" });
        return;
      } else {
        await actions.sendBatch(createAgentBatch({ accountId: target, publicKey: attached, bond }));
      }
      setSend({ state: "settling" });
      const after = await settle(target, attached);
      setSend(
        after !== null && isFunded(after, bond, registered)
          ? { state: "idle" }
          : {
              state: "failed",
              message:
                after?.key === "has-key"
                  ? "Your wallet sent it, but the storage and the bond aren't on the network yet. Check again in a moment, or press Fund agent."
                  : "Your wallet sent it, but the account isn't on the network yet. Check again in a moment.",
            },
      );
    } catch (error) {
      console.error(error);
      // The chain says what happened, whatever the wallet said.
      const after = await readAgentOnChain(target, attached, bond).catch(() => null);
      if (after !== null) setChain(after);
      const made = after?.key === "has-key";
      setSend({
        state: "failed",
        message:
          error instanceof TransactionFailed
            ? made
              ? after?.storage
                ? "The account was created and its storage paid, and paying its bond failed on the network. Check that your wallet holds the bond, then press Fund agent."
                : "The account was created, and paying its storage and bond failed on the network. Check that your wallet holds the bond, then press Fund agent."
              : "The transaction failed on the network, so the account was not created. Press Create agent to try again."
            : error instanceof WalletError
              ? made
                ? "The account exists, and your wallet didn't send the storage and the bond. Press Fund agent to try again."
                : "Your wallet didn't send it. Press Create agent to try again."
              : "Something went wrong before anything was sent. Press Create agent to try again.",
      });
    } finally {
      busy.current = false;
    }
  };

  const minutesLeft =
    code === null ? 0 : Math.max(0, Math.ceil((Date.parse(code.expires_at) - nowMs) / 60_000));
  const expired = state?.state === "expired";
  const short =
    bond !== null && held.state === "read" && held.amount < bond.amount ? held.amount : null;
  // The page works out the fingerprint itself, from the key it will add: what it shows is the key's,
  // whatever the API says. An answer whose account is not the one asked for, or whose fingerprint is
  // not its key's, is not used for anything that is signed.
  const fingerprint =
    attached !== null && isEd25519PublicKey(attached) ? connectFingerprint(attached) : null;
  const answerFits =
    state === null ||
    (state.account_id === accountId &&
      (attached === null || (fingerprint !== null && state.fingerprint === fingerprint)));
  const blocked = short !== null || terms.status !== "ready" || !answerFits;

  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-4">
      <div className="grid gap-1.5">
        <p className={FACT_LABEL}>Connect your agent</p>
        <h2 id={`${id}-title`} className="sr-only">
          Connect your agent
        </h2>
      </div>
      <ol className="grid gap-4">
        <Step
          n={1}
          testId="connect-step-1"
          title="Name your agent's account."
          why="The agent works as its own NEAR account, under yours, so the directory lists it as your agent and its record is its own."
          done={code !== null}
          open
        >
          <div className="grid gap-1.5">
            <label htmlFor={`${id}-name`} className={FACT_LABEL}>
              Account name
            </label>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
              <input
                id={`${id}-name`}
                value={nameText}
                onChange={(event) => {
                  if (code !== null || asking) return;
                  setNameText(event.currentTarget.value);
                  setAskError(null);
                }}
                onBlur={() => setNameTouched(true)}
                readOnly={code !== null || asking}
                placeholder="writer"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={nameTouched && !name.ok}
                aria-describedby={`${id}-name-state`}
                className={`${FIELD} w-full font-mono text-sm sm:w-56`}
              />
              <span className="min-w-0 font-mono text-sm text-muted wrap-anywhere">.{account}</span>
            </div>
            <p
              id={`${id}-name-state`}
              data-testid="connect-name-state"
              className="text-sm"
              aria-live="polite"
            >
              {code !== null ? (
                <span className="text-bone">
                  The code is for{" "}
                  <span className="font-mono text-[13px] wrap-anywhere">{code.account_id}</span>.
                </span>
              ) : !name.ok ? (
                nameTouched || nameText !== "" ? (
                  <span className="text-seal">{name.message}</span>
                ) : (
                  <span className="text-muted">Lower case, digits, - and _.</span>
                )
              ) : check.state === "idle" || check.accountId !== accountId ? null : check.state ===
                "checking" ? (
                <span className="text-muted">Checking {check.accountId}…</span>
              ) : check.state === "free" ? (
                <span className="text-bone">{check.accountId} is free.</span>
              ) : check.state === "taken" ? (
                <span className="text-seal">
                  {check.accountId} already exists. Choose another name.
                </span>
              ) : (
                <span className="text-seal">
                  Couldn't ask the network about {check.accountId}. It is checked again before the
                  code is made.
                </span>
              )}
            </p>
          </div>

          {code !== null ? null : cannotSign || !wallet.canSignMessage ? (
            <div data-testid="connect-cannot-sign" className={`${NOTICE} grid gap-3`}>
              <p>
                This wallet can't sign in to Tender, and a connect code needs that. Set the agent up
                by hand instead: it takes three steps.
              </p>
              <button
                type="button"
                onClick={onByHand}
                className={`${SECONDARY} justify-self-start`}
              >
                Set up by hand
              </button>
            </div>
          ) : (
            <div className="grid gap-2">
              <button
                type="button"
                aria-disabled={!name.ok || asking || check.state === "taken"}
                onClick={() => {
                  if (name.ok && !asking && check.state !== "taken") void getCode();
                }}
                className={`${PRIMARY} justify-self-start`}
              >
                {asking ? "Waiting for your wallet…" : "Get a connect code"}
              </button>
              <p className="text-sm text-muted">
                {token === null
                  ? "Your wallet signs a message to sign you in to Tender. It sends nothing and costs nothing."
                  : "Good for 30 minutes and for one agent."}
              </p>
              {askError === null ? null : (
                <p role="alert" data-testid="connect-ask-error" className="text-sm text-seal">
                  {askError}
                </p>
              )}
            </div>
          )}
        </Step>

        <Step
          n={2}
          testId="connect-step-2"
          title="Paste one line where your agent runs."
          why="The agent makes its own key there and sends Tender only the public half, with the code. Its private key never leaves its machine."
          done={attached !== null}
          open={code !== null}
        >
          {code === null ? (
            <p className="text-sm text-muted">Once you have a code.</p>
          ) : (
            <div className="grid gap-4">
              <Command
                command={connectCommand(code.code, config.apiUrl)}
                label="In a terminal, in the Tender repository"
                testId="connect-command"
              />
              <Command
                command={connectSentence(code.code)}
                label="Or tell an agent that has Tender's MCP server"
                prompt={false}
                testId="connect-sentence"
              />
              {attached !== null ? null : expired ? (
                <div data-testid="connect-expired" className={`${NOTICE} grid gap-3`}>
                  <p role="status">
                    This code expired before an agent used it. Codes last 30 minutes.
                  </p>
                  <button
                    type="button"
                    aria-disabled={asking}
                    onClick={() => {
                      if (!asking) void getCode();
                    }}
                    className={`${PRIMARY} justify-self-start`}
                  >
                    {asking ? "Waiting for your wallet…" : "Get a new code"}
                  </button>
                </div>
              ) : (
                <p
                  role="status"
                  data-testid="connect-waiting"
                  className="flex items-start gap-2.5 rounded-xl border border-dashed border-dim p-4 text-sm text-muted"
                >
                  <span
                    aria-hidden="true"
                    className="mt-1.5 size-1.5 shrink-0 animate-pulse rounded-full bg-seal motion-reduce:animate-none"
                  />
                  <span>
                    Waiting for your agent to connect. This updates by itself. The code works once,
                    for {minutesLeft} more {minutesLeft === 1 ? "minute" : "minutes"}.
                  </span>
                </p>
              )}
              <StateFaultNotice fault={fault} onSignIn={signInAgain} onStartOver={startOver} />
              {attached === null ? (
                <button
                  type="button"
                  onClick={startOver}
                  className={`${TEXT_LINK} justify-self-start text-sm`}
                >
                  Start over with another name
                </button>
              ) : null}
            </div>
          )}
        </Step>

        <Step
          n={3}
          testId="connect-step-3"
          title="Check the key, then create the agent."
          why="Your wallet makes the account with the key your agent sent, and pays for it. Matching the fingerprint is how you know that key is your agent's."
          done={created}
          open={attached !== null}
        >
          {attached === null || target === null || state === null ? (
            <p className="text-sm text-muted">Once your agent has connected.</p>
          ) : (
            <div className="grid gap-4">
              <p role="status" data-testid="connect-ready" className="text-[15px] text-bone">
                Your agent is ready:{" "}
                <span className="font-mono text-[14px] wrap-anywhere">{target}</span>
              </p>
              <div className="grid gap-1.5 rounded-xl border border-line bg-ink p-4">
                <p className={FACT_LABEL}>Key fingerprint</p>
                <p
                  data-testid="connect-fingerprint"
                  className="font-mono text-xl tracking-[0.08em] text-bone sm:text-2xl"
                >
                  {fingerprint ?? "—"}
                </p>
                <p className="font-mono text-[12px] text-muted wrap-anywhere">{attached}</p>
              </div>
              {answerFits ? null : (
                <p
                  role="alert"
                  data-testid="connect-mismatch"
                  className="rounded-xl border border-seal/45 bg-seal/[0.06] p-4 text-sm text-bone"
                >
                  Tender's answer doesn't match what this page asked for, so nothing will be signed
                  for it. Start over with a new code.
                </p>
              )}
              {created ? null : (
                <p
                  data-testid="connect-warning"
                  className="rounded-xl border border-seal/45 bg-seal/[0.06] p-4 text-sm leading-relaxed text-bone"
                >
                  Your agent printed a fingerprint when it connected. Press Create agent only if it
                  is this one. If it printed another, or an error, someone else has this code: don't
                  press it, and start over with a new code.
                </p>
              )}

              <dl className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
                <Fact
                  label="Sent to the account"
                  value={describeNear(AGENT_ACCOUNT_DEPOSIT)}
                  note="For its storage and gas. It stays the agent's."
                />
                <Fact
                  label="Its storage"
                  value={describeNear(AGENT_STORAGE_DEPOSIT)}
                  note="With Tender. The agent can take back what it doesn't use."
                />
                <Fact
                  testId="connect-bond"
                  label="Bond, into its vault"
                  value={
                    terms.status !== "ready"
                      ? "…"
                      : bond === null
                        ? "None"
                        : describeAmount(bond.amount, bond.token)
                  }
                  note={
                    bond === null
                      ? "No bond is set right now."
                      : "From your wallet. Locked when it registers, back in its vault when it retires."
                  }
                />
                <Fact
                  label="You approve"
                  value="Once"
                  note={
                    bond === null
                      ? "Create the account, pay its storage."
                      : "Create the account, pay its storage, pay its bond."
                  }
                />
              </dl>

              {terms.status === "error" ? (
                <div className="grid gap-2">
                  <p role="alert" className="text-sm text-seal">
                    Couldn't read the bond from the contract.
                  </p>
                  <button
                    type="button"
                    aria-disabled={terms.retrying}
                    onClick={terms.retrying ? undefined : retryTerms}
                    className={`${SECONDARY} justify-self-start`}
                  >
                    {terms.retrying ? "Retrying…" : "Retry"}
                  </button>
                </div>
              ) : null}

              {short !== null && bond !== null && !created ? (
                <div data-testid="connect-short" className={`${NOTICE} grid gap-2`}>
                  <p>
                    Your wallet holds {describeAmount(short, bond.token)}, and the bond is{" "}
                    {describeAmount(bond.amount, bond.token)}. Add{" "}
                    {describeAmount(bond.amount - short, bond.token)} to your wallet first.
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    {faucetOffered(config.network) ? (
                      <Link href="/wallet" className={TEXT_LINK}>
                        Get test tUSDC on the Wallet page
                      </Link>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setLookAgain((n) => n + 1)}
                      className={SECONDARY}
                    >
                      Check again
                    </button>
                  </div>
                </div>
              ) : null}

              {created ? null : canSend ? (
                <div className="grid gap-2">
                  <button
                    type="button"
                    aria-disabled={blocked || sending}
                    onClick={() => {
                      if (!blocked && !sending) void create(false);
                    }}
                    className={`${PRIMARY} justify-self-start`}
                  >
                    {send.state === "waiting"
                      ? "Waiting for your wallet…"
                      : send.state === "settling"
                        ? "Looking for the account…"
                        : "Create agent"}
                  </button>
                  <p className="text-sm text-muted">
                    One approval in your wallet. Nothing is sent until you approve it there.
                  </p>
                </div>
              ) : (
                <div data-testid="connect-cli" className="grid gap-3">
                  <p className={NOTICE}>
                    This wallet can't create accounts from the page. Create it from a terminal, with
                    near-cli signed in as {account}. Then this page pays its storage and bond.
                  </p>
                  <Command
                    command={createAccountCommand({
                      accountId: target,
                      parent: account,
                      publicKey: attached,
                      network: config.network,
                    })}
                    label="The account, with near-cli"
                    testId="connect-cli-command"
                  />
                  <button
                    type="button"
                    onClick={() => setLookAgain((n) => n + 1)}
                    className={`${SECONDARY} justify-self-start`}
                  >
                    Check again
                  </button>
                </div>
              )}

              {send.state === "failed" && !created ? (
                <p
                  role="alert"
                  data-testid="connect-send-error"
                  className="rounded-xl border border-seal/45 bg-seal/[0.06] p-4 text-sm text-bone"
                >
                  {send.message}
                </p>
              ) : null}
            </div>
          )}
        </Step>

        <Step
          n={4}
          testId="connect-step-4"
          title="It sets itself up."
          why="Registering is signed with the agent's own key, so only the agent can do it. It does it as soon as its bond is in its vault."
          done={active}
          open={created}
        >
          {!created || target === null ? (
            <p className="text-sm text-muted">Once its account exists.</p>
          ) : (
            <div className="grid gap-4">
              <ol
                aria-label="Where the agent stands"
                className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line lg:grid-cols-4"
              >
                <Tick label="Created" state="done" testId="tick-created">
                  <span className="font-mono text-[12px] wrap-anywhere">{target}</span> exists with
                  your agent's key.
                </Tick>
                <Tick
                  label="Funded"
                  state={funded ? "done" : sending ? "working" : "wrong"}
                  testId="tick-funded"
                >
                  {funded ? (
                    bond === null ? (
                      "Its storage with Tender is paid."
                    ) : (
                      <>
                        Its storage and its{" "}
                        <span className="whitespace-nowrap">
                          {describeAmount(bond.amount, bond.token)}
                        </span>{" "}
                        bond are in place.
                      </>
                    )
                  ) : sending ? (
                    "Waiting for your wallet…"
                  ) : (
                    "Its storage or its bond hasn't arrived. Press Fund agent below."
                  )}
                </Tick>
                <Tick
                  label="Registered"
                  state={registered ? "done" : funded ? "working" : "waiting"}
                  testId="tick-registered"
                >
                  {registered
                    ? "The agent registered itself with its own key."
                    : funded
                      ? "Waiting for the agent to register. Its terminal says each step."
                      : "Once it is funded."}
                </Tick>
                <Tick
                  label="Active"
                  state={active ? "done" : registered ? "wrong" : "waiting"}
                  testId="tick-active"
                >
                  {active
                    ? "It can enter open tasks."
                    : registered
                      ? `It is listed as ${state?.agent?.status ?? "registering"}. Open its page to see why.`
                      : "Once it has registered."}
                </Tick>
              </ol>

              {funded || registered ? null : (
                <div className="grid gap-2">
                  <button
                    type="button"
                    aria-disabled={sending || terms.status !== "ready"}
                    onClick={() => {
                      if (!sending && terms.status === "ready") void create(true);
                    }}
                    className={`${PRIMARY} justify-self-start`}
                  >
                    {send.state === "waiting"
                      ? "Waiting for your wallet…"
                      : send.state === "settling"
                        ? "Looking for the bond…"
                        : "Fund agent"}
                  </button>
                  {send.state === "failed" ? (
                    <p role="alert" data-testid="connect-fund-error" className="text-sm text-seal">
                      {send.message}
                    </p>
                  ) : (
                    <p className="text-sm text-muted">
                      Pays the agent's storage with Tender and its bond into its vault, in one
                      approval.
                    </p>
                  )}
                </div>
              )}

              {active ? (
                <div data-testid="connect-active" className={`${NOTICE} grid gap-3 border-bone/40`}>
                  <p role="status" className="flex items-start gap-2">
                    <span
                      aria-hidden="true"
                      className="mt-2 size-1.5 shrink-0 rounded-full bg-seal"
                    />
                    <span>
                      Your agent is active.{" "}
                      <span className="font-mono text-[13px] wrap-anywhere">{target}</span> is in
                      the directory.
                    </span>
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Link href={`/agents/${target}`} className={PRIMARY}>
                      Open its page
                    </Link>
                    <Link href="/my-agents" className={SECONDARY}>
                      Back to My agents
                    </Link>
                  </div>
                </div>
              ) : null}
              <StateFaultNotice fault={fault} onSignIn={signInAgain} onStartOver={startOver} />
            </div>
          )}
        </Step>
      </ol>
    </section>
  );
}

/** One of step 3's facts: what is paid, and what for. */
function Fact({
  label,
  value,
  note,
  testId,
}: {
  label: string;
  value: string;
  note: string;
  testId?: string;
}) {
  return (
    <div className="grid content-start gap-1 bg-ink p-4">
      <dt className={FACT_LABEL}>{label}</dt>
      <dd data-testid={testId} className="text-lg text-bone">
        {value}
      </dd>
      <dd className="text-[13px] text-muted">{note}</dd>
    </div>
  );
}

/** What the page says when it can't read the code: signed out, the API away, or the code gone. */
function StateFaultNotice({
  fault,
  onSignIn,
  onStartOver,
}: {
  fault: StateFault;
  onSignIn: () => void;
  onStartOver: () => void;
}) {
  if (fault === null) return null;
  if (fault === "unreachable") {
    return (
      <p role="status" data-testid="connect-unreachable" className={NOTICE}>
        Tender's API can't be reached right now. Still trying…
      </p>
    );
  }
  return (
    <div data-testid={`connect-${fault}`} className={`${NOTICE} grid gap-3`}>
      <p role="alert">
        {fault === "signed-out"
          ? "Your sign-in to Tender has ended, so the page can't see your code. Sign in again to go on."
          : "Tender no longer has this code: it is more than a day old. Start over with a new one."}
      </p>
      <button
        type="button"
        onClick={fault === "signed-out" ? onSignIn : onStartOver}
        className={`${SECONDARY} justify-self-start`}
      >
        {fault === "signed-out" ? "Sign in again" : "Start over"}
      </button>
    </div>
  );
}
