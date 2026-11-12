"use client";

import {
  getAccessToken,
  PrivyProvider,
  useLoginWithEmail,
  useLoginWithOAuth,
  useLogout,
  usePrivy,
} from "@privy-io/react-auth";
import {
  useCreateWallet,
  useExportWallet,
  useSignRawHash,
} from "@privy-io/react-auth/extended-chains";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { PrivyBridge, PrivyKit, PrivyUser } from "./privy";

// Privy's React kit, mounted in a React root of its own at the end of the page, with one component
// under its provider that hands what the hooks give to the bridge (lib/privy.ts) on every render.
// The pages never see the kit: they use the wallet store, and this module is imported by
// lib/wallet.ts alone, when a page first needs the login, in a build with a Privy app id. The login
// is Tender's own window, over Privy's headless hooks; Privy's own window here is the key export's.

/** The ink and the bone of the app's look (app/globals.css), for Privy's windows. */
const INK = "#0a0a0b";
const BONE = "#eeebe4";

function Bridge({ bridge }: { bridge: PrivyBridge }) {
  const { ready, authenticated, user } = usePrivy();
  const ended = {
    onComplete: ({ user: done }: { user: PrivyUser }) => bridge.loginEnded({ user: done }),
    onError: (error: unknown) => bridge.loginEnded({ error: String(error) }),
  };
  const { sendCode, loginWithCode } = useLoginWithEmail(ended);
  // On every page: back from Google, this hook is what ends the login, on the page it started on.
  const { initOAuth } = useLoginWithOAuth(ended);
  const { logout } = useLogout();
  const { createWallet } = useCreateWallet();
  const { signRawHash } = useSignRawHash();
  const { exportWallet } = useExportWallet();

  useEffect(() => {
    const kit: PrivyKit = {
      ready,
      authenticated,
      user,
      sendCode: (input) => sendCode(input),
      loginWithCode: (input) => loginWithCode(input),
      initOAuth: (input) => initOAuth(input),
      logout,
      createWallet: (input) => createWallet(input),
      signRawHash: (input) => signRawHash(input),
      exportWallet: (input) => exportWallet(input),
      getAccessToken,
    };
    bridge.publish(kit);
  });
  return null;
}

/** Mounts the kit for the app `appId` and hands its hooks to `bridge`. Once per page. */
export function mountPrivyKit(
  bridge: PrivyBridge,
  { appId, clientId }: { appId: string; clientId: string | null },
): void {
  const host = document.createElement("div");
  host.dataset.testid = "privy-kit";
  document.body.append(host);
  createRoot(host).render(
    <PrivyProvider
      appId={appId}
      {...(clientId === null ? {} : { clientId })}
      config={{
        // No `loginMethods` here: a value here would override the dashboard's, and the owner
        // chooses them there (email and Google, which the app's Connect window offers;
        // docs/RUNBOOK.md).
        appearance: { theme: INK, accentColor: BONE, showWalletLoginFirst: false },
        // NEAR's wallet is made by the bridge (`createWallet({ chainType: "near" })`), and no
        // other chain's wallet is made at all.
        embeddedWallets: {
          ethereum: { createOnLogin: "off" },
          solana: { createOnLogin: "off" },
        },
      }}
    >
      <Bridge bridge={bridge} />
    </PrivyProvider>,
  );
}
