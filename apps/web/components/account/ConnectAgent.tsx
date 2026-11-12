"use client";

import {
  AGENT_ACCOUNT_DEPOSIT,
  AGENT_STORAGE_DEPOSIT,
  type AgentBondTerms,
  ApiError,
  type ConnectCodeState,
  connectCommand,
  connectFingerprint,
  connectSentence,
  implicitAccountOf,
  isEd25519PublicKey,
} from "@tender/shared";
import Link from "next/link";
import { Fragment, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { type BondTerms, readBondTerms } from "../../lib/account";
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
  heldOnImplicit,
  heldOnSubAccount,
  implicitAgentBatch,
  isFunded,
  isPaid,
  type KeptCode,
  keepCode,
  readAgentFunding,
  readAgentOnChain,
  readKeptCode,
  readWalletBalance,
  rememberImplicit,
  storageNote,
  whatLanded,
} from "../../lib/connect";
import { errorMessage } from "../../lib/errors";
import { faucetOffered } from "../../lib/faucet";
import { accountExists, fullAccessKeysOf } from "../../lib/rpc";
import type { Loaded } from "../../lib/useLoad";
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
//    Create agent, and ONE approval: the account and its NEAR, with its setup code and the call that
//    adds that key as a full-access key (no AddKey action, which some wallets refuse), then what
//    Tender does not hold for it yet: its storage, and the bond from the person's wallet into the
//    agent's vault. When the wallet refuses or blocks that, the page offers ONE way out, "Use a
//    separate account instead": the API records the choice, and the approval sends NEAR to the
//    implicit account of the key (which the page works out itself) and the same storage and bond.
//    The directory does not list such an agent under the person, which the page says.
// 4. The agent registers itself with its own key. The page ticks Created, Funded, Registered and
//    Active from the chain and the index, and says what to do at each step that fails.
//
// A code that two different keys tried is CONTESTED (the API says so): someone else has it, and the
// page creates and funds nothing for it. A name whose account exists already is an agent the person
// may have started: "Finish this agent" reads where it stands and pays what it lacks, with no code.
// The code's id (no credential) is kept in this tab, so a reload comes back to the same code.
//
// The page never makes, sees or keeps the agent's private key, and nothing is signed until the
// person presses the button that names what it signs.

/** What the page says when a fresh read of the code is not what the person checked. */
const ANSWER_CHANGED =
  "Tender's answer changed just before your wallet was asked, so nothing was sent. Read the page again before you press anything.";

/** What the page says of an implicit account, wherever it offers or shows one. */
const SEPARATE_ACCOUNT =
  "This agent is its own account, so Tender's directory won't list it under you as its provider.";

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
  /**
   * `kind`: the way whose account the words are about ("pressing Create agent again creates the
   * account only"). They are shown only while the code is on that way.
   */
  | { state: "failed"; message: string; kind?: "sub_account" | "implicit" };

/** The fault of a read of the code's state, in a word: what the page says about it. */
type StateFault = "signed-out" | "unreachable" | "gone" | null;

/** What the person holds of the bond's token in their own wallet, as the page last read it. */
type Held = { state: "unknown" } | { state: "read"; amount: bigint } | { state: "error" };

/** A code as the page holds it: what is kept across a reload, and the code itself while shown. */
type HeldCode = KeptCode & {
  /** The code, shown once; null after a reload, as it is never kept. */
  code: string | null;
};

/** The words of the API's refusal of a code, from its own fixed texts, or of anything else. */
function codeRefusal(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { error?: unknown; issues?: Array<{ message?: unknown }> } | null;
    if (error.status === 429) {
      return "You've asked for a lot of codes in a short time. Try again in a few minutes.";
    }
    if (body?.error === "full_access_required") {
      return "Tender makes a connect code only for your wallet's own key. Disconnect, sign in again, and try once more.";
    }
    const issue = body?.issues?.[0]?.message;
    if (error.status === 400 && typeof issue === "string") return issue;
  }
  return walletErrorMessage(error) || errorMessage(error);
}

/** An account id that breaks at its dots on a narrow screen, and not in the middle of a part. */
export function AccountName({ id, className }: { id: string; className?: string }) {
  const parts = id.split(".");
  return (
    <span className={`font-mono wrap-anywhere ${className ?? ""}`}>
      {parts.map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one id, in their order
        <Fragment key={index}>
          {part}
          {index < parts.length - 1 ? (
            <>
              .<wbr />
            </>
          ) : null}
        </Fragment>
      ))}
    </span>
  );
}

/** A tick of the agent's setup: done, under way, waiting on something, or wanting the person. */
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
    <li data-testid={testId} data-state={state} className="grid content-start gap-2 bg-ink p-4">
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
        {/* What the mark says, for a screen reader: the words below stay read as they are. */}
        <span className="sr-only">
          {state === "done" ? ", done" : state === "wrong" ? ", needs you" : ", not yet"}
        </span>
      </p>
      <div className="text-[13px] leading-snug text-muted">{children}</div>
    </li>
  );
}

/**
 * The four ticks of an agent's setup, Created · Funded · Registered · Active, and Fund agent while
 * Tender lacks its storage or its bond. Step 4 shows them for a code's account, and "Finish this
 * agent" for an account typed in step 1.
 */
function AgentTicks({
  target,
  funded,
  registered,
  active,
  status,
  bond,
  send,
  canFund,
  fundBlocked,
  onFund,
  keyWords = "your agent's key",
}: {
  /** What the Created tick says the account has: the key the code brought, or the key shown above. */
  keyWords?: string;
  target: string;
  funded: boolean;
  registered: boolean;
  active: boolean;
  /** The agent's status in the index, once it is there. */
  status: string | null;
  bond: AgentBondTerms | null;
  send: Send;
  /** Whether Fund agent is offered at all: not while the terms of the bond are unread. */
  canFund: boolean;
  /** Why Fund agent is off, if it is. */
  fundBlocked: string | null;
  onFund: () => void;
}) {
  const sending = send.state === "waiting" || send.state === "settling";
  return (
    <div className="grid gap-4">
      <ol
        aria-label="Where the agent stands"
        className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line lg:grid-cols-4"
      >
        <Tick label="Created" state="done" testId="tick-created">
          <AccountName id={target} className="text-[12px]" /> exists with {keyWords}.
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
                <span className="whitespace-nowrap">{describeAmount(bond.amount, bond.token)}</span>{" "}
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
              ? `It is listed as ${status ?? "registering"}. Open its page to see why.`
              : "Once it has registered."}
        </Tick>
      </ol>

      {funded || registered ? null : (
        <div className="grid gap-2">
          <button
            type="button"
            aria-disabled={sending || !canFund || fundBlocked !== null}
            onClick={() => {
              if (!sending && canFund && fundBlocked === null) onFund();
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
          ) : fundBlocked !== null ? (
            <p className="text-sm text-muted">{fundBlocked}</p>
          ) : (
            <p className="text-sm text-muted">
              Pays what Tender doesn't hold for the agent yet, its storage or its bond, in one
              approval.
            </p>
          )}
        </div>
      )}

      {active ? (
        <div data-testid="connect-active" className={`${NOTICE} grid gap-3 border-bone/40`}>
          <p role="status" className="flex items-start gap-2">
            <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-seal" />
            <span>
              Your agent is active. <AccountName id={target} className="text-[13px]" /> is in the
              directory.
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
    </div>
  );
}

/** Reads the chain until `ready` holds, or the tries run out; gives the last thing it read. */
async function settleOn<T>(read: () => Promise<T>, ready: (seen: T) => boolean): Promise<T | null> {
  let seen: T | null = null;
  for (let tries = 0; tries < SETTLE_TRIES; tries++) {
    try {
      seen = await read();
      if (ready(seen)) return seen;
    } catch (error) {
      console.error(error);
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE_EVERY_MS));
  }
  return seen;
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

  // A code kept in this tab before a reload comes back: its id and its name, not the code itself.
  const [code, setCode] = useState<HeldCode | null>(() => {
    const kept = readKeptCode(account);
    return kept === null ? null : { ...kept, code: null };
  });
  const [nameText, setNameText] = useState(() => code?.name ?? "");
  const [nameTouched, setNameTouched] = useState(false);
  const [check, setCheck] = useState<NameCheck>({ state: "idle" });
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [cannotSign, setCannotSign] = useState(false);
  // The wallet refused or failed the sub-account's transaction, and no account was made: the page
  // offers the implicit account, if nothing of this way reached the chain (`heldOnSubAccount`).
  const [primaryRefused, setPrimaryRefused] = useState(false);
  const [finishing, setFinishing] = useState<string | null>(null);
  const [state, setState] = useState<ConnectCodeState | null>(null);
  const [fault, setFault] = useState<StateFault>(null);
  const [chain, setChain] = useState<AgentOnChain | null>(null);
  // The other way's account, as the page last read it: `<name>.<you>` while the code is on the
  // implicit account, and the implicit account while it is on `<name>.<you>`. What Tender holds
  // there is never paid again for this way.
  const [other, setOther] = useState<{ account: string; chain: AgentOnChain } | null>(null);
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
  // Which account the agent gets: `<name>.<you>`, or the implicit account of its key, which the page
  // works out from the key itself and never takes from the API.
  const kind = state?.account_kind ?? "sub_account";
  const implicitAccount = attached === null ? null : implicitAccountOf(attached);
  const expected = kind === "implicit" ? implicitAccount : accountId;
  const contested = state !== null && (state.state === "contested" || state.contested_at !== null);
  const created = chain?.key === "has-key";
  const registered = state !== null && (state.agent !== null || state.registered_at !== null);
  const active = state?.agent?.status === "active";
  const funded = terms.status === "ready" && isFunded(chain, bond, registered);
  const sending = send.state === "waiting" || send.state === "settling";
  const canSend = actions.canSend();
  const locked = code !== null || finishing !== null;

  // The name changed: ask the chain about the account once the typing stops.
  useEffect(() => {
    if (accountId === null || locked) {
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
  }, [accountId, locked]);

  // A code is out: ask the API how it stands every `pollMs`, and the chain once a key is attached,
  // until the agent is active, the code ran out with no key, or two keys contested it.
  const codeId = code?.id ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `lookAgain` restarts the loop on purpose
  useEffect(() => {
    if (codeId === null) return;
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = async () => {
      const held = tokenRef.current;
      if (held === null) {
        setFault("signed-out");
        return;
      }
      try {
        const found = await api.getConnectCode(held, codeId);
        if (gone) return;
        setNowMs(Date.now());
        if (found === null) {
          keepCode(account, null);
          setFault("gone");
          return;
        }
        setState(found);
        setFault(null);
        // The implicit account is the key's own: the page reads the one it works out.
        const where =
          found.public_key === null
            ? null
            : found.account_kind === "implicit"
              ? implicitAccountOf(found.public_key)
              : found.account_id;
        // The other way's account, which the page also works out itself.
        const otherAt =
          found.public_key === null
            ? null
            : found.account_kind === "implicit"
              ? `${found.name}.${account}`
              : implicitAccountOf(found.public_key);
        if (found.public_key !== null && where !== null) {
          try {
            const [onChain, onOther] = await Promise.all([
              readAgentOnChain(where, found.public_key, bondRef.current),
              otherAt === null
                ? Promise.resolve(null)
                : readAgentOnChain(otherAt, found.public_key, bondRef.current, "optimistic"),
            ]);
            if (!gone) {
              setChain(onChain);
              setOther(
                otherAt === null || onOther === null ? null : { account: otherAt, chain: onOther },
              );
            }
          } catch (error) {
            // The chain is asked again at the next look.
            console.error(error);
          }
        }
        if (found.agent?.status === "active") keepCode(account, null);
        if (
          found.state === "expired" ||
          found.state === "contested" ||
          found.contested_at !== null ||
          found.agent?.status === "active"
        ) {
          return;
        }
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
  }, [codeId, pollMs, lookAgain, account]);

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
      keepCode(account, made);
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
    keepCode(account, null);
    setCode(null);
    setFinishing(null);
    setState(null);
    setChain(null);
    setFault(null);
    setHeld({ state: "unknown" });
    setSend({ state: "idle" });
    setPrimaryRefused(false);
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

  // The page works out the fingerprint itself, from the key it will add: what it shows is the key's,
  // whatever the API says. An answer whose account is not the one asked for, or whose fingerprint is
  // not its key's, is not used for anything that is signed, nor for a command to run.
  const fingerprint =
    attached !== null && isEd25519PublicKey(attached) ? connectFingerprint(attached) : null;
  const answerFits =
    state === null ||
    (expected !== null &&
      state.account_id === expected &&
      (attached === null || (fingerprint !== null && state.fingerprint === fingerprint)));

  /**
   * Whether a fresh read of the code is the one the person checked: not contested, the same key, and
   * the account the page works out itself for the account kind it says.
   */
  const fits = (now: ConnectCodeState): boolean =>
    now.state !== "contested" &&
    now.contested_at === null &&
    now.public_key === attached &&
    attached !== null &&
    now.account_id === (now.account_kind === "implicit" ? implicitAccountOf(attached) : accountId);

  /**
   * Create agent: the one approval, or only the paying part when the account is there already. With
   * `separate`, the person chose "Use a separate account instead": the API is told first, and the
   * approval is for the implicit account of the key.
   */
  const create = async (fundOnly: boolean, separate = false) => {
    if (busy.current || attached === null || accountId === null || terms.status !== "ready") return;
    if (!answerFits || contested) return;
    busy.current = true;
    setSend({ state: "waiting" });
    let sentAccount = false;
    let implicitRoute = kind === "implicit";
    let where = expected;
    // While Tender is asked to record the separate account: a failure there sent nothing.
    let switching = false;
    try {
      // How the code stands now, not at the last poll: a code contested since, or whose key or
      // account is not the one the person checked, is not signed for; nor one whose account kind
      // changed since the page showed it (only the separate-account button changes it, here).
      if (codeId !== null) {
        let now = await withToken((held) => api.getConnectCode(held, codeId));
        if (now !== null) setState(now);
        if (now === null || !fits(now) || (!separate && now.account_kind !== kind)) {
          setSend({ state: "failed", message: ANSWER_CHANGED });
          return;
        }
        if (separate && now.account_kind === "sub_account") {
          // Nothing of the first way may be on the chain: an account made late, or storage or a
          // bond an earlier try paid for `<name>.<you>`, would be paid again for the other.
          const sub = await readAgentOnChain(accountId, attached, bond, "optimistic");
          setChain(sub);
          const held = heldOnSubAccount(accountId, sub, bond);
          if (held !== null) {
            setSend({ state: "failed", message: held });
            return;
          }
          switching = true;
          now = await withToken((held) => api.chooseImplicitAccount(held, codeId));
          switching = false;
          setState(now);
          rememberImplicit(account);
        }
        if (!fits(now) || (separate && now.account_kind !== "implicit")) {
          setSend({ state: "failed", message: ANSWER_CHANGED });
          return;
        }
        implicitRoute = now.account_kind === "implicit";
        where = implicitRoute ? implicitAccountOf(attached) : accountId;
      }
      if (where === null) {
        setSend({ state: "idle" });
        return;
      }
      const target = where;
      // The other way's account, at the newest block: storage or a bond an earlier try paid there
      // is never paid again for this way, whatever Tender's record says now (an API that switches
      // the way, or a try in another tab).
      const otherAt = implicitRoute ? accountId : implicitAccountOf(attached);
      if (otherAt !== null) {
        const otherNow = await readAgentOnChain(otherAt, attached, bond, "optimistic");
        setOther({ account: otherAt, chain: otherNow });
        const heldThere = implicitRoute
          ? heldOnSubAccount(accountId, otherNow, bond)
          : heldOnImplicit(otherAt, accountId, otherNow, bond);
        if (heldThere !== null) {
          setSend({ state: "failed", message: heldThere });
          return;
        }
      }
      // What the chain holds now, not what the page last saw: an earlier try may have paid the
      // storage or the bond, which is never paid twice.
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
        sentAccount = true;
        await actions.sendBatch(
          implicitRoute
            ? implicitAgentBatch({ accountId: target, chain: fresh, bond })
            : createAgentBatch({ accountId: target, publicKey: attached, chain: fresh, bond }),
        );
      }
      setSend({ state: "settling" });
      const after = await settleOn(
        () => readAgentOnChain(target, attached, bond),
        (seen) => isFunded(seen, bond, registered),
      );
      if (after !== null) setChain(after);
      setSend(
        after !== null && isFunded(after, bond, registered)
          ? { state: "idle" }
          : {
              state: "failed",
              kind: implicitRoute ? "implicit" : "sub_account",
              message:
                after?.key === "has-key"
                  ? "Your wallet sent it, but the storage and the bond aren't on the network yet. Check again in a moment, or press Fund agent."
                  : "Your wallet sent it, but the account isn't on the network yet. Check again in a moment.",
            },
      );
    } catch (error) {
      console.error(error);
      if (switching) {
        // Tender did not record the separate account: nothing was sent, and the way out stays.
        setSend({
          state: "failed",
          message:
            error instanceof ApiError && error.status === 409
              ? "Tender didn't take the separate account: the code changed meanwhile (another key tried it, or the agent registered). Nothing was sent. Read the page again."
              : "Tender couldn't record the separate account just now, so nothing was sent. Press Use a separate account instead again in a moment.",
        });
        return;
      }
      // The chain says what happened, whatever the wallet said.
      const after =
        where === null ? null : await readAgentOnChain(where, attached, bond).catch(() => null);
      if (after !== null) setChain(after);
      // The wallet refused or blocked the sub-account's transaction, or the network failed it, and
      // no account was made: the separate account is the way out, while nothing of this way is on
      // the chain (`heldOnSubAccount` decides what is shown).
      if (
        sentAccount &&
        !implicitRoute &&
        after !== null &&
        after.key === "missing" &&
        (error instanceof WalletError || error instanceof TransactionFailed)
      ) {
        setPrimaryRefused(true);
      }
      setSend({
        state: "failed",
        kind: implicitRoute ? "implicit" : "sub_account",
        message:
          error instanceof TransactionFailed || error instanceof WalletError
            ? whatLanded(after, bond, error instanceof WalletError)
            : sentAccount
              ? whatLanded(after, bond, true)
              : separate
                ? "Something went wrong before anything was sent. Press Use a separate account instead to try again."
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
  // What Tender holds for the other way's account, in words, or null when it holds nothing. A
  // reading of the account of the way the code was on before is not used.
  const otherAccount = kind === "implicit" ? accountId : implicitAccount;
  const otherWords =
    other === null || accountId === null || other.account !== otherAccount
      ? null
      : kind === "implicit"
        ? heldOnSubAccount(accountId, other.chain, bond)
        : heldOnImplicit(other.account, accountId, other.chain, bond);
  const blocked =
    short !== null || terms.status !== "ready" || !answerFits || contested || otherWords !== null;
  const showFinishOffer =
    !locked && name.ok && check.state === "taken" && check.accountId === accountId;
  // What of the first way is on the chain for `<name>.<you>`, in words, or null when nothing is.
  const heldWords =
    kind === "sub_account" && accountId !== null && chain !== null
      ? heldOnSubAccount(accountId, chain, bond)
      : null;
  // Storage alone with Tender, which stops nothing: on the other way's account, or on
  // `<name>.<you>` when the separate account is offered.
  const otherNote =
    other !== null && other.account === otherAccount && otherWords === null
      ? storageNote(other.account, other.chain, bond)
      : null;
  const ownNote =
    primaryRefused &&
    kind === "sub_account" &&
    accountId !== null &&
    chain !== null &&
    heldWords === null
      ? storageNote(accountId, chain, bond)
      : null;
  const noteWords = otherNote ?? ownNote;

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
          done={locked}
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
                  if (locked || asking) return;
                  setNameText(event.currentTarget.value);
                  setAskError(null);
                }}
                onBlur={() => setNameTouched(true)}
                readOnly={locked || asking}
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
              {finishing !== null ? (
                <span className="text-bone">
                  Finishing <AccountName id={finishing} className="text-[13px]" />.
                </span>
              ) : code !== null ? (
                <span className="text-bone">
                  The code is for{" "}
                  <AccountName id={target ?? code.account_id} className="text-[13px]" />.
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
                <span className="text-seal">{check.accountId} already exists.</span>
              ) : (
                <span className="text-seal">
                  Couldn't ask the network about {check.accountId}. It is checked again before the
                  code is made.
                </span>
              )}
            </p>
          </div>

          {showFinishOffer && accountId !== null ? (
            <div data-testid="connect-finish-offer" className={`${NOTICE} grid gap-3`}>
              <p>
                If it is an agent you started here, finish it: the page reads where it stands and
                pays what Tender doesn't hold for it yet. No new code is needed. Otherwise choose
                another name.
              </p>
              <button
                type="button"
                onClick={() => {
                  setFinishing(accountId);
                  setSend({ state: "idle" });
                }}
                className={`${PRIMARY} justify-self-start`}
              >
                Finish this agent
              </button>
            </div>
          ) : null}

          {locked ? null : cannotSign || !wallet.canSignMessage ? (
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
          ) : showFinishOffer ? null : (
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

        {finishing !== null ? (
          <FinishAgent
            accountId={finishing}
            name={nameText.trim()}
            terms={terms}
            bond={bond}
            retryTerms={retryTerms}
            pollMs={pollMs}
            onStartOver={startOver}
          />
        ) : (
          <>
            <Step
              n={2}
              testId="connect-step-2"
              title="Paste one line where your agent runs."
              why="The agent makes its own key there and sends Tender only the public half, with the code. Its private key never leaves its machine."
              done={attached !== null && !contested}
              open={code !== null}
            >
              {code === null ? (
                <p className="text-sm text-muted">Once you have a code.</p>
              ) : (
                <div className="grid gap-4">
                  {contested ? null : code.code === null ? (
                    <p data-testid="connect-code-not-kept" className={NOTICE}>
                      The code was shown before this page was reloaded, and it is not kept.
                      {attached === null
                        ? " If your agent has it, it can still connect, and this page sees it. If not, get a new code."
                        : " Your agent has connected with it."}
                    </p>
                  ) : (
                    <>
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
                    </>
                  )}
                  {attached !== null || contested ? null : expired || code.code === null ? (
                    <div
                      data-testid={expired ? "connect-expired" : "connect-new-code"}
                      className={`${NOTICE} grid gap-3`}
                    >
                      {expired ? (
                        <p role="status">
                          This code expired before an agent used it. Codes last 30 minutes.
                        </p>
                      ) : null}
                      <button
                        type="button"
                        aria-disabled={asking}
                        onClick={() => {
                          if (!asking) void getCode();
                        }}
                        className={`${expired ? PRIMARY : SECONDARY} justify-self-start`}
                      >
                        {asking ? "Waiting for your wallet…" : "Get a new code"}
                      </button>
                    </div>
                  ) : null}
                  {attached !== null || contested || expired || code.code === null ? null : (
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
                        Waiting for your agent to connect. This updates by itself. The code works
                        once, for {minutesLeft} more {minutesLeft === 1 ? "minute" : "minutes"}.
                      </span>
                    </p>
                  )}
                  <StateFaultNotice fault={fault} onSignIn={signInAgain} onStartOver={startOver} />
                  {attached === null && !contested ? (
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
              done={created && !contested}
              open={attached !== null || contested}
            >
              {contested ? (
                <Contested created={created} onStartOver={startOver} />
              ) : attached === null || target === null || state === null ? (
                <p className="text-sm text-muted">Once your agent has connected.</p>
              ) : (
                <div className="grid gap-4">
                  <p role="status" data-testid="connect-ready" className="text-[15px] text-bone">
                    Your agent is ready: <AccountName id={target} className="text-[14px]" />
                  </p>
                  {kind === "implicit" ? (
                    <p data-testid="connect-implicit" className={NOTICE}>
                      {SEPARATE_ACCOUNT}
                    </p>
                  ) : null}
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
                      Tender's answer doesn't match what this page asked for, so nothing will be
                      signed for it and no command is shown. Start over with a new code.
                    </p>
                  )}
                  {created ? null : (
                    <p
                      data-testid="connect-warning"
                      className="rounded-xl border border-seal/45 bg-seal/[0.06] p-4 text-sm leading-relaxed text-bone"
                    >
                      Your agent printed a fingerprint when it connected. Press Create agent only if
                      it is this one. If it printed another, or an error, someone else has this
                      code: don't press it, and start over with a new code.
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
                    <Fact label="You approve" value="Once" note={approveNote(chain, bond)} />
                  </dl>

                  <TermsError terms={terms} retry={retryTerms} />

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
                  ) : kind === "sub_account" &&
                    answerFits &&
                    accountId !== null &&
                    fingerprint !== null ? (
                    // Only for an answer that fits, built from the page's own account and the key
                    // whose fingerprint it worked out: a command is run with the person's keychain.
                    <div data-testid="connect-cli" className="grid gap-3">
                      <p className={NOTICE}>
                        This wallet can't create accounts from the page. Create it from a terminal,
                        with near-cli signed in as {account}. Then this page pays its storage and
                        bond.
                      </p>
                      <Command
                        command={createAccountCommand({
                          accountId,
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
                  ) : null}

                  {send.state === "failed" &&
                  !created &&
                  (send.kind === undefined || send.kind === kind) ? (
                    <p
                      role="alert"
                      data-testid="connect-send-error"
                      className="rounded-xl border border-seal/45 bg-seal/[0.06] p-4 text-sm text-bone"
                    >
                      {send.message}
                    </p>
                  ) : null}

                  {otherWords !== null && !created ? (
                    <p data-testid="connect-other-held" className={NOTICE}>
                      {otherWords}
                    </p>
                  ) : null}
                  {noteWords !== null && !created ? (
                    <p data-testid="connect-storage-note" className="text-sm text-muted">
                      {noteWords}
                    </p>
                  ) : null}
                  {primaryRefused &&
                  kind === "sub_account" &&
                  !created &&
                  canSend &&
                  heldWords !== null ? (
                    <p data-testid="connect-implicit-held" className={NOTICE}>
                      {heldWords}
                    </p>
                  ) : null}
                  {primaryRefused &&
                  kind === "sub_account" &&
                  !created &&
                  canSend &&
                  chain !== null &&
                  heldWords === null ? (
                    <div data-testid="connect-implicit-offer" className={`${NOTICE} grid gap-3`}>
                      <p>
                        Some wallets won't set up an account under yours. Your agent can use an
                        account of its own instead, which a plain transfer from your wallet creates,
                        with the same storage and bond. {SEPARATE_ACCOUNT}
                      </p>
                      <button
                        type="button"
                        aria-disabled={blocked || sending}
                        onClick={() => {
                          if (!blocked && !sending) void create(false, true);
                        }}
                        className={`${PRIMARY} justify-self-start`}
                      >
                        Use a separate account instead (works with every wallet)
                      </button>
                    </div>
                  ) : null}
                </div>
              )}
            </Step>

            <Step
              n={4}
              testId="connect-step-4"
              title="It sets itself up."
              why="Registering is signed with the agent's own key, so only the agent can do it. It does it as soon as its bond is in its vault."
              done={active && !contested}
              open={created && !contested}
            >
              {!created || contested || target === null ? (
                <p className="text-sm text-muted">Once its account exists.</p>
              ) : (
                <div className="grid gap-4">
                  <AgentTicks
                    target={target}
                    funded={funded}
                    registered={registered}
                    active={active}
                    status={state?.agent?.status ?? null}
                    bond={bond}
                    send={send}
                    canFund={terms.status === "ready" && answerFits}
                    fundBlocked={null}
                    onFund={() => void create(true)}
                  />
                  <StateFaultNotice fault={fault} onSignIn={signInAgain} onStartOver={startOver} />
                </div>
              )}
            </Step>
          </>
        )}
      </ol>
    </section>
  );
}

/**
 * What the one approval of step 3 does, by what Tender holds already: an earlier try may have paid
 * the storage or the bond, which is not paid again.
 */
function approveNote(chain: AgentOnChain | null, bond: AgentBondTerms | null): string {
  if (chain?.key === "has-key") return "Done: the account is created. Step 4 shows the rest.";
  const storage = chain?.storage === true;
  const bondIn = bond === null || (chain !== null && chain.vault >= bond.amount);
  if (bond === null) {
    return storage
      ? "Create the account. Its storage is in place already."
      : "Create the account, pay its storage.";
  }
  if (storage && bondIn) return "Create the account. Its storage and bond are in place already.";
  if (storage) return "Create the account, pay its bond. Its storage is in place already.";
  if (bondIn) return "Create the account, pay its storage. Its bond is in place already.";
  return "Create the account, pay its storage, pay its bond.";
}

/** What step 3 shows for a code that two different keys tried: nothing to create, start over. */
function Contested({ created, onStartOver }: { created: boolean; onStartOver: () => void }) {
  return (
    <div
      data-testid="connect-contested"
      className="grid gap-3 rounded-xl border border-seal/45 bg-seal/[0.06] p-4 text-sm leading-relaxed text-bone"
    >
      <p role="alert">
        Two different keys tried this code: someone else has it. Start over.
        {created
          ? " The account was created already: don't fund it until the fingerprint your agent printed matches its key."
          : " Nothing will be created for it."}
      </p>
      <button type="button" onClick={onStartOver} className={`${SECONDARY} justify-self-start`}>
        Start over
      </button>
    </div>
  );
}

/** What the page says when it couldn't read the bond from the contract, with Retry. */
function TermsError({ terms, retry }: { terms: Loaded<BondTerms>; retry: () => void }) {
  if (terms.status !== "error") return null;
  return (
    <div className="grid gap-2">
      <p role="alert" className="text-sm text-seal">
        Couldn't read the bond from the contract.
      </p>
      <button
        type="button"
        aria-disabled={terms.retrying}
        onClick={terms.retrying ? undefined : retry}
        className={`${SECONDARY} justify-self-start`}
      >
        {terms.retrying ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}

/** Where an account typed in step 1 stands, as "Finish this agent" reads it. */
interface Finding {
  /** Its full-access keys, null when there is no such account. */
  keys: string[] | null;
  storage: boolean;
  vault: bigint;
  /** Its status in the index; null while the index doesn't list it. */
  status: string | null;
}

/**
 * "Finish this agent": an account under the person's that exists already, an agent they started
 * (after a reload, in another browser, or by hand). The page reads its full-access keys, what Tender
 * holds for it and its status in the index, shows the ticks, and Fund agent while its storage or its
 * bond is missing. No code is made: the key is on the account already. It funds only an account
 * whose one full-access key is shown to be matched with the fingerprint the agent printed.
 */
function FinishAgent({
  accountId,
  name,
  terms,
  bond,
  retryTerms,
  pollMs,
  onStartOver,
}: {
  accountId: string;
  name: string;
  terms: Loaded<BondTerms>;
  bond: AgentBondTerms | null;
  retryTerms: () => void;
  pollMs: number;
  onStartOver: () => void;
}) {
  const wallet = useWallet();
  const [finding, setFinding] = useState<Finding | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [send, setSend] = useState<Send>({ state: "idle" });
  const [lookAgain, setLookAgain] = useState(0);
  const busy = useRef(false);
  const bondRef = useRef(bond);
  bondRef.current = bond;

  /** One look at the account: its keys, Tender's funds for it, and the index. */
  const read = async (): Promise<Finding> => {
    const [keys, funding, record] = await Promise.all([
      fullAccessKeysOf(accountId),
      readAgentFunding(accountId, bondRef.current),
      api.getAgentRecord(accountId),
    ]);
    const status =
      record === null
        ? null
        : typeof record.agent.status === "string"
          ? record.agent.status
          : // An API from before bonds lists a registered agent with no status: it is active.
            "active";
    return { keys, ...funding, status };
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: `lookAgain` restarts the loop on purpose
  useEffect(() => {
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = async () => {
      try {
        const found = await read();
        if (gone) return;
        setFinding(found);
        setUnreachable(false);
        if (found.status === "active" || found.keys === null) return;
      } catch (error) {
        if (gone) return;
        console.error(error);
        setUnreachable(true);
      }
      if (!gone) timer = setTimeout(look, pollMs);
    };
    void look();
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [accountId, pollMs, lookAgain]);

  const registered = finding?.status != null;
  const active = finding?.status === "active";
  const funded = finding !== null && (registered || isPaid(finding, bond));
  const keys = finding?.keys ?? null;
  const fundBlocked =
    keys === null
      ? "There is no such account any more."
      : keys.length === 0
        ? "This account has no full-access key, so no agent can register with it. Don't fund it."
        : keys.length > 1
          ? `This account has ${keys.length} full-access keys. An agent made with a connect code has one, its own, and registers only then. Fund agent is off.`
          : null;

  const fund = async () => {
    if (busy.current || finding === null || terms.status !== "ready" || fundBlocked !== null) {
      return;
    }
    busy.current = true;
    setSend({ state: "waiting" });
    try {
      // The account's keys now, as every other payment reads afresh before it is signed.
      const keysNow = await fullAccessKeysOf(accountId);
      if (keysNow === null || keysNow.length !== 1) {
        setSend({
          state: "failed",
          message:
            "The account's keys changed: it no longer has exactly one full-access key. Nothing was sent.",
        });
        return;
      }
      // The account's one key may have a separate account that an earlier try paid for: what
      // Tender holds there is not paid again here.
      const implicit = implicitAccountOf(keysNow[0] ?? "");
      if (implicit !== null) {
        const there = await readAgentFunding(implicit, bond, "optimistic");
        const held = heldOnImplicit(implicit, accountId, { key: "missing", ...there }, bond);
        if (held !== null) {
          setSend({ state: "failed", message: held });
          return;
        }
      }
      // What Tender holds now, so that nothing is paid twice.
      const now = await readAgentFunding(accountId, bond);
      const calls = fundCallsFor(accountId, now, bond);
      if (calls.length > 0) await wallet.signAndSend(calls);
      setSend({ state: "settling" });
      const after = await settleOn(read, (seen) => isPaid(seen, bond));
      if (after !== null) setFinding(after);
      setSend(
        after !== null && isPaid(after, bond)
          ? { state: "idle" }
          : {
              state: "failed",
              message:
                "Your wallet sent it, but the storage and the bond aren't on the network yet. Check again in a moment.",
            },
      );
    } catch (error) {
      console.error(error);
      const after = await read().catch(() => null);
      if (after !== null) setFinding(after);
      setSend({
        state: "failed",
        message:
          error instanceof TransactionFailed
            ? "Paying the storage or the bond failed on the network. Check that your wallet holds the bond, then press Fund agent again."
            : error instanceof WalletError
              ? "Your wallet didn't send it. Press Fund agent to try again."
              : "Something went wrong before anything was sent. Press Fund agent to try again.",
      });
    } finally {
      busy.current = false;
    }
  };

  return (
    <Step
      n={2}
      testId="connect-finish"
      title="Finish this agent."
      why="Its account exists, so its key is on it already: no code is needed. The page reads where it stands, and your wallet pays what Tender doesn't hold for it yet."
      done={active}
      open
    >
      <div className="grid gap-4">
        {finding === null ? (
          <p role="status" className="text-sm text-muted">
            {unreachable
              ? "The network can't be reached right now. Still trying…"
              : "Reading where it stands…"}
          </p>
        ) : (
          <>
            {keys !== null && keys.length > 0 ? (
              <div
                data-testid="connect-finish-keys"
                className="grid gap-3 rounded-xl border border-line bg-ink p-4"
              >
                <p className={FACT_LABEL}>
                  {keys.length === 1 ? "Its full-access key" : "Its full-access keys"}
                </p>
                {keys.map((key) => (
                  <div key={key} className="grid gap-1">
                    <p className="font-mono text-xl tracking-[0.08em] text-bone sm:text-2xl">
                      {connectFingerprint(key)}
                    </p>
                    <p className="font-mono text-[12px] text-muted wrap-anywhere">{key}</p>
                  </div>
                ))}
              </div>
            ) : null}
            {funded || fundBlocked !== null ? null : (
              <p
                data-testid="connect-finish-warning"
                className="rounded-xl border border-seal/45 bg-seal/[0.06] p-4 text-sm leading-relaxed text-bone"
              >
                Fund it only if this is the fingerprint your agent printed. If it is not, the
                account is not your agent's.
              </p>
            )}
            <TermsError terms={terms} retry={retryTerms} />
            {keys === null ? (
              <p role="alert" className="text-sm text-seal">
                <AccountName id={accountId} /> doesn't exist any more.
              </p>
            ) : (
              <AgentTicks
                target={accountId}
                funded={funded}
                registered={registered}
                active={active}
                status={finding.status}
                bond={bond}
                send={send}
                canFund={terms.status === "ready"}
                fundBlocked={fundBlocked}
                onFund={() => void fund()}
                keyWords={keys.length === 1 ? "the key above" : "the keys above"}
              />
            )}
            {funded && !registered ? (
              <p data-testid="connect-finish-register" className="text-sm text-muted">
                Its bond is in its vault. Where the agent runs, run the same{" "}
                <span className="font-mono text-bone">pnpm agent:connect</span> command again (or{" "}
                <span className="font-mono text-bone">pnpm agent:register --name {name}</span>
                ), and it registers.
              </p>
            ) : null}
            {unreachable ? (
              <p role="status" className={NOTICE}>
                The network can't be reached right now. Still trying…
              </p>
            ) : null}
          </>
        )}
        <div className="flex flex-wrap items-center gap-4">
          {active ? null : (
            <button
              type="button"
              onClick={() => setLookAgain((n) => n + 1)}
              className={`${SECONDARY} justify-self-start`}
            >
              Check again
            </button>
          )}
          <button type="button" onClick={onStartOver} className={`${TEXT_LINK} text-sm`}>
            Start over with another name
          </button>
        </div>
      </div>
    </Step>
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
