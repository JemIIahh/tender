import { chown, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ApiClient, KeyPair, type KeyPairString, keyKindOf, TenderClient } from "@tender/client";
import { createStateStore } from "@tender/mcp";
import { AccountIdSchema, canonicalBase } from "@tender/shared";
import { createEntryCounts } from "../policy";
import { AgentMemory, agentTick, runAgent } from "../runner";
import { planAssistedImport } from "./assistance-planner";
import { createUtilityEscrowSolver, utilityRequest } from "./escrow";
import { createEscrowAssistedSolver } from "./escrow-assistance";

const CONTRACT = "tender.tender-dev-1104.testnet";
const TOKEN = "tusdc.tender-dev-1104.testnet";
const API = "https://tender-api-production-6c4b8458.up.railway.app";

/** Work keys by default; optional separate capped spending and acceptance keys. No owner key. */
export async function runUtilityWorkers(env: NodeJS.ProcessEnv = process.env) {
  if (
    env.TENDER_NETWORK !== "testnet" ||
    env.TENDER_CONTRACT !== CONTRACT ||
    canonicalBase(env.TENDER_API_URL ?? "") !== API
  )
    throw new Error("Worker deployment does not match the approved public testnet.");
  const directory = env.UTILITY_DATA_DIR ?? "/data/utility";
  if (!isAbsolute(directory))
    throw new Error("Worker state must use an absolute persistent directory.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // A fresh persistent mount is root-owned. Drop privileges before loading keys or starting work.
  if (process.getuid?.() === 0) {
    await chown(directory, 1000, 1000);
    process.setgid?.(1000);
    process.setuid?.(1000);
  }
  const rpcUrl = env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";
  const roles = [
    {
      role: "data-check",
      stem: "DATA_CHECK",
      name: "Data Check",
      tags: ["data-quality", "csv", "deduplication"],
    },
    {
      role: "import-planner",
      stem: "IMPORT_PLANNER",
      name: "Import Planner",
      tags: ["import-readiness"],
    },
  ] as const;
  const workers: Array<
    (typeof roles)[number] & {
      client: TenderClient;
      api: ApiClient;
      state: ReturnType<typeof createStateStore>;
      entryCounts: ReturnType<typeof createEntryCounts>;
    }
  > = [];
  for (const role of roles) {
    const accountId = env[`${role.stem}_ACCOUNT`];
    const privateKey = env[`${role.stem}_PRIVATE_KEY`];
    if (accountId !== `${role.role}.tender-dev-1104.testnet` || !privateKey)
      throw new Error("Worker identity is missing or unexpected.");
    const client = new TenderClient({
      network: "testnet",
      contractId: CONTRACT,
      rpcUrl,
      signer: { accountId, privateKey },
    });
    const publicKey = KeyPair.fromString(privateKey as KeyPairString)
      .getPublicKey()
      .toString();
    const access = await client.viewAccessKey(accountId, publicKey);
    if (!access || keyKindOf(access.permission, CONTRACT) !== "function_call")
      throw new Error("Hosted workers require scoped function-call keys.");
    const registered = await client.getAgent(accountId);
    if (registered?.status !== "active") throw new Error("Worker is not registered and active.");
    const stateDirectory = join(directory, role.role);
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    workers.push({
      ...role,
      client,
      api: new ApiClient({ baseUrl: API, signer: { accountId, privateKey } }),
      state: createStateStore(join(stateDirectory, "drafts")),
      entryCounts: createEntryCounts(join(stateDirectory, "entries.json")),
    });
  }
  const mode = env.UTILITY_ASSISTANCE_MODE ?? "";
  if (mode !== "" && mode !== "escrow") throw new Error("Unknown utility assistance mode.");
  const planner = workers.find((worker) => worker.role === "import-planner");
  let assisted: ReturnType<typeof createEscrowAssistedSolver> | undefined;
  let assistanceHealthy = true;
  if (mode === "escrow") {
    if (!planner) throw new Error("Import Planner is required for assistance.");
    const allowed = (value: string | undefined) => {
      if (!value?.trim()) throw new Error("Assistance requires explicit account allowlists.");
      return [...new Set(value.split(",").map((account) => AccountIdSchema.parse(account.trim())))];
    };
    const spenderKey = env.IMPORT_PLANNER_SPENDING_PRIVATE_KEY;
    const acceptanceKey = env.IMPORT_PLANNER_ACCEPTANCE_PRIVATE_KEY;
    const minProfit = env.UTILITY_ASSISTANCE_MIN_PROFIT;
    if (
      !spenderKey ||
      !acceptanceKey ||
      !minProfit ||
      !/^[0-9]+$/.test(minProfit) ||
      BigInt(minProfit) <= 0n
    )
      throw new Error("Assistance needs two scoped keys and a positive explicit minimum margin.");
    const scoped = (privateKey: string) =>
      new TenderClient({
        network: "testnet",
        contractId: CONTRACT,
        rpcUrl,
        signer: { accountId: planner.client.accountId as string, privateKey },
      });
    assisted = createEscrowAssistedSolver({
      worker: planner.client,
      spender: scoped(spenderKey),
      acceptor: scoped(acceptanceKey),
      api: planner.api,
      state: planner.state,
      journalDir: join(directory, "import-planner", "assistance"),
      token: TOKEN,
      posters: allowed(env.UTILITY_ASSISTANCE_POSTERS),
      verifiers: allowed(env.UTILITY_ASSISTANCE_VERIFIERS),
      minProfit: BigInt(minProfit),
      plan: planAssistedImport,
      services: [
        { capability: "csv-audit", serviceId: "1" },
        { capability: "duplicate-records", serviceId: "2" },
      ].map((service) => ({
        ...service,
        agent: "data-check.tender-dev-1104.testnet",
        provider: "tender-dev-1104.testnet",
        maxPrice: 100000n,
      })),
    });
    await assisted.ready(); // Refuse unsafe keys or incompatible journals before reporting healthy.
  }
  const port = Number(env.PORT ?? "8787");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid worker health port.");
  const stop = new AbortController();
  const onStop = () => stop.abort();
  process.once("SIGTERM", onStop);
  process.once("SIGINT", onStop);
  const server = createServer((request, response) => {
    if (request.url !== "/v1/health" || request.method !== "GET") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(stop.signal.aborted || !assistanceHealthy ? 503 : 200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(
      JSON.stringify({
        status: stop.signal.aborted ? "stopping" : assistanceHealthy ? "ok" : "degraded",
        network: "testnet",
        workers: workers.map((worker) => worker.name),
        solver: "deterministic",
        ai_requests: 0,
        assistance: assisted ? "escrow" : "disabled",
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  try {
    await Promise.all(
      workers.map(async (worker) => {
        const direct = createUtilityEscrowSolver(worker.role);
        const coordinator = worker.role === "import-planner" ? assisted : undefined;
        const options = {
          name: worker.name,
          client: worker.client,
          api: worker.api,
          state: worker.state,
          entryCounts: worker.entryCounts,
          tags: worker.tags,
          solver: coordinator
            ? {
                ...direct,
                solve: async (ctx: Parameters<typeof direct.solve>[0]) =>
                  utilityRequest(ctx.brief.instructions)?.operation === "import-readiness"
                    ? coordinator.solve(ctx)
                    : direct.solve(ctx),
              }
            : direct,
          signal: stop.signal,
          pollMs: 15_000,
          policy: {
            minReward: { [TOKEN]: 100_000n },
            verifiers: "any" as const,
            maxVoidsAfterReveals: 2,
            maxPosterVoids: 2,
            dailyEntries: 10,
            dailyJudgedHires: 10,
          },
        };
        if (!coordinator) return runAgent(options);
        const memory = new AgentMemory();
        while (!stop.signal.aborted) {
          try {
            await coordinator.tick();
            assistanceHealthy = true;
          } catch {
            assistanceHealthy = false;
            console.warn("Escrow assistance paused; inspect keys, chain and persistent journal.");
          }
          // Serial with the coordinator so draft replacement cannot race a runner commit/reveal.
          await agentTick({ ...options, memory });
          try {
            await sleep(5000, undefined, { signal: stop.signal });
          } catch {
            if (!stop.signal.aborted) throw new Error("Assistance polling failed.");
          }
        }
      }),
    );
  } finally {
    stop.abort();
    process.off("SIGTERM", onStop);
    process.off("SIGINT", onStop);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
