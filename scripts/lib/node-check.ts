import { requireNodeVersion } from "@tender/client";

// The first import of each command in `scripts/` (`pnpm demo:local`, `pnpm serve`, the agent
// commands, the swarm demo): on a Node that Tender does not run on (`engines.node` in package.json),
// the command says so in one line and exits with 1 before the rest of it runs, and before it starts
// anything. By then the command's modules are loaded and linked, and `@tender/client` has run; the
// rest of the command has not.
requireNodeVersion();
