"use client";

import { ApiError, type ConnectImplicitAgents } from "@tender/shared";
import Link from "next/link";
import { useState } from "react";
import { readBondTerms } from "../../lib/account";
import { api } from "../../lib/api";
import { useApiToken } from "../../lib/auth";
import { bondOfTerms, madeImplicit, readAgentFunding } from "../../lib/connect";
import { errorMessage } from "../../lib/errors";
import { accountExists } from "../../lib/rpc";
import { useLoad } from "../../lib/useLoad";
import { useWallet } from "../../lib/wallet";
import { walletErrorMessage } from "../../lib/walletErrors";
import { CARD, EYEBROW, PANEL_TITLE, TEXT_LINK } from "../ui";
import { Chip } from "./parts";

// My agents' list of the agents the person set up as separate accounts: "Connect your agent" with
// "Use a separate account instead" gives the agent the implicit account of its own key, which the
// contract gives no provider, so the directory (and the list above, which goes by provider) does
// not show it under the person. The API keeps the person's own record of them
// (`GET /v1/connect/implicit`), which needs a sign-in; the page says that nothing on the chain links
// them to the person. One that never registered, and that nothing reached on the chain, can be
// dismissed: its record and its code go.

/** The words of an agent's status, as the index gives it. */
const STATUS: Record<string, { label: string; dot: string }> = {
  active: { label: "Active", dot: "bg-seal" },
  unregistering: { label: "Unregistering", dot: "bg-current" },
  retired: { label: "Retired", dot: "bg-current opacity-35" },
};

type Agents = ConnectImplicitAgents["agents"];

/** What the list read found: the agents, or a token the API no longer takes. */
type Found = Agents | "signed-out";

/** Whether anything reached `account` on the chain: the account itself, or storage or a bond with Tender. */
async function anythingLanded(account: string): Promise<boolean> {
  const [exists, terms] = await Promise.all([accountExists(account), readBondTerms()]);
  if (exists) return true;
  const funding = await readAgentFunding(account, bondOfTerms(terms));
  return funding.storage || funding.vault > 0n;
}

function List({
  agents,
  token,
  onChanged,
}: {
  agents: Agents;
  token: string;
  onChanged: () => void;
}) {
  // The row being dismissed, and what each refused dismissal said.
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<Record<string, string>>({});

  const dismiss = async (id: string, account: string) => {
    if (busy !== null) return;
    setBusy(id);
    setSaid((now) => ({ ...now, [id]: "" }));
    try {
      // The record is the only link to whatever reached the account: it is kept while anything did.
      if (await anythingLanded(account)) {
        setSaid((now) => ({
          ...now,
          [id]: "Something already reached this account, so its record is kept.",
        }));
        return;
      }
      await api.dismissImplicitAgent(token, id);
      onChanged();
    } catch (error) {
      console.error(error);
      setSaid((now) => ({
        ...now,
        [id]:
          error instanceof ApiError && error.status === 409
            ? "This agent has registered, so its record is kept."
            : `Couldn't dismiss it: ${errorMessage(error)}`,
      }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section data-testid="implicit-agents" className={`${CARD} grid overflow-hidden`}>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line px-5 py-4 sm:px-6">
        <h2 className={PANEL_TITLE}>Separate accounts</h2>
        <p className={EYEBROW}>Set up by you, not linked on chain</p>
      </div>
      <ul className="grid">
        {agents.map((entry) => {
          const status = entry.agent === null ? null : STATUS[entry.agent.status];
          const note = said[entry.id];
          return (
            <li
              key={entry.id}
              data-testid="implicit-agent"
              className="grid min-w-0 gap-2 border-t border-line px-5 py-4 first:border-t-0 sm:flex sm:items-center sm:justify-between sm:gap-6 sm:px-6"
            >
              <div className="grid min-w-0 gap-1">
                <p className="text-[15px] font-medium text-bone">{entry.name}</p>
                <Link
                  href={`/agents/${entry.account_id}`}
                  className={`${TEXT_LINK} min-w-0 text-[13px]`}
                >
                  <span className="font-mono wrap-anywhere">{entry.account_id}</span>
                </Link>
                {note ? (
                  <p
                    role="status"
                    data-testid="implicit-agent-note"
                    className="text-[13px] text-muted"
                  >
                    {note}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-3 text-bone">
                {status === undefined || status === null ? (
                  <>
                    <Chip dot="bg-dim">Not registered yet</Chip>
                    <button
                      type="button"
                      aria-disabled={busy !== null}
                      onClick={() => void dismiss(entry.id, entry.account_id)}
                      className={`${TEXT_LINK} text-[13px]`}
                    >
                      {busy === entry.id ? "Checking…" : "Dismiss"}
                    </button>
                  </>
                ) : (
                  <Chip dot={status.dot}>{status.label}</Chip>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The line that offers the sign-in which lists them: a message signed, nothing sent. */
function SignInLine({ expired }: { expired: boolean }) {
  const { signIn } = useApiToken();
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <p data-testid="implicit-agents-signin" className="text-sm text-muted">
      {expired
        ? "Your sign-in to Tender has ended, so the agents you set up as separate accounts aren't listed. "
        : "You set up an agent as a separate account here. "}
      <button
        type="button"
        onClick={() => {
          setFailed(null);
          signIn().catch((error: unknown) => {
            console.error(error);
            setFailed(walletErrorMessage(error) || errorMessage(error));
          });
        }}
        className={TEXT_LINK}
      >
        Sign in to Tender to list them
      </button>
      . It signs a message and costs nothing.
      {failed === null ? null : <span className="block text-seal">{failed}</span>}
    </p>
  );
}

/**
 * The person's agents on separate accounts, once they are signed in to Tender: nothing while there
 * are none. Signed out, one line offers the sign-in, only where it can find something (this tab saw
 * them set one up) or where a sign-in ended. A read that fails says so, with Retry.
 */
export function ImplicitAgents({ account }: { account: string }) {
  const wallet = useWallet();
  const { token } = useApiToken();
  const [state, retry] = useLoad<Found>(token === null ? null : `${account}:${token}`, async () => {
    if (token === null) return null;
    try {
      return (await api.implicitAgents(token)).agents;
    } catch (error) {
      // A token the API no longer takes is a sign-in that ended, not a failure.
      if (error instanceof ApiError && error.status === 401) return "signed-out";
      throw error;
    }
  });

  if (token === null) {
    return wallet.canSignMessage && madeImplicit(account) ? <SignInLine expired={false} /> : null;
  }
  if (state.status === "error") {
    return (
      <p role="alert" data-testid="implicit-agents-error" className="text-sm text-muted">
        Couldn't list the agents you set up as separate accounts.{" "}
        <button
          type="button"
          aria-disabled={state.retrying}
          onClick={state.retrying ? undefined : retry}
          className={TEXT_LINK}
        >
          {state.retrying ? "Retrying…" : "Retry"}
        </button>
      </p>
    );
  }
  if (state.status !== "ready") return null;
  if (state.data === "signed-out") {
    return wallet.canSignMessage ? <SignInLine expired /> : null;
  }
  if (state.data.length === 0) return null;
  return <List agents={state.data} token={token} onChanged={retry} />;
}
