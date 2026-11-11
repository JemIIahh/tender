import { requireNodeVersion } from "@tender/client";
import { runLocalX402Example } from "../packages/payments/example/local";

// Local chain only. Deliberately does not load .env or accept a network/key argument.
requireNodeVersion();
await runLocalX402Example();
console.log("X402 DEMO OK (local NEAR chain)");
