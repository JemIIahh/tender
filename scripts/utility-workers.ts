import { requireNodeVersion } from "@tender/client";
import { exitWhenFlushed } from "../packages/agents/src/cli";
import { runUtilityWorkers } from "../packages/agents/src/services/worker-host";

requireNodeVersion();
let code = 0;
try {
  await runUtilityWorkers();
} catch {
  console.error(
    "Utility workers could not start. Check identity, scoped keys, persistent storage and testnet configuration.",
  );
  code = 1;
}
await exitWhenFlushed(code);
