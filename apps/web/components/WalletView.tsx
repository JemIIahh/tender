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
import { errorMessage } from "../lib/errors";
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
import { ErrorState } from "./ErrorState";

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

type ActionId = "connect" | "disconnect" | "setup" | "deposit" | "withdraw" | "storage";

/** What the last action came to, shown next to the control that started it. */
interface Notice {
  action: ActionId;
  kind: "done" | "failed";
  text: string;
}

const PRIMARY =
  "min-h-11 w-fit rounded border border-neutral-900 bg-neutral-900 px-4 text-white aria-disabled:opacity-60";
const SECONDARY = "min-h-11 w-fit rounded border border-neutral-900 px-4 aria-disabled:opacity-60";

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
      className="rounded border border-neutral-900 p-3 text-sm"
    >
      {notice.text}
    </p>
  );
}

function BalancesSection({ rows }: { rows: TokenRow[] }) {
  return (
    <section className="grid gap-2">
      <h2 className="text-lg font-semibold">Balances</h2>
      {rows.length === 0 ? (
        <p>Tender lists no tokens yet.</p>
      ) : (
        <ul className="grid gap-2">
          {rows.map((row) => (
            <li
              key={row.token}
              data-testid="token-row"
              className="grid gap-1 rounded border border-neutral-300 p-3"
            >
              <span className="font-mono text-sm wrap-anywhere">
                {row.token}
                {row.enabled ? "" : " (not taking deposits)"}
              </span>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <dt className="text-neutral-700">In your vault</dt>
                <dd data-testid="vault-balance">
                  <Amount value={row.vault.toString()} token={row.token} />
                </dd>
                <dt className="text-neutral-700">In your wallet</dt>
                <dd data-testid="wallet-balance">
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
    <section className="grid gap-2">
      <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold">
        Storage with Tender
      </h2>
      {storage === null ? (
        <>
          <p>
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
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-neutral-700">Deposited</dt>
            <dd data-testid="storage-total">{describeNear(storage.total)}</dd>
            <dt className="text-neutral-700">Free to take back</dt>
            <dd data-testid="storage-available">{describeNear(storage.available)}</dd>
          </dl>
          <button
            key="take-back"
            type="button"
            aria-disabled={running !== null || storage.available === 0n}
            onClick={onWithdraw}
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
  const [selected, setSelected] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
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
    <section className="grid gap-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p>{intro}</p>
      {unavailable !== null || row === undefined ? (
        <p data-testid="form-unavailable">{unavailable}</p>
      ) : (
        <form onSubmit={submit} className="grid gap-2">
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid min-w-0 gap-1">
              <label htmlFor={`${id}-token`} className="text-sm">
                Token
              </label>
              <select
                id={`${id}-token`}
                value={row.token}
                onChange={(event) => {
                  setSelected(event.currentTarget.value);
                  setError(null);
                }}
                className="min-h-11 max-w-full rounded border border-neutral-900 bg-white px-2"
              >
                {rows.map((candidate) => (
                  <option key={candidate.token} value={candidate.token}>
                    {candidate.token}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1">
              <label htmlFor={`${id}-amount`} className="text-sm">
                Amount
              </label>
              <input
                id={`${id}-amount`}
                value={text}
                onChange={(event) => setText(event.currentTarget.value)}
                inputMode="decimal"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={error !== null}
                aria-describedby={error === null ? `${id}-have` : `${id}-have ${id}-error`}
                className="min-h-11 w-40 rounded border border-neutral-900 px-2"
              />
            </div>
            <button type="submit" aria-disabled={anyRunning} className={PRIMARY}>
              {running ? "Waiting for your wallet…" : submitLabel}
            </button>
          </div>
          <p id={`${id}-have`} className="text-sm">
            {source === "vault" ? "In your vault: " : "In your wallet: "}
            <Amount value={max?.toString() ?? null} token={row.token} />
          </p>
          {/* Not an alert: the page has one alert at a time, for what an action came to. */}
          {error === null ? null : (
            <p id={`${id}-error`} data-testid="amount-error" className="text-sm">
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
  const later = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const connection = useRef<HTMLHeadingElement>(null);
  const connected = useRef(accountId !== null);

  /** `quiet`: read again without taking the page away, as after an action or for the notice. */
  const load = useCallback((account: string, quiet: boolean) => {
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
    setNotice(null);
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
   */
  const run = async (action: ActionId, task: () => Promise<string | null>): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true;
    setRunning(action);
    setNotice(null);
    try {
      const text = await task();
      if (text !== null) setNotice({ action, kind: "done", text });
      return true;
    } catch (error) {
      console.error(error);
      setNotice({ action, kind: "failed", text: walletErrorMessage(error) });
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
      (events) =>
        eventOf(events, "deposit") === undefined
          ? "Tender sent the deposit back, so nothing was added. Check that it takes this token and that your account has storage to spare."
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

  const takeBackStorage = (available: bigint) =>
    send(
      "storage",
      async () => [storageWithdrawCall(config.contractId)],
      () => `Took back ${describeNear(available)} of unused storage.`,
    );

  const noticeFor = (action: ActionId) =>
    notice?.action === action ? <NoticeLine notice={notice} /> : null;

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">Wallet</h1>

      <section className="grid gap-2">
        <h2 ref={connection} tabIndex={-1} className="text-lg font-semibold">
          Connection
        </h2>
        {!ready ? (
          <p role="status">Checking for your wallet…</p>
        ) : accountId === null ? (
          <>
            <p>Connect a wallet to see your balances and move funds.</p>
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
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span>Connected as</span>
              <span data-testid="account-id" className="font-mono text-sm wrap-anywhere">
                {accountId}
              </span>
            </p>
            {canSignMessage ? null : (
              <p role="status" data-testid="cannot-sign" className="text-sm">
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
        <p role="status">Loading your balances…</p>
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
            onWithdraw={() => panel.data.storage && takeBackStorage(panel.data.storage.available)}
          />

          <BalancesSection rows={panel.data.rows} />

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
        </>
      )}
    </div>
  );
}
