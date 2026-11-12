import { waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createPrivyBridge } from "../lib/privy";

// lib/privyKit.tsx mounts Privy's provider with the app's config. Privy's kit itself is replaced
// here by a provider that records the config it is given; the hooks give what a signed-out kit would.

const seen = vi.hoisted(() => ({ configs: [] as Array<Record<string, unknown>> }));

vi.mock("@privy-io/react-auth", () => ({
  PrivyProvider: ({
    children,
    config,
  }: {
    children: React.ReactNode;
    config: Record<string, unknown>;
  }) => {
    seen.configs.push(config);
    return children;
  },
  usePrivy: () => ({ ready: true, authenticated: false, user: null }),
  useLoginWithEmail: () => ({ sendCode: async () => {}, loginWithCode: async () => {} }),
  useLoginWithOAuth: () => ({ initOAuth: async () => {} }),
  useLogout: () => ({ logout: async () => {} }),
  getAccessToken: async () => null,
}));
vi.mock("@privy-io/react-auth/extended-chains", () => ({
  useCreateWallet: () => ({ createWallet: async () => ({}) }),
  useSignRawHash: () => ({ signRawHash: async () => ({}) }),
  useExportWallet: () => ({ exportWallet: async () => {} }),
}));

afterEach(() => {
  document.querySelector('[data-testid="privy-kit"]')?.remove();
});

test("google_is_sent_back_to_the_site_s_root_and_nowhere_else", async () => {
  const { mountPrivyKit } = await import("../lib/privyKit");
  const bridge = createPrivyBridge();
  mountPrivyKit(bridge, { appId: "cm0app1d", clientId: null });
  await waitFor(() => expect(seen.configs.length).toBeGreaterThan(0));
  // One fixed address, the one the owner lists in Privy's dashboard: the origin, which opens the
  // root (no trailing slash, which Privy's docs say a listed address may not have).
  expect(seen.configs[0]?.customOAuthRedirectUrl).toBe(window.location.origin);
  expect(window.location.origin).toBe("http://localhost:3000");
  // And the bridge has the kit.
  await waitFor(() => expect(bridge.kit().ready).toBe(true));
});
