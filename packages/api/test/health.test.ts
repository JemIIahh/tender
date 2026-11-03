import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { type ApiDeps, createApp, type HealthResponse } from "../src/index";
import { fakeClient, resetDb, testDeps } from "./helpers";

// The index that `GET /v1/health` reports is the cursor of the deployment: `<network>:<contractId>`,
// the key the indexer keeps (`startIndexer`). The rest of the health route is tested in
// read.test.ts, limits.test.ts and schemas.test.ts.

let deps: ApiDeps;

beforeAll(async () => {
  deps = await testDeps();
});

afterAll(() => deps.db.close());

beforeEach(() => resetDb(deps.db));

async function setCursor(source: string, height: bigint): Promise<void> {
  await deps.db.query("insert into chain_cursor (source, height) values ($1, $2)", [
    source,
    height,
  ]);
}

/** The `indexed_height` and the `lag_blocks` that health gives, with the chain at height 1000. */
async function indexed(
  over: Partial<ApiDeps> = {},
): Promise<Pick<HealthResponse, "indexed_height" | "lag_blocks">> {
  const client = fakeClient({ finalHeight: async () => 1_000n });
  const res = await createApp({ ...deps, client, ...over }).request("/v1/health");
  expect(res.status).toBe(200);
  const { indexed_height, lag_blocks } = (await res.json()) as HealthResponse;
  return { indexed_height, lag_blocks };
}

test("health_reads_the_cursor_of_its_own_deployment", async () => {
  const own = `${deps.network}:${deps.contractId}`;
  await setCursor(own, 90n);
  expect(await indexed()).toEqual({ indexed_height: "90", lag_blocks: "910" });

  // Another deploy's cursor, further on or not, is not how far this one has got.
  await setCursor("sandbox:other.test.near", 500n);
  await setCursor("testnet:tender.test.near", 20n);
  expect(await indexed()).toEqual({ indexed_height: "90", lag_blocks: "910" });
});

test("health_follows_the_network_and_the_contract_it_is_given", async () => {
  await setCursor("sandbox:tender.test.near", 90n);
  await setCursor("testnet:other.testnet", 700n);
  expect(await indexed({ network: "testnet", contractId: "other.testnet" })).toEqual({
    indexed_height: "700",
    lag_blocks: "300",
  });
  // The same contract on another network has no cursor of its own.
  expect(await indexed({ network: "mainnet", contractId: "other.testnet" })).toEqual({
    indexed_height: "0",
    lag_blocks: "1000",
  });
});

test("health_says_nothing_is_indexed_when_only_other_deploys_have_a_cursor", async () => {
  await setCursor("sandbox:other.test.near", 500n);
  await setCursor(`${deps.network}:${deps.contractId}2`, 600n);
  expect(await indexed()).toEqual({ indexed_height: "0", lag_blocks: "1000" });
});

test("health_says_whether_the_services_are_waiting_for_the_chain", async () => {
  await setCursor(`${deps.network}:${deps.contractId}`, 90n);
  const client = fakeClient({ finalHeight: async () => 1_000n });
  let waiting = false;
  const app = createApp({ ...deps, client, waitingForChain: () => waiting });
  const read = async () => {
    const res = await app.request("/v1/health");
    expect(res.status).toBe(200);
    return (await res.json()) as HealthResponse;
  };

  // Nothing is waited for: the flag is false, and the fields a monitor already reads are as before.
  expect(await read()).toEqual({
    ok: true,
    network: deps.network,
    contract: deps.contractId,
    indexed_height: "90",
    chain_final_height: "1000",
    lag_blocks: "910",
    waiting_for_chain: false,
  });

  // While the services wait for the chain, the API is still up and still `ok`, and says so.
  waiting = true;
  expect(await read()).toMatchObject({
    ok: true,
    indexed_height: "90",
    lag_blocks: "910",
    waiting_for_chain: true,
  });
  waiting = false;
  expect((await read()).waiting_for_chain).toBe(false);

  // An app that is told nothing of the services is not waiting.
  const alone = createApp({ ...deps, client });
  expect(
    ((await (await alone.request("/v1/health")).json()) as HealthResponse).waiting_for_chain,
  ).toBe(false);

  // The answer of a chain that cannot be read carries it too.
  const down = fakeClient({
    finalHeight: async () => {
      throw new Error("down");
    },
  });
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    waiting = true;
    const unavailable = await createApp({
      ...deps,
      client: down,
      waitingForChain: () => waiting,
    }).request("/v1/health");
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      ok: false,
      error: "chain_unavailable",
      waiting_for_chain: true,
    });
  } finally {
    errors.mockRestore();
  }
});
