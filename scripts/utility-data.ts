import { requireNodeVersion } from "@tender/client";
import { dataQualityMain } from "../packages/agents/example/data-quality-cli";

requireNodeVersion();
try {
  await dataQualityMain(process.argv.slice(2));
} catch {
  console.error(
    "Data Quality command failed. Check the input, manifest and required configuration; no credentials are logged.",
  );
  process.exitCode = 1;
}
