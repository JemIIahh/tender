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
};

export default config;
