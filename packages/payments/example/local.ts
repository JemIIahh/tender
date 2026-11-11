import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { ApiClient, registerLocalAgent, startLocalChain, TenderClient } from "@tender/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { createFacilitatorNearSigner } from "@x402/near";
import { ExactNearScheme } from "@x402/near/exact/facilitator";
import { startServices } from "../../../scripts/serve";
import {
  createClientNearSigner,
  createX402ServiceHandler,
  purchaseX402Service,
} from "../src/index";

/** Team-owned example: real local NEAR settlement. No public RPC, AI, or paid provider. */
export async function runLocalX402Example(log: (line: string) => void = console.log) {
  const work = await mkdtemp(join(tmpdir(), "tender-x402-local-"));
  const chain = await startLocalChain({ minWindowSecs: 5 });
  let services: Awaited<ReturnType<typeof startServices>> | undefined;
  let server: ReturnType<typeof serve> | undefined;
  try {
    services = await startServices(
      {
        TENDER_NETWORK: "sandbox",
        TENDER_CONTRACT: chain.contractId,
        NEAR_RPC_URL: chain.rpcUrl,
        DATABASE_URL: "pglite:memory",
        API_PORT: "0",
        INDEXER_POLL_MS: "100",
      },
      { deploymentsDir: join(work, "deployments"), log: () => {} },
    );
    await registerLocalAgent(chain, "alice", ["data"]);
    await registerLocalAgent(chain, "bob", ["data"]);
    const { alice: buyer, bob: provider, owner: relayer } = chain.accounts;
    const reader = new TenderClient({
      network: "sandbox",
      contractId: chain.contractId,
      rpcUrl: chain.rpcUrl,
    });
    const api = new ApiClient({ baseUrl: services.publicUrl, signer: provider });
    const until = async (check: () => Promise<boolean>) => {
      const end = Date.now() + 30_000;
      while (!(await check())) {
        if (Date.now() > end) throw new Error("Local index did not catch up.");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    await until(async () => (await api.getAgent(provider.accountId))?.agent.status === "active");
    let handler: (request: Request) => Promise<Response> = async () =>
      new Response(null, { status: 503 });
    let port = 0;
    await new Promise<void>((resolve) => {
      server = serve(
        { hostname: "127.0.0.1", port: 0, fetch: (request) => handler(request) },
        (address) => {
          port = address.port;
          resolve();
        },
      );
    });
    const endpoint = `http://127.0.0.1:${port}/inventory`;
    const { service } = await api.createService({
      agent: provider.accountId,
      title: "Tender team inventory API",
      description: "Counts items in boxes. Local demonstration run by the Tender team.",
      tags: ["data"],
      category: "other",
      output_format: "json",
      token: chain.tokenId,
      price: "1000",
      payment_mode: "x402",
      x402: {
        endpoint,
        network: "near:testnet",
        pay_to: provider.accountId,
        max_timeout_seconds: 60,
      },
      verification: { kind: "none" },
      commit_secs: 0,
      reveal_secs: 0,
      pick_secs: 0,
    });
    assert.equal(service.payment_mode, "x402");
    assert.equal(
      (await api.listServices({ agent: provider.accountId })).services[0]?.id,
      service.id,
    );
    // The public CAIP-2 scheme is exercised against an explicitly overridden LOCAL RPC only.
    const rpcUrls = { "near:testnet": chain.rpcUrl };
    const facilitator = new x402Facilitator().register(
      "near:testnet",
      new ExactNearScheme(
        createFacilitatorNearSigner({
          relayers: [
            { accountId: relayer.accountId, secretKey: relayer.privateKey as `ed25519:${string}` },
          ],
          rpcUrls,
        }),
      ),
    );
    let responses = 0;
    let settlements = 0;
    handler = createX402ServiceHandler({
      service,
      allowLocalHttp: true,
      stateFile: join(work, "asp-payments.json"),
      facilitator: {
        verify: (payload, requirements) => facilitator.verify(payload, requirements),
        settle: (payload, requirements) => {
          settlements += 1;
          return facilitator.settle(payload, requirements);
        },
      },
      async respond(input) {
        const values = input as { boxes: number; itemsPerBox: number };
        assert.ok(Number.isSafeInteger(values.boxes) && Number.isSafeInteger(values.itemsPerBox));
        responses += 1;
        return { items: values.boxes * values.itemsPerBox, provider: provider.accountId };
      },
    });
    const unpaid = await fetch(endpoint, { method: "POST" });
    assert.equal(unpaid.status, 402);
    assert.equal(responses, 0);
    await unpaid.body?.cancel();
    log("Unpaid request: HTTP 402; API result withheld.");
    const wallet = (accountId: string) =>
      reader.view<string>(chain.tokenId, "ft_balance_of", { account_id: accountId });
    const buyerBefore = BigInt(await wallet(buyer.accountId));
    const providerBefore = BigInt(await wallet(provider.accountId));
    const buyerVaultBefore = await reader.balanceOf(buyer.accountId, chain.tokenId);
    const providerVaultBefore = await reader.balanceOf(provider.accountId, chain.tokenId);
    const taskCountBefore = await reader.view(chain.contractId, "get_tasks", {
      from_id: "0",
      limit: 50,
    });
    const options = {
      payer: buyer.accountId,
      asset: chain.tokenId,
      signer: createClientNearSigner({
        accountId: buyer.accountId,
        secretKey: buyer.privateKey as `ed25519:${string}`,
        rpcUrls,
      }),
      requestId: "local-inventory-1",
      maxPrice: "1000",
      totalBudget: "1000",
      budgetFile: join(work, "buyer-budget.json"),
      allowedOrigins: [new URL(endpoint).origin],
      allowLocalHttp: true,
    };
    const delivery = await purchaseX402Service(service, { boxes: 3, itemsPerBox: 4 }, options);
    assert.deepEqual(delivery.body, { items: 12, provider: provider.accountId });
    assert.equal(delivery.settlement.success, true);
    const repeated = await purchaseX402Service(service, { boxes: 3, itemsPerBox: 4 }, options);
    assert.deepEqual(repeated, delivery);
    assert.equal(settlements, 1);
    assert.equal(responses, 1);
    assert.equal(BigInt(await wallet(buyer.accountId)), buyerBefore - 1000n);
    assert.equal(BigInt(await wallet(provider.accountId)), providerBefore + 1000n);
    assert.equal(await reader.balanceOf(buyer.accountId, chain.tokenId), buyerVaultBefore);
    assert.equal(await reader.balanceOf(provider.accountId, chain.tokenId), providerVaultBefore);
    assert.deepEqual(
      await reader.view(chain.contractId, "get_tasks", { from_id: "0", limit: 50 }),
      taskCountBefore,
    );
    await assert.rejects(
      () => purchaseX402Service(service, {}, { ...options, requestId: "over-budget" }),
      /budget exhausted/,
    );
    log("Buyer paid 1,000 atomic test-token units; ASP wallet received exactly 1,000.");
    log("Received { items: 12 }; retry charged nothing; next purchase blocked by budget.");
    log("Tender vaults and task count unchanged. No public testnet, AI or FastNEAR requests.");
    return {
      passed: true,
      amount: "1000",
      settlements,
      responses,
      transaction: delivery.settlement.transaction,
    };
  } finally {
    if (server) {
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await services?.stop();
    await chain.stop();
    await rm(work, { recursive: true, force: true });
  }
}
