import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { type LocalChain, type LocalRole, startLocalChain, TenderClient } from "@tender/client";
import { type Db, migrate, openDb } from "@tender/db";
import { createRpcSource, runIndexer } from "@tender/indexer";
import { computeCommitment, randomSalt, sha256Hex } from "@tender/shared";
import { afterAll, beforeAll, expect, test } from "vitest";
import { addRoleKey } from "../../../scripts/keeper-key";
import { type KeeperChain, keeperTick } from "../src/keeper";

// One local chain for the file, and the indexer running on it from before the first task, so that
// the database the keeper reads is the one `pnpm serve` would give it. The keeper signs as the
// chain's keeper account with the function-call key the key script mints: limited to `void_task`
// and `cleanup`, which are all it needs. The windows are the shortest the chain takes, 5 s, so a
// task is expired within seconds; the sandbox prunes its old blocks after a minute or two, so the
// indexer is never stopped while a test runs.

const REWARD = 1_000_000n;
const ENV_FILE = ".env.deploy.sandbox";

let chain: LocalChain;
let reader: TenderClient;
let db: Db;
let keeper: TenderClient;
let keyDir: string;
const stopIndexer = new AbortController();
let indexer: Promise<void>;
/** Set if the indexer stops before the tests are done: nothing after that would be indexed. */
let indexerFailure: unknown;

const clientOf = (role: LocalRole) =>
  new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
    signer: chain.accounts[role],
  });

beforeAll(async () => {
  // Alice and bob enter an open task, so they are registered agents, with a bond, before it.
  chain = await startLocalChain({ registerAgents: ["alice", "bob"] });
  reader = new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
  });

  // The keeper's key: made by the script, from an env file like the deploy's, and read back from it.
  keyDir = await mkdtemp(join(tmpdir(), "tender-keeper-"));
  const { keeper: account } = chain.accounts;
  await writeFile(
    join(keyDir, ENV_FILE),
    [
      `TENDER_CONTRACT=${chain.contractId}`,
      `KEEPER_ACCOUNT=${account.accountId}`,
      `KEEPER_FULL_ACCESS_KEY=${account.privateKey}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await addRoleKey(
    "keeper",
    { network: chain.network, rpcUrl: chain.rpcUrl, contractId: chain.contractId },
    { dir: keyDir, log: () => undefined },
  );
  const { KEEPER_PRIVATE_KEY: privateKey } = parseEnv(
    await readFile(join(keyDir, ENV_FILE), "utf8"),
  );
  if (privateKey === undefined) throw new Error("the key script did not write KEEPER_PRIVATE_KEY");
  keeper = new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
    signer: { accountId: account.accountId, privateKey },
  });

  db = await openDb("pglite:memory");
  await migrate(db);
  indexer = runIndexer({
    db,
    source: createRpcSource({ rpcUrl: chain.rpcUrl, pollMs: 100 }),
    contractId: chain.contractId,
    cursorSource: `sandbox:${chain.contractId}`,
    teamAccounts: [],
    startHeight: await reader.finalHeight(),
    signal: stopIndexer.signal,
    log: () => undefined,
  }).catch((error: unknown) => {
    indexerFailure = error;
  });
});

afterAll(async () => {
  stopIndexer.abort();
  await indexer;
  await db?.close();
  await chain?.stop();
  if (keyDir) await rm(keyDir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits until `check` holds, looking every 100 ms, and fails the test after `ms`. */
async function until(what: string, check: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const giveUpAt = Date.now() + ms;
  while (!(await check())) {
    if (indexerFailure !== undefined) {
      throw new Error(`the indexer stopped while waiting until ${what}`, { cause: indexerFailure });
    }
    if (Date.now() > giveUpAt) throw new Error(`timed out waiting until ${what}`);
    await sleep(100);
  }
}

/** Waits until the last final block is at or past `ns`: a deadline it has reached has passed. */
const chainReaches = (ns: bigint) =>
  until(`the chain's clock reaches ${ns}`, async () => (await reader.blockTimestampNs()) >= ns);

async function indexedHeight(): Promise<bigint | null> {
  const [row] = await db.query<{ height: string }>(
    "select height::text as height from chain_cursor where source = $1",
    [`sandbox:${chain.contractId}`],
  );
  return row ? BigInt(row.height) : null;
}

/** Waits until the index holds every block up to the chain's final height as of now. */
async function caughtUp(): Promise<void> {
  const final = await reader.finalHeight();
  await until(`the index reaches block ${final}`, async () => {
    const height = await indexedHeight();
    return height !== null && height >= final;
  });
}

async function taskOnChain(id: bigint) {
  const task = await reader.getTask(id);
  if (task === null) throw new Error(`task ${id} is not on the chain`);
  return task;
}

/** Funds the poster's vault with one reward and posts a task with four windows of `windowSecs`. */
async function postTask(windowSecs: number): Promise<bigint> {
  const poster = clientOf("poster");
  await poster.deposit(chain.tokenId, REWARD);
  const { taskId } = await poster.postTask({
    token: chain.tokenId,
    reward: REWARD,
    briefUri: "keeper://brief",
    briefHash: sha256Hex("brief"),
    criteriaHash: sha256Hex("criteria"),
    verifier: chain.accounts.judge.accountId,
    commitSecs: windowSecs,
    revealSecs: windowSecs,
    pickSecs: windowSecs,
    fallbackSecs: windowSecs,
  });
  return taskId;
}

/**
 * One tick of the keeper, at the time of the chain's last final block: it is what the chain will
 * say of any deadline for the transactions the tick sends. Returns what it did and what it logged.
 */
async function tick(client: KeeperChain) {
  const now = await reader.blockTimestampNs();
  const lines: string[] = [];
  const result = await keeperTick({ db, client, now: () => now, log: (line) => lines.push(line) });
  return { result, lines };
}

test("keeper_voids_expired_and_cleans", async () => {
  // Two tasks. Nobody enters the first; alice and bob enter the second, reveal, and are judged.
  const empty = await postTask(5);
  const judged = await postTask(10);
  const alice = clientOf("alice");
  const bob = clientOf("bob");
  const entrants = [alice, bob].map((client) => {
    const account = client.accountId ?? "";
    const contentHash = sha256Hex(`work of ${account}`);
    const salt = randomSalt();
    return {
      client,
      account,
      contentHash,
      salt,
      commitment: computeCommitment(judged, account, contentHash, salt),
    };
  });
  const { commit_deadline: commitDeadline, reveal_deadline: judgedRevealDeadline } =
    await taskOnChain(judged);
  await Promise.all(entrants.map((e) => e.client.commit(judged, e.commitment)));
  await chainReaches(BigInt(commitDeadline));
  await Promise.all(
    entrants.map((e) => e.client.reveal(judged, e.contentHash, e.salt, `keeper://${e.account}`)),
  );

  // The first task's reveal window is over with nothing revealed, so the first tick voids it. The
  // second has two reveals, so no void applies to it, and nothing is settled yet to clean.
  await chainReaches(BigInt((await taskOnChain(empty)).reveal_deadline));
  await caughtUp();
  const first = await tick(keeper);
  expect(first.result).toEqual({ voided: [empty], cleaned: [] });
  expect(first.lines).toEqual([`keeper: voided task ${empty}`]);
  expect((await taskOnChain(empty)).outcome).toMatchObject({
    kind: "voided",
    reason: "no_reveals",
  });
  expect((await taskOnChain(judged)).outcome).toBeNull();

  // The judge picks alice once the reveal window is over, and the second tick cleans the entries of
  // that task. The task with no entries costs it a read and nothing more.
  await chainReaches(BigInt(judgedRevealDeadline));
  await clientOf("judge").pick(
    judged,
    [{ account: entrants[0]?.account ?? "", bps: 10_000 }],
    sha256Hex("{}"),
    "keeper://scorecard",
  );
  expect((await taskOnChain(judged)).cleaned).toBe(0);
  await caughtUp();
  const second = await tick(keeper);
  expect(second.result).toEqual({ voided: [], cleaned: [judged] });
  expect(second.lines).toEqual([`keeper: cleaned task ${judged}`]);
  const after = await taskOnChain(judged);
  expect(after.commit_count).toBe(2);
  expect(after.cleaned).toBe(after.commit_count);
  expect(await reader.getAllEntries(judged)).toEqual([]);
  expect(await taskOnChain(empty)).toMatchObject({ commit_count: 0, cleaned: 0 });

  // Nothing is left for a third tick to do.
  const third = await tick(keeper);
  expect(third.result).toEqual({ voided: [], cleaned: [] });
  expect(third.lines).toEqual([]);
});

test("keeper_tolerates_races", async () => {
  const id = await postTask(5);
  await chainReaches(BigInt((await taskOnChain(id)).reveal_deadline));
  await caughtUp();

  // Two keepers at once, each with a key of its own, so that their transactions are sent side by
  // side: both read the task as expired, and one of the two voids is the second to reach the
  // contract, which refuses it as settled.
  const [one, other] = await Promise.all([tick(keeper), tick(clientOf("treasury"))]);

  expect([...one.result.voided, ...other.result.voided]).toEqual([id]);
  const lines = [...one.lines, ...other.lines];
  expect(lines.filter((line) => line.includes("ERROR"))).toEqual([]);
  expect(lines.sort()).toEqual(
    [
      `DEBUG keeper: void_task task ${id} lost the race (E_SETTLED)`,
      `keeper: voided task ${id}`,
    ].sort(),
  );
  expect((await taskOnChain(id)).outcome).toMatchObject({ kind: "voided", reason: "no_reveals" });
});
