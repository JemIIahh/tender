"use client";

import { getAccessToken, PrivyProvider, useLogin, useLogout, usePrivy } from "@privy-io/react-auth";
import {
  useCreateWallet,
  useExportWallet,
  useSignRawHash,
} from "@privy-io/react-auth/extended-chains";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { PrivyBridge, PrivyKit } from "./privy";

// Privy's React kit, mounted in a React root of its own at the end of the page, with one component
// under its provider that hands what the hooks give to the bridge (lib/privy.ts) on every render.
// The pages never see the kit: they use the wallet store, and this module is imported by
// lib/wallet.ts alone, when a page first needs the login, in a build with a Privy app id. Privy's
// own windows (the login, the key export) are drawn by the kit in this root.

/** The ink and the bone of the app's look (app/globals.css), for Privy's windows. */
const INK = "#0a0a0b";
const BONE = "#eeebe4";

function Bridge({ bridge }: { bridge: PrivyBridge }) {
  const { ready, authenticated, user } = usePrivy();
  const { login } = useLogin({
    onComplete: ({ user: done }) => bridge.loginEnded({ user: done }),
    onError: (error) => bridge.loginEnded({ error: String(error) }),
  });
  const { logout } = useLogout();
  const { createWallet } = useCreateWallet();
  const { signRawHash } = useSignRawHash();
  const { exportWallet } = useExportWallet();

  useEffect(() => {
    const kit: PrivyKit = {
      ready,
      authenticated,
      user,
      login: () => login(),
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
        // chooses them there (email and Google, which the app's own button names; docs/RUNBOOK.md).
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
