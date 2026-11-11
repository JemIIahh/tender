import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLlmServiceSolver, createModelCallBudget } from "@tender/agents";
import { requireNodeVersion } from "@tender/client";
import { runServiceAssistedTaskExample } from "../packages/payments/example/task";
import { envDir, readEnvFile } from "./lib/env";

requireNodeVersion();
const settings = { ...readEnvFile(join(envDir(), ".env")), ...process.env };
// Any OpenAI-compatible chat completions API: LLM_BASE_URL (its base, such as
// https://example.com/v1), LLM_MODEL and LLM_API_KEY, from .env or the environment.
const baseUrl = settings.LLM_BASE_URL?.trim() ?? "";
const model = settings.LLM_MODEL?.trim() ?? "";
const apiKey = settings.LLM_API_KEY?.trim() ?? "";
let base: URL;
try {
  base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
} catch {
  throw new Error(
    "Set LLM_BASE_URL to an OpenAI-compatible API's base URL. No inference request was sent.",
  );
}
if (base.protocol !== "https:" && base.hostname !== "127.0.0.1" && base.hostname !== "localhost")
  throw new Error(
    "LLM_BASE_URL must be https (or a local address). No inference request was sent.",
  );
// The solver's own rule, here too, so that --check refuses what --run would.
if (base.username || base.password || base.search || base.hash)
  throw new Error(
    "LLM_BASE_URL cannot hold credentials, a query or a fragment. No inference request was sent.",
  );
if (model === "" || apiKey === "")
  throw new Error("Set LLM_MODEL and LLM_API_KEY. No inference request was sent.");
// The one address the demo may call: the solver posts to <LLM_BASE_URL>/chat/completions.
const completions = new URL("chat/completions", base).href;
const plan = {
  network: "sandbox",
  modelApi: base.origin,
  model,
  maxRequests: 2,
  maxOutputTokensPerRequest: 2000,
  maxInputBytes: 32768,
  publicTransactions: 0,
};
console.log(JSON.stringify(plan));
if (process.argv[2] === "--check") process.exit(0);
if (process.argv[2] !== "--run")
  throw new Error("Use --check (no inference) or --run (at most two model requests).");
const nameFlag = process.argv.indexOf("--run-name");
const runName = nameFlag === -1 ? "default" : process.argv[nameFlag + 1];
if (!runName || !/^[a-z0-9-]{1,40}$/.test(runName))
  throw new Error("A run name must contain 1–40 lowercase letters, digits or hyphens.");
// A new name deliberately authorizes a separate bounded evaluation. Never generated automatically.
const directory = runName === "default" ? ".tender/x402-llm" : join(".tender/x402-llm", runName);
await mkdir(directory, { recursive: true, mode: 0o700 });
const budget = createModelCallBudget(join(directory, "model-budget.json"), plan.maxRequests);
const requests: Array<{ status: number; usage?: unknown }> = [];
const transport: typeof fetch = async (url, init) => {
  if (String(url) !== completions) throw new Error("Unapproved inference endpoint.");
  const response = await fetch(url, init);
  const record = {
    status: response.status,
    usage: response.ok ? ((await response.clone().json()) as { usage?: unknown }).usage : undefined,
  };
  requests.push(record);
  await writeFile(
    join(directory, "usage.json"),
    `${JSON.stringify({ ...plan, requests }, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(`MODEL: request ${requests.length}/${plan.maxRequests}, HTTP ${response.status}`);
  return response;
};
const report = await runServiceAssistedTaskExample(console.log, {
  solverFactory: (options) =>
    createLlmServiceSolver({
      ...options,
      name: "Tender team model service buyer",
      llm: {
        baseUrl,
        apiKey,
        model,
        maxOutputTokens: plan.maxOutputTokensPerRequest,
        timeoutMs: 30000,
        budget,
        fetch: transport,
      },
    }),
  modelCalls: () => requests.length,
});
await writeFile(join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, {
  mode: 0o600,
});
console.log("LLM X402 TASK DEMO OK (local NEAR chain, real model decisions)");
