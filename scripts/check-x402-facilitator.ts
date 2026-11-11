import { join } from "node:path";
import { requireNodeVersion } from "@tender/client";
import { REFERENCE_TESTNET_URL } from "@tender/payments";
import { envDir, readEnvFile } from "./lib/env";

requireNodeVersion();
const env = { ...readEnvFile(join(envDir(), ".env")), ...process.env };
if (env.X402_FACILITATOR_URL && env.X402_FACILITATOR_URL !== REFERENCE_TESTNET_URL)
  throw new Error("This check only contacts the explicit NEAR testnet reference instance.");
const supported = await fetch(`${REFERENCE_TESTNET_URL}/supported`, {
  redirect: "error",
  signal: AbortSignal.timeout(15000),
});
if (!supported.ok) throw new Error(`Facilitator discovery failed (HTTP ${supported.status}).`);
const metadata = (await supported.json()) as {
  kinds?: Array<{ x402Version?: number; scheme?: string; network?: string }>;
};
if (
  !metadata.kinds?.some(
    (kind) => kind.x402Version === 2 && kind.scheme === "exact" && kind.network === "near:testnet",
  )
)
  throw new Error("The facilitator does not advertise the required NEAR testnet exact scheme.");
const ready = await fetch(`${REFERENCE_TESTNET_URL}/readyz`, {
  redirect: "error",
  signal: AbortSignal.timeout(15000),
});
await ready.body?.cancel();
console.log(
  JSON.stringify({
    supported: true,
    ready: ready.status === 200,
    credentialConfigured: !!env.X402_FACILITATOR_API_KEY,
    credentialVerified: false,
    transactionsSent: 0,
    note: "Discovery only. Private read-only verification must precede enabling settlement.",
  }),
);
if (ready.status !== 200) process.exitCode = 1;
