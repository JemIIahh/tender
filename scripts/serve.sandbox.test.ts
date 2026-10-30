import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { type LocalChain, startLocalChain, TenderClient } from "@tender/client";
import type { SessionLock } from "@tender/db";
import { sha256Hex } from "@tender/shared";
import { KeyPair } from "near-api-js";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { addRoleKey } from "./keeper-key";
import { checkKeeperKey, type ServeOptions, type Services, startServices } from "./serve";

// The services process as `pnpm serve` starts it, against a local chain, with the index in an
// in-memory PGlite: the indexer on the RPC source, the API on a free port, and the keeper when its
// key is set. The keeper signs with the function-call key the key script mints, as on testnet. The
// sandbox prunes its old blocks after a minute or two, so each test starts its own services, from
// the chain's final height.

const REWARD = 1_000_000n;
const ENV_FILE = ".env.deploy.sandbox";

let chain: LocalChain;
let reader: TenderClient;
/** No deployment record is in it, so nothing in the repository says where the indexer starts. */
let deploymentsDir: string;
let keyDir: string;
/** The keeper's function-call key, as the key script wrote it. */
let keeperKey: string;
const running: Services[] = [];

beforeAll(async () => {
  chain = await startLocalChain();
  reader = new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
  });
  deploymentsDir = await mkdtemp(join(tmpdir(), "tender-serve-deployments-"));

  keyDir = await mkdtemp(join(tmpdir(), "tender-serve-keys-"));
  const { keeper } = chain.accounts;
  await writeFile(
    join(keyDir, ENV_FILE),
    [
      `TENDER_CONTRACT=${chain.contractId}`,
      `KEEPER_ACCOUNT=${keeper.accountId}`,
      `KEEPER_FULL_ACCESS_KEY=${keeper.privateKey}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await addRoleKey(
    "keeper",
    { network: chain.network, rpcUrl: chain.rpcUrl, contractId: chain.contractId },
    { dir: keyDir, log: () => undefined },
  );
  const { KEEPER_PRIVATE_KEY } = parseEnv(await readFile(join(keyDir, ENV_FILE), "utf8"));
  if (KEEPER_PRIVATE_KEY === undefined) {
    throw new Error("the key script did not write KEEPER_PRIVATE_KEY");
  }
  keeperKey = KEEPER_PRIVATE_KEY;
});

afterAll(async () => {
  await Promise.all(running.map((services) => services.stop()));
  await chain?.stop();
  for (const dir of [deploymentsDir, keyDir]) {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What `pnpm serve` reads for this chain, with `extra` on top. */
function envFor(extra: Record<string, string> = {}): Record<string, string> {
  return {
    TENDER_NETWORK: "sandbox",
    TENDER_CONTRACT: chain.contractId,
    NEAR_RPC_URL: chain.rpcUrl,
    DATABASE_URL: "pglite:memory",
    API_PORT: "0",
    INDEXER_POLL_MS: "100",
    ...extra,
  };
}

/** The keeper's variables: its account, the scoped key, and a short interval. */
const keeperEnv = (intervalMs: number) => ({
  KEEPER_ACCOUNT: chain.accounts.keeper.accountId,
  KEEPER_PRIVATE_KEY: keeperKey,
  KEEPER_INTERVAL_MS: String(intervalMs),
});

/** Starts the services, with their lines in `lines`, and stops them after the file if a test does not. */
async function serve(
  env: Record<string, string>,
  lines: string[],
  over: ServeOptions = {},
): Promise<Services> {
  const services = await startServices(env, {
    deploymentsDir,
    log: (line) => lines.push(line),
    ...over,
  });
  running.push(services);
  return services;
}

interface Health {
  ok: boolean;
  network: string;
  contract: string;
  indexed_height: string;
  chain_final_height: string;
  lag_blocks: string;
}

async function health(url: string): Promise<{ status: number; body: Health }> {
  const res = await fetch(`${url}/v1/health`);
  return { status: res.status, body: (await res.json()) as Health };
}

/** Waits until `check` holds, looking every 100 ms, and fails the test after `ms`. */
async function until(what: string, check: () => Promise<boolean>, ms: number): Promise<void> {
  const giveUpAt = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > giveUpAt) throw new Error(`timed out waiting until ${what}`);
    await sleep(100);
  }
}

/** Whether `url`'s port takes a connection, on the loopback address. */
function takesConnections(url: string): Promise<boolean> {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: Number(port) });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
  });
}

test("serve_boots_with_pglite_and_reports_health", async () => {
  const lines: string[] = [];
  const services = await serve(envFor(), lines);
  // With no PUBLIC_API_URL, the sandbox API is called at the loopback address on its port.
  expect(services.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(services.publicUrl).toBe(services.url);

  // Within 10 s the index is following the chain: a block is applied and the lag is small.
  let last: { status: number; body: Health } | undefined;
  await until(
    "the API reports a healthy index",
    async () => {
      last = await health(services.url);
      return last.status === 200 && last.body.ok && BigInt(last.body.lag_blocks) < 20n;
    },
    10_000,
  );
  expect(last?.body).toMatchObject({ ok: true, network: "sandbox", contract: chain.contractId });
  expect(BigInt(last?.body.indexed_height ?? "0")).toBeGreaterThan(0n);
  expect(BigInt(last?.body.lag_blocks ?? "20")).toBeLessThan(20n);
  // Nothing was asked of a keeper, and none runs.
  expect(lines).toContain("serve: keeper off (KEEPER_PRIVATE_KEY is not set)");

  await services.stop();
});

test("serve_starts_the_keeper_when_its_key_is_set", async () => {
  const lines: string[] = [];
  const services = await serve(envFor(keeperEnv(500)), lines);
  expect(lines).toContain(`serve: keeper on, as ${chain.accounts.keeper.accountId}`);

  // A task nobody enters, with the shortest windows: once its reveal window is over with nothing
  // revealed, the keeper voids it, signing with the scoped key. Nobody else here calls void_task.
  const poster = new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
    signer: chain.accounts.poster,
  });
  await poster.deposit(chain.tokenId, REWARD);
  const { taskId } = await poster.postTask({
    token: chain.tokenId,
    reward: REWARD,
    briefUri: "serve://brief",
    briefHash: sha256Hex("brief"),
    criteriaHash: sha256Hex("criteria"),
    verifier: chain.accounts.judge.accountId,
    commitSecs: 5,
    revealSecs: 5,
    pickSecs: 5,
    fallbackSecs: 5,
  });

  await until(
    `the keeper voids task ${taskId}`,
    async () => (await reader.getTask(taskId))?.outcome != null,
    60_000,
  );
  expect((await reader.getTask(taskId))?.outcome).toMatchObject({
    kind: "voided",
    reason: "no_reveals",
  });
  await until(
    "the keeper logs the void",
    async () => lines.includes(`keeper: voided task ${taskId}`),
    10_000,
  );
  expect(lines.filter((line) => line.startsWith("ERROR"))).toEqual([]);

  await services.stop();
});

test("the_keeper_key_check_reads_what_the_node_says_of_each_key", async () => {
  // The check that guards the keeper off the sandbox, against the RPC's own answers: the scoped
  // key the key script added is taken, and the account's full-access key and a key it does not
  // have are refused.
  const accountId = chain.accounts.keeper.accountId;
  const keeper = (privateKey: string) => ({ accountId, privateKey, intervalMs: undefined });
  await expect(
    checkKeeperKey(reader, keeper(keeperKey), chain.contractId),
  ).resolves.toBeUndefined();
  await expect(
    checkKeeperKey(reader, keeper(chain.accounts.keeper.privateKey), chain.contractId),
  ).rejects.toThrow(/^KEEPER_PRIVATE_KEY is a full-access key of keeper\.sandbox /);
  await expect(
    checkKeeperKey(reader, keeper(KeyPair.fromRandom("ed25519").toString()), chain.contractId),
  ).rejects.toThrow(/^KEEPER_PRIVATE_KEY is not a key of keeper\.sandbox /);
});

test("the_keeper_and_the_indexer_wait_together_for_the_lock", async () => {
  // Another process holds the lock until `free` is set: then this one takes it, and starts the
  // indexer and the keeper together, so that only one process sends the keeper's calls.
  let free = false;
  const release = vi.fn(async () => undefined);
  const held: SessionLock = { lost: new AbortController().signal, release };
  const tryLock = vi.fn(async () => (free ? held : null));
  const lines: string[] = [];
  const services = await serve(envFor(keeperEnv(500)), lines, { tryLock });

  expect(lines).toContain(
    "indexer: another services process holds the indexer lock; serving the API, and starting " +
      "the indexer and the keeper once the lock is free",
  );
  expect(lines.filter((line) => line.startsWith("serve: keeper on"))).toEqual([]);
  // The API serves meanwhile, with nothing indexed.
  const waiting = await health(services.url);
  expect(waiting.status).toBe(200);
  expect(waiting.body.indexed_height).toBe("0");

  free = true;
  await until(
    "the indexer applies a block",
    async () => BigInt((await health(services.url)).body.indexed_height) > 0n,
    20_000,
  );
  expect(lines).toContain("indexer: took the indexer lock; started the indexer and the keeper");
  expect(lines).toContain(`serve: keeper on, as ${chain.accounts.keeper.accountId}`);

  await services.stop();
  expect(release).toHaveBeenCalledTimes(1);
  expect(lines.at(-1)).toBe("serve: stopped");
});

test("stop_leaves_the_port_closed_and_every_loop_resolved", async () => {
  const lines: string[] = [];
  const services = await serve(envFor(keeperEnv(100)), lines, { closeGraceMs: 300 });
  await until(
    "the indexer applies a block",
    async () => BigInt((await health(services.url)).body.indexed_height) > 0n,
    10_000,
  );

  // An event stream that the client keeps open and never reads: only the cut after the grace
  // ends it, and stop() must not wait for it to end by itself.
  const stream = await fetch(`${services.url}/v1/events`);
  expect(stream.status).toBe(200);
  expect(await takesConnections(services.url)).toBe(true);

  const errors = vi.spyOn(console, "error");
  try {
    const started = Date.now();
    const stopping = services.stop();
    // Stopping again is the same stop.
    expect(services.stop()).toBe(stopping);
    await stopping;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(lines.at(-1)).toBe("serve: stopped");

    // The port takes no connection, and the stream that was open has ended.
    expect(await takesConnections(services.url)).toBe(false);
    await expect(stream.text()).rejects.toThrow();

    // Every loop has ended. Each of them reads the database, which stop() closed last, so one that
    // still ran would fail and say so: the indexer on the next block, the keeper within 100 ms,
    // an event stream within a second.
    const after = lines.length;
    await sleep(2_000);
    expect(lines.slice(after)).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  } finally {
    errors.mockRestore();
  }
});
