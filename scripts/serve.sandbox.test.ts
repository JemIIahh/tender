import { type ChildProcess, spawn } from "node:child_process";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { ApiClient, type LocalChain, startLocalChain, TenderClient } from "@tender/client";
import { type Db, migrate, openDb, PgliteLockLostError, type SessionLock } from "@tender/db";
import { IndexerError } from "@tender/indexer";
import { GasGiftResponseSchema, implicitAccountOf, sha256Hex } from "@tender/shared";
import { BOT_COMMANDS } from "@tender/telegram";
import { KeyPair } from "near-api-js";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { addRoleKey } from "./keeper-key";
import { REPO_ROOT } from "./lib/env";
import {
  checkJudgeKey,
  checkKeeperKey,
  exitOnFailure,
  type ServeOptions,
  type Services,
  startServices,
  TELEGRAM_STOP_MS,
  TELEGRAM_WEBHOOK_PATH,
} from "./serve";

// The services process as `pnpm serve` starts it, against a local chain, with the index in an
// in-memory PGlite: the indexer on the RPC source, the API on a free port, and the keeper, the
// Judge and the Telegram bot when their variables are set. The keeper and the Judge sign with the
// function-call keys the key script mints, as on testnet. The bot calls a fake Bot API on the
// loopback address, never Telegram. The sandbox prunes its old blocks after a minute or two, so
// each test starts its own services, from the chain's final height.

/**
 * Every loop of the notifier and of the Judge that has started, in order, and whether it has
 * stopped: once the promise its start returned has resolved.
 */
const loops = vi.hoisted(() => ({
  notifiers: [] as Array<{ stopped: boolean }>,
  judges: [] as Array<{ stopped: boolean }>,
}));
vi.mock("@tender/telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tender/telegram")>();
  return {
    ...actual,
    startNotifier(...args: Parameters<typeof actual.startNotifier>) {
      const running = actual.startNotifier(...args);
      const loop = { stopped: false };
      loops.notifiers.push(loop);
      return running.then(() => {
        loop.stopped = true;
      });
    },
  };
});
vi.mock("@tender/judge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tender/judge")>();
  return {
    ...actual,
    startJudge(...args: Parameters<typeof actual.startJudge>) {
      const running = actual.startJudge(...args);
      const loop = { stopped: false };
      loops.judges.push(loop);
      return running.then(() => {
        loop.stopped = true;
      });
    },
  };
});

const REWARD = 1_000_000n;
const ENV_FILE = ".env.deploy.sandbox";
/** A token in the shape @BotFather gives one. The fake Bot API takes this one alone. */
const BOT_TOKEN = "123456789:AAE-serve-sandbox-test-token";
const BOT_USERNAME = "tender_serve_test_bot";
const WEBHOOK_SECRET = "serve-sandbox_webhook-secret";
const WEB_URL = "http://localhost:3000";

let chain: LocalChain;
let reader: TenderClient;
let poster: TenderClient;
/** No deployment record is in it, so nothing in the repository says where the indexer starts. */
let deploymentsDir: string;
/**
 * A directory with no env file and no `deployments/`, which the processes of `runServe` take for
 * the place of both (`TENDER_ENV_DIR`): what they read must not depend on the `.env`,
 * `.env.deploy.<network>` and `deployments/<network>.json` that this checkout, or the machine that
 * runs the tests, happens to have.
 */
let emptyEnvDir: string;
let keyDir: string;
/** The keeper's and the Judge's function-call keys, as the key script wrote them. */
let keeperKey: string;
let judgeKey: string;
const running: Services[] = [];
const fakes: FakeBotApi[] = [];
/** Directories of the tests' own, such as a PGlite database's. */
const dirs: string[] = [];
/** The processes of `runServe`, which the end of the file kills if a test left them. */
const children: ChildProcess[] = [];

beforeAll(async () => {
  chain = await startLocalChain();
  reader = new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
  });
  poster = new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
    signer: chain.accounts.poster,
  });
  deploymentsDir = await mkdtemp(join(tmpdir(), "tender-serve-deployments-"));
  emptyEnvDir = await mkdtemp(join(tmpdir(), "tender-serve-env-"));

  keyDir = await mkdtemp(join(tmpdir(), "tender-serve-keys-"));
  const { keeper, judge } = chain.accounts;
  await writeFile(
    join(keyDir, ENV_FILE),
    [
      `TENDER_CONTRACT=${chain.contractId}`,
      `KEEPER_ACCOUNT=${keeper.accountId}`,
      `KEEPER_FULL_ACCESS_KEY=${keeper.privateKey}`,
      `JUDGE_ACCOUNT=${judge.accountId}`,
      `JUDGE_FULL_ACCESS_KEY=${judge.privateKey}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const target = { network: chain.network, rpcUrl: chain.rpcUrl, contractId: chain.contractId };
  // One after the other: both write to the one env file.
  await addRoleKey("keeper", target, { dir: keyDir, log: () => undefined });
  await addRoleKey("judge", target, { dir: keyDir, log: () => undefined });
  const written = parseEnv(await readFile(join(keyDir, ENV_FILE), "utf8"));
  if (written.KEEPER_PRIVATE_KEY === undefined || written.JUDGE_PRIVATE_KEY === undefined) {
    throw new Error("the key script did not write KEEPER_PRIVATE_KEY and JUDGE_PRIVATE_KEY");
  }
  keeperKey = written.KEEPER_PRIVATE_KEY;
  judgeKey = written.JUDGE_PRIVATE_KEY;
});

afterAll(async () => {
  for (const child of children) child.kill("SIGKILL");
  await Promise.all(running.map((services) => services.stop()));
  await Promise.all(fakes.map((fake) => fake.close()));
  await chain?.stop();
  for (const dir of [deploymentsDir, emptyEnvDir, keyDir, ...dirs]) {
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

/** The Judge's variables: its account, the scoped key, and a short interval. */
const judgeEnv = (intervalMs: number) => ({
  JUDGE_ACCOUNT: chain.accounts.judge.accountId,
  JUDGE_PRIVATE_KEY: judgeKey,
  JUDGE_INTERVAL_MS: String(intervalMs),
});

/** The bot's variables, by long polling unless `extra` says otherwise. */
const telegramEnv = (extra: Record<string, string> = {}) => ({
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_BOT_USERNAME: BOT_USERNAME,
  PUBLIC_WEB_URL: WEB_URL,
  ...extra,
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
  waiting_for_chain: boolean;
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

/** Posts a task as the poster, with its reward deposited first, and returns its id. */
async function postTask(over: { verifier?: string; criteria?: string } = {}): Promise<bigint> {
  await poster.deposit(chain.tokenId, REWARD);
  const { taskId } = await poster.postTask({
    token: chain.tokenId,
    reward: REWARD,
    briefUri: "serve://brief",
    briefHash: sha256Hex("brief"),
    criteriaHash: sha256Hex(over.criteria ?? "criteria"),
    verifier: over.verifier,
    commitSecs: 60,
    revealSecs: 60,
    pickSecs: 60,
    fallbackSecs: 60,
  });
  return taskId;
}

// ---- A fake Bot API ---------------------------------------------------------------------------

/** One call the bot made to the Bot API: the method, and the JSON it sent. */
interface BotCall {
  method: string;
  payload: Record<string, unknown>;
}

/** An update as Telegram sends one: here, always a message. */
interface FakeUpdate {
  update_id: number;
  message: Record<string, unknown>;
}

interface FakeBotApi {
  /** What grammY's `client.apiRoot` takes: where the server listens. */
  apiRoot: string;
  calls: BotCall[];
  /** The calls of `method`, in order. */
  callsOf(method: string): BotCall[];
  /** The texts the bot sent to `chat`, in order. */
  sentTo(chat: number): string[];
  /** Hands `update` to the next long poll. */
  push(update: FakeUpdate): void;
  /** Answers the calls held so far, and holds no more. */
  release(): void;
  /** Answers the calls it holds, and stops. */
  close(): Promise<void>;
}

/** What `getMe` answers. */
const BOT_INFO = {
  id: 7_000_000_003,
  is_bot: true,
  first_name: "Tender",
  username: BOT_USERNAME,
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

let lastUpdate = 0;

/** `text` sent to the bot in the private chat `chat`, by the person on the other end of it. */
function messageFrom(chat: number, text: string): FakeUpdate {
  lastUpdate += 1;
  const command = /^\/\S+/.exec(text)?.[0];
  return {
    update_id: lastUpdate,
    message: {
      message_id: lastUpdate,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chat, type: "private", first_name: "Ada" },
      from: { id: chat, is_bot: false, first_name: "Ada" },
      text,
      ...(command !== undefined && {
        entities: [{ type: "bot_command", offset: 0, length: command.length }],
      }),
    },
  };
}

/**
 * A Bot API server on the loopback address that stands in for Telegram's. It records every call
 * made with `BOT_TOKEN`, and answers `getMe` with `BOT_INFO`, `getUpdates` with the updates that
 * `push` handed it (a long poll waits up to 200 ms for one), `sendMessage` with the message it
 * made, and anything else with `true`. It drops the updates below the offset a poll sends, as
 * Telegram does once they are confirmed. A call that `hold` picks out is not answered until
 * `release` or `close`, as by a Telegram that does not answer. A call that `refuse` picks out is
 * answered with 401, as by a Telegram that does not take the token, once it is no longer held.
 */
async function startFakeBotApi(
  hold: (call: BotCall) => boolean = () => false,
  refuse: (call: BotCall) => boolean = () => false,
): Promise<FakeBotApi> {
  const calls: BotCall[] = [];
  let queued: FakeUpdate[] = [];
  const waiting = new Set<() => void>();
  const held = new Set<() => void>();
  let holding = hold;
  /** How many requests it is answering. */
  let answering = 0;
  const prefix = `/bot${BOT_TOKEN}/`;

  const server: Server = createServer(async (req, res) => {
    answering += 1;
    res.once("close", () => {
      answering -= 1;
    });
    let body = "";
    for await (const chunk of req) body += chunk;
    const answer = (status: number, json: unknown) => {
      if (res.destroyed) return;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (!req.url?.startsWith(prefix)) {
      answer(404, { ok: false, error_code: 404, description: "Not Found" });
      return;
    }
    const method = req.url.slice(prefix.length);
    const payload = (body === "" ? {} : JSON.parse(body)) as Record<string, unknown>;
    const call = { method, payload };
    calls.push(call);
    if (holding(call)) await new Promise<void>((resolve) => held.add(resolve));
    if (refuse(call)) {
      answer(401, { ok: false, error_code: 401, description: "Unauthorized" });
      return;
    }
    switch (method) {
      case "getMe":
        answer(200, { ok: true, result: BOT_INFO });
        return;
      case "getUpdates": {
        const offset = Number(payload.offset ?? 0);
        queued = queued.filter((update) => update.update_id >= offset);
        if (queued.length === 0 && Number(payload.timeout ?? 0) > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, 200);
            function done() {
              clearTimeout(timer);
              waiting.delete(done);
              resolve();
            }
            waiting.add(done);
            res.once("close", done);
          });
        }
        answer(200, { ok: true, result: queued });
        return;
      }
      case "sendMessage":
        answer(200, {
          ok: true,
          result: {
            message_id: calls.length,
            date: Math.floor(Date.now() / 1000),
            chat: { id: payload.chat_id, type: "private" },
            text: payload.text,
          },
        });
        return;
      default:
        answer(200, { ok: true, result: true });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port for the fake");

  const fake: FakeBotApi = {
    apiRoot: `http://127.0.0.1:${address.port}`,
    calls,
    callsOf: (method) => calls.filter((call) => call.method === method),
    // A reply names its chat with Telegram's number, and the notifier with the text the database
    // holds: both are the chat.
    sentTo: (chat) =>
      calls
        .filter(
          (call) => call.method === "sendMessage" && String(call.payload.chat_id) === `${chat}`,
        )
        .map((call) => String(call.payload.text)),
    push(update) {
      queued.push(update);
      for (const wake of [...waiting]) wake();
    },
    release() {
      holding = () => false;
      for (const answer of [...held]) answer();
      held.clear();
    },
    async close() {
      // The calls it held are answered before the connections go: a call cut short would be
      // retried by the bot, at a server that is gone.
      fake.release();
      while (answering > 0) await sleep(10);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  fakes.push(fake);
  return fake;
}

// ---- The tests --------------------------------------------------------------------------------

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
  // Nothing is waited for.
  expect(last?.body.waiting_for_chain).toBe(false);
  // Nothing was asked of a keeper, a Judge or a bot, and none runs.
  expect(lines).toContain("serve: keeper off (KEEPER_PRIVATE_KEY is not set)");
  expect(lines).toContain("serve: Judge off (JUDGE_PRIVATE_KEY is not set)");
  expect(lines).toContain("serve: Telegram off (TELEGRAM_BOT_TOKEN is not set)");
  // No Telegram webhook either.
  expect((await fetch(`${services.url}${TELEGRAM_WEBHOOK_PATH}`, { method: "POST" })).status).toBe(
    404,
  );

  // The API is on every address of the machine, not on the loopback one alone: a host's proxy
  // reaches a container by its own address. A machine with no such address (no network) skips this.
  const outside = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry !== undefined && !entry.internal && entry.family === "IPv4");
  if (outside !== undefined) {
    const answer = await health(`http://${outside.address}:${new URL(services.url).port}`);
    expect(answer.status).toBe(200);
  }

  await services.stop();
});

test("serve_starts_the_keeper_when_its_key_is_set", async () => {
  const lines: string[] = [];
  const services = await serve(envFor(keeperEnv(500)), lines);
  expect(lines).toContain(`serve: keeper on, as ${chain.accounts.keeper.accountId}`);

  // A task nobody enters, with the shortest windows: once its reveal window is over with nothing
  // revealed, the keeper voids it, signing with the scoped key. Nobody else here calls void_task.
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

test("the_key_checks_read_what_the_node_says_of_each_key", async () => {
  // The checks that guard the keeper and the Judge off the sandbox, against the RPC's own answers:
  // the scoped keys the key script added are taken, and the accounts' full-access keys and a key
  // they do not have are refused.
  const { keeper, judge } = chain.accounts;
  const keyOf = (accountId: string, privateKey: string) => ({ accountId, privateKey });
  await expect(
    checkKeeperKey(reader, keyOf(keeper.accountId, keeperKey), chain.contractId),
  ).resolves.toBeUndefined();
  await expect(
    checkKeeperKey(reader, keyOf(keeper.accountId, keeper.privateKey), chain.contractId),
  ).rejects.toThrow(/^KEEPER_PRIVATE_KEY is a full-access key of keeper\.sandbox /);
  await expect(
    checkKeeperKey(
      reader,
      keyOf(keeper.accountId, KeyPair.fromRandom("ed25519").toString()),
      chain.contractId,
    ),
  ).rejects.toThrow(/^KEEPER_PRIVATE_KEY is not a key of keeper\.sandbox /);

  await expect(
    checkJudgeKey(reader, keyOf(judge.accountId, judgeKey), chain.contractId),
  ).resolves.toBeUndefined();
  await expect(
    checkJudgeKey(reader, keyOf(judge.accountId, judge.privateKey), chain.contractId),
  ).rejects.toThrow(/^JUDGE_PRIVATE_KEY is a full-access key of judge\.sandbox /);
  // Each scoped key is limited to Tender for its own role's methods: neither passes for the other.
  await expect(
    checkKeeperKey(reader, keyOf(judge.accountId, judgeKey), chain.contractId),
  ).rejects.toThrow(
    /^KEEPER_PRIVATE_KEY is a key of judge\.sandbox \(KEEPER_ACCOUNT\) that is not a function-call key limited to tender\.sandbox for void_task and cleanup\./,
  );
  await expect(
    checkJudgeKey(reader, keyOf(keeper.accountId, keeperKey), chain.contractId),
  ).rejects.toThrow(
    /^JUDGE_PRIVATE_KEY is a key of keeper\.sandbox \(JUDGE_ACCOUNT\) that is not a function-call key limited to tender\.sandbox for pick and pick_attested\./,
  );
});

test("serve_runs_the_judge_with_its_scoped_key", async () => {
  const lines: string[] = [];
  const services = await serve(envFor(judgeEnv(200)), lines);
  expect(lines).toContain(`serve: Judge on, as ${chain.accounts.judge.accountId}`);

  // A task that names the Judge, with criteria the API was never sent: a tick of the Judge takes
  // it in from the index, and turns it down.
  const taskId = await postTask({
    verifier: chain.accounts.judge.accountId,
    criteria: "criteria nobody stored",
  });
  let task: { judge_status: string | null; judge_reason: string | null } | undefined;
  await until(
    `the Judge looks at task ${taskId}`,
    async () => {
      const res = await fetch(`${services.url}/v1/tasks/${taskId}`);
      if (res.status !== 200) return false;
      task = ((await res.json()) as { task: NonNullable<typeof task> }).task;
      return task.judge_status !== null;
    },
    30_000,
  );
  expect(task).toMatchObject({
    judge_status: "rejected",
    judge_reason: "criteria not found or invalid",
  });
  expect(lines.filter((line) => line.startsWith("ERROR"))).toEqual([]);

  await services.stop();
});

test("serve_runs_the_bot_by_long_polling_and_the_notifier", async () => {
  const telegram = await startFakeBotApi();
  const lines: string[] = [];
  const services = await serve(envFor(telegramEnv()), lines, {
    telegramApiRoot: telegram.apiRoot,
  });
  expect(lines).toContain(
    "serve: Telegram bot on, taking updates by long polling, and the notifier",
  );

  // Once at the start: the menu of commands and the bot's own details. Then the long polling, which
  // asks for messages only, and keeps the updates that came while no process polled.
  await until("the bot polls", async () => telegram.callsOf("getUpdates").length > 0, 10_000);
  expect(telegram.callsOf("setMyCommands").map((call) => call.payload)).toEqual([
    { commands: BOT_COMMANDS, scope: { type: "all_private_chats" } },
  ]);
  expect(telegram.callsOf("getMe")).toHaveLength(1);
  expect(telegram.callsOf("deleteWebhook").map((call) => call.payload)).toEqual([
    { drop_pending_updates: false },
  ]);
  expect(telegram.callsOf("getUpdates")[0]?.payload).toMatchObject({
    allowed_updates: ["message"],
  });

  // A chat links itself to the poster's account, with the link the web app gets for the account.
  const chat = 4_242;
  const api = new ApiClient({ baseUrl: services.publicUrl, signer: chain.accounts.poster });
  const nonce = new URL((await api.telegramLink()).url).searchParams.get("start");
  telegram.push(messageFrom(chat, `/start ${nonce}`));
  await until("the bot answers", async () => telegram.sentTo(chat).length > 0, 10_000);
  expect(telegram.sentTo(chat)).toEqual([
    `Linked to <b>${chain.accounts.poster.accountId}</b>. You will get alerts for it and its ` +
      "agents. /help",
  ]);

  // The notifier tells the chat of the poster's new task, with a link to it in the web app.
  const taskId = await postTask();
  await until(
    `the notifier tells the chat of task ${taskId}`,
    async () => telegram.sentTo(chat).length > 1,
    30_000,
  );
  expect(telegram.sentTo(chat)[1]).toContain(`${WEB_URL}/tasks/${taskId}`);

  // Stopping ends the long polling: the bot tells Telegram the updates it handled, and then calls
  // nothing more.
  await services.stop();
  expect(telegram.calls.at(-1)).toEqual({
    method: "getUpdates",
    payload: { offset: lastUpdate + 1, limit: 1 },
  });
  const calls = telegram.calls.length;
  await sleep(1_000);
  expect(telegram.calls).toHaveLength(calls);
  expect(lines.filter((line) => /^(ERROR|WARN) telegram/.test(line))).toEqual([]);
});

test("serve_takes_the_bots_updates_at_its_webhook", async () => {
  // Telegram is slow to give the bot its own details, until `release`.
  const telegram = await startFakeBotApi((call) => call.method === "getMe");
  const lines: string[] = [];
  const before = loops.notifiers.length;
  const services = await serve(
    envFor(telegramEnv({ TELEGRAM_MODE: "webhook", TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET })),
    lines,
    { telegramApiRoot: telegram.apiRoot },
  );
  expect(lines).toContain(
    `serve: Telegram bot on, taking updates at POST ${TELEGRAM_WEBHOOK_PATH}, and the notifier`,
  );
  // The notifier runs in this mode too.
  const notifiers = loops.notifiers.slice(before);
  expect(notifiers).toEqual([{ stopped: false }]);
  const chat = 4_343;
  const webhook = `${services.url}${TELEGRAM_WEBHOOK_PATH}`;
  const post = (secret?: string, body: BodyInit = JSON.stringify(messageFrom(chat, "/help"))) =>
    fetch(webhook, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret !== undefined && { "X-Telegram-Bot-Api-Secret-Token": secret }),
      },
      body,
      // A stream goes without a Content-Length.
      ...(body instanceof ReadableStream && { duplex: "half" }),
    });

  // Until the bot has its own details, no update is taken, with the secret or without, and none
  // makes the bot call Telegram: the one call is the one the services made at start.
  await until(
    "the services ask for the bot",
    async () => telegram.callsOf("getMe").length > 0,
    10_000,
  );
  for (const secret of [WEBHOOK_SECRET, undefined, "wrong-secret"]) {
    const res = await post(secret);
    expect(res.status, String(secret)).toBe(503);
    expect(await res.json(), String(secret)).toEqual({
      error: "unavailable",
      message: "the bot is starting",
    });
  }
  expect(telegram.callsOf("getMe")).toHaveLength(1);
  telegram.release();
  await until(
    "the bot has its details",
    async () => (await post("wrong-secret")).status === 401,
    10_000,
  );

  // An update without the secret, or with another one, is turned away, and the bot says nothing.
  const calls = telegram.calls.length;
  for (const secret of [undefined, "wrong-secret", `${WEBHOOK_SECRET}x`]) {
    const res = await post(secret);
    expect(res.status, String(secret)).toBe(401);
    expect(await res.text(), String(secret)).toBe("");
  }
  expect(telegram.calls).toHaveLength(calls);

  // A body that does not say its length, or says more than 1 MiB, is not read, secret or not.
  const tooLarge = {
    error: "payload_too_large",
    message: "the request body must say its length, and be 1 MiB at most",
  };
  const unsized = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(messageFrom(chat, "/help"))));
      controller.close();
    },
  });
  for (const body of [unsized, "x".repeat(1_048_577)]) {
    const res = await post(WEBHOOK_SECRET, body);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual(tooLarge);
  }
  expect(telegram.sentTo(chat)).toEqual([]);

  // With the secret, the bot has answered through the Bot API by the time the webhook answers 200.
  const res = await post(WEBHOOK_SECRET);
  expect(res.status).toBe(200);
  expect(telegram.sentTo(chat)).toHaveLength(1);
  expect(telegram.sentTo(chat)[0]).toMatch(/^<b>Tender alerts<\/b>\n\/status/);

  // The menu is set once, and nothing polls or touches the webhook, which is the owner's to set.
  await until("the menu is set", async () => telegram.callsOf("setMyCommands").length > 0, 10_000);
  expect(telegram.callsOf("setMyCommands")).toHaveLength(1);
  const methods = new Set(telegram.calls.map((call) => call.method));
  expect([...methods].filter((method) => /Updates|Webhook/.test(method))).toEqual([]);

  // Once stopped, the notifier has stopped, the port takes no connection, and nothing calls
  // Telegram or writes a line, to the services' log or, as the notifier does, to the console.
  const errors = vi.spyOn(console, "error");
  try {
    await services.stop();
    expect(notifiers).toEqual([{ stopped: true }]);
    expect(lines.at(-1)).toBe("serve: stopped");
    expect(lines.filter((line) => /^(ERROR|WARN) telegram/.test(line))).toEqual([]);
    const after = { lines: lines.length, calls: telegram.calls.length };
    await sleep(1_000);
    expect(await takesConnections(services.url)).toBe(false);
    expect(lines).toHaveLength(after.lines);
    expect(telegram.calls).toHaveLength(after.calls);
    expect(errors).not.toHaveBeenCalled();
  } finally {
    errors.mockRestore();
  }
});

test("the_webhook_says_the_bot_is_not_available_once_it_cannot_start", async () => {
  // Telegram is slow to give the bot its own details, and then does not take its token.
  const telegram = await startFakeBotApi(
    (call) => call.method === "getMe",
    (call) => call.method === "getMe",
  );
  const lines: string[] = [];
  const services = await serve(
    envFor(telegramEnv({ TELEGRAM_MODE: "webhook", TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET })),
    lines,
    { telegramApiRoot: telegram.apiRoot },
  );
  const post = async () => {
    const res = await fetch(`${services.url}${TELEGRAM_WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
      },
      body: JSON.stringify(messageFrom(4_545, "/help")),
    });
    return { status: res.status, body: await res.json() };
  };
  const unavailable = (message: string) => ({
    status: 503,
    body: { error: "unavailable", message },
  });
  await until(
    "the services ask for the bot",
    async () => telegram.callsOf("getMe").length > 0,
    10_000,
  );

  // While Telegram has not answered, the bot is starting.
  expect(await post()).toEqual(unavailable("the bot is starting"));

  // Then Telegram turns the token down. The ERROR is logged, and nothing tries again: from then on
  // the bot is not available, which is no longer "starting".
  telegram.release();
  await until(
    "the ERROR is logged",
    async () => lines.some((line) => line.startsWith("ERROR")),
    10_000,
  );
  expect(lines.filter((line) => line.startsWith("ERROR"))).toEqual([
    "ERROR telegram: the bot cannot start (GrammyError 401: Telegram does not take " +
      "TELEGRAM_BOT_TOKEN)",
  ]);
  expect(await post()).toEqual(unavailable("the bot is not available"));
  expect(await post()).toEqual(unavailable("the bot is not available"));
  // The rest of the services go on, and the bot said nothing.
  expect((await health(services.url)).status).toBe(200);
  expect(telegram.callsOf("sendMessage")).toEqual([]);
  expect(telegram.callsOf("getMe")).toHaveLength(1);

  await services.stop();
  expect(lines.at(-1)).toBe("serve: stopped");
});

test("stop_goes_on_without_a_telegram_that_does_not_answer", async () => {
  // Telegram takes the long polling, then never answers the last call the bot makes, the one that
  // tells it which updates were handled. Stopping gives up on it after 5 s, says what it left, and
  // stops the rest, here the indexer and the database.
  const telegram = await startFakeBotApi(
    (call) => call.method === "getUpdates" && call.payload.limit === 1,
  );
  const lines: string[] = [];
  const graceMs = 300;
  const services = await serve(envFor(telegramEnv()), lines, {
    closeGraceMs: graceMs,
    telegramApiRoot: telegram.apiRoot,
  });
  await until("the bot polls", async () => telegram.callsOf("getUpdates").length > 0, 10_000);

  const started = Date.now();
  await services.stop();
  const took = Date.now() - started;
  // The deadline, and then the rest of the stop: the indexer's block in hand and the database.
  expect(took).toBeGreaterThanOrEqual(TELEGRAM_STOP_MS - 10);
  expect(took).toBeLessThan(TELEGRAM_STOP_MS + graceMs + 3_000);
  expect(lines).toContain(
    "WARN telegram: not stopped within 5 s, as Telegram does not answer; going on without the " +
      "call that tells Telegram which updates were handled",
  );
  expect(lines.at(-1)).toBe("serve: stopped");
  expect(await takesConnections(services.url)).toBe(false);

  // When Telegram answers at last, the bot's stop ends, and it calls nothing more.
  const calls = telegram.calls.length;
  telegram.release();
  await sleep(500);
  expect(telegram.calls).toHaveLength(calls);
});

test("the_keeper_the_judge_and_the_indexer_wait_together_for_the_lock", async () => {
  // Another process holds the lock until `free` is set: then this one takes it, and starts the
  // indexer, the keeper and the Judge together, so that only one process sends the keeper's calls
  // and picks for the Judge.
  let free = false;
  const release = vi.fn(async () => undefined);
  const held: SessionLock = { lost: new AbortController().signal, release };
  const tryLock = vi.fn(async () => (free ? held : null));
  const lines: string[] = [];
  const services = await serve(envFor({ ...keeperEnv(500), ...judgeEnv(500) }), lines, {
    tryLock,
  });

  expect(lines).toContain(
    "indexer: another services process holds the indexer lock; serving the API, and starting " +
      "the indexer, the keeper and the Judge once the lock is free",
  );
  expect(lines.filter((line) => /^serve: (keeper|Judge) on/.test(line))).toEqual([]);
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
  expect(lines).toContain(
    "indexer: took the indexer lock; started the indexer, the keeper and the Judge",
  );
  expect(lines).toContain(`serve: keeper on, as ${chain.accounts.keeper.accountId}`);
  expect(lines).toContain(`serve: Judge on, as ${chain.accounts.judge.accountId}`);

  await services.stop();
  expect(release).toHaveBeenCalledTimes(1);
  expect(lines.at(-1)).toBe("serve: stopped");
});

test("stop_leaves_the_port_closed_and_every_loop_resolved", async () => {
  const telegram = await startFakeBotApi();
  const lines: string[] = [];
  const before = { notifiers: loops.notifiers.length, judges: loops.judges.length };
  const services = await serve(
    envFor({ ...keeperEnv(100), ...judgeEnv(100), ...telegramEnv() }),
    lines,
    { closeGraceMs: 300, telegramApiRoot: telegram.apiRoot },
  );
  await until(
    "the indexer applies a block",
    async () => BigInt((await health(services.url)).body.indexed_height) > 0n,
    10_000,
  );
  await until("the bot polls", async () => telegram.callsOf("getUpdates").length > 0, 10_000);
  // One notifier and one Judge run, and neither has stopped.
  const notifiers = loops.notifiers.slice(before.notifiers);
  const judges = loops.judges.slice(before.judges);
  expect(notifiers).toEqual([{ stopped: false }]);
  expect(judges).toEqual([{ stopped: false }]);

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
    // The notifier and the Judge had stopped by the time stop() resolved.
    expect(notifiers).toEqual([{ stopped: true }]);
    expect(judges).toEqual([{ stopped: true }]);

    // Every loop has ended. Each of them reads the database, which stop() closed last, so one that
    // still ran would fail and say so: the indexer on the next block, the keeper and the Judge
    // within 100 ms, an event stream within a second. The bot polls no more.
    const after = lines.length;
    const calls = telegram.calls.length;
    await sleep(2_000);
    expect(lines.slice(after)).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
    expect(telegram.calls).toHaveLength(calls);
  } finally {
    errors.mockRestore();
  }
});

// ---- The database ------------------------------------------------------------------------------

test("serve_keeps_its_index_in_a_pglite_directory_that_one_process_has_open_at_a_time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tender-serve-pglite-"));
  dirs.push(dir);
  const url = `pglite:${join(dir, "index")}`;
  const lines: string[] = [];
  const first = await serve(envFor({ DATABASE_URL: url }), lines);

  // A second services process on the directory is refused with the reason, and the first goes on.
  const second = lines.slice();
  await expect(serve(envFor({ DATABASE_URL: url }), second)).rejects.toThrow(
    /^the PGlite directory .* is open already in this process/,
  );
  expect(second.slice(lines.length)).toEqual([]);

  const taskId = await postTask();
  await until(
    `the index holds task ${taskId}`,
    async () => (await fetch(`${first.url}/v1/tasks/${taskId}`)).status === 200,
    30_000,
  );
  await first.stop();

  // Stopped, the services let the directory go. They start on it again with the index as it was,
  // and the check of the database against the chain, which asks for the task count now, passes.
  const restarted = await serve(envFor({ DATABASE_URL: url }), lines);
  expect((await fetch(`${restarted.url}/v1/tasks/${taskId}`)).status).toBe(200);
  expect(lines.filter((line) => /^indexer: resuming after block \d+$/.test(line))).toHaveLength(1);
  await restarted.stop();
});

test("serve_refuses_a_database_that_holds_the_index_of_another_deploy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tender-serve-pglite-"));
  dirs.push(dir);
  const url = `pglite:${join(dir, "index")}`;
  // The index of another contract, as an earlier deploy left it.
  const left = await openDb(url);
  await migrate(left);
  await left.query("insert into chain_cursor (source, height) values ($1, 12345)", [
    "sandbox:old-deploy.sandbox",
  ]);
  await left.close();

  const lines: string[] = [];
  const failure = await serve(envFor({ DATABASE_URL: url }), lines).then(
    () => undefined,
    (error: unknown) => error as Error,
  );
  expect(failure?.message).toMatch(
    /^the database holds the index of another deploy of Tender: its chain cursor is for "sandbox:old-deploy\.sandbox", and this deploy is "sandbox:/,
  );
  expect(failure?.message).toContain("one database per contract deploy");
  // Nothing served from it, and what had started is stopped: the directory opens again.
  expect(lines.filter((line) => line.startsWith("serve: API at"))).toEqual([]);
  await (await openDb(url)).close();
});

// ---- The database against the chain ------------------------------------------------------------

/**
 * A PGlite directory of its own with a real index in it: a task the chain holds, and the cursor
 * after its block. The first call makes it, by serving, posting a task and stopping; every call
 * copies it, so that a test may change what it holds.
 */
let indexed: Promise<{ dir: string; taskId: bigint; cursor: bigint }> | undefined;
async function indexedCopy(): Promise<{ url: string; taskId: bigint; cursor: bigint }> {
  indexed ??= (async () => {
    const base = await mkdtemp(join(tmpdir(), "tender-serve-master-"));
    dirs.push(base);
    const dir = join(base, "index");
    const services = await serve(envFor({ DATABASE_URL: `pglite:${dir}` }), []);
    const taskId = await postTask();
    await until(
      `the index holds task ${taskId}`,
      async () => (await fetch(`${services.url}/v1/tasks/${taskId}`)).status === 200,
      30_000,
    );
    await services.stop();
    const db = await openDb(`pglite:${dir}`);
    const [row] = await db.query<{ height: string }>(
      "select height::text as height from chain_cursor",
    );
    await db.close();
    return { dir, taskId, cursor: BigInt(row?.height ?? "0") };
  })();
  const { dir, taskId, cursor } = await indexed;
  const base = await mkdtemp(join(tmpdir(), "tender-serve-copy-"));
  dirs.push(base);
  await cp(dir, join(base, "index"), { recursive: true });
  return { url: `pglite:${join(base, "index")}`, taskId, cursor };
}

/** Changes what a copy of the index holds: `change` is given the database, which is closed after. */
async function changing(url: string, change: (db: Db) => Promise<void>): Promise<void> {
  const db = await openDb(url);
  try {
    await change(db);
  } finally {
    await db.close();
  }
}

/** Stores a task of id `id` as the index would. */
async function indexTask(db: Db, id: number): Promise<void> {
  await db.query(
    `insert into tasks (id, poster, token, reward, fee_bps, brief_uri, brief_hash, criteria_hash,
       verifier, created_at, commit_deadline, reveal_deadline, pick_deadline, fallback_deadline,
       max_entries, max_winners, invited, created_height)
     values ($1, 'poster.test.near', 'token.test.near', 1, 0, 'uri', 'h', 'h', 'judge.test.near',
       1, 1, 1, 1, 1, 1, 1, '[]', 1)`,
    [id],
  );
}

/** The reads of the chain that the check makes, over `reader`, failing as `fails` says. */
function chainThatFails(fails: { final: number; count: number }) {
  const asks = { final: 0, count: 0 };
  const down = () => new Error("fetch failed for https://rpc.example.org/?apiKey=s3cret");
  return {
    asks,
    chain: {
      network: reader.network,
      contractId: reader.contractId,
      finalHeight: async () => {
        asks.final += 1;
        if (asks.final <= fails.final) throw down();
        return reader.finalHeight();
      },
      taskCount: async () => {
        asks.count += 1;
        if (asks.count <= fails.count) throw down();
        return reader.taskCount();
      },
    },
  };
}

/**
 * The reads of the chain that the check makes, over `reader`, with a node whose final block is `gap`
 * blocks below `cursor` until `catchUp`, and the chain's own after.
 */
function chainThatLags(cursor: bigint, gap: bigint) {
  const asks = { final: 0 };
  let behind = true;
  return {
    asks,
    catchUp: () => {
      behind = false;
    },
    chain: {
      network: reader.network,
      contractId: reader.contractId,
      finalHeight: async () => {
        asks.final += 1;
        return behind ? cursor - gap : reader.finalHeight();
      },
      taskCount: () => reader.taskCount(),
    },
  };
}

/**
 * The reads of the chain that the check makes, over `reader`, whose first read of the task count
 * says `short`, as a node of a load-balanced RPC that is a block or two behind the one that gave the
 * final height does.
 */
function chainThatCountsShortOnce(short: bigint) {
  const asks = { count: 0 };
  return {
    asks,
    chain: {
      network: reader.network,
      contractId: reader.contractId,
      finalHeight: () => reader.finalHeight(),
      taskCount: async () => {
        asks.count += 1;
        return asks.count === 1 ? short : reader.taskCount();
      },
    },
  };
}

/** Whether `promise` has not settled within `ms`. */
const stillPending = (promise: Promise<unknown>, ms = 100): Promise<boolean> =>
  Promise.race([promise.then(() => false), sleep(ms).then(() => true)]);

/** The lines of `lines` that tell of a wait for the chain. */
const waitsOf = (lines: string[]) =>
  lines.filter((line) => line.startsWith("WARN indexer: cannot check the database"));

test("serve_serves_while_the_chain_cannot_be_asked_and_indexes_once_it_can", async () => {
  const { url, taskId, cursor } = await indexedCopy();
  const flaky = chainThatFails({ final: 2, count: 1 });
  const lines: string[] = [];
  const services = await serve(envFor({ DATABASE_URL: url, ...keeperEnv(200) }), lines, {
    deployment: { chain: flaky.chain, retryMs: 20, longestMs: 40 },
  });

  // The services are up on the first failed read: the API serves the index as it is, and none of
  // the indexer, the keeper and the Judge has started, since nothing says yet whose index it is.
  const early = lines.slice();
  expect(early).toContain(
    "WARN indexer: cannot check the database against the chain yet (cannot read the final " +
      "block (Error)); trying again in 0.02 s",
  );
  expect(early.filter((line) => /^serve: API at/.test(line))).toHaveLength(1);
  expect(early.some((line) => line.startsWith("indexer: resuming"))).toBe(false);
  expect(early.some((line) => line.startsWith("serve: keeper on"))).toBe(false);
  const served = await health(services.url);
  expect(served.status).toBe(200);
  expect(BigInt(served.body.indexed_height)).toBe(cursor);
  // The API is up and `ok`, and says that the services wait for the chain.
  expect(served.body.ok).toBe(true);
  expect(served.body.waiting_for_chain).toBe(true);
  expect((await fetch(`${services.url}/v1/tasks/${taskId}`)).status).toBe(200);

  // Once the node answers, the database is found to match, and they start.
  await until(
    "the keeper and the indexer start",
    async () => lines.some((line) => line.startsWith("serve: keeper on")),
    30_000,
  );
  expect((await health(services.url)).body.waiting_for_chain).toBe(false);
  expect(lines).toContain(
    "indexer: the database matches the chain; starting the indexer and the keeper",
  );
  expect(lines.some((line) => line.startsWith("indexer: resuming after block"))).toBe(true);
  expect(lines.filter((line) => line.startsWith("ERROR"))).toEqual([]);
  expect(flaky.asks.final).toBeGreaterThan(2);
  expect(flaky.asks.count).toBeGreaterThan(1);
  // What the failed reads quoted does not show.
  expect(lines.filter((line) => line.includes("s3cret"))).toEqual([]);
  await services.stop();
});

test("serve_ends_on_the_index_of_another_chain_once_two_reads_in_a_row_say_so", async () => {
  const { url, cursor } = await indexedCopy();
  // A task the chain has not made: the index of a contract that was made again under this name.
  await changing(url, (db) => indexTask(db, 999));
  const lines: string[] = [];
  const services = await serve(envFor({ DATABASE_URL: url, ...keeperEnv(200) }), lines, {
    deployment: { retryMs: 20, longestMs: 40 },
  });

  // The services are up on the first read that comes out short, which is not taken for the last:
  // the API serves the index as it is, and none of the indexer and the keeper has started.
  const waits = waitsOf(lines);
  expect(waits).toHaveLength(1);
  expect(waits[0]).toMatch(
    /^WARN indexer: cannot check the database against the chain yet \(the node counts \d+ tasks, fewer than the 999 the database holds, though its final block, \d+, is past the last block the index took, \d+: reading again before the database is taken for another deploy's\); trying again in 0\.02 s$/,
  );
  expect(lines.some((line) => line.startsWith("indexer: resuming"))).toBe(false);
  expect(lines.some((line) => line.startsWith("serve: keeper on"))).toBe(false);

  // The next read says the same, and the services cannot go on. They say why in the error, which is
  // the refusal as a start would throw it, and no line of their own.
  const error = await services.failed;
  expect(error).toBeInstanceOf(IndexerError);
  expect(error.message).toMatch(
    /^the database holds task 999, but .* has made \d+ on sandbox, as read at its final block \d+, past the last block the index took \(\d+\), on 2 reads in a row\. Either the node at NEAR_RPC_URL is behind the chain: wait for it/,
  );
  expect(error.message).toContain(
    "use a new database for this deploy (one database per contract deploy)",
  );
  expect(error.message).toContain("keep the old one");
  expect(lines.filter((line) => line.startsWith("ERROR"))).toEqual([]);

  // Until the process ends, the API serves and nothing writes: the cursor stays where it was while
  // the chain moves on.
  await postTask();
  await sleep(500);
  const served = await health(services.url);
  expect(served.status).toBe(200);
  expect(BigInt(served.body.indexed_height)).toBe(cursor);
  expect(lines.some((line) => line.startsWith("indexer: resuming"))).toBe(false);
  expect(lines.some((line) => line.startsWith("serve: keeper on"))).toBe(false);

  // The process then ends with 1, and the services are stopped first: the database is let go.
  const printed: string[] = [];
  const exits: number[] = [];
  await exitOnFailure(
    services,
    {
      exit: (code) => {
        exits.push(code);
      },
    },
    { print: (line) => printed.push(line) },
  );
  expect(exits).toEqual([1]);
  expect(printed).toEqual([`serve: ${error.message}`]);
  expect(lines.at(-1)).toBe("serve: stopped");
  await (await openDb(url)).close();
});

test("serve_does_not_take_one_short_count_for_the_index_of_another_chain", async () => {
  const { url } = await indexedCopy();
  // One read of the count comes out short, and the next is the chain's own.
  const odd = chainThatCountsShortOnce(0n);
  const lines: string[] = [];
  const services = await serve(envFor({ DATABASE_URL: url, ...keeperEnv(200) }), lines, {
    deployment: { chain: odd.chain, retryMs: 20, longestMs: 40 },
  });

  const waits = waitsOf(lines);
  expect(waits).toHaveLength(1);
  expect(waits[0]).toMatch(
    /\(the node counts 0 tasks, fewer than the \d+ the database holds, though its final block, \d+, is past the last block the index took, \d+: reading again before the database is taken for another deploy's\)/,
  );
  // The second read agrees with the database: the indexer and the keeper start, and nothing ends.
  await until(
    "the keeper and the indexer start",
    async () => lines.some((line) => line.startsWith("serve: keeper on")),
    30_000,
  );
  expect(lines).toContain(
    "indexer: the database matches the chain; starting the indexer and the keeper",
  );
  expect(odd.asks.count).toBe(2);
  expect(lines.filter((line) => line.startsWith("ERROR"))).toEqual([]);
  expect(await stillPending(services.failed)).toBe(true);
  await services.stop();
});

test("serve_refuses_an_index_that_is_ahead_of_the_chain_as_one_of_a_new_chain", async () => {
  const { url, cursor } = await indexedCopy();
  // The chain was started afresh under the same contract name: its blocks are below the cursor.
  const ahead = cursor + 1_000_000n;
  await changing(url, async (db) => {
    await db.query("update chain_cursor set height = $1", [ahead]);
  });
  const lines: string[] = [];
  // On the sandbox the node is the index's own source, so a block below the cursor is no lag: the
  // first read refuses, and the start throws like any refusal to start.
  const failure = await serve(envFor({ DATABASE_URL: url }), lines).then(
    () => undefined,
    (error: unknown) => error as Error,
  );
  expect(failure).toBeInstanceOf(IndexerError);
  expect(failure?.message).toContain(
    `the index took block ${ahead}, but the final block of sandbox at the node is`,
  );
  expect(failure?.message).toContain("a new chain under this contract name needs a new database");
  // What had started is stopped, and nothing was written: the directory opens again.
  expect(lines.some((line) => line.startsWith("indexer: resuming"))).toBe(false);
  expect(lines.filter((line) => line.startsWith("ERROR"))).toEqual([]);
  await (await openDb(url)).close();
});

test("serve_waits_for_a_node_behind_the_index_off_the_sandbox_and_says_so_now_and_then", async () => {
  const { url, cursor } = await indexedCopy();
  // A node 500 blocks below the index, as one that is catching up is. The check is given what a
  // network off the sandbox gets: a skew of 20 blocks, and 100000 blocks before no lag explains it.
  const lagging = chainThatLags(cursor, 500n);
  const lines: string[] = [];
  const services = await serve(envFor({ DATABASE_URL: url, ...keeperEnv(200) }), lines, {
    deployment: {
      chain: lagging.chain,
      skewBlocks: 20n,
      lagLimitBlocks: 100_000n,
      retryMs: 20,
      longestMs: 40,
      behindWarnMs: 1_000,
    },
  });

  const waits = waitsOf(lines);
  expect(waits).toHaveLength(1);
  expect(waits[0]).toContain(
    `(the final block of the node, ${cursor - 500n}, is 500 blocks below the last block the index ` +
      `took, ${cursor}: the node is behind, and is waited for)`,
  );

  // The wait goes on and says so again after a second, though the node is asked every 20 ms or so.
  await until("the wait says so again", async () => waitsOf(lines).length >= 2, 10_000);
  expect(lagging.asks.final).toBeGreaterThan(waitsOf(lines).length * 2);
  // Meanwhile the API serves the index as it is, the services do not end, and nothing has started.
  const served = await health(services.url);
  expect(served.status).toBe(200);
  expect(BigInt(served.body.indexed_height)).toBe(cursor);
  // `lag_blocks` cannot show a node that is behind the index, which is why health says it, and
  // keeps saying it between the WARN lines.
  expect(served.body.waiting_for_chain).toBe(true);
  await sleep(100);
  expect((await health(services.url)).body.waiting_for_chain).toBe(true);
  expect(await stillPending(services.failed)).toBe(true);
  expect(lines.some((line) => line.startsWith("indexer: resuming"))).toBe(false);
  expect(lines.some((line) => line.startsWith("serve: keeper on"))).toBe(false);

  // Once the node has caught up, the database is found to match, and they start.
  lagging.catchUp();
  await until(
    "the keeper and the indexer start",
    async () => lines.some((line) => line.startsWith("serve: keeper on")),
    30_000,
  );
  expect((await health(services.url)).body.waiting_for_chain).toBe(false);
  expect(lines).toContain(
    "indexer: the database matches the chain; starting the indexer and the keeper",
  );
  expect(lines.filter((line) => line.startsWith("ERROR"))).toEqual([]);
  expect(await stillPending(services.failed)).toBe(true);
  await services.stop();
});

test("stopping_ends_the_wait_for_a_chain_that_never_answers", async () => {
  const { url } = await indexedCopy();
  const down = chainThatFails({ final: Number.MAX_SAFE_INTEGER, count: 0 });
  const lines: string[] = [];
  const services = await serve(envFor({ DATABASE_URL: url }), lines, {
    deployment: { chain: down.chain, retryMs: 20, longestMs: 40 },
  });
  await until("the node has been asked several times", async () => down.asks.final >= 5, 10_000);
  expect((await health(services.url)).status).toBe(200);

  const stopped = Date.now();
  await services.stop();
  expect(Date.now() - stopped).toBeLessThan(5_000);
  // Nothing asks the node after the stop, and nothing was refused: the node was only waited for.
  const asked = down.asks.final;
  await sleep(300);
  expect(down.asks.final).toBe(asked);
  expect(lines.filter((line) => line.startsWith("ERROR"))).toEqual([]);
  expect(lines.some((line) => line.startsWith("indexer: resuming"))).toBe(false);
  expect(lines.at(-1)).toBe("serve: stopped");
});

// ---- The PGlite directory, lost -----------------------------------------------------------------

/** What another process writes into a lock it has taken over. */
const TAKEN_LOCK = `${JSON.stringify({ token: "another-process", pid: 4242, host: "some-host.local" })}\n`;

test("serve_ends_on_a_pglite_directory_that_another_process_took_over", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tender-serve-pglite-"));
  dirs.push(dir);
  const index = join(dir, "index");
  const lines: string[] = [];
  // A beat every 40 ms and a lock that lasts 600 ms, so that a loss shows at once.
  const services = await serve(envFor({ DATABASE_URL: `pglite:${index}` }), lines, {
    pgliteLock: { beatMs: 40, staleMs: 600 },
  });
  expect((await health(services.url)).status).toBe(200);
  // The beats go on, and lose nothing.
  expect(await stillPending(services.failed, 300)).toBe(true);

  // Another process takes the directory over, as it does from a holder that was away too long.
  const lock = join(index, "tender.lock");
  await writeFile(lock, TAKEN_LOCK);
  const error = await services.failed;
  expect(error).toBeInstanceOf(PgliteLockLostError);
  expect(error.message).toContain(
    `the PGlite directory ${index} is no longer this process's: process 4242 on some-host.local ` +
      "has made its own lock there",
  );

  // The process ends with 1, through the same failure as a refusal that comes late. The stop does
  // not touch the other process's lock, and lets this process's claim on the directory go.
  const printed: string[] = [];
  const exits: number[] = [];
  await exitOnFailure(
    services,
    {
      exit: (code) => {
        exits.push(code);
      },
    },
    { print: (line) => printed.push(line) },
  );
  expect(exits).toEqual([1]);
  expect(printed).toEqual([`serve: ${error.message}`]);
  expect(lines.at(-1)).toBe("serve: stopped");
  expect(await readFile(lock, "utf8")).toBe(TAKEN_LOCK);
  await rm(lock);
  await (await openDb(`pglite:${index}`)).close();
});

// ---- The process itself ------------------------------------------------------------------------

/**
 * `scripts/serve.ts` as `pnpm serve` runs it, in a process of its own on `env` alone, so that
 * nothing of this process's own reaches it, and nothing of the repository's: its env files and
 * `deployments/` are those of `emptyEnvDir` (`TENDER_ENV_DIR`), unless `env` names another. What
 * it prints is kept, and `printed` and `end` wait for it, failing with everything it printed if it
 * ends first or takes too long.
 */
function runServe(env: Record<string, string>) {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/serve.ts"], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH ?? "", TENDER_ENV_DIR: emptyEnvDir, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  let ended: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  // "close", not "exit": by then everything the process printed has been read.
  child.once("close", (code, signal) => {
    ended = { code, signal };
  });

  const waitFor = async (what: string, check: () => boolean, ms: number): Promise<void> => {
    try {
      await until(
        what,
        async () => {
          if (check()) return true;
          if (ended !== undefined) throw new Error(`the process ended (${JSON.stringify(ended)})`);
          return false;
        },
        ms,
      );
    } catch (error) {
      throw new Error(
        `${(error as Error).message} before ${what}\n--- stdout ---\n${stdout}--- stderr ---\n${stderr}`,
      );
    }
  };
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    hasEnded: () => ended !== undefined,
    /** Where the API listens, once the process has said so. */
    apiUrl: () => /^serve: API at (\S+),/m.exec(stdout)?.[1],
    /** Waits until a line of its output matches `pattern`. */
    printed: (pattern: RegExp, ms = 90_000) =>
      waitFor(`the process prints ${pattern}`, () => pattern.test(stdout), ms),
    /** Waits until the process ends, and says how. */
    async end(ms = 90_000) {
      await waitFor("the process ends", () => ended !== undefined, ms);
      return ended as NonNullable<typeof ended>;
    },
  };
}

test("the_process_exits_with_1_on_the_index_of_another_chain", async () => {
  const { url } = await indexedCopy();
  await changing(url, (db) => indexTask(db, 999));
  const run = runServe(envFor({ DATABASE_URL: url }));
  try {
    // It serves for the first read, and ends with the second, two seconds later.
    const { code } = await run.end();
    expect(code, run.stderr()).toBe(1);
    expect(run.stdout()).toMatch(/^serve: API at /m);
    expect(run.stdout()).toMatch(
      /^WARN indexer: cannot check the database against the chain yet \(the node counts \d+ tasks, fewer than the 999 /m,
    );
    expect(run.stdout()).not.toMatch(/^indexer: resuming/m);
    expect(run.stderr()).toMatch(
      /^serve: the database holds task 999, but .* has made \d+ on sandbox, as read at its final block \d+, past the last block the index took \(\d+\), on 2 reads in a row\. Either the node at NEAR_RPC_URL is behind the chain: wait for it/m,
    );
  } finally {
    run.child.kill("SIGKILL");
  }
}, 180_000);

test("the_process_exits_with_1_when_another_process_takes_its_pglite_directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tender-serve-pglite-"));
  dirs.push(dir);
  const index = join(dir, "index");
  const run = runServe(envFor({ DATABASE_URL: `pglite:${index}` }));
  try {
    await run.printed(/^serve: API at /m);
    const lock = join(index, "tender.lock");
    await writeFile(lock, TAKEN_LOCK);
    // The holder finds out at its next beat, which is every 10 s.
    const { code } = await run.end(60_000);
    expect(code, run.stderr()).toBe(1);
    expect(run.stderr()).toContain(
      `serve: the PGlite directory ${index} is no longer this process's: process 4242 on ` +
        "some-host.local has made its own lock there",
    );
    // The other process's lock is as it left it.
    expect(await readFile(lock, "utf8")).toBe(TAKEN_LOCK);
  } finally {
    run.child.kill("SIGKILL");
  }
}, 180_000);

/**
 * What `pnpm serve` reads for a testnet whose node is the local chain's, so that the check of the
 * database against the chain has the defaults that a network off the sandbox gets. The index in
 * `url` is made the testnet's, with its cursor at `cursor`.
 */
async function offSandbox(url: string, cursor: bigint): Promise<Record<string, string>> {
  await changing(url, async (db) => {
    await db.query("update chain_cursor set source = $1, height = $2", [
      `testnet:${chain.contractId}`,
      cursor,
    ]);
  });
  return {
    TENDER_NETWORK: "testnet",
    TENDER_CONTRACT: chain.contractId,
    NEAR_RPC_URL: chain.rpcUrl,
    DATABASE_URL: url,
    API_PORT: "0",
    PUBLIC_API_URL: "http://127.0.0.1:3001",
    INDEXER_START_HEIGHT: "1",
  };
}

test("off_the_sandbox_the_process_waits_for_a_node_behind_the_index_and_ends_only_on_a_gap_no_lag_explains", async () => {
  const final = await reader.finalHeight();

  // A node 500 blocks behind the index, which is waited for. The first try is told, and the later
  // ones are not for a minute.
  const lagging = runServe(await offSandbox((await indexedCopy()).url, final + 500n));
  try {
    await lagging.printed(
      /^WARN indexer: cannot check the database against the chain yet \(the final block of the node, \d+, is \d+ blocks below the last block the index took, \d+: the node is behind, and is waited for\); trying again in 2 s$/m,
    );
    // Past the second try, at 2 s: the wait does not end the process, and the API serves.
    await sleep(3_000);
    expect(lagging.hasEnded(), lagging.stderr()).toBe(false);
    expect(
      lagging.stdout().match(/^WARN indexer: cannot check the database against the chain yet/gm),
    ).toHaveLength(1);
    expect(lagging.stdout()).not.toMatch(/^indexer: resuming/m);
    const apiUrl = lagging.apiUrl();
    expect(apiUrl).toBeDefined();
    expect((await health(apiUrl as string)).status).toBe(200);
    // It stops when it is told to, and that is no failure.
    lagging.child.kill("SIGTERM");
    const { code } = await lagging.end(30_000);
    expect(code, lagging.stderr()).toBe(0);
  } finally {
    lagging.child.kill("SIGKILL");
  }

  // A cursor 200000 blocks past the node's: no lag explains that, so the process ends with 1, and
  // says that the node is most likely of another network. It says so after two reads in a row, the
  // first told with a WARN, since the final height can come from a node of a load-balanced RPC
  // that has just restarted.
  const far = runServe(await offSandbox((await indexedCopy()).url, final + 200_000n));
  try {
    const { code } = await far.end();
    expect(code, far.stderr()).toBe(1);
    expect(far.stdout()).toMatch(
      /^WARN indexer: cannot check the database against the chain yet \(the final block of the node, \d+, is \d+ blocks below the last block the index took, \d+, more than any lag explains: reading again before the node is taken for one of another network\); trying again in 2 s$/m,
    );
    expect(far.stderr()).toMatch(
      /^serve: the index took block \d+, but the final block of testnet at the node is \d+, \d+ blocks below it, on 2 reads in a row\. No lag explains a gap that size: the node at NEAR_RPC_URL is most likely on another network than testnet\. Point NEAR_RPC_URL at a testnet node, and start the services again\. Or this is a new chain under the contract name /m,
    );
  } finally {
    far.child.kill("SIGKILL");
  }
}, 240_000);

/**
 * A token as the email login signs one: a JWT with ES256, made here with node's crypto. The route
 * verifies it as it does a real one.
 */
function loginToken(key: KeyObject, claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signed = `${part({ alg: "ES256", typ: "JWT", kid: "sandbox-key" })}.${part(claims)}`;
  const signature = sign("sha256", Buffer.from(signed), { key, dsaEncoding: "ieee-p1363" });
  return `${signed}.${signature.toString("base64url")}`;
}

test("the_gas_gift_creates_a_new_implicit_account_with_its_first_near_once", async () => {
  const login = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  // Alice's key is a full-access key of a local account that is not the contract's owner.
  const gift = chain.accounts.alice;
  const lines: string[] = [];
  // The three variables the gift needs, as the owner sets them. The login's tokens are checked
  // against a key set: here the test's own, in place of the one Privy publishes, which is never
  // called. It is asked for the key of each token, as a published one is.
  const asked: unknown[] = [];
  const services = await serve(
    envFor({
      GAS_GIFT_ACCOUNT: gift.accountId,
      GAS_GIFT_PRIVATE_KEY: gift.privateKey,
      PRIVY_APP_ID: "tender-sandbox-app",
    }),
    lines,
    {
      gasGiftKeys: async (header) => {
        asked.push(header.kid);
        return login.publicKey;
      },
    },
  );
  expect(lines).toContain(
    `serve: gas gift on, from ${gift.accountId}: 0.1 NEAR to each new account, 2 NEAR a day ` +
      "at most; login tokens checked with the app's published keys",
  );

  const key = KeyPair.fromRandom("ed25519");
  const publicKey = key.getPublicKey().toString();
  const implicit = implicitAccountOf(publicKey);
  if (implicit === null) throw new Error("a fresh ed25519 key has no implicit account");
  // Nobody has sent it NEAR: it is not on chain.
  expect(await reader.nearBalanceOf(implicit)).toBe(0n);
  expect(await reader.viewAccessKey(implicit, publicKey)).toBeNull();

  const now = Math.floor(Date.now() / 1000);
  const token = loginToken(login.privateKey, {
    iss: "privy.io",
    aud: "tender-sandbox-app",
    sub: "did:privy:sandbox-user",
    sid: "sandbox-session",
    iat: now,
    exp: now + 3600,
  });
  const askFor = (accountId: string) =>
    fetch(`${services.url}/v1/gas-gift`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ account_id: accountId }),
    });

  const res = await askFor(implicit);
  expect(res.status).toBe(200);
  expect(asked).toEqual(["sandbox-key"]);
  const sent = GasGiftResponseSchema.parse(await res.json());
  expect(sent).toMatchObject({ status: "sent", amount: "100000000000000000000000" });
  if (sent.status !== "sent") throw new Error("the gift was not sent");
  expect((await reader.txStatus(sent.tx_hash, gift.accountId)).kind).toMatch(
    /^(executed|pending)$/,
  );

  // The route answers once the transfer has executed; the final view catches up within blocks.
  await until(
    "the gift is in the final view",
    async () => (await reader.nearBalanceOf(implicit)) > 0n,
    15_000,
  );
  expect(await reader.nearBalanceOf(implicit)).toBe(100_000_000_000_000_000_000_000n);
  // The transfer made the account, with the key its name is the hex of as its full-access key.
  expect(await reader.viewAccessKey(implicit, publicKey)).toEqual({ permission: "FullAccess" });
  // And it succeeded, once all of it is final (its refund receipt comes a block later).
  await until(
    "the gift's transaction is final",
    async () => (await reader.txStatus(sent.tx_hash, gift.accountId)).kind !== "pending",
    15_000,
  );
  expect((await reader.txStatus(sent.tx_hash, gift.accountId)).kind).toBe("executed");

  // Once per login: the same login, for the same account and for another, gets nothing more.
  const twice = await askFor(implicit);
  expect(twice.status).toBe(409);
  expect(await twice.json()).toMatchObject({ error: "already_given" });
  const other = implicitAccountOf(KeyPair.fromRandom("ed25519").getPublicKey().toString());
  if (other === null) throw new Error("a fresh ed25519 key has no implicit account");
  const elsewhere = await askFor(other);
  expect(elsewhere.status).toBe(409);
  expect(await reader.nearBalanceOf(other)).toBe(0n);

  await services.stop();
  expect(lines.filter((line) => line.startsWith("ERROR"))).toEqual([]);
  // Nothing the services wrote holds the key or the token.
  expect(lines.filter((line) => line.includes(gift.privateKey) || line.includes(token))).toEqual(
    [],
  );
});
