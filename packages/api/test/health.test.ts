import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
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
