import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { ApiClient, type LocalChain, startLocalChain, TenderClient } from "@tender/client";
import { type Db, migrate, openDb, type SessionLock } from "@tender/db";
import { sha256Hex } from "@tender/shared";
import { BOT_COMMANDS } from "@tender/telegram";
import { KeyPair } from "near-api-js";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { addRoleKey } from "./keeper-key";
import {
  checkJudgeKey,
  checkKeeperKey,
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
let keyDir: string;
/** The keeper's and the Judge's function-call keys, as the key script wrote them. */
let keeperKey: string;
let judgeKey: string;
const running: Services[] = [];
const fakes: FakeBotApi[] = [];
/** Directories of the tests' own, such as a PGlite database's. */
const dirs: string[] = [];

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
  await Promise.all(running.map((services) => services.stop()));
  await Promise.all(fakes.map((fake) => fake.close()));
  await chain?.stop();
  for (const dir of [deploymentsDir, keyDir, ...dirs]) {
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
  // Nothing was asked of a keeper, a Judge or a bot, and none runs.
  expect(lines).toContain("serve: keeper off (KEEPER_PRIVATE_KEY is not set)");
  expect(lines).toContain("serve: Judge off (JUDGE_PRIVATE_KEY is not set)");
  expect(lines).toContain("serve: Telegram off (TELEGRAM_BOT_TOKEN is not set)");
  // No Telegram webhook either.
  expect((await fetch(`${services.url}${TELEGRAM_WEBHOOK_PATH}`, { method: "POST" })).status).toBe(
    404,
  );

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
  expect((await fetch(`${services.url}/v1/tasks/${taskId}`)).status).toBe(200);

  // Once the node answers, the database is found to match, and they start.
  await until(
    "the keeper and the indexer start",
    async () => lines.some((line) => line.startsWith("serve: keeper on")),
    30_000,
  );
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

test("serve_refuses_the_index_of_another_chain_and_goes_on_serving_it", async () => {
  const { url, cursor } = await indexedCopy();
  // A task the chain has not made: the index of a contract that was made again under this name.
  await changing(url, (db) => indexTask(db, 999));
  const lines: string[] = [];
  const services = await serve(envFor({ DATABASE_URL: url, ...keeperEnv(200) }), lines);

  const refused = lines.filter((line) => line.startsWith("ERROR"));
  expect(refused).toHaveLength(1);
  expect(refused[0]).toMatch(
    /^ERROR indexer: cannot start the indexer and the keeper \(the database holds task 999, but .* has made \d+ on sandbox, as read at its final block \d+, past the last block the index took \(\d+\)\. Either the node at NEAR_RPC_URL is behind the chain: wait for it/,
  );
  expect(refused[0]).toContain(
    "use a new database for this deploy (one database per contract deploy)",
  );
  expect(refused[0]).toMatch(/; not trying again$/);

  // The API serves, and nothing writes: the cursor stays where it was while the chain moves on.
  await postTask();
  await sleep(1_500);
  expect((await health(services.url)).status).toBe(200);
  expect(BigInt((await health(services.url)).body.indexed_height)).toBe(cursor);
  expect(lines.some((line) => line.startsWith("indexer: resuming"))).toBe(false);
  expect(lines.some((line) => line.startsWith("serve: keeper on"))).toBe(false);

  // It stops all the same, and lets the database go.
  await services.stop();
  expect(lines.at(-1)).toBe("serve: stopped");
  await (await openDb(url)).close();
});

test("serve_refuses_an_index_that_is_ahead_of_the_chain_as_one_of_a_new_chain", async () => {
  const { url, cursor } = await indexedCopy();
  // The chain was started afresh under the same contract name: its blocks are below the cursor.
  const ahead = cursor + 1_000_000n;
  await changing(url, async (db) => {
    await db.query("update chain_cursor set height = $1", [ahead]);
  });
  const lines: string[] = [];
  const services = await serve(envFor({ DATABASE_URL: url }), lines);

  const refused = lines.filter((line) => line.startsWith("ERROR"));
  expect(refused).toHaveLength(1);
  expect(refused[0]).toContain(
    `the index took block ${ahead}, but the final block of sandbox at the node is`,
  );
  expect(refused[0]).toContain("a new chain under this contract name needs a new database");
  expect((await health(services.url)).status).toBe(200);
  expect(lines.some((line) => line.startsWith("indexer: resuming"))).toBe(false);
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
