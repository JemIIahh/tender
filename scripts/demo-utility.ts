import { requireNodeVersion } from "@tender/client";
import { runDataQualityExample } from "../packages/payments/example/data-quality";

requireNodeVersion();
await runDataQualityExample();
console.log("UTILITY DEMO OK (local NEAR chain; public-data workload)");
