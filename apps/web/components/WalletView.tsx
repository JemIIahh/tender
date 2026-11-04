"use client";

import {
  depositCall,
  storageDepositCall,
  storageWithdrawCall,
  type TenderCall,
  type TenderEvent,
} from "@tender/shared";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { config } from "../lib/config";
import { READING_BALANCES } from "../lib/copy";
import { errorMessage } from "../lib/errors";
import { FAUCET_AMOUNT, faucetOffered, faucetToken, planFaucet } from "../lib/faucet";
import {
  describeAmount,
  describeNear,
  isRegisteredAtToken,
  planWithdraw,
  readAmount,
  readVault,
  SETUP_DEPOSIT_YOCTO,
  type TokenRow,
  type VaultData,
} from "../lib/vault";
import { useWallet } from "../lib/wallet";
import { WALLET_CANNOT_SIGN_MESSAGE, walletErrorMessage } from "../lib/walletErrors";
import { Amount } from "./Amount";
import { Avatar } from "./Avatar";
import { ErrorState } from "./ErrorState";
import { FaucetSection } from "./FaucetSection";
import { PageHead } from "./PageHead";
import { CARD, FACT_LABEL, FIELD, NOTICE, PANEL, PANEL_TITLE, PRIMARY, SECONDARY } from "./ui";

// The wallet page: connect a wallet, set up the account with Tender, put tokens into the vault and
// take them out. The balances are read from the chain through the browser's own RPC node, so they
// are the chain's and not an index's; after anything is sent they are read again, and once more a
// moment later, because the node the wallet used can be a block ahead of this one.
//
// What a person is told after sending comes from the events the transactions logged. A refunded
// deposit and a withdrawal the token could not pay are successful transactions with a different
// event, and are worded as what they are.

/** How long after sending the balances are read once more. */
const LATER_REFRESH_MS = 2500;

interface Stale {
  message: string;
  retrying: boolean;
}

type Panel =
  | { status: "loading" }
  | { status: "error"; message: string; retrying: boolean }
  | { status: "ready"; data: VaultData; stale: Stale | null };

type ActionId = "connect" | "disconnect" | "setup" | "deposit" | "withdraw" | "storage" | "faucet";

/** What the last action came to, shown next to the control that started it. */
interface Notice {
  action: ActionId;
  kind: "done" | "failed";
  text: string;
}

/** Whether the keyboard focus has nowhere to be, which is what removing the focused element does. */
function focusLost(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

/** The first event called `name`, with its data narrowed to that event's. */
function eventOf<K extends TenderEvent["event"]>(
  events: readonly TenderEvent[],
  name: K,
): Extract<TenderEvent, { event: K }> | undefined {
  return events.find((event): event is Extract<TenderEvent, { event: K }> => event.event === name);
}

/** The words for a result that has none of the events it should: it can't be told what happened. */
const NO_EVENT =
  "The wallet finished, but Tender didn't report what happened. The balances are read from the network.";

function NoticeLine({ notice }: { notice: Notice | null }) {
  if (notice === null) return null;
  return (
    <p
      role={notice.kind === "failed" ? "alert" : "status"}
      data-testid="notice"
      className={
        notice.kind === "failed"
          ? "rounded-xl border border-seal/45 bg-seal/[0.06] p-4 text-sm text-bone"
          : NOTICE
      }
    >
      {notice.text}
    </p>
  );
}

function BalancesSection({ rows }: { rows: TokenRow[] }) {
  return (
    <section className={PANEL}>
      <h2 className={PANEL_TITLE}>Balances</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">Tender lists no tokens yet.</p>
      ) : (
        <ul className="grid gap-3">
          {rows.map((row) => (
            <li
              key={row.token}
              data-testid="token-row"
              className="grid min-w-0 gap-3 rounded-xl border border-line bg-ink p-4 sm:p-5"
            >
              <span className="flex min-w-0 items-center gap-2 font-mono text-xs text-muted wrap-anywhere">
                <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-seal" />
                {row.token}
                {row.enabled ? "" : " (not taking deposits)"}
              </span>
              <dl className="grid grid-cols-2 gap-3">
                <dt className={`${FACT_LABEL} row-start-1`}>In your vault</dt>
                <dd
                  data-testid="vault-balance"
                  className="text-xl leading-tight font-medium tracking-[-0.02em] text-bone tabular-nums wrap-anywhere sm:text-2xl"
                >
                  <Amount value={row.vault.toString()} token={row.token} />
                </dd>
                <dt className={`${FACT_LABEL} row-start-1`}>In your wallet</dt>
                <dd
                  data-testid="wallet-balance"
                  className="text-xl leading-tight tracking-[-0.02em] text-muted tabular-nums wrap-anywhere sm:text-2xl"
                >
                  <Amount value={row.wallet?.toString() ?? null} token={row.token} />
                </dd>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StorageSection({
  storage,
  running,
  notices,
  onSetUp,
  onWithdraw,
}: {
  storage: VaultData["storage"];
  running: ActionId | null;
  notices: ReactNode;
  onSetUp: () => void;
  onWithdraw: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const wasUnset = useRef(storage === null);
  // Taking storage back with none to take sends a transaction that does nothing: it is off then.
  const takeBackOff = running !== null || storage === null || storage.available === 0n;
  // The button that set the account up is gone once it is: the focus goes to the section, which
  // is where what it did is told, and not to the top of the document.
  useEffect(() => {
    if (storage === null) {
      wasUnset.current = true;
    } else if (wasUnset.current) {
      wasUnset.current = false;
      if (focusLost()) heading.current?.focus();
    }
  }, [storage]);

  return (
    <section className={PANEL}>
      <h2 ref={heading} tabIndex={-1} className={PANEL_TITLE}>
        Storage with Tender
      </h2>
      {storage === null ? (
        <>
          <p className="text-sm text-muted">
            Your account is not set up with Tender yet. Setting it up deposits{" "}
            {describeNear(SETUP_DEPOSIT_YOCTO)} to pay for the space your balances take. What you
            don't use you can take back.
          </p>
          {/* A key of its own: the next button, in this place, is another button, and a press meant
              for this one (a second one, or a late one) is not taken by that one. */}
          <button
            key="setup"
            type="button"
            aria-disabled={running !== null}
            onClick={onSetUp}
            className={PRIMARY}
          >
            {running === "setup" ? "Waiting for your wallet…" : "Set up account"}
          </button>
        </>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line">
            <div className="grid content-start gap-1.5 bg-ink p-4">
              <dt className={FACT_LABEL}>Deposited</dt>
              <dd
                data-testid="storage-total"
                className="text-lg text-bone tabular-nums wrap-anywhere"
              >
                {describeNear(storage.total)}
              </dd>
            </div>
            <div className="grid content-start gap-1.5 bg-ink p-4">
              <dt className={FACT_LABEL}>Free to take back</dt>
              <dd
                data-testid="storage-available"
                className="text-lg text-bone tabular-nums wrap-anywhere"
              >
                {describeNear(storage.available)}
              </dd>
            </div>
          </dl>
          {/* `aria-disabled` does not stop a press, so the handler has the same condition. */}
          <button
            key="take-back"
            type="button"
            aria-disabled={takeBackOff}
            onClick={() => {
              if (!takeBackOff) onWithdraw();
            }}
            className={SECONDARY}
          >
            {running === "storage" ? "Waiting for your wallet…" : "Withdraw unused storage"}
          </button>
        </>
      )}
      {notices}
    </section>
  );
}

/** A form to move an amount of one of the tokens: add funds to the vault, or take them out. */
function AmountForm({
  title,
  intro,
  rows,
  source,
  unavailable,
  submitLabel,
  running,
  anyRunning,
  onSubmit,
  notice,
}: {
  title: string;
  intro: string;
  rows: TokenRow[];
  /** Where the amount comes from, and so what the most is: the vault or the wallet. */
  source: "vault" | "wallet";
  /** Why there is nothing to do here, or null. */
  unavailable: string | null;
  submitLabel: string;
  /** This form's action is under way. */
  running: boolean;
  /** Some action is under way, this one or another. */
  anyRunning: boolean;
  /** Sends the amount. True if it went through, and the form is emptied. */
  onSubmit: (token: string, amount: bigint) => Promise<boolean>;
  notice: ReactNode;
}) {
  const id = useId();
  // The token an amount is typed for (or the person chose), or null while the form shows the first
  // of the list, which is free to change. Once an amount is typed it is for the token that was
  // shown, and stays with it however the list is ordered.
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (selected !== null && !rows.some((candidate) => candidate.token === selected)) {
    // The token the amount was for has left the list: the amount goes with it, and does not turn
    // into an amount of another token. (React takes a state change made while rendering this
    // component and renders again at once.)
    setSelected(null);
    setText("");
    setError(null);
  }
  const row = rows.find((candidate) => candidate.token === selected) ?? rows[0];
  const max = row === undefined ? null : source === "vault" ? row.vault : row.wallet;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (anyRunning || row === undefined) return;
    const reading = readAmount(text, row.token, max, source);
    if (!reading.ok) {
      setError(reading.message);
      return;
    }
    setError(null);
    if (await onSubmit(row.token, reading.amount)) setText("");
  };

  return (
    <section className={PANEL}>
      <h2 className={PANEL_TITLE}>{title}</h2>
      <p className="text-sm text-muted">{intro}</p>
      {unavailable !== null || row === undefined ? (
        <p data-testid="form-unavailable" className="text-sm text-bone">
          {unavailable}
        </p>
      ) : (
        <form onSubmit={submit} className="grid gap-2">
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid max-w-full min-w-0 gap-1.5">
              <label htmlFor={`${id}-token`} className={FACT_LABEL}>
                Token
              </label>
              <select
                id={`${id}-token`}
                value={row.token}
                onChange={(event) => {
                  setSelected(event.currentTarget.value);
                  setError(null);
                }}
                className={`${FIELD} max-w-full font-mono text-sm`}
              >
                {rows.map((candidate) => (
                  <option key={candidate.token} value={candidate.token}>
                    {candidate.token}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <label htmlFor={`${id}-amount`} className={FACT_LABEL}>
                Amount
              </label>
              <input
                id={`${id}-amount`}
                value={text}
                onChange={(event) => {
                  setText(event.currentTarget.value);
                  setSelected(row.token);
                }}
                inputMode="decimal"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={error !== null}
                aria-describedby={error === null ? `${id}-have` : `${id}-have ${id}-error`}
                className={`${FIELD} w-40 tabular-nums`}
              />
            </div>
            <button type="submit" aria-disabled={anyRunning} className={PRIMARY}>
              {running ? "Waiting for your wallet…" : submitLabel}
            </button>
          </div>
          <p id={`${id}-have`} className="text-sm text-muted">
            {source === "vault" ? "In your vault: " : "In your wallet: "}
            <Amount value={max?.toString() ?? null} token={row.token} />
          </p>
          {/* Not an alert: the page has one alert at a time, for what an action came to. */}
          {error === null ? null : (
            <p id={`${id}-error`} data-testid="amount-error" className="text-sm text-seal">
              {error}
            </p>
          )}
        </form>
      )}
      {notice}
    </section>
  );
}

export function WalletView({
  laterRefreshMs = LATER_REFRESH_MS,
}: {
  laterRefreshMs?: number;
} = {}) {
  const { ready, accountId, canSignMessage, connect, disconnect, signAndSend } = useWallet();
  const [panel, setPanel] = useState<Panel>({ status: "loading" });
  const [running, setRunning] = useState<ActionId | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Set at once when an action starts, where `running` is only set for the next render: a second
  // press before then must not start a second wallet dialog.
  const busy = useRef(false);
  // The read that counts. An answer to an earlier one is dropped: strict mode starts two, an
  // action reads again while a slow read is on its way, and another account is another page.
  const latest = useRef(0);
  // The account the page is for now. A read for another one (a delayed one, or one that an action
  // began for an account that has since been left) is not made, and its answer is not taken.
  const shown = useRef<string | null>(accountId);
  const later = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const connection = useRef<HTMLHeadingElement>(null);
  const connected = useRef(accountId !== null);

  /** `quiet`: read again without taking the page away, as after an action or for the notice. */
  const load = useCallback((account: string, quiet: boolean) => {
    if (account !== shown.current) return;
    const request = ++latest.current;
    setPanel((was) => {
      if (quiet) {
        return was.status === "ready" && was.stale !== null
          ? { ...was, stale: { ...was.stale, retrying: true } }
          : was;
      }
      // A retry leaves the error and its button where they are, so that the person who pressed it
      // keeps their focus.
      return was.status === "error" ? { ...was, retrying: true } : { status: "loading" };
    });
    readVault(account).then(
      (data) => {
        if (request === latest.current) setPanel({ status: "ready", data, stale: null });
      },
      (error) => {
        if (request !== latest.current) return;
        // The person gets words; the original goes to the console, where a developer looks.
        console.error(error);
        const message = errorMessage(error);
        setPanel((was) =>
          was.status === "ready"
            ? { ...was, stale: { message, retrying: false } }
            : { status: "error", message, retrying: false },
        );
      },
    );
  }, []);

  useEffect(() => {
    shown.current = accountId;
    setNotice(null);
    // The read that was to come after an action is for the account that did it.
    clearTimeout(later.current);
    if (accountId === null) {
      // Drop any read still on its way: it is for an account that is gone.
      latest.current++;
      return;
    }
    load(accountId, false);
  }, [accountId, load]);

  useEffect(() => () => clearTimeout(later.current), []);

  // Connecting, or disconnecting, takes away the button that was pressed.
  useEffect(() => {
    if (connected.current !== (accountId !== null)) {
      connected.current = accountId !== null;
      if (focusLost()) connection.current?.focus();
    }
  }, [accountId]);

  /** Reads the balances again now and once more shortly: the wallet's node can be ahead of ours. */
  const refresh = (account: string) => {
    load(account, true);
    clearTimeout(later.current);
    later.current = setTimeout(() => load(account, true), laterRefreshMs);
  };

  /**
   * Runs one action, one at a time. `task` gives the words for what it came to, or null for
   * nothing to say; what it throws is worded, logged, and shown by the control that started it.
   * What it came to is told only while the page is still for the account the action began under:
   * Alice's withdrawal that ends after the wallet became Bob's is no news for Bob's page.
   */
  const run = async (action: ActionId, task: () => Promise<string | null>): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true;
    const account = shown.current;
    const tell = (told: Notice) => {
      if (shown.current === account) setNotice(told);
    };
    setRunning(action);
    setNotice(null);
    try {
      const text = await task();
      if (text !== null) tell({ action, kind: "done", text });
      return true;
    } catch (error) {
      console.error(error);
      tell({ action, kind: "failed", text: walletErrorMessage(error) });
      return false;
    } finally {
      busy.current = false;
      setRunning(null);
    }
  };

  /** An action that sends calls. The balances are read again whatever came of it. */
  const send = (
    action: ActionId,
    plan: () => Promise<TenderCall[]>,
    wording: (events: TenderEvent[]) => string,
  ) =>
    run(action, async () => {
      if (accountId === null) return null;
      try {
        const { events } = await signAndSend(await plan());
        return wording(events);
      } finally {
        // The first of two transactions can land and the second fail, so this is for a failure too.
        refresh(accountId);
      }
    });

  const setUp = () =>
    send(
      "setup",
      async () => [storageDepositCall(config.contractId, SETUP_DEPOSIT_YOCTO)],
      (events) => {
        const stored = eventOf(events, "storage_deposit");
        return stored === undefined
          ? NO_EVENT
          : `Your account is set up. ${describeNear(BigInt(stored.data.amount))} is deposited for storage.`;
      },
    );

  const addFunds = (token: string, amount: bigint) =>
    send(
      "deposit",
      async () => [depositCall(token, config.contractId, amount)],
      // No `deposit` event is no proof of a refund: an event the wallet did not return reads the
      // same. So the words are the ones for any missing event, and the balances, read again, say
      // what became of the deposit.
      (events) =>
        eventOf(events, "deposit") === undefined
          ? NO_EVENT
          : `Added ${describeAmount(amount, token)} to your vault.`,
    );

  const withdraw = (token: string, amount: bigint) =>
    send(
      "withdraw",
      async () => {
        if (accountId === null) return [];
        // Read now and not from the page: it could have changed since, and a token pays only an
        // account it has registered.
        const registered = await isRegisteredAtToken(token, accountId);
        return planWithdraw({
          contractId: config.contractId,
          token,
          account: accountId,
          amount,
          registered,
        });
      },
      (events) => {
        if (eventOf(events, "withdraw_failed") !== undefined) {
          return "The token couldn't pay out, so the amount is back in your vault.";
        }
        return eventOf(events, "withdraw") === undefined
          ? NO_EVENT
          : `Withdrew ${describeAmount(amount, token)} to your wallet.`;
      },
    );

  // Testnet's free test tokens: a mint to the connected account, with the token's registration in
  // front of it if the token does not know the account. One batch, one approval. The token logs no
  // Tender event, so the words rest on the transaction having succeeded (a failed one throws), and
  // the balances, read again, show what the account now holds.
  const getTestTokens = (token: string) =>
    send(
      "faucet",
      async () => {
        if (accountId === null) return [];
        // Read now and not from the page, as for a withdrawal: it could have changed since.
        const registered = await isRegisteredAtToken(token, accountId);
        return planFaucet({ token, account: accountId, registered });
      },
      () =>
        `Added ${describeAmount(FAUCET_AMOUNT, token)} to your wallet. They are free test tokens with no value.`,
    );

  // No amount in the words: what was taken back is what the balances above show, read again.
  const takeBackStorage = () =>
    send(
      "storage",
      async () => [storageWithdrawCall(config.contractId)],
      () => "Took back your unused storage.",
    );

  const noticeFor = (action: ActionId) =>
    notice?.action === action ? <NoticeLine notice={notice} /> : null;

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-5">
      <div className="pb-3">
        <PageHead
          eyebrow="Account"
          title="Wallet"
          art={{ name: "escrow", focus: { x: 0.6, y: 0.52, scale: 0.46 } }}
        >
          Your vault with Tender: the tasks you post are paid from it, and what you win is paid into
          it.
        </PageHead>
      </div>

      <section className={`${CARD} grid gap-4 p-5 sm:p-6`}>
        <h2 ref={connection} tabIndex={-1} className={PANEL_TITLE}>
          Connection
        </h2>
        {!ready ? (
          <p role="status" className="text-sm text-muted">
            Checking for your wallet…
          </p>
        ) : accountId === null ? (
          <>
            <p className="text-sm text-muted">
              Connect a wallet to see your balances and move funds.
            </p>
            <button
              key="connect"
              type="button"
              aria-disabled={running !== null}
              onClick={() =>
                run("connect", async () => {
                  await connect();
                  return null;
                })
              }
              className={PRIMARY}
            >
              {running === "connect" ? "Waiting for your wallet…" : "Connect wallet"}
            </button>
          </>
        ) : (
          <>
            <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
              <Avatar account={accountId} size={34} />
              <span className="text-sm text-muted">Connected as</span>
              <span data-testid="account-id" className="font-mono text-sm text-bone wrap-anywhere">
                {accountId}
              </span>
            </p>
            {canSignMessage ? null : (
              <p role="status" data-testid="cannot-sign" className={NOTICE}>
                {WALLET_CANNOT_SIGN_MESSAGE}
              </p>
            )}
            <button
              key="disconnect"
              type="button"
              aria-disabled={running !== null}
              onClick={() =>
                run("disconnect", async () => {
                  await disconnect();
                  return null;
                })
              }
              className={SECONDARY}
            >
              {running === "disconnect" ? "Disconnecting…" : "Disconnect"}
            </button>
          </>
        )}
        {noticeFor("connect")}
        {noticeFor("disconnect")}
      </section>

      {accountId === null ? null : panel.status === "loading" ? (
        <p role="status" className="text-sm text-muted">
          {READING_BALANCES}
        </p>
      ) : panel.status === "error" ? (
        <ErrorState
          message={panel.message}
          retrying={panel.retrying}
          onRetry={() => load(accountId, false)}
        />
      ) : (
        <>
          {panel.stale === null ? null : (
            <ErrorState
              message={`${panel.stale.message} What is shown may be out of date.`}
              retrying={panel.stale.retrying}
              onRetry={() => load(accountId, true)}
            />
          )}

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] lg:items-start">
            <div className="grid gap-5">
              <StorageSection
                storage={panel.data.storage}
                running={running}
                notices={
                  <>
                    {noticeFor("setup")}
                    {noticeFor("storage")}
                  </>
                }
                onSetUp={setUp}
                onWithdraw={takeBackStorage}
              />

              {faucetOffered(config.network) ? (
                <FaucetSection
                  token={faucetToken(panel.data.rows, config.network)}
                  running={running === "faucet"}
                  anyRunning={running !== null}
                  onGet={getTestTokens}
                  notice={noticeFor("faucet")}
                />
              ) : null}
            </div>

            <BalancesSection rows={panel.data.rows} />
          </div>

          <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
            <AmountForm
              title="Add funds"
              intro="Move tokens from your wallet into your vault. Tasks you post are paid from the vault."
              rows={panel.data.rows.filter((row) => row.enabled)}
              source="wallet"
              unavailable={
                panel.data.storage === null
                  ? "Set up your account first."
                  : panel.data.rows.some((row) => row.enabled)
                    ? null
                    : "Tender takes no deposits right now."
              }
              submitLabel="Add funds"
              running={running === "deposit"}
              anyRunning={running !== null}
              onSubmit={addFunds}
              notice={noticeFor("deposit")}
            />

            <AmountForm
              title="Withdraw"
              intro="Move tokens from your vault back to your wallet. If the token hasn't registered your account, that happens first, in the same approval, for 0.00125 NEAR."
              rows={panel.data.rows.filter((row) => row.vault > 0n)}
              source="vault"
              unavailable={
                panel.data.rows.some((row) => row.vault > 0n)
                  ? null
                  : "There is nothing in your vault to withdraw."
              }
              submitLabel="Withdraw"
              running={running === "withdraw"}
              anyRunning={running !== null}
              onSubmit={withdraw}
              notice={noticeFor("withdraw")}
            />
          </div>
        </>
      )}
    </div>
  );
}
