import { mkdir, writeFile } from "node:fs/promises";
import { requireNodeVersion } from "@tender/client";
import { runServiceAssistedTaskExample } from "../packages/payments/example/task";

requireNodeVersion();
// Local chain only. No .env, public deployment, paid inference, or caller-selected network.
const report = await runServiceAssistedTaskExample();
await mkdir(".tender/x402-task", { recursive: true, mode: 0o700 });
await writeFile(".tender/x402-task/report.json", `${JSON.stringify(report, null, 2)}\n`, {
  mode: 0o600,
});
console.log("X402 TASK DEMO OK (local NEAR chain)");
