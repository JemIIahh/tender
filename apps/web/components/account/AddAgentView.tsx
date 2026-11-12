"use client";

import { AGENT_ACCOUNT_DEPOSIT, AGENT_STORAGE_DEPOSIT, implicitAccountOf } from "@tender/shared";
import Link from "next/link";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { type BondTerms, readBondTerms } from "../../lib/account";
import { readAgentName, readPublicKey, SECRET_WARNING } from "../../lib/agentKey";
import { api } from "../../lib/api";
import { config } from "../../lib/config";
import {
  type AgentOnChain,
  bondOfTerms,
  createAccountActions,
  createAccountCommand,
  implicitAgentBatch,
  isPaid,
  readAgentOnChain,
} from "../../lib/connect";
import { formatSpan } from "../../lib/phase";
import { accountExists, accountKeyState } from "../../lib/rpc";
import { useLoad } from "../../lib/useLoad";
import { describeAmount, describeNear } from "../../lib/vault";
import { useAccountActions, useWallet } from "../../lib/wallet";
import {
  SEND_MAY_STILL_GO_THROUGH,
  sendOutcomeUnknown,
  TransactionFailed,
  WalletError,
} from "../../lib/walletErrors";
import { PageHead } from "../PageHead";
import { FACT_LABEL, FIELD, NOTICE, PRIMARY, SECONDARY, TEXT_LINK } from "../ui";
import { ConnectAgent } from "./ConnectAgent";
import { Command, ConnectGate } from "./parts";
import { STEP_LOOK, Step } from "./Step";

export { AGENT_ACCOUNT_DEPOSIT, createAccountActions, createAccountCommand, STEP_LOOK };

// "Add an agent": making an agent of the connected account. The page leads with "Connect your agent"
// (ConnectAgent.tsx): one paste where the agent runs and one approval in the wallet. Below it,
// "Advanced: set up by hand" keeps the three deliberate steps, for a person who wants each one in
// their own hands:
//
// 1. The agent makes its own key, where it runs (`pnpm agent:init`), and the person pastes the
//    PUBLIC key here. The page never makes, sees or keeps a private key: one pasted by mistake is
//    cleared from the field at once and kept nowhere.
// 2. The person's wallet creates the agent's account under theirs, `<name>.<account>`, in ONE
//    transaction to the new account: CreateAccount, a Transfer of `AGENT_ACCOUNT_DEPOSIT` for its
//    storage and gas, the setup code (contract/agent-setup) and its call, which adds the pasted key
//    with full access from inside the account. There is no AddKey action, which some wallets refuse.
//    A wallet that can't send it gets a near-cli command that makes the account with the key
//    instead, and "Check again" reads the chain.
// 3. The agent registers itself and locks its bond (`pnpm agent:register`), which only its own key
//    can sign. The page shows the bond from the contract's config, and watches the API until the
//    agent is listed.
//
// Nothing is signed until the person presses the button that says what it signs.

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
            <dd className="text-[13px] text-muted">
              Added with full access by the account's setup code.
            </dd>
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
                label="The account with its key, with near-cli"
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
  command = REGISTER_COMMAND,
}: {
  accountId: string;
  onListed: () => void;
  watchEveryMs: number;
  command?: string;
}) {
  const [terms, retry] = useLoad("config", () => readBondTerms());
  return (
    <div className="grid gap-4">
      <Command command={command} label="Run where the agent runs" account={accountId} />
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

// ---- An owner whose account is an implicit account ---------------------------------------------

/**
 * An implicit account: 64 hex characters, the account of an ed25519 key. Every account of the email
 * and Google login is one. A NEAR account id is 64 characters at most, so it can have no account
 * under it, and "Add an agent" can't make `<name>.<owner>`, nor can the API make a connect code for
 * one (`readAgentName` refuses the owner).
 */
export function isImplicitAccount(accountId: string): boolean {
  return /^[0-9a-f]{64}$/.test(accountId);
}

/** Why an implicit account's agent gets an account of its own key, in one plain line. */
export const IMPLICIT_OWNER_LINE =
  "Your account's name has no room for accounts under it, so your agent gets an account made from its own key.";

/** The name of the agent's key file, which `init` makes and `register` reads. */
const IMPLICIT_KEY_NAME = "agent";

/** The command that registers the agent of an implicit account, which `init` could not name. */
export const implicitRegisterCommand = (agentId: string) =>
  `${REGISTER_COMMAND} --name ${IMPLICIT_KEY_NAME} --account ${agentId}`;

/** What the chain says of the agent's account, for the key that was pasted. */
type ImplicitLook =
  | { state: "idle" }
  | { state: "checking" | "error"; accountId: string }
  | { state: "read"; accountId: string; chain: AgentOnChain };

/**
 * "Add an agent" for an implicit account: the agent makes its key, the person pastes the public
 * half, and ONE approval sends NEAR to the implicit account of that key (which the chain creates
 * with that key as its one full-access key), Tender's storage for it and the bond into its vault
 * (`implicitAgentBatch`, as "Use a separate account instead" sends). Then the agent registers with
 * its own key. Nothing is signed until the button is pressed.
 */
function ImplicitFlow({ watchEveryMs }: { watchEveryMs: number }) {
  const id = useId();
  const actions = useAccountActions();
  const [terms, retryTerms] = useLoad("config", () => readBondTerms());
  const [keyText, setKeyText] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [look, setLook] = useState<ImplicitLook>({ state: "idle" });
  const [create, setCreate] = useState<Create>({ state: "idle" });
  const [listed, setListed] = useState<string | null>(null);
  const busy = useRef(false);
  const latestLook = useRef(0);

  const key = readPublicKey(keyText);
  const publicKey = key.ok ? key.publicKey : null;
  const agentId = publicKey === null ? null : implicitAccountOf(publicKey);
  const bond = terms.status === "ready" ? bondOfTerms(terms.data) : null;
  const termsRead = terms.status === "ready";
  const sending = create.state === "waiting" || create.state === "settling";

  /** Reads where the agent's account stands. Null when the read failed. */
  const read = async (target: string, pk: string): Promise<AgentOnChain | null> => {
    const request = ++latestLook.current;
    setLook({ state: "checking", accountId: target });
    try {
      const chain = await readAgentOnChain(target, pk, bond);
      if (request === latestLook.current) setLook({ state: "read", accountId: target, chain });
      return chain;
    } catch (error) {
      console.error(error);
      if (request === latestLook.current) setLook({ state: "error", accountId: target });
      return null;
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: `read` is this render's, and the read is keyed on what it reads
  useEffect(() => {
    if (agentId === null || publicKey === null || !termsRead) {
      latestLook.current++;
      setLook({ state: "idle" });
      return;
    }
    if (busy.current) return;
    void read(agentId, publicKey);
  }, [agentId, publicKey, termsRead]);

  const onKey = (text: string) => {
    if (sending) return;
    setCreate({ state: "idle" });
    setListed(null);
    const reading = readPublicKey(text);
    if (!reading.ok && reading.secret) {
      // Key material: out of the field at once, kept nowhere, and the person is told.
      setKeyText("");
      setKeyError(reading.message);
      return;
    }
    setKeyText(text);
    setKeyError(reading.ok || text.trim().length < 50 ? null : reading.message);
  };

  const shown = look.state !== "idle" && look.accountId === agentId ? look : null;
  const chain = shown?.state === "read" ? shown.chain : null;
  const made = chain !== null && chain.key === "has-key" && isPaid(chain, bond);
  const taken = chain !== null && chain.key === "other-keys";
  const ready = agentId !== null && chain !== null && !made && !taken;

  const send = async () => {
    if (busy.current || agentId === null || publicKey === null || !termsRead) return;
    busy.current = true;
    setCreate({ state: "waiting" });
    try {
      // Read again now: what Tender holds for the account may have changed since the page looked.
      const fresh = await read(agentId, publicKey);
      if (
        fresh === null ||
        fresh.key === "other-keys" ||
        (fresh.key === "has-key" && isPaid(fresh, bond))
      ) {
        setCreate({ state: "idle" });
        return;
      }
      await actions.sendBatch(implicitAgentBatch({ accountId: agentId, chain: fresh, bond }));
      setCreate({ state: "settling" });
      for (let tries = 0; tries < SETTLE_TRIES; tries++) {
        const seen = await read(agentId, publicKey);
        if (seen !== null && seen.key === "has-key" && isPaid(seen, bond)) {
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
            ? "The transaction failed on the network. Check that your account holds the NEAR and the bond before you try again."
            : sendOutcomeUnknown(error)
              ? SEND_MAY_STILL_GO_THROUGH
              : error instanceof WalletError
                ? "The wallet didn't send it. Try again."
                : "Something went wrong before anything was sent. Try once more.",
      });
    } finally {
      busy.current = false;
    }
  };

  return (
    <div className="grid gap-6">
      <p data-testid="implicit-owner" className={NOTICE}>
        {IMPLICIT_OWNER_LINE}
      </p>
      <ol className="grid gap-4">
        <Step
          n={1}
          title="Make your agent's key where the agent runs."
          why="The key signs everything the agent does, so it is made on the agent's machine and never leaves it. Tender only ever sees the public half."
          done={publicKey !== null}
          open
        >
          <Command command={initCommand(IMPLICIT_KEY_NAME)} label="Run where the agent runs" />
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
              aria-describedby={keyError === null ? undefined : `${id}-key-error`}
              className={`${FIELD} font-mono text-sm`}
            />
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
          why="The account is made from the key: its name is the key's 64 characters, and the key is its only key. Tender's directory won't list it under you as its provider."
          done={made}
          open={publicKey !== null || made}
        >
          <dl className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2">
            <div className="grid content-start gap-1 bg-ink p-4">
              <dt className={FACT_LABEL}>Its account</dt>
              <dd
                data-testid="implicit-agent"
                className="font-mono text-[13px] text-bone wrap-anywhere"
              >
                {agentId ?? "From step 1"}
              </dd>
            </div>
            <div className="grid content-start gap-1 bg-ink p-4">
              <dt className={FACT_LABEL}>You sign</dt>
              <dd className="text-lg text-bone">1 approval</dd>
              <dd className="text-[13px] text-muted">
                {describeNear(AGENT_ACCOUNT_DEPOSIT)} to the account, which stays the agent's, its
                storage with Tender and its bond.
              </dd>
            </div>
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
                className={SECONDARY}
              >
                {terms.retrying ? "Retrying…" : "Retry"}
              </button>
            </div>
          ) : null}

          <p data-testid="implicit-state" className="text-sm" aria-live="polite">
            {shown === null ? null : shown.state === "checking" ? (
              <span className="text-muted">Checking the account…</span>
            ) : shown.state === "error" ? (
              <span className="text-seal">
                Couldn't ask the network about the account. It is checked again before anything is
                sent.
              </span>
            ) : made ? (
              <span className="text-bone">The account is made and paid for. On to step 3.</span>
            ) : taken ? (
              <span className="text-seal">
                That account exists with other keys, so it isn't this key's to use.
              </span>
            ) : null}
          </p>

          {made ? null : !actions.canSend() ? (
            <p data-testid="cannot-create" className={NOTICE}>
              This wallet can't send the approval from the page.
            </p>
          ) : (
            <button
              type="button"
              aria-disabled={!ready || sending}
              onClick={() => {
                if (ready && !sending) void send();
              }}
              className={PRIMARY}
            >
              {create.state === "waiting"
                ? "Waiting for your wallet…"
                : create.state === "settling"
                  ? "Looking for the account…"
                  : "Create the agent's account"}
            </button>
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
        </Step>

        <Step
          n={3}
          title="Let the agent register itself and lock its bond."
          why="Registering is signed with the agent's own key, so only the agent can do it. The bond makes each agent cost something while it is active, and comes back when it retires."
          done={made && listed === agentId}
          open={made}
        >
          {made && agentId !== null ? (
            <Register
              accountId={agentId}
              command={implicitRegisterCommand(agentId)}
              onListed={() => setListed(agentId)}
              watchEveryMs={watchEveryMs}
            />
          ) : (
            <p className="text-sm text-muted">Once its account exists.</p>
          )}
        </Step>
      </ol>
    </div>
  );
}

/**
 * "Advanced: set up by hand": the three steps, folded away under a button until a person asks for
 * them, or the connect flow sends them here (a wallet that can't sign in).
 */
function ByHand({
  open,
  onToggle,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-4">
      <div className="grid gap-2 border-t border-line pt-6">
        <h2 id={`${id}-title`} className="sr-only">
          Set up by hand
        </h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-steps`}
          onClick={onToggle}
          className={`${SECONDARY} justify-self-start`}
        >
          {open ? "Hide the steps by hand" : "Advanced: set up by hand"}
        </button>
        <p className="text-sm text-muted">
          Make the key yourself, paste its public key, create the account, and register, one step at
          a time.
        </p>
      </div>
      {open ? (
        <div id={`${id}-steps`} data-testid="by-hand">
          {children}
        </div>
      ) : null}
    </section>
  );
}

export function AddAgentView({
  watchEveryMs = WATCH_EVERY_MS,
  pollMs,
}: {
  watchEveryMs?: number;
  /** How often the connect flow asks how its code stands; a test sets it short. */
  pollMs?: number;
} = {}) {
  const wallet = useWallet();
  const [byHand, setByHand] = useState(false);
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-8">
      <PageHead title="Add an agent." muted="Its key stays where it runs.">
        One paste where your agent runs, and one approval in your wallet. What it costs:{" "}
        {describeNear(AGENT_ACCOUNT_DEPOSIT)} sent to the agent's new account, which stays the
        agent's, {describeNear(AGENT_STORAGE_DEPOSIT)} for its storage with Tender, and the bond it
        locks when it registers, paid from your wallet into the agent's own vault and refunded in
        full to that vault when it retires.{" "}
        <Link href="/my-agents" className={TEXT_LINK}>
          Back to My agents
        </Link>
      </PageHead>
      <ConnectGate
        wallet={wallet}
        why="Sign in first: your account makes the agent's account and pays for it."
      >
        {(account) =>
          isImplicitAccount(account) ? (
            // No account can be made under it, and no connect code: the agent's own key's account.
            <ImplicitFlow key={account} watchEveryMs={watchEveryMs} />
          ) : (
            <div className="grid gap-8">
              <ConnectAgent
                key={account}
                account={account}
                onByHand={() => setByHand(true)}
                {...(pollMs === undefined ? {} : { pollMs })}
              />
              <ByHand open={byHand} onToggle={() => setByHand((was) => !was)}>
                <Flow key={account} account={account} watchEveryMs={watchEveryMs} />
              </ByHand>
            </div>
          )
        }
      </ConnectGate>
    </div>
  );
}
