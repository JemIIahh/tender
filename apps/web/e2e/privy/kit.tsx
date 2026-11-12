"use client";

import { type ReactNode, useEffect, useRef, useSyncExternalStore } from "react";

// A stand-in for Privy's React kit (`@privy-io/react-auth` and its `extended-chains` entry), for
// the login's e2e suite (playwright.privy.config.ts) only. The real kit talks to Privy's servers,
// which a spec must not reach, so that suite builds the app with these two module names pointing
// here (next.config.ts, under TENDER_E2E_PRIVY_KIT=1, which no other build sets). It has the hooks
// lib/privyKit.tsx uses, with Privy's shapes: an email login whose code is the one the spec set
// (`window.__tenderPrivyStub`; any other is Privy's "invalid_credentials"), a Google login that
// leaves the page and comes back to it with Privy's `privy_oauth_*` parameters (no Google is
// reached), a NEAR wallet at the address the spec set, and a login that lasts for the tab
// (sessionStorage), as Privy's lasts across a reload. It signs nothing: the specs that use it send
// no transaction.

interface StubSettings {
  address: string;
  login: "email" | "google";
  /** The code the email login takes. */
  code?: string;
  /** Privy's error code for every code sent, when the spec wants sending to fail. */
  sendFails?: string;
  /** "deny": the person turns the Google login down at "Google". */
  oauth?: "deny";
  /** How long the login takes to end once the page is back from "Google". */
  oauthDelayMs?: number;
}

/** The code the email login takes when the spec sets none. */
const CODE = "123456";

/** An error as Privy's hooks throw one: with its code. */
function privyError(code: string): Error {
  return Object.assign(new Error(code), { privyErrorCode: code });
}

interface LoginCallbacks {
  onComplete?: (params: { user: ReturnType<typeof userOf> }) => void;
  onError?: (error: string) => void;
}

const AUTHED = "tender.e2e.privy.authed";

function settings(): StubSettings {
  const set = (window as unknown as { __tenderPrivyStub?: StubSettings }).__tenderPrivyStub;
  if (set === undefined) throw new Error("the e2e kit needs window.__tenderPrivyStub");
  return set;
}

function userOf(stub: StubSettings) {
  return {
    id: "did:privy:e2e",
    linkedAccounts: [
      { type: stub.login === "google" ? "google_oauth" : "email" },
      { type: "wallet", chainType: "near", address: stub.address },
    ],
    ...(stub.login === "google" ? { google: { email: "x" } } : { email: { address: "x" } }),
  };
}

const listeners = new Set<() => void>();
let authed: boolean | null = null;

function isAuthed(): boolean {
  authed ??= sessionStorage.getItem(AUTHED) === "1";
  return authed;
}

function setAuthed(next: boolean): void {
  authed = next;
  if (next) sessionStorage.setItem(AUTHED, "1");
  else sessionStorage.removeItem(AUTHED);
  for (const listener of [...listeners]) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function PrivyProvider({ children }: { appId: string; children: ReactNode }) {
  return <>{children}</>;
}

export function usePrivy() {
  const authenticated = useSyncExternalStore(subscribe, isAuthed, () => false);
  return { ready: true, authenticated, user: authenticated ? userOf(settings()) : null };
}

export function useLoginWithEmail(callbacks: LoginCallbacks) {
  return {
    sendCode: async ({ email }: { email: string }) => {
      const fails = settings().sendFails;
      if (fails !== undefined) throw privyError(fails);
      if (!email.includes("@")) throw privyError("invalid_data");
    },
    loginWithCode: async ({ code }: { code: string }) => {
      if (code !== (settings().code ?? CODE)) {
        callbacks.onError?.("invalid_credentials");
        throw privyError("invalid_credentials");
      }
      setAuthed(true);
      callbacks.onComplete?.({ user: userOf(settings()) });
    },
    state: { status: "initial" },
  };
}

const OAUTH_PARAMS = ["privy_oauth_code", "privy_oauth_state", "privy_oauth_provider"];

export function useLoginWithOAuth(callbacks: LoginCallbacks) {
  const latest = useRef(callbacks);
  latest.current = callbacks;
  // Back from "Google": the parameters are read, taken off the address, and the login ends, as
  // Privy's hook does on the page the provider sends the person back to.
  useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("privy_oauth_code");
    if (code === null || url.searchParams.get("privy_oauth_state") === null) return;
    for (const name of OAUTH_PARAMS) url.searchParams.delete(name);
    window.history.replaceState({}, "", url);
    const end = () => {
      if (code === "denied") {
        latest.current.onError?.("oauth_user_denied");
        return;
      }
      setAuthed(true);
      latest.current.onComplete?.({ user: userOf(settings()) });
    };
    const delay = settings().oauthDelayMs ?? 0;
    if (delay > 0) setTimeout(end, delay);
    else end();
  }, []);
  return {
    // Leaves the page and comes back to it, as a Google login does, with no Google in between.
    initOAuth: async ({ provider }: { provider: string }) => {
      const url = new URL(window.location.href);
      url.searchParams.set("privy_oauth_code", settings().oauth === "deny" ? "denied" : "e2e-code");
      url.searchParams.set("privy_oauth_state", "e2e-state");
      url.searchParams.set("privy_oauth_provider", provider);
      window.location.assign(url);
    },
    loading: false,
    state: { status: "initial" },
  };
}

export function useLogout() {
  return { logout: async () => setAuthed(false) };
}

export async function getAccessToken(): Promise<string | null> {
  return isAuthed() ? "e2e-login-token" : null;
}

export function useCreateWallet() {
  return {
    createWallet: async () => ({
      user: userOf(settings()),
      wallet: { address: settings().address },
    }),
  };
}

export function useSignRawHash() {
  return {
    signRawHash: async (): Promise<{ signature: `0x${string}` }> => {
      throw new Error("the e2e kit signs nothing");
    },
  };
}

export function useExportWallet() {
  return { exportWallet: async () => {} };
}
