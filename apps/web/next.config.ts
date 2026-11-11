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
      // The login's e2e suite (playwright.privy.config.ts) builds the app with Privy's kit replaced
      // by a stand-in (e2e/privy/kit.tsx): the real kit talks to Privy's servers, which a spec must
      // not reach. Only that suite sets TENDER_E2E_PRIVY_KIT, and only for its own dev server.
      ...(process.env.TENDER_E2E_PRIVY_KIT === "1"
        ? {
            "@privy-io/react-auth/extended-chains": "./e2e/privy/kit.tsx",
            "@privy-io/react-auth": "./e2e/privy/kit.tsx",
          }
        : {}),
    },
  },
};

export default config;
