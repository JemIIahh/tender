"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { type BondTerms, readBondTerms } from "../../lib/account";
import { readAgentName, readPublicKey, SECRET_WARNING } from "../../lib/agentKey";
import { api } from "../../lib/api";
import { config } from "../../lib/config";
import { formatSpan } from "../../lib/phase";
import { accountExists, accountKeyState } from "../../lib/rpc";
import { useLoad } from "../../lib/useLoad";
import { describeAmount, describeNear } from "../../lib/vault";
import { type AccountAction, useAccountActions, useWallet } from "../../lib/wallet";
import { TransactionFailed, WalletError } from "../../lib/walletErrors";
import { PageHead } from "../PageHead";
import { FACT_LABEL, FIELD, NOTICE, PRIMARY, SECONDARY, TEXT_LINK } from "../ui";
import { Command, ConnectGate } from "./parts";

// "Add an agent": the guided way to make an agent of the connected account, in three steps.
//
// 1. The agent makes its own key, where it runs (`pnpm agent:init`), and the person pastes the
//    PUBLIC key here. The page never makes, sees or keeps a private key: one pasted by mistake is
//    cleared from the field at once and kept nowhere.
// 2. The person's wallet creates the agent's account under theirs, `<name>.<account>`, in ONE
//    transaction to the new account: CreateAccount, a Transfer of `AGENT_ACCOUNT_DEPOSIT` for its
//    storage and gas, and AddKey of the pasted key with full access. A wallet that can't send it
//    gets the same as a near-cli command instead, and "Check again" reads the chain.
// 3. The agent registers itself and locks its bond (`pnpm agent:register`), which only its own key
//    can sign. The page shows the bond from the contract's config, and watches the API until the
//    agent is listed.
//
// Nothing is signed until the person presses the button that says what it signs.

/** What the wallet sends the new account: 0.5 NEAR, for its storage and its gas for a long while. */
export const AGENT_ACCOUNT_DEPOSIT = 5n * 10n ** 23n;

/** How long the page waits after a name or key is typed before it asks the chain about it. */
const CHECK_DELAY_MS = 400;
/** How often the page asks the API whether the agent has registered. */
const WATCH_EVERY_MS = 4000;
/** After the wallet sends, how often and how many times the page looks for the account. */
const SETTLE_EVERY_MS = 1500;
const SETTLE_TRIES = 5;

/** The commands, as the agent tools (packages/agents) name them. */
export const initCommand = (name: string) => `pnpm agent:init --name ${name}`;
export const REGISTER_COMMAND = "pnpm agent:register";

/** The same transaction as the wallet's, for near-cli (near-cli-rs), signed with the person's key. */
export function createAccountCommand(plan: {
  accountId: string;
  parent: string;
  publicKey: string;
  network: string;
}): string {
  return [
    "near account create-account fund-myself",
    plan.accountId,
    `'${describeNear(AGENT_ACCOUNT_DEPOSIT)}'`,
    "use-manually-provided-public-key",
    plan.publicKey,
    "sign-as",
    plan.parent,
    "network-config",
    plan.network,
    "sign-with-keychain send",
  ].join(" ");
}

/** The actions of the one transaction that makes the agent's account. */
export function createAccountActions(publicKey: string): AccountAction[] {
  return [
    { type: "CreateAccount" },
    { type: "Transfer", params: { deposit: AGENT_ACCOUNT_DEPOSIT.toString() } },
    { type: "AddKey", params: { publicKey, accessKey: { permission: "FullAccess" } } },
  ];
}

/** What the chain says of the account the name makes, for the key that was pasted. */
type Lookup =
  | { state: "idle" }
  | {
      /**
       * "yours": it exists and has the key it was asked about, with full access: step 2 is done, by
       * this page or another way, for that account and that key.
       */
      state: "checking" | "free" | "yours" | "taken" | "error";
      /** The account and the key (null: none was pasted yet) the chain was asked about. */
      accountId: string;
      publicKey: string | null;
    };

/** What the person pressed Create for: the account the wallet was asked to make, with that key. */
interface Signed {
  accountId: string;
  publicKey: string;
}

type Create =
  | { state: "idle" }
  | { state: "waiting" }
  | { state: "settling" }
  | { state: "failed"; message: string }
  | { state: "unseen" };

/**
 * How a step looks once it is open, and before. A step that is not open yet has a dashed edge on
 * the ink and a muted title, and is never faded: faded, its muted words would fall below 4.5:1
 * (WCAG 1.4.3). test/contrast.test.ts holds both looks to that.
 */
export const STEP_LOOK = {
  open: {
    card: "rounded-2xl border border-line bg-panel",
    title: "text-bone",
    why: "text-muted",
  },
  unopened: {
    card: "rounded-2xl border border-dashed border-line bg-ink",
    title: "text-muted",
    why: "text-muted",
  },
} as const;

/** A numbered step: its number, its title, why it is done this way, and what to do. */
function Step({
  n,
  title,
  why,
  done,
  open,
  children,
}: {
  n: number;
  title: string;
  why: string;
  done: boolean;
  open: boolean;
  children: ReactNode;
}) {
  return (
    <li
      data-testid={`step-${n}`}
      data-done={done}
      data-open={open}
      className={`${open ? STEP_LOOK.open.card : STEP_LOOK.unopened.card} grid gap-5 p-5 sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-6 sm:p-7`}
    >
      <span
        aria-hidden="true"
        className={`hidden size-10 place-items-center rounded-full font-mono text-sm sm:grid ${
          done
            ? "bg-bone text-ink"
            : open
              ? "border border-bone text-bone"
              : "border border-dashed border-dim text-muted"
        }`}
      >
        {done ? (
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          n
        )}
      </span>
      <div className="grid min-w-0 gap-4">
        <div className="grid gap-1.5">
          <p className={`${FACT_LABEL} flex items-center gap-2`}>
            {/* On a phone the number's circle is a dot beside these words: red once done. */}
            <span
              aria-hidden="true"
              className={`size-1.5 rounded-full sm:hidden ${done ? "bg-seal" : "bg-dim"}`}
            />
            Step {n}
            {done ? " · done" : ""}
          </p>
          <h2
            className={`text-xl leading-snug font-semibold tracking-tight sm:text-2xl ${open ? STEP_LOOK.open.title : STEP_LOOK.unopened.title}`}
          >
            {title}
          </h2>
          <p
            className={`text-[15px] leading-relaxed ${open ? STEP_LOOK.open.why : STEP_LOOK.unopened.why}`}
          >
            <span className={open ? "text-bone" : undefined}>Why: </span>
            {why}
          </p>
        </div>
        {children}
      </div>
    </li>
  );
}

/** The bond registering locks, from the contract's config, in words. */
function BondLine({ terms }: { terms: BondTerms }) {
  if (terms.state === "set") {
    const cooldown =
      terms.cooldownSecs === null
        ? ""
        : ` It can be claimed back ${formatSpan(BigInt(terms.cooldownSecs) * 1_000_000_000n)} after the agent unregisters.`;
    return (
      <p data-testid="bond-terms">
        Registering locks{" "}
        <strong className="font-medium text-bone">
          {describeAmount(BigInt(terms.amount), terms.token)}
        </strong>{" "}
        from the agent's own Tender vault as a bond. It is refundable: the agent gets it back in
        full when it retires.{cooldown}
      </p>
    );
  }
  return (
    <p data-testid="bond-terms">
      {terms.state === "none"
        ? "No bond is set right now, so registering locks nothing."
        : "This contract takes no bond yet, so registering locks nothing."}
    </p>
  );
}

/** Step 3's watch: asks the API for the agent until it is listed. */
function RegistrationWatch({
  accountId,
  onListed,
  everyMs,
}: {
  accountId: string;
  onListed: () => void;
  everyMs: number;
}) {
  const [state, setState] = useState<"waiting" | "listed" | "unreachable">("waiting");
  const listed = useRef(onListed);
  listed.current = onListed;
  useEffect(() => {
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = () => {
      api.getAgent(accountId).then(
        (found) => {
          if (gone) return;
          if (found !== null) {
            setState("listed");
            listed.current();
            return;
          }
          setState("waiting");
          timer = setTimeout(look, everyMs);
        },
        (error) => {
          if (gone) return;
          console.error(error);
          setState("unreachable");
          timer = setTimeout(look, everyMs);
        },
      );
    };
    look();
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [accountId, everyMs]);

  if (state === "listed") {
    return (
      <div data-testid="registered" className={`${NOTICE} grid gap-3 border-bone/40`}>
        <p role="status" className="flex items-center gap-2">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-seal" />
          <span>
            Registered. <span className="font-mono text-[13px] wrap-anywhere">{accountId}</span> is
            in the directory.
          </span>
        </p>
        <div className="flex flex-wrap gap-2">
          <Link href={`/agents/${accountId}`} className={PRIMARY}>
            Open its page
          </Link>
          <Link href="/my-agents" className={SECONDARY}>
            Back to My agents
          </Link>
        </div>
      </div>
    );
  }
  return (
    <p
      role="status"
      data-testid="watching"
      className="flex items-start gap-2.5 rounded-xl border border-dashed border-dim p-4 text-sm text-muted"
    >
      <span
        aria-hidden="true"
        className="mt-1.5 size-1.5 shrink-0 animate-pulse rounded-full bg-seal motion-reduce:animate-none"
      />
      <span>
        {state === "unreachable"
          ? "Tender's API can't be reached right now. Still trying…"
          : "Waiting for the agent to register. This updates by itself."}
      </span>
    </p>
  );
}

function Flow({ account, watchEveryMs }: { account: string; watchEveryMs: number }) {
  const id = useId();
  const actions = useAccountActions();
  const [keyText, setKeyText] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [nameText, setNameText] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [lookup, setLookup] = useState<Lookup>({ state: "idle" });
  const [create, setCreate] = useState<Create>({ state: "idle" });
  // What the wallet was last asked to make. Any edit of the name or the key forgets it.
  const [signed, setSigned] = useState<Signed | null>(null);
  // The account the API listed as a registered agent, once it has.
  const [listed, setListed] = useState<string | null>(null);
  const busy = useRef(false);
  const latestLookup = useRef(0);

  const key = readPublicKey(keyText);
  const publicKey = key.ok ? key.publicKey : null;
  const name = readAgentName(nameText, account);
  const accountId = name.ok ? name.accountId : null;
  const canSend = actions.canSend();
  const sending = create.state === "waiting" || create.state === "settling";

  /** Asks the chain about `target` for `pk`: free, already the agent's, or taken. */
  const check = async (target: string, pk: string | null): Promise<Lookup> => {
    const request = ++latestLookup.current;
    setLookup({ state: "checking", accountId: target, publicKey: pk });
    let next: Lookup;
    try {
      // Without a key, all there is to know is whether the account is there.
      const state =
        pk === null
          ? (await accountExists(target))
            ? "other-keys"
            : "missing"
          : await accountKeyState(target, pk);
      next = {
        state: state === "missing" ? "free" : state === "has-key" ? "yours" : "taken",
        accountId: target,
        publicKey: pk,
      };
    } catch (error) {
      console.error(error);
      next = { state: "error", accountId: target, publicKey: pk };
    }
    if (request === latestLookup.current) setLookup(next);
    return next;
  };

  // The name, or the key, changed: ask the chain about the account once the typing stops.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `check` is this render's, and the lookup is keyed on what it reads
  useEffect(() => {
    if (accountId === null) {
      latestLookup.current++;
      setLookup({ state: "idle" });
      return;
    }
    if (create.state === "waiting" || create.state === "settling") return;
    const timer = setTimeout(() => void check(accountId, publicKey), CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [accountId, publicKey]);

  /** An edit of the name or the key: what was done for the last ones is not for these. */
  const edited = () => {
    setSigned(null);
    setListed(null);
    setCreate({ state: "idle" });
  };

  const onKey = (text: string) => {
    if (sending) return;
    edited();
    const reading = readPublicKey(text);
    if (!reading.ok && reading.secret) {
      // Key material: out of the field at once, kept nowhere (not in state, not logged, not in the
      // address), and the person is told.
      setKeyText("");
      setKeyError(reading.message);
      return;
    }
    setKeyText(text);
    // An error is shown once the person leaves the field or pastes a whole key; until then, typing
    // is not an error.
    setKeyError(reading.ok || text.trim().length < 50 ? null : reading.message);
  };

  // What the chain said is about the name and the key on the page only if it was asked about them.
  const lookupFits =
    lookup.state !== "idle" && lookup.accountId === accountId && lookup.publicKey === publicKey;
  // Step 2 is done when the chain says this account has this key, and, if the wallet was asked to
  // make one, it is the one it was asked to make.
  const created =
    lookup.state === "yours" &&
    lookupFits &&
    (signed === null || (signed.accountId === accountId && signed.publicKey === publicKey));
  const ready = publicKey !== null && accountId !== null && lookup.state === "free" && lookupFits;

  const send = async () => {
    if (busy.current || publicKey === null || accountId === null) return;
    busy.current = true;
    // The name and the key are locked from here until the wallet has answered and the page has
    // looked: what is shown as made is what was signed for.
    setSigned({ accountId, publicKey });
    setCreate({ state: "waiting" });
    try {
      // Read again now: the name may have been taken since the page looked.
      const fresh = await check(accountId, publicKey);
      if (fresh.state !== "free") {
        setCreate({ state: "idle" });
        return;
      }
      await actions.send(accountId, createAccountActions(publicKey));
      setCreate({ state: "settling" });
      // The wallet's node can be a block ahead of this page's: look a few times.
      for (let tries = 0; tries < SETTLE_TRIES; tries++) {
        const seen = await check(accountId, publicKey);
        if (seen.state === "yours") {
          setCreate({ state: "idle" });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, SETTLE_EVERY_MS));
      }
      setCreate({ state: "unseen" });
    } catch (error) {
      console.error(error);
      setCreate({
        state: "failed",
        message:
          error instanceof TransactionFailed
            ? "The transaction failed on the network, so the account was not created."
            : error instanceof WalletError
              ? "The wallet didn't send it. Try again, or create the account from a terminal below."
              : "Something went wrong before the account was made. Check again, or try once more.",
      });
    } finally {
      busy.current = false;
    }
  };

  const shownName = name.ok ? nameText.trim() : "<name>";
  const showCli = !canSend || create.state === "failed" || create.state === "unseen";

  return (
    <ol className="grid gap-4">
      <Step
        n={1}
        title="Make your agent's key where the agent runs."
        why="The key signs everything the agent does, so it is made on the agent's machine and never leaves it. Tender only ever sees the public half."
        done={publicKey !== null}
        open
      >
        <Command command={initCommand(shownName)} label="Run where the agent runs" />
        <div className="grid gap-1.5">
          <label htmlFor={`${id}-key`} className={FACT_LABEL}>
            The public key it printed
          </label>
          <input
            id={`${id}-key`}
            value={keyText}
            onChange={(event) => onKey(event.currentTarget.value)}
            onBlur={() => setKeyError(keyText === "" ? keyError : key.ok ? null : key.message)}
            readOnly={sending}
            placeholder="ed25519:…"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={keyError !== null}
            aria-describedby={`${id}-key-help${keyError === null ? "" : ` ${id}-key-error`}`}
            className={`${FIELD} font-mono text-sm`}
          />
          <p id={`${id}-key-help`} className="text-sm text-muted">
            Only the line that starts with <span className="font-mono text-bone">ed25519:</span> and
            is marked public. Never the private key.
          </p>
          {keyError === null ? null : (
            <p
              id={`${id}-key-error`}
              data-testid="key-error"
              role={keyError === SECRET_WARNING ? "alert" : undefined}
              className="text-sm text-seal"
            >
              {keyError}
            </p>
          )}
        </div>
      </Step>

      <Step
        n={2}
        title="Create its account."
        why="The agent works as its own NEAR account, under yours, so the directory lists it as your agent and its record is its own."
        done={created}
        open={publicKey !== null || created}
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
                if (sending) return;
                edited();
                setNameText(event.currentTarget.value);
              }}
              onBlur={() => setNameTouched(true)}
              readOnly={sending}
              placeholder="scout"
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
            data-testid="name-state"
            className="text-sm"
            aria-live="polite"
          >
            {!name.ok ? (
              nameTouched || nameText !== "" ? (
                <span className="text-seal">{name.message}</span>
              ) : (
                <span className="text-muted">Lower case, digits, - and _.</span>
              )
            ) : lookup.state === "idle" || !lookupFits ? null : lookup.state === "checking" ? (
              <span className="text-muted">Checking {lookup.accountId}…</span>
            ) : lookup.state === "free" ? (
              <span className="text-bone">{lookup.accountId} is free.</span>
            ) : lookup.state === "yours" ? (
              <span className="text-bone">
                {lookup.accountId} exists and has this key. On to step 3.
              </span>
            ) : lookup.state === "taken" ? (
              <span className="text-seal">
                {lookup.accountId} already exists{publicKey === null ? "" : " without this key"}.
                Choose another name.
              </span>
            ) : lookup.state === "error" ? (
              <span className="text-seal">
                Couldn't ask the network about {lookup.accountId}. It is checked again before
                anything is sent.
              </span>
            ) : null}
          </p>
        </div>

        <dl className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3">
          <div className="grid gap-1 bg-ink p-4">
            <dt className={FACT_LABEL}>Sent to the new account</dt>
            <dd data-testid="deposit" className="text-lg text-bone">
              {describeNear(AGENT_ACCOUNT_DEPOSIT)}
            </dd>
            <dd className="text-[13px] text-muted">
              For its storage and gas. It stays the agent's.
            </dd>
          </div>
          <div className="grid gap-1 bg-ink p-4">
            <dt className={FACT_LABEL}>Its key</dt>
            <dd className="font-mono text-[13px] text-bone wrap-anywhere">
              {publicKey ?? "From step 1"}
            </dd>
            <dd className="text-[13px] text-muted">Added with full access.</dd>
          </div>
          <div className="grid gap-1 bg-ink p-4">
            <dt className={FACT_LABEL}>You sign</dt>
            <dd className="text-lg text-bone">1 transaction</dd>
            <dd className="text-[13px] text-muted">Create, fund, add the key: all or nothing.</dd>
          </div>
        </dl>

        {created ? null : canSend ? (
          <div className="grid gap-2">
            <button
              type="button"
              aria-disabled={!ready || sending}
              onClick={() => {
                if (ready && !sending) void send();
              }}
              className={PRIMARY}
            >
              {create.state === "waiting" ? (
                "Waiting for your wallet…"
              ) : create.state === "settling" ? (
                "Looking for the account…"
              ) : accountId === null ? (
                "Create the account"
              ) : (
                <>
                  Create{" "}
                  {/* The account as it will be made: an account id is lower case, so the pill's
                      capitals are not put on it. */}
                  <span className="font-mono tracking-normal normal-case">{accountId}</span>
                </>
              )}
            </button>
            {sending ? (
              <p className="text-sm text-muted">
                The key and the name are locked until your wallet answers.
              </p>
            ) : ready ? null : (
              <p className="text-sm text-muted">
                {publicKey === null
                  ? "Paste the agent's public key in step 1 first."
                  : "Choose a free name first."}
              </p>
            )}
          </div>
        ) : (
          <p data-testid="cannot-create" className={NOTICE}>
            This wallet can't create accounts from the page. Create it from a terminal instead, with
            near-cli signed in as {account}:
          </p>
        )}

        {create.state === "failed" ? (
          <p
            role="alert"
            data-testid="create-error"
            className="rounded-xl border border-seal/45 bg-seal/[0.06] p-4 text-sm text-bone"
          >
            {create.message}
          </p>
        ) : create.state === "unseen" ? (
          <p role="status" className={NOTICE}>
            The wallet sent it, but the account isn't on the network yet. Check again in a moment.
          </p>
        ) : null}

        {showCli && !created ? (
          <div className="grid gap-3">
            {publicKey !== null && accountId !== null ? (
              <Command
                command={createAccountCommand({
                  accountId,
                  parent: account,
                  publicKey,
                  network: config.network,
                })}
                label="The same transaction, with near-cli"
              />
            ) : (
              <p className="text-sm text-muted">
                The command appears here once the key and a name are in.
              </p>
            )}
            {accountId === null ? null : (
              <button
                type="button"
                aria-disabled={lookup.state === "checking" || sending}
                onClick={() => {
                  if (lookup.state !== "checking" && !sending) void check(accountId, publicKey);
                }}
                className={SECONDARY}
              >
                {lookup.state === "checking" ? "Checking…" : "Check again"}
              </button>
            )}
          </div>
        ) : null}
      </Step>

      <Step
        n={3}
        title="Let the agent register itself and lock its bond."
        why="Registering is signed with the agent's own key, so only the agent can do it. The bond makes each agent cost something while it is active, and comes back when it retires."
        done={created && listed === accountId}
        open={created}
      >
        {created && accountId !== null ? (
          <Register
            accountId={accountId}
            onListed={() => setListed(accountId)}
            watchEveryMs={watchEveryMs}
          />
        ) : (
          <p className="text-sm text-muted">Once its account exists.</p>
        )}
      </Step>
    </ol>
  );
}

function Register({
  accountId,
  onListed,
  watchEveryMs,
}: {
  accountId: string;
  onListed: () => void;
  watchEveryMs: number;
}) {
  const [terms, retry] = useLoad("config", () => readBondTerms());
  return (
    <div className="grid gap-4">
      <Command command={REGISTER_COMMAND} label="Run where the agent runs" account={accountId} />
      <div className="grid gap-2 text-[15px] leading-relaxed text-muted">
        {terms.status === "ready" ? (
          <BondLine terms={terms.data} />
        ) : terms.status === "error" ? (
          <div className="grid gap-2">
            <p role="alert" className="text-seal">
              Couldn't read the bond from the contract.
            </p>
            <button
              type="button"
              aria-disabled={terms.retrying}
              onClick={terms.retrying ? undefined : retry}
              className={SECONDARY}
            >
              {terms.retrying ? "Retrying…" : "Retry"}
            </button>
          </div>
        ) : (
          <p>Reading the bond from the contract…</p>
        )}
      </div>
      <RegistrationWatch accountId={accountId} onListed={onListed} everyMs={watchEveryMs} />
    </div>
  );
}

export function AddAgentView({ watchEveryMs = WATCH_EVERY_MS }: { watchEveryMs?: number } = {}) {
  const wallet = useWallet();
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-8">
      <PageHead
        eyebrow="My agents"
        title="Add an agent."
        muted="Its key stays where it runs."
        art={{ name: "signal", focus: { x: 0.6, y: 0.5, scale: 0.42 } }}
      >
        Three steps. What it costs: {describeNear(AGENT_ACCOUNT_DEPOSIT)} sent to the agent's new
        account, which stays the agent's, and the bond it locks when it registers, refunded in full
        when it retires.{" "}
        <Link href="/my-agents" className={TEXT_LINK}>
          Back to My agents
        </Link>
      </PageHead>
      <ConnectGate
        wallet={wallet}
        art="scorecard"
        why="The agent's account is made under the account your wallet is connected as, and your wallet signs it."
      >
        {(account) => <Flow key={account} account={account} watchEveryMs={watchEveryMs} />}
      </ConnectGate>
    </div>
  );
}
