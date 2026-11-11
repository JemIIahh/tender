"use client";

import { type ReactNode, useSyncExternalStore } from "react";

// A stand-in for Privy's React kit (`@privy-io/react-auth` and its `extended-chains` entry), for
// the login's e2e suite (playwright.privy.config.ts) only. The real kit talks to Privy's servers,
// which a spec must not reach, so that suite builds the app with these two module names pointing
// here (next.config.ts, under TENDER_E2E_PRIVY_KIT=1, which no other build sets). It has the hooks
// lib/privyKit.tsx uses, with Privy's shapes: a login that succeeds at once as the person the spec
// set (`window.__tenderPrivyStub`), a NEAR wallet at the address the spec set, and a login that
// lasts for the tab (sessionStorage), as Privy's lasts across a reload. It signs nothing: the
// specs that use it send no transaction.

interface StubSettings {
  address: string;
  login: "email" | "google";
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

export function useLogin(callbacks: {
  onComplete?: (params: { user: ReturnType<typeof userOf> }) => void;
  onError?: (error: string) => void;
}) {
  return {
    login: () => {
      setAuthed(true);
      callbacks.onComplete?.({ user: userOf(settings()) });
    },
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
