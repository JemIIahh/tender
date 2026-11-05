"use client";

import type { ConnectImplicitAgents } from "@tender/shared";
import Link from "next/link";
import { useState } from "react";
import { api } from "../../lib/api";
import { useApiToken } from "../../lib/auth";
import { errorMessage } from "../../lib/errors";
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
// them to the person.

/** The words of an agent's status, as the index gives it. */
const STATUS: Record<string, { label: string; dot: string }> = {
  active: { label: "Active", dot: "bg-seal" },
  unregistering: { label: "Unregistering", dot: "bg-current" },
  retired: { label: "Retired", dot: "bg-current opacity-35" },
};

type Agents = ConnectImplicitAgents["agents"];

function List({ agents }: { agents: Agents }) {
  return (
    <section data-testid="implicit-agents" className={`${CARD} grid overflow-hidden`}>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line px-5 py-4 sm:px-6">
        <h2 className={PANEL_TITLE}>Separate accounts</h2>
        <p className={EYEBROW}>Set up by you, not linked on chain</p>
      </div>
      <ul className="grid">
        {agents.map((entry) => {
          const status = entry.agent === null ? null : STATUS[entry.agent.status];
          return (
            <li
              key={entry.account_id}
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
              </div>
              <span className="text-bone">
                {status === undefined || status === null ? (
                  <Chip dot="bg-dim">Not registered yet</Chip>
                ) : (
                  <Chip dot={status.dot}>{status.label}</Chip>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The person's agents on separate accounts, once they are signed in to Tender: nothing while there
 * are none. Signed out, one line offers the sign-in, which signs a message and sends nothing.
 */
export function ImplicitAgents({ account }: { account: string }) {
  const wallet = useWallet();
  const { token, signIn } = useApiToken();
  const [failed, setFailed] = useState<string | null>(null);
  const [state] = useLoad(token === null ? null : `${account}:${token}`, () =>
    token === null ? Promise.resolve(null) : api.implicitAgents(token),
  );

  if (token === null) {
    if (!wallet.canSignMessage) return null;
    return (
      <p data-testid="implicit-agents-signin" className="text-sm text-muted">
        Set up an agent as a separate account?{" "}
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
          Sign in to Tender to list it
        </button>
        . It signs a message and costs nothing.
        {failed === null ? null : <span className="block text-seal">{failed}</span>}
      </p>
    );
  }
  if (state.status !== "ready" || state.data.agents.length === 0) return null;
  return <List agents={state.data.agents} />;
}
