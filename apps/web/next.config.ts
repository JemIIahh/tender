import type { NextConfig } from "next";

const config: NextConfig = {
  // The workspace packages ship TypeScript source, so Next has to compile them.
  //
  // Import only `@tender/client/outcome` from this app, never the `@tender/client` root (P06-P3).
  // The root also exports the Node-only modules (near-sandbox and the near-api-js signing code),
  // and they must never reach the browser bundle. Use the shared `fetchJson` for every API call.
  // Biome enforces this with noRestrictedImports (see biome.json).
  transpilePackages: ["@tender/shared", "@tender/client"],

  // Without this, `next dev` writes an untracked AGENTS.md here whenever it detects an AI coding
  // agent. The Next.js docs it points to are in node_modules/next/dist/docs.
  agentRules: false,

  // No development indicator in the corner of the page: in a preview it covers the sidebar's foot.
  devIndicators: false,

  turbopack: {
    resolveAlias: {
      // Two Solana program clients that Privy's kit imports for its Solana funding screens, which
      // this app never shows: the installed versions need a newer @solana/kit than the one Privy
      // resolves to, and fail the build. lib/noSolana.ts stands in for both, in every build.
      "@solana-program/system": "./lib/noSolana.ts",
      "@solana-program/token": "./lib/noSolana.ts",
      // Privy's kit, the module lib/privyKit.tsx imports, as the build is for:
      ...privyKit(),
    },
  },
};

/**
 * Where Privy's kit comes from. The login's e2e suite (playwright.privy.config.ts) builds the app
 * with a stand-in (e2e/privy/kit.tsx), since the real kit talks to Privy's servers, which a spec
 * must not reach; only that suite sets TENDER_E2E_PRIVY_KIT. A build with no Privy app id has no
 * login, and gets lib/noPrivy.ts, so that it does not compile the kit for nothing. Next has read
 * the .env files by the time it reads this file. Any other build gets the kit itself.
 */
function privyKit(): Record<string, string> {
  const to = (file: string) => ({
    "@privy-io/react-auth/extended-chains": file,
    "@privy-io/react-auth": file,
  });
  if (process.env.TENDER_E2E_PRIVY_KIT === "1") return to("./e2e/privy/kit.tsx");
  if ((process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "").trim() === "") return to("./lib/noPrivy.ts");
  return {};
}

export default config;
