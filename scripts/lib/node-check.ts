import { requireNodeVersion } from "@tender/client";

// The first import of each command in `scripts/` (`pnpm demo:local`, `pnpm serve`, the agent
// commands, the swarm demo): on a Node older than Tender needs, the command says so in one line and
// exits with 1 before the rest of it is loaded, and before it starts anything.
requireNodeVersion();
