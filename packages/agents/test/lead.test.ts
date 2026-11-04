import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type SignedTx, TenderError, type TxResult, type TxStatus } from "@tender/client";
import { createStateStore, isDraftOf, type StateStore } from "@tender/mcp";
import {
  canonicalJson,
  computeCommitment,
  type EntryView,
  type PostTaskInput,
  type SpendOptions,
  sha256Hex,
  type TaskDetailResponse,
  type TaskOutcome,
  type TaskView,
  type TenderApi,
} from "@tender/shared";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createLeadSolver, LEAD_TAG, type LeadChain, type LeadSolver } from "../src/agents/lead";
import { type AgentChain, type AgentMemory, agentTick } from "../src/runner";
import type { TaskContext } from "../src/types";
import {
  BRIEF,
  CRITERIA,
  JUDGE,
  POSTER,
  picked,
  taskDetailResponse,
  taskSpec,
  taskSummary,
  voided,
} from "./helpers";
import { PowerCut, PowerFs } from "./power-fs";

// The lead agent of the swarm demo, with a stand-in chain and a stand-in API in one small world.
// The pack is the demo's own (scripts/swarm-research-pack), so the happy path also shows that what
// the lead assembles from the pack's solutions is the pack's parent solution. The parent is entered
// the way the runner enters it (`agentTick`, which commits what `solve` returns as the placeholder),
// and the lead's job is driven a pass (`tick`) at a time, as its host's loop would drive it.

const PACK = join(import.meta.dirname, "../../../scripts/swarm-research-pack");
const CHILDREN = join(PACK, "children");
const SLUGS = ["01-gas-ledger", "02-key-audit", "03-event-tally"];

const LEAD = "lead.test.near";
const ALICE = "alice.test.near";
const BOB = "bob.test.near";
const STRANGER = "stranger.test.near";
const KEY = "ed25519:Fj4yBuvGfEKKEEqx4DkXtgWUzGPrNwUUU4wP3P8r1AD9";
/** A token the client's network knows the decimals of (6, so 2.00 is 2_000_000). */
const TOKEN = "tusdc.test.near";
const CONTRACT = "tender.test.near";
const PARENT_ID = 10;
const NS = 1_000_000_000n;
/** The chain's clock at the start, in nanoseconds. Moves only when the world moves it. */
const T0 = 1_700_000_000n * NS;
/** Room for every entry the runner makes. */
const STORAGE = {
  total: "1000000000000000000000000",
  available: "1000000000000000000000000",
  used_bytes: "0",
};

const solutionOf = (slug: string): string =>
  readFileSync(join(CHILDREN, slug, "solution.txt"), "utf8");

interface Child {
  id: bigint;
  input: PostTaskInput;
  opts: SpendOptions | undefined;
  polls: number;
}

interface WorldOptions {
  /** The parent's commit window, in seconds from the start. Default one hour. */
  commitSecs?: number;
  /** The poll on which each child settles (1 is the first poll that finds it), by child order. */
  settleOn?: number[];
  /** Who wins each child, by child order. */
  winners?: string[];
  /** The outcome that replaces a pick, by child order. */
  voidChild?: number;
  /** The content the winner of each child revealed. Default: the pack's solution. */
  contents?: string[];
  /** Children never settle, and each poll moves the clock on by this many seconds. */
  stall?: { secs: number };
  /** Makes the post of child number `n` (from 0) fail once with this error; it does not land. */
  failPost?: { n: number; error: Error };
  /** Child number `n` lands, and the answer to the post is lost: the client times out. */
  lostPost?: { n: number };
  /**
   * Child number `n` is slow, as under congestion: the client gives up (`E_TIMEOUT`) after
   * `giveUpSecs` of chain time, and the transaction lands `landsAfterSecs` after it was sent, or
   * never if that is huge.
   */
  slowPost?: { n: number; giveUpSecs: number; landsAfterSecs: number };
  /**
   * This many other tasks are made on the chain just before the lead's lost or slow post lands, or
   * while a post that fails to be signed is waiting.
   */
  crowd?: number;
  /** The signing of child number `n` fails once, before there is a transaction: nothing is sent. */
  signFails?: { n: number };
  /**
   * Child number `n`'s transaction fails on chain `times` times, with this error: the client throws
   * it, and the chain keeps the failure.
   */
  failedPost?: { n: number; times: number; error: TenderError; clientSees?: Error };
  /** The node has forgotten every transaction: `txStatus` says unknown, always. */
  forgetTxs?: boolean;
  /** The Nth call of `txStatus` throws once, as a node that does not answer would. */
  failTxStatus?: number;
  /** Makes the Nth commit (from 1) fail once; the default is the first. With no `n`, every one. */
  failCommit?: { error: Error; n?: number };
  /** The Nth call of the API's `getTask` for a child throws once; "always" makes every one throw. */
  failGetTask?: number | "always";
  /** The Nth call of the API's `getBlob` throws once. */
  failGetBlob?: number;
  /** The Nth read of the chain's clock throws once. */
  failClock?: number;
  /** Each post takes this long in real time. */
  postDelayMs?: number;
  /** The delegate key's caps as `get_delegate` shows them; null for a key that is no delegate. */
  caps?: { token?: string; per_task_cap?: string; total_cap?: string; spent?: string } | null;
  /** The lead's vault. Default 6.00, which pays for the pack exactly. */
  vault?: bigint;
  /**
   * Things that happen at a given moment of a hire, to lose power or to let a disk flush at an
   * unlucky one. `n` is the number of the child, from 0. A hook that throws ends the hire there.
   */
  hooks?: {
    /** The hire of child `n` begins: its brief is about to go up. */
    beforeHire?: (n: number) => void;
    /** The client is about to sign the post of child `n`. */
    beforeSign?: (n: number) => void;
    /** The post of child `n` is signed and its hook has run; the transaction is about to be sent. */
    beforeLand?: (n: number, tx: SignedTx) => void;
    /** The post of child `n` has landed on the chain, and the client has not answered yet. */
    afterLand?: (n: number) => void;
  };
}

/** A small world: a chain with a clock, an index of tasks, and the events in the order they happen. */
function buildWorld(o: WorldOptions = {}) {
  const events: string[] = [];
  const children: Child[] = [];
  const blobs = new Map<string, Uint8Array>();
  const uploads: Array<{ kind: string; sha256: string }> = [];
  const heldouts: string[] = [];
  const commits: Array<{ taskId: bigint; commitment: string }> = [];
  const reveals: Array<{ taskId: bigint; contentHash: string; uri: string }> = [];
  const entries = new Map<string, EntryView>();
  let now = T0;
  let childPolls = 0;
  let blobReads = 0;
  let clockReads = 0;
  let commitCalls = 0;
  /** The `limit` of every page of tasks the lead read. */
  const pageReads: number[] = [];
  let postFailed = false;
  let slowSent = false;
  const world = { phase: "open" as "open" | "revealing" };

  const parentCommitDeadline = T0 + BigInt(o.commitSecs ?? 3600) * NS;
  /** The number of tasks on the chain: the ids are 1 to this. */
  let total = BigInt(PARENT_ID);
  const nextId = () => {
    total += 1n;
    return total;
  };
  /** Posts the client gave up on that are still on their way. */
  const pending: Array<{
    input: PostTaskInput;
    opts: SpendOptions | undefined;
    landAt: bigint;
    txHash: string;
  }> = [];
  /** What the chain says of each transaction the client signed, by hash. */
  const txs = new Map<
    string,
    | { kind: "unsent" }
    | { kind: "on its way" }
    | { kind: "executed"; taskId: bigint }
    | { kind: "failed"; error: TenderError }
  >();
  let signedCount = 0;
  let signFailed = false;
  let failedTimes = 0;
  let txStatusCalls = 0;
  /** Lets the posts that are due land. Every read of the chain starts with it. */
  const land = () => {
    for (const post of pending.filter((one) => one.landAt <= now)) {
      pending.splice(pending.indexOf(post), 1);
      total += BigInt(o.crowd ?? 0);
      const id = nextId();
      children.push({ id, input: post.input, opts: post.opts, polls: 0 });
      txs.set(post.txHash, { kind: "executed", taskId: id });
    }
  };
  /** A task as the chain shows it: the lead's child, or one of somebody else's. */
  const viewOf = (id: bigint): TaskView => {
    const child = children.find((one) => one.id === id);
    return (
      child === undefined
        ? { id: String(id), poster: STRANGER, parent: null, brief_hash: "0".repeat(64) }
        : {
            id: String(id),
            poster: LEAD,
            parent: String(PARENT_ID),
            brief_hash: child.input.briefHash,
          }
    ) as TaskView;
  };

  const client: LeadChain & AgentChain = {
    network: "testnet",
    contractId: CONTRACT,
    accountId: LEAD,
    async commit(taskId, commitment) {
      commitCalls += 1;
      events.push("commit");
      const failing = o.failCommit;
      if (failing !== undefined && (failing.n === undefined || failing.n === commitCalls)) {
        throw failing.error;
      }
      commits.push({ taskId, commitment });
      entries.set(String(taskId), {
        task_id: String(taskId),
        account: LEAD,
        index: 0,
        commitment,
        committed_at_block: "1000",
        content_hash: null,
        uri: null,
      });
      return { txHash: "tx-commit" } as TxResult;
    },
    async reveal(taskId, contentHash, _salt, uri) {
      reveals.push({ taskId, contentHash, uri });
      return { txHash: "tx-reveal" } as TxResult;
    },
    async storageBalanceOf() {
      return STORAGE;
    },
    async getEntry(taskId) {
      return entries.get(String(taskId)) ?? null;
    },
    async postTask(input, opts, sendHooks) {
      land();
      const n = children.length;
      events.push(`post ${n}`);
      if (o.postDelayMs !== undefined) await delay(o.postDelayMs);
      o.hooks?.beforeSign?.(n);
      if (o.signFails?.n === n && !signFailed) {
        signFailed = true;
        // Other people's tasks pile up on the chain meanwhile.
        total += BigInt(o.crowd ?? 0);
        throw new Error("the node did not answer");
      }
      // Signed. From here on the transaction may be sent, and its hash is known to the caller.
      signedCount += 1;
      const tx: SignedTx = {
        txHash: `tx-${n}-${signedCount}`,
        signerId: LEAD,
        publicKey: KEY,
        nonce: BigInt(signedCount),
        blockHash: "7".repeat(44),
        blockHeight: 1000n + BigInt(signedCount),
      };
      txs.set(tx.txHash, { kind: "unsent" });
      await sendHooks?.beforeSend?.(tx);
      o.hooks?.beforeLand?.(n, tx);
      if (o.failPost?.n === n && !postFailed) {
        // It never reached the node: the chain has no record of it, and the caller cannot know.
        postFailed = true;
        throw o.failPost.error;
      }
      if (o.failedPost?.n === n && failedTimes < o.failedPost.times) {
        failedTimes += 1;
        txs.set(tx.txHash, { kind: "failed", error: o.failedPost.error });
        throw o.failedPost.clientSees ?? o.failedPost.error;
      }
      if (o.slowPost?.n === n && !slowSent) {
        slowSent = true;
        pending.push({
          input,
          opts,
          landAt: now + BigInt(o.slowPost.landsAfterSecs) * NS,
          txHash: tx.txHash,
        });
        txs.set(tx.txHash, { kind: "on its way" });
        now += BigInt(o.slowPost.giveUpSecs) * NS;
        throw new TenderError("E_TIMEOUT", "TenderClient.send timed out; the transaction may land");
      }
      if (o.lostPost?.n === n && !postFailed) total += BigInt(o.crowd ?? 0);
      const id = nextId();
      children.push({ id, input, opts, polls: 0 });
      txs.set(tx.txHash, { kind: "executed", taskId: id });
      // A post takes a few seconds of chain time.
      now += 3n * NS;
      o.hooks?.afterLand?.(n);
      if (o.lostPost?.n === n && !postFailed) {
        postFailed = true;
        throw new TenderError("E_TIMEOUT", "TenderClient.send timed out; the transaction may land");
      }
      return { txHash: tx.txHash, taskId: id } as TxResult & { taskId: bigint };
    },
    async txStatus(txHash): Promise<TxStatus> {
      land();
      txStatusCalls += 1;
      if (o.failTxStatus === txStatusCalls) {
        throw new TenderError("E_TIMEOUT", "TenderClient.txStatus timed out");
      }
      const state = o.forgetTxs ? undefined : txs.get(txHash);
      if (state === undefined || state.kind === "unsent") return { kind: "unknown" };
      if (state.kind === "on its way") return { kind: "pending" };
      if (state.kind === "failed") return { kind: "failed", error: state.error };
      return {
        kind: "executed",
        result: {
          txHash,
          events: [],
          returnValue: String(state.taskId),
          receipts: [],
        } as TxResult,
      };
    },
    async blockTimestampNs() {
      land();
      clockReads += 1;
      if (o.failClock === clockReads) throw new Error("the node did not answer");
      return now;
    },
    async taskCount() {
      land();
      return total;
    },
    async getTasks(fromId, limit) {
      land();
      pageReads.push(limit);
      const page: TaskView[] = [];
      for (let id = fromId; id <= total && page.length < limit; id++) page.push(viewOf(id));
      return page;
    },
    async balanceOf() {
      return o.vault ?? 6_000_000n;
    },
    async view<T>(_contract: string, method: string): Promise<T> {
      if (method !== "get_delegate") throw new Error(`unexpected view ${method}`);
      const caps = o.caps === undefined ? {} : o.caps;
      if (caps === null) return null as T;
      return {
        token: caps.token ?? TOKEN,
        per_task_cap: caps.per_task_cap ?? "2000000",
        total_cap: caps.total_cap ?? "6000000",
        spent: caps.spent ?? "0",
      } as T;
    },
  };

  const settled = (child: Child, index: number): TaskDetailResponse => {
    const winner = o.winners?.[index] ?? (index === 1 ? BOB : ALICE);
    const content = o.contents?.[index] ?? solutionOf(SLUGS[index] ?? "");
    const bytes = new TextEncoder().encode(content);
    const hash = sha256Hex(bytes);
    blobs.set(hash, bytes);
    const outcome: TaskOutcome =
      o.voidChild === index
        ? voided(Number(child.id), "no_reveals")
        : picked(Number(child.id), winner);
    const loser = winner === ALICE ? BOB : ALICE;
    const base = taskDetailResponse(
      taskSpec({
        id: Number(child.id),
        tags: ["extraction"],
        phase: "settled",
        outcome,
        entries: [
          // The loser comes first in the order of commits, so the lead must go by the winner.
          {
            account: loser,
            entry_index: 0,
            committed_height: "1",
            content_hash: sha256Hex("a weak answer"),
            uri: "https://api.test/v1/blobs/weak",
            revealed: true,
            is_team: true,
          },
          {
            account: winner,
            entry_index: 1,
            committed_height: "2",
            content_hash: hash,
            uri: `https://api.test/v1/blobs/${hash}`,
            revealed: true,
            is_team: true,
          },
        ],
      }),
    );
    return { ...base, task: { ...base.task, poster: LEAD, parent: String(PARENT_ID) } };
  };

  const parentSpec = () =>
    taskSpec({
      id: PARENT_ID,
      tags: [LEAD_TAG],
      phase: world.phase,
      poster: POSTER,
      createdAt: String(T0),
    });
  const parentTask = () => ({
    ...taskDetailResponse(parentSpec()).task,
    token: TOKEN,
    reward: "10000000",
    created_at: String(T0),
    commit_deadline: String(parentCommitDeadline),
  });

  const unexpected = (method: string) => () => {
    throw new Error(`unexpected call to api.${method}`);
  };
  const api: TenderApi = {
    // The question board (task questions): the lead neither asks nor answers, and reads no board.
    listQuestions: async () => null,
    askQuestion: unexpected("askQuestion"),
    answerQuestion: unexpected("answerQuestion"),
    postClarification: unexpected("postClarification"),
    async uploadBlob(blob) {
      if (blob.kind === "brief") o.hooks?.beforeHire?.(children.length);
      events.push(`upload ${blob.kind}`);
      const sha256 = sha256Hex(blob.bytes);
      blobs.set(sha256, blob.bytes);
      uploads.push({ kind: blob.kind, sha256 });
      return { sha256, uri: `https://api.test/v1/blobs/${sha256}` };
    },
    async uploadHeldout(commitment) {
      events.push("upload heldout");
      heldouts.push(commitment);
    },
    async getTask(id) {
      if (id === BigInt(PARENT_ID)) {
        return {
          ...taskDetailResponse(parentSpec()),
          task: parentTask(),
          brief: { ...BRIEF, tags: [LEAD_TAG] },
        };
      }
      childPolls += 1;
      if (o.failGetTask === "always" || o.failGetTask === childPolls) {
        throw new Error("the API timed out");
      }
      const index = children.findIndex((child) => child.id === id);
      const child = children[index];
      if (child === undefined) return null;
      child.polls += 1;
      // The index trails the chain: the first look finds nothing.
      if (child.polls === 1) return null;
      if (o.stall !== undefined) {
        now += BigInt(o.stall.secs) * NS;
        return { ...taskDetailResponse(taskSpec({ id: Number(id), tags: ["extraction"] })) };
      }
      const on = o.settleOn?.[index] ?? 2;
      if (child.polls - 1 >= on) return settled(child, index);
      return taskDetailResponse(taskSpec({ id: Number(id), tags: ["extraction"] }));
    },
    async getBlob(sha256) {
      blobReads += 1;
      if (o.failGetBlob === blobReads) throw new Error("the API timed out");
      return blobs.get(sha256) ?? null;
    },
    async listTasks(filter = {}) {
      const open = world.phase === "open" && (filter.tag === undefined || filter.tag === LEAD_TAG);
      return { tasks: open ? [taskSummary(parentSpec())] : [], next_cursor: null };
    },
    async start() {
      return { ok: true, working_count: 1 };
    },
    async listEntries() {
      return { entries: [] };
    },
    listAgents: unexpected("listAgents"),
    getAgent: unexpected("getAgent"),
    health: unexpected("health"),
    getScorecard: unexpected("getScorecard"),
    telegramLink: unexpected("telegramLink"),
    signIn: unexpected("signIn"),
  };

  const task = parentTask();
  const ctx: TaskContext = {
    task,
    brief: { ...BRIEF, tags: [LEAD_TAG] },
    criteria: CRITERIA,
  };

  return {
    client,
    api,
    ctx,
    events,
    children,
    uploads,
    heldouts,
    commits,
    reveals,
    blobs,
    pageReads,
    /** Lets the posts that are due land, as the next read of the chain would. */
    settle: land,
    state: world,
    /** Moves the chain's clock on. */
    advance(secs: number) {
      now += BigInt(secs) * NS;
    },
    now: () => now,
  };
}

type World = ReturnType<typeof buildWorld>;

let dirs: string[] = [];
let state: StateStore;
let stateDir: string;
let journalDir: string;
/** Ends every wait a test leaves behind, so that no lead outlives its test. */
let stop: AbortController;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "lead-state-"));
  journalDir = mkdtempSync(join(tmpdir(), "lead-journal-"));
  dirs = [stateDir, journalDir];
  state = createStateStore(stateDir);
  stop = new AbortController();
});
afterEach(() => {
  stop.abort();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function optionsOf(world: World, more: Partial<Parameters<typeof createLeadSolver>[0]> = {}) {
  return {
    seedsDir: CHILDREN,
    client: world.client,
    api: world.api,
    judgeAccount: JUDGE,
    token: TOKEN,
    delegateKey: KEY,
    posters: [POSTER],
    journalDir,
    state,
    // A hire is taken to take 5 s here, in place of 20, so that the short windows of a test fit.
    hireSecs: 5,
    pollMs: 1,
    backoffMs: 1,
    maxBackoffMs: 2,
    ...more,
  };
}

function leadOf(
  world: World,
  more: Partial<Parameters<typeof createLeadSolver>[0]> = {},
  lines: string[] = [],
): LeadSolver {
  return createLeadSolver({ ...optionsOf(world, more), log: (line) => lines.push(line) });
}

/** One tick of the runner, which enters the parent with what the lead's `solve` returns. */
async function enter(
  world: World,
  lead: LeadSolver,
  more: { solveTimeoutMs?: number; memory?: AgentMemory; lines?: string[] } = {},
): Promise<void> {
  await agentTick({
    name: "lead",
    client: world.client,
    api: world.api,
    state,
    tags: [LEAD_TAG],
    solver: lead,
    solveTimeoutMs: more.solveTimeoutMs,
    memory: more.memory,
    log: (line) => more.lines?.push(line),
  });
}

/** Passes over the lead's jobs until none is under way. */
async function finish(lead: LeadSolver, max = 600, each?: () => void): Promise<void> {
  for (let pass = 0; pass < max; pass++) {
    await lead.tick();
    each?.();
    if ((await lead.active()).length === 0) return;
    await delay(3);
  }
  throw new Error("the job did not end");
}

/** A post the journal notes: which part, and the transaction once it is signed. */
interface JobTx {
  slug: string;
  tx?: { txHash: string; publicKey: string; nonce: string; blockHash: string; blockHeight: string };
}

const jobOf = (parent = PARENT_ID) =>
  JSON.parse(readFileSync(join(journalDir, `${parent}.json`), "utf8")) as {
    status: string;
    reason?: string;
    hires: Array<{ slug: string; id: string; winner?: string }>;
    intent?: JobTx;
    unresolved?: JobTx;
    failedPosts?: { slug: string; count: number };
  };
const journalFiles = () => readdirSync(journalDir).filter((name) => name.endsWith(".json"));
const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes ?? new Uint8Array());
const parentSolution = () => readFileSync(join(PACK, "parent", "solution.txt"), "utf8");

async function finalAnswer(): Promise<unknown> {
  const draft = await state.getDraft(String(PARENT_ID));
  return JSON.parse(Buffer.from(draft?.contentBase64 ?? "", "base64").toString());
}

describe("the lead's job on a swarm task", () => {
  test("takes_the_parent_with_a_placeholder_and_hires_nothing_until_a_pass_runs", async () => {
    const world = buildWorld();
    const lead = leadOf(world);
    await enter(world, lead);

    // The runner committed what `solve` returned, as it commits any answer.
    expect(world.events).toEqual(["commit"]);
    expect(world.children).toHaveLength(0);
    const draft = await state.getDraft(String(PARENT_ID));
    expect(draft).not.toBeNull();
    if (draft === null) return;
    expect(Buffer.from(draft.contentBase64, "base64").toString()).toBe("placeholder");
    expect(draft.contentHash).toBe(sha256Hex("placeholder"));
    expect(draft.commitment).toBe(
      computeCommitment(BigInt(PARENT_ID), LEAD, draft.contentHash, draft.salt),
    );
    expect(draft.commitment).toBe(world.commits[0]?.commitment);
    expect(isDraftOf(draft, LEAD)).toBe(true);
    // Bound to this contract and this task, as the runner's drafts are.
    expect(draft.contractId).toBe(CONTRACT);
    expect(draft.taskCreatedAt).toBe(world.ctx.task.created_at);
    expect(draft.committedAt).toBeDefined();
    expect(draft.revealedUri).toBeUndefined();
    // The job is written down, under way.
    expect(jobOf().status).toBe("hiring");
    expect(await lead.active()).toEqual([String(PARENT_ID)]);
  });

  test("a_pass_hires_three_under_a_delegate_key_then_the_assembled_pack_replaces_the_placeholder", async () => {
    const world = buildWorld();
    const lines: string[] = [];
    const lead = leadOf(world, {}, lines);
    await enter(world, lead);
    await finish(lead);

    // The placeholder is the first thing on chain: a child needs an entry on the parent. The
    // assembled answer is the last.
    expect(world.events[0]).toBe("commit");
    expect(world.events.at(-1)).toBe("commit");
    expect(world.events.filter((event) => event === "commit")).toHaveLength(2);
    expect(world.commits.map((one) => one.taskId)).toEqual([BigInt(PARENT_ID), BigInt(PARENT_ID)]);

    // Three children, in the order of the pack, each uploaded before it is posted.
    expect(world.children).toHaveLength(3);
    expect(world.events.slice(1, -1)).toEqual([
      "upload brief",
      "upload criteria",
      "upload heldout",
      "post 0",
      "upload brief",
      "upload criteria",
      "upload heldout",
      "post 1",
      "upload brief",
      "upload criteria",
      "upload heldout",
      "post 2",
    ]);

    for (const [index, child] of world.children.entries()) {
      // A delegate spend: no deposit. A sub-task of the parent, judged by the Judge, paid in the
      // parent's token, with the held-out checks of its own.
      expect(child.opts).toEqual({ delegate: true });
      expect(child.input).toMatchObject({
        token: TOKEN,
        reward: 2_000_000n,
        verifier: JUDGE,
        parent: BigInt(PARENT_ID),
        maxWinners: 1,
        commitSecs: 600,
        revealSecs: 300,
        pickSecs: 600,
        fallbackSecs: 600,
      });
      expect(child.input.heldoutCommitment).toBe(world.heldouts[index]);
      expect(child.input.briefUri).toBe(`https://api.test/v1/blobs/${child.input.briefHash}`);
      // What went up is what the post pins.
      const briefFile = JSON.parse(
        readFileSync(join(CHILDREN, SLUGS[index] ?? "", "brief.json"), "utf8"),
      );
      expect(child.input.briefHash).toBe(sha256Hex(canonicalJson(briefFile)));
    }

    // The pack's parent solution is the parts in order, whoever won each, and it is the draft now.
    expect(await finalAnswer()).toEqual(JSON.parse(parentSolution()));
    const draft = await state.getDraft(String(PARENT_ID));
    expect(draft?.commitment).toBe(world.commits[1]?.commitment);
    expect(draft?.committedAt).toBeDefined();
    expect(isDraftOf(draft ?? ({} as never), LEAD)).toBe(true);
    expect(jobOf().status).toBe("done");
    expect(await lead.active()).toEqual([]);
    expect(lines.some((line) => line.includes("placeholder"))).toBe(true);

    // The runner reveals that draft once the reveal window opens.
    world.state.phase = "revealing";
    await enter(world, lead);
    expect(world.reveals).toHaveLength(1);
    expect(world.reveals[0]?.contentHash).toBe(draft?.contentHash);
  });

  test("the_parts_follow_the_pack_s_order_when_the_children_settle_in_another", async () => {
    const world = buildWorld({ settleOn: [4, 3, 2], winners: [BOB, ALICE, BOB] });
    const lead = leadOf(world);
    await enter(world, lead);
    await finish(lead);
    expect(await finalAnswer()).toEqual(JSON.parse(parentSolution()));
  });

  test("the_winner_s_content_is_taken_by_the_winner_and_not_by_the_order_of_commits", async () => {
    // The stand-in lists the loser first. Contents that differ per child show it went by the winner.
    const contents = SLUGS.map((_, index) => JSON.stringify({ child: index }));
    const world = buildWorld({ contents });
    const lead = leadOf(world);
    await enter(world, lead);
    await finish(lead);
    expect(await finalAnswer()).toEqual({ parts: [{ child: 0 }, { child: 1 }, { child: 2 }] });
  });

  test("a_content_that_is_not_json_stays_a_string_in_its_part", async () => {
    const contents = [solutionOf(SLUGS[0] ?? ""), "plain words", solutionOf(SLUGS[2] ?? "")];
    const world = buildWorld({ contents });
    const lead = leadOf(world);
    await enter(world, lead);
    await finish(lead);
    expect(((await finalAnswer()) as { parts: unknown[] }).parts[1]).toBe("plain words");
  });

  test("windows_given_to_the_lead_replace_the_pack_s", async () => {
    const world = buildWorld({ commitSecs: 170 });
    const windows = { commit_secs: 20, reveal_secs: 20, pick_secs: 30, fallback_secs: 20 };
    const lead = leadOf(world, { windows });
    await enter(world, lead);
    await finish(lead);
    expect(world.children).toHaveLength(3);
    for (const child of world.children) {
      expect(child.input).toMatchObject({
        commitSecs: 20,
        revealSecs: 20,
        pickSecs: 30,
        fallbackSecs: 20,
      });
    }
  });

  test("every_child_settles_a_minute_before_the_parent_s_commit_deadline", async () => {
    // The clock the lead reads, plus the three windows that lead to the pick deadline, must be at
    // least a minute short of the parent's commit deadline, at every post.
    const world = buildWorld({ commitSecs: 170 });
    const windows = { commit_secs: 20, reveal_secs: 20, pick_secs: 30, fallback_secs: 20 };
    const lead = leadOf(world, { windows });
    await enter(world, lead);
    await finish(lead);
    const deadline = BigInt(world.ctx.task.commit_deadline);
    expect(world.children).toHaveLength(3);
    let clock = T0;
    for (const child of world.children) {
      const pick =
        clock + BigInt(child.input.commitSecs + child.input.revealSecs + child.input.pickSecs) * NS;
      expect(pick).toBeLessThanOrEqual(deadline - 60n * NS);
      clock += 3n * NS;
    }
  });
});

describe("what the lead will not do", () => {
  test("a_task_without_the_swarm_tag_is_left_alone", async () => {
    const world = buildWorld();
    const ctx = { ...world.ctx, brief: { ...BRIEF, tags: ["regex"] } };
    expect(await leadOf(world).solve(ctx)).toBeNull();
    expect(world.events).toEqual([]);
    expect(journalFiles()).toEqual([]);
  });

  test("a_parent_with_no_room_for_the_pack_s_windows_is_left_alone_before_anything_is_committed", async () => {
    // The pack's windows take 1500 s; a parent with 100 s to its commit deadline cannot wait.
    const world = buildWorld({ commitSecs: 100 });
    const lines: string[] = [];
    expect(await leadOf(world, {}, lines).solve(world.ctx)).toBeNull();
    expect(world.events).toEqual([]);
    expect(journalFiles()).toEqual([]);
    expect(lines.join("\n")).toMatch(/commit deadline/);
    expect(lines.filter((line) => line.includes("declining task 10"))).toHaveLength(1);
  });

  test("a_parent_that_leaves_the_windows_but_not_the_minute_in_hand_is_left_alone", async () => {
    // The windows take 70 s. A commit deadline 100 s away leaves room for them, and not for them
    // and a minute to assemble in. With no margin (and a hire taken to take 1 s) it is hired for.
    const windows = { commit_secs: 20, reveal_secs: 20, pick_secs: 30, fallback_secs: 20 };
    const tight = buildWorld({ commitSecs: 100 });
    expect(await leadOf(tight, { windows }).solve(tight.ctx)).toBeNull();
    expect(tight.events).toEqual([]);

    const relaxed = buildWorld({ commitSecs: 100 });
    const lead = leadOf(relaxed, { windows, marginSecs: 0, hireSecs: 1 });
    await enter(relaxed, lead);
    await finish(lead);
    expect(relaxed.children).toHaveLength(3);
  });

  test("a_placeholder_that_never_lands_hires_nothing_and_the_job_ends_when_there_is_no_time", async () => {
    const world = buildWorld({
      failCommit: { error: new TenderError("E_UNKNOWN", "node down"), n: 1 },
    });
    const lines: string[] = [];
    const lead = leadOf(world, {}, lines);
    await enter(world, lead);
    // The runner's commit failed, so the lead has no entry to name as the parent's.
    await lead.tick();
    await lead.tick();
    expect(world.children).toHaveLength(0);
    expect((await lead.active()).length).toBe(1);
    // Time passes until even the first part cannot be hired.
    world.advance(3600 - 300);
    await finish(lead);
    expect(world.children).toHaveLength(0);
    expect(jobOf().status).toBe("abandoned");
    expect(lines.join("\n")).toMatch(/commit deadline/);
    expect(lines.join("\n")).toMatch(/nothing was spent/);
  });

  test("a_post_that_the_contract_refuses_stops_the_hiring_and_nothing_more_is_spent", async () => {
    const world = buildWorld({
      failPost: { n: 1, error: new TenderError("E_AUTH", "past the total cap") },
    });
    const lines: string[] = [];
    const lead = leadOf(world, {}, lines);
    await enter(world, lead);
    await finish(lead);
    expect(world.children).toHaveLength(1);
    expect(jobOf().status).toBe("abandoned");
    expect(jobOf().reason).toContain("E_AUTH");
    expect(jobOf().intent).toBeUndefined();
    expect(lines.join("\n")).toContain("E_AUTH");
    // More passes post nothing, and the job is not under way.
    for (let pass = 0; pass < 5; pass++) await lead.tick();
    expect(world.children).toHaveLength(1);
    expect(await lead.active()).toEqual([]);
    // The parent's entry is not stranded: its draft is still the placeholder, and not dead, so the
    // runner reveals it in its time.
    const draft = await state.getDraft(String(PARENT_ID));
    expect(Buffer.from(draft?.contentBase64 ?? "", "base64").toString()).toBe("placeholder");
    expect(draft?.dead).toBeUndefined();
    world.state.phase = "revealing";
    await enter(world, lead);
    expect(world.reveals).toHaveLength(1);
  });

  test("a_child_that_is_voided_ends_the_job_with_no_answer", async () => {
    const world = buildWorld({ voidChild: 2 });
    const lines: string[] = [];
    const lead = leadOf(world, {}, lines);
    await enter(world, lead);
    await finish(lead);
    expect(jobOf().status).toBe("abandoned");
    expect(lines.join("\n")).toMatch(/voided/);
    const draft = await state.getDraft(String(PARENT_ID));
    expect(Buffer.from(draft?.contentBase64 ?? "", "base64").toString()).toBe("placeholder");
  });

  test("children_that_never_settle_end_the_job_at_the_parent_s_commit_deadline", async () => {
    const world = buildWorld({ stall: { secs: 600 } });
    const lines: string[] = [];
    const lead = leadOf(world, {}, lines);
    await enter(world, lead);
    await finish(lead);
    expect(jobOf().status).toBe("abandoned");
    expect(lines.join("\n")).toMatch(/commit deadline/);
  });

  test("an_abort_ends_the_loop_at_once", async () => {
    const controller = new AbortController();
    const world = buildWorld({ stall: { secs: 0 } });
    const lead = leadOf(world);
    await enter(world, lead);
    const running = lead.run(controller.signal);
    setTimeout(() => controller.abort(), 50);
    await running;
    expect(controller.signal.aborted).toBe(true);
  });

  test("an_empty_pack_is_a_mistake_found_when_the_solver_is_made", () => {
    const empty = mkdtempSync(join(tmpdir(), "lead-empty-"));
    dirs.push(empty);
    const world = buildWorld();
    expect(() => createLeadSolver({ ...optionsOf(world), seedsDir: empty })).toThrow(
      /no sub-tasks/,
    );
  });

  test("a_child_whose_files_do_not_fit_is_found_when_the_solver_is_made", () => {
    const bad = mkdtempSync(join(tmpdir(), "lead-bad-"));
    dirs.push(bad);
    mkdirSync(join(bad, "01-broken"));
    writeFileSync(join(bad, "01-broken", "task.json"), "{}");
    const world = buildWorld();
    expect(() => createLeadSolver({ ...optionsOf(world), seedsDir: bad })).toThrow(/01-broken/);
  });

  test("options_that_make_no_sense_are_found_when_the_solver_is_made", () => {
    const world = buildWorld();
    expect(() => createLeadSolver({ ...optionsOf(world), hireSecs: -1 })).toThrow(RangeError);
    expect(() => createLeadSolver({ ...optionsOf(world), marginSecs: 1.5 })).toThrow(RangeError);
    expect(() => createLeadSolver({ ...optionsOf(world), journalDir: "" })).toThrow(/journal/);
    expect(() => createLeadSolver({ ...optionsOf(world), delegateKey: "" })).toThrow(/key/);
  });
});

// A swarm task is tagged by whoever posts it, so the tag alone is no reason to spend the lead's
// vault: a stranger could post a tiny parent and have the lead hire children for it, up to the caps
// of its delegate key. The lead takes a parent on only if it pays, from a poster and a verifier it
// trusts, in the token of its key, and with room for the sub-tasks. Each check below refuses on its
// own: the parent it refuses is right in every other way.
describe("what the lead will not take on", () => {
  /** `ctx` with some fields of its task replaced. */
  const withTask = (ctx: TaskContext, changes: Partial<TaskContext["task"]>): TaskContext => ({
    ...ctx,
    task: { ...ctx.task, ...changes },
  });

  /** Declines `changes` of a parent that is otherwise fine, and checks nothing else happened. */
  async function declined(
    changes: Partial<TaskContext["task"]>,
    more: WorldOptions = {},
    lead?: Partial<Parameters<typeof createLeadSolver>[0]>,
  ): Promise<string[]> {
    const world = buildWorld(more);
    const lines: string[] = [];
    const answer = await leadOf(world, lead, lines).solve(withTask(world.ctx, changes));
    expect(answer).toBeNull();
    // Nothing on chain, nothing uploaded, nothing posted, no job, no draft kept.
    expect(world.events).toEqual([]);
    expect(world.children).toHaveLength(0);
    expect(journalFiles()).toEqual([]);
    expect(await state.getDraft(String(PARENT_ID))).toBeNull();
    const refusals = lines.filter((line) => line.includes(`declining task ${PARENT_ID}`));
    expect(refusals, lines.join("\n")).toHaveLength(1);
    return refusals;
  }

  test("a_parent_that_pays_less_than_the_sub_tasks_cost_is_refused", async () => {
    // 1.00 tUSDC less its 5% fee is 0.95, and the three sub-tasks cost 6.00.
    const [line] = await declined({ reward: "1000000" });
    expect(line).toMatch(/0\.95/);
    expect(line).toMatch(/6\.00/);
    expect(line).toMatch(/profit/);
  });

  test("a_parent_whose_payout_only_equals_the_cost_is_refused_and_one_unit_more_is_taken", async () => {
    // 6_315_789 less a fee of floor(x * 500 / 10_000) = 315_789 is exactly 6_000_000.
    await declined({ reward: "6315789" });
    // One unit more leaves 6_000_001 after the same fee, which is above the cost.
    const world = buildWorld();
    const answer = await leadOf(world).solve(withTask(world.ctx, { reward: "6315790" }));
    expect(answer).not.toBeNull();
  });

  test("the_fee_is_the_one_the_parent_was_posted_with", async () => {
    // 6.60 tUSDC clears the cost at a fee of 5%, and not at 10%.
    await declined({ reward: "6600000", fee_bps: 1000 });
    const world = buildWorld();
    const answer = await leadOf(world).solve(withTask(world.ctx, { reward: "6600000" }));
    expect(answer).not.toBeNull();
  });

  test("a_parent_in_another_token_than_the_delegate_key_s_is_refused", async () => {
    const [line] = await declined({ token: "other.test.near" });
    expect(line).toContain("other.test.near");
    expect(line).toContain(TOKEN);
  });

  test("a_token_whose_decimals_are_unknown_is_refused_not_guessed", async () => {
    const world = buildWorld();
    const lines: string[] = [];
    const solver = leadOf(world, { token: "weird.test.near" }, lines);
    expect(await solver.solve(withTask(world.ctx, { token: "weird.test.near" }))).toBeNull();
    expect(world.events).toEqual([]);
    expect(lines.join("\n")).toMatch(/declining task 10: .*decimals/);
  });

  test("a_parent_verified_by_a_stranger_is_refused", async () => {
    const [line] = await declined({ verifier: STRANGER });
    expect(line).toContain(STRANGER);
    expect(line).toContain(JUDGE);
  });

  test("a_parent_posted_by_a_stranger_is_refused", async () => {
    const [line] = await declined({ poster: STRANGER });
    expect(line).toContain(STRANGER);
  });

  test("a_parent_with_too_little_time_is_refused", async () => {
    const [line] = await declined({}, { commitSecs: 100 });
    expect(line).toMatch(/commit deadline/);
  });

  test("a_parent_with_room_for_the_first_part_and_not_for_the_last_is_refused_before_anything_is_spent", async () => {
    // The first part takes 30 s and the second 1500 s. The lead looks at every part before it
    // takes the parent on, not at the first alone, or it would hire for one and leave the parent
    // unanswered.
    const pack = mkdtempSync(join(tmpdir(), "lead-mixed-"));
    dirs.push(pack);
    cpSync(CHILDREN, pack, { recursive: true });
    rmSync(join(pack, "03-event-tally"), { recursive: true });
    const first = join(pack, "01-gas-ledger", "task.json");
    writeFileSync(
      first,
      JSON.stringify({
        ...JSON.parse(readFileSync(first, "utf8")),
        commit_secs: 10,
        reveal_secs: 10,
        pick_secs: 10,
        fallback_secs: 10,
      }),
    );
    const world = buildWorld({ commitSecs: 200 });
    const lines: string[] = [];
    const solver = leadOf(world, { seedsDir: pack }, lines);
    expect(await solver.solve(world.ctx)).toBeNull();
    expect(world.events).toEqual([]);
    expect(lines.join("\n")).toMatch(/declining task 10: .*02-key-audit/);
  });

  test("a_parent_that_fails_several_checks_is_refused_with_one_line", async () => {
    const [line] = await declined({
      poster: STRANGER,
      verifier: STRANGER,
      token: "other.test.near",
      reward: "1",
    });
    expect(line).toContain(STRANGER);
  });

  test("a_parent_that_passes_every_check_is_taken_on", async () => {
    const world = buildWorld();
    const lines: string[] = [];
    expect(await leadOf(world, {}, lines).solve(world.ctx)).not.toBeNull();
    expect(lines.some((line) => line.includes("declining"))).toBe(false);
    expect(jobOf().status).toBe("hiring");
  });

  test("the_posters_default_to_TEAM_ACCOUNTS", async () => {
    const env = { TEAM_ACCOUNTS: ` ${POSTER}, ${LEAD} ,` };
    const taken = buildWorld();
    const solver = leadOf(taken, { posters: undefined, env });
    expect(await solver.solve(taken.ctx)).not.toBeNull();
    rmSync(journalDir, { recursive: true, force: true });

    const refused = buildWorld();
    const lines: string[] = [];
    const other = leadOf(refused, { posters: undefined, env }, lines);
    expect(await other.solve(withTask(refused.ctx, { poster: STRANGER }))).toBeNull();
    expect(refused.events).toEqual([]);
    expect(lines.join("\n")).toContain(STRANGER);
  });

  test("a_lead_with_no_posters_is_a_mistake_found_when_the_solver_is_made", () => {
    const world = buildWorld();
    const options = { ...optionsOf(world), posters: undefined };
    expect(() => createLeadSolver({ ...options, env: {} })).toThrow(/TEAM_ACCOUNTS/);
    expect(() => createLeadSolver({ ...options, posters: [], env: {} })).toThrow(/TEAM_ACCOUNTS/);
    expect(() => createLeadSolver({ ...options, env: { TEAM_ACCOUNTS: " , " } })).toThrow(
      /TEAM_ACCOUNTS/,
    );
  });

  test("a_poster_that_is_not_an_account_id_is_a_mistake_found_when_the_solver_is_made", () => {
    const world = buildWorld();
    expect(() => createLeadSolver({ ...optionsOf(world), posters: ["Not An Account"] })).toThrow(
      /account id/,
    );
  });
});

// Fix round 1 (the review of f29de14..02bd4d6). The gate was sound, and three paths remained where
// the lead paid for children and then answered nothing. Each test below is the reviewer's probe.
describe("fix round 1: I1, the plan is paid for whole or not at all", () => {
  test("I1a_a_commit_window_the_hiring_could_outrun_is_refused_before_anything_is_paid", async () => {
    // The probe: 133 s to the commit deadline, windows of 70 s, a 60 s margin. At one instant the
    // three parts fit; with the time it takes to hire them (20 s a part by default) they do not.
    const world = buildWorld({ commitSecs: 133 });
    const windows = { commit_secs: 20, reveal_secs: 20, pick_secs: 30, fallback_secs: 20 };
    const lines: string[] = [];
    const lead = leadOf(world, { windows, hireSecs: undefined }, lines);
    await enter(world, lead);
    await lead.tick();
    expect(world.children).toHaveLength(0);
    expect(world.events).toEqual([]);
    expect(journalFiles()).toEqual([]);
    expect(lines.join("\n")).toMatch(/declining task 10: .*commit deadline/);
  });

  test("I1a_a_clock_that_outruns_the_hiring_allowance_stops_the_hiring_before_the_next_part", async () => {
    // Hiring is taken to take 1 s a part, and each post takes the chain 3 s. The first part fits;
    // before the second, the lead sees that it and the third no longer do, and it posts no more.
    const world = buildWorld({ commitSecs: 133 });
    const windows = { commit_secs: 20, reveal_secs: 20, pick_secs: 30, fallback_secs: 20 };
    const lines: string[] = [];
    const lead = leadOf(world, { windows, hireSecs: 1 }, lines);
    await enter(world, lead);
    await finish(lead);
    expect(world.children).toHaveLength(1);
    expect(jobOf().status).toBe("abandoned");
    expect(jobOf().reason).toMatch(/commit deadline/);
    for (let pass = 0; pass < 5; pass++) await lead.tick();
    expect(world.children).toHaveLength(1);
    expect(lines.join("\n")).toMatch(/no more is spent/);
  });

  test("I1b_a_remaining_cap_that_cannot_cover_the_sub_tasks_is_refused_before_anything_is_paid", async () => {
    // The probe: total cap 10.00 and 5.00 spent leaves 5.00, and the three sub-tasks cost 6.00.
    const world = buildWorld({ caps: { total_cap: "10000000", spent: "5000000" } });
    const lines: string[] = [];
    const lead = leadOf(world, {}, lines);
    await enter(world, lead);
    await lead.tick();
    expect(world.children).toHaveLength(0);
    expect(world.events).toEqual([]);
    expect(lines.join("\n")).toMatch(/declining task 10: .*total cap/);
  });

  test("I1b_exactly_enough_cap_is_taken", async () => {
    const world = buildWorld({ caps: { total_cap: "10000000", spent: "4000000" } });
    const lead = leadOf(world);
    await enter(world, lead);
    await finish(lead);
    expect(world.children).toHaveLength(3);
  });

  test("I1b_a_sub_task_above_the_per_task_cap_is_refused", async () => {
    const world = buildWorld({ caps: { per_task_cap: "1500000" } });
    const lines: string[] = [];
    expect(await leadOf(world, {}, lines).solve(world.ctx)).toBeNull();
    expect(world.events).toEqual([]);
    expect(lines.join("\n")).toMatch(/declining task 10: .*01-gas-ledger.*a task may cost/);
  });

  test("I1b_a_vault_that_cannot_pay_for_the_sub_tasks_is_refused", async () => {
    const world = buildWorld({ vault: 5_000_000n });
    const lines: string[] = [];
    expect(await leadOf(world, {}, lines).solve(world.ctx)).toBeNull();
    expect(world.events).toEqual([]);
    expect(lines.join("\n")).toMatch(/declining task 10: .*vault/);
  });

  test("I1b_a_key_that_is_no_delegate_or_spends_another_token_is_refused", async () => {
    const none = buildWorld({ caps: null });
    const lines: string[] = [];
    expect(await leadOf(none, {}, lines).solve(none.ctx)).toBeNull();
    expect(lines.join("\n")).toMatch(/declining task 10: .*not a delegate key/);

    const other = buildWorld({ caps: { token: "other.test.near" } });
    const more: string[] = [];
    expect(await leadOf(other, {}, more).solve(other.ctx)).toBeNull();
    expect(more.join("\n")).toMatch(/declining task 10: .*other\.test\.near/);
  });

  test("the_lead_works_on_one_parent_at_a_time_and_never_on_the_same_one_twice", async () => {
    const world = buildWorld();
    const lines: string[] = [];
    const lead = leadOf(world, {}, lines);
    await enter(world, lead);
    // Another parent while the first is under way: its cost would come out of the same cap.
    const second = { ...world.ctx, task: { ...world.ctx.task, id: "11" } };
    expect(await lead.solve(second)).toBeNull();
    expect(lines.join("\n")).toMatch(/declining task 11: .*one parent at a time/);

    await finish(lead);
    // The same parent again, as a draft that was set aside would offer it.
    expect(await lead.solve(world.ctx)).toBeNull();
    expect(lines.join("\n")).toMatch(/declining task 10: .*job for it already/);
  });

  test("a_job_of_another_life_of_the_chain_is_set_aside_and_does_not_block_the_parent", async () => {
    const world = buildWorld();
    const old = {
      parent: String(PARENT_ID),
      contractId: CONTRACT,
      account: LEAD,
      parentCreatedAt: "5",
      commitDeadline: "6",
      token: TOKEN,
      status: "done",
      hires: [],
    };
    writeFileSync(join(journalDir, `${PARENT_ID}.json`), JSON.stringify(old));
    const lead = leadOf(world);
    expect(await lead.solve(world.ctx)).not.toBeNull();
    expect(jobOf().status).toBe("hiring");
    expect(readdirSync(journalDir).some((name) => name.includes("orphaned"))).toBe(true);
  });

  test("a_journal_that_cannot_be_read_fails_closed", async () => {
    const world = buildWorld();
    const lines: string[] = [];
    const lead = leadOf(world, {}, lines);
    writeFileSync(join(journalDir, "3.json"), "not json");
    expect(await lead.solve(world.ctx)).toBeNull();
    expect(lines.join("\n")).toMatch(/ERROR task 10 failed/);
    await lead.tick();
    expect(lines.join("\n")).toMatch(/ERROR the jobs cannot be read/);
    expect(world.children).toHaveLength(0);
  });
});

describe("fix round 1: I2, a failed call is tried again and the job survives a restart", () => {
  test("I2_one_failed_poll_does_not_abandon_a_parent_whose_children_are_paid_for", async () => {
    // The probe: the API's getTask throws once, on its 4th call. All three children are posted.
    const world = buildWorld({ failGetTask: 4 });
    const lines: string[] = [];
    const lead = leadOf(world, {}, lines);
    await enter(world, lead);
    await finish(lead);
    expect(world.children).toHaveLength(3);
    expect(jobOf().status).toBe("done");
    expect(await finalAnswer()).toEqual(JSON.parse(parentSolution()));
    expect(lines.join("\n")).toMatch(/WARN task 10 \(waiting\) failed \(Error\), trying again in/);
  });

  test("I2_a_failed_blob_fetch_and_a_failed_clock_read_are_tried_again", async () => {
    const world = buildWorld({ failGetBlob: 1, failClock: 12 });
    const lead = leadOf(world);
    await enter(world, lead);
    await finish(lead);
    expect(world.children).toHaveLength(3);
    expect(jobOf().status).toBe("done");
    expect(await finalAnswer()).toEqual(JSON.parse(parentSolution()));
  });

  test("I2_a_failed_commit_of_the_answer_is_tried_again_with_the_same_salt", async () => {
    const world = buildWorld({ failCommit: { error: new Error("socket hang up"), n: 2 } });
    const lead = leadOf(world);
    await enter(world, lead);
    await finish(lead);
    expect(jobOf().status).toBe("done");
    const draft = await state.getDraft(String(PARENT_ID));
    expect(draft?.commitment).toBe(world.commits.at(-1)?.commitment);
    expect(await finalAnswer()).toEqual(JSON.parse(parentSolution()));
    // Placeholder, the commit that failed, the commit that went through.
    expect(world.events.filter((event) => event === "commit")).toHaveLength(3);
  });

  test("I2_a_commit_the_contract_refuses_ends_the_job", async () => {
    const world = buildWorld({
      failCommit: { error: new TenderError("E_PHASE", "the commit window is over"), n: 2 },
    });
    const lead = leadOf(world);
    await enter(world, lead);
    await finish(lead);
    expect(jobOf().status).toBe("abandoned");
    expect(jobOf().reason).toContain("E_PHASE");
  });

  test("I2_a_job_that_keeps_failing_waits_longer_between_tries_and_ends_at_the_commit_deadline", async () => {
    const world = buildWorld({ failGetTask: "always" });
    const lines: string[] = [];
    const lead = leadOf(world, { backoffMs: 300, maxBackoffMs: 600 }, lines);
    await enter(world, lead);
    // Thirty passes in a tight loop (well inside the first pause): the job is not tried again until
    // its pause is over, so it is tried once and not thirty times.
    for (let pass = 0; pass < 30; pass++) await lead.tick();
    const tries = lines.filter((line) => line.includes("trying again")).length;
    expect(tries).toBeGreaterThan(0);
    expect(tries).toBeLessThanOrEqual(3);
    expect(world.children).toHaveLength(3);
    expect(jobOf().status).toBe("waiting");

    // Time passes on the chain until the parent's commit deadline: the job ends there.
    world.advance(3600);
    await delay(100);
    await finish(lead);
    expect(jobOf().status).toBe("abandoned");
    expect(jobOf().reason).toMatch(/commit deadline/);
  });

  test("I2_a_restart_resumes_the_job_and_does_not_hire_the_parts_again", async () => {
    // The third post cannot be signed (the node did not answer), after two were hired.
    const world = buildWorld({ signFails: { n: 2 } });
    const first = leadOf(world);
    await enter(world, first);
    await first.tick();
    expect(world.children).toHaveLength(2);
    expect(jobOf().status).toBe("hiring");
    expect(jobOf().hires.map((one) => one.slug)).toEqual(SLUGS.slice(0, 2));
    // The note is there, and it has no transaction: nothing was signed, so nothing was sent.
    expect(jobOf().intent?.slug).toBe(SLUGS[2]);
    expect(jobOf().intent?.tx).toBeUndefined();

    // A new process on the same journal and drafts. It has nothing to wait for: no transaction of
    // the third part exists, so it posts it, once, and the two hired are not hired again.
    const lines: string[] = [];
    const second = leadOf(world, {}, lines);
    await finish(second);
    expect(world.children).toHaveLength(3);
    expect(new Set(world.children.map((one) => one.input.briefHash)).size).toBe(3);
    expect(jobOf().status).toBe("done");
    expect(await finalAnswer()).toEqual(JSON.parse(parentSolution()));
    expect(lines.join("\n")).toMatch(/never signed/);
  });

  test("I2_a_post_whose_answer_was_lost_is_found_on_the_chain_and_not_posted_again", async () => {
    const world = buildWorld({ lostPost: { n: 1 } });
    const lines: string[] = [];
    const lead = leadOf(world, {}, lines);
    await enter(world, lead);
    await finish(lead);
    // Part 2 landed, the client timed out, and the lead found it on the chain.
    expect(world.children).toHaveLength(3);
    expect(new Set(world.children.map((one) => one.input.briefHash)).size).toBe(3);
    expect(jobOf().hires.map((one) => one.slug)).toEqual(SLUGS);
    expect(jobOf().status).toBe("done");
    expect(lines.join("\n")).toMatch(/was posted already/);
  });
});

describe("fix round 1: I3, the lead's long work is not the runner's solve", () => {
  test("I3_solve_returns_quickly_however_long_the_hiring_takes", async () => {
    // Each post takes 1.5 s, so a solve that hired would take 4.5 s; this one must take a fraction
    // of one post.
    const world = buildWorld({ postDelayMs: 1500 });
    const lead = leadOf(world);
    const started = Date.now();
    const answer = await lead.solve(world.ctx);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(text(answer ?? undefined)).toBe("placeholder");
    // It hired nothing: that is for the passes.
    expect(world.children).toHaveLength(0);
  });

  test("I3_a_runner_with_a_short_solve_timeout_still_ends_with_the_assembled_answer", async () => {
    // Hiring takes over 2 s here (700 ms a post) and the runner gives a solve 400 ms. The lead's work
    // was never inside that solve, so the placeholder is committed, the job goes on, and the answer
    // replaces it.
    const world = buildWorld({ postDelayMs: 700 });
    const runner: string[] = [];
    const lead = leadOf(world);
    await enter(world, lead, { solveTimeoutMs: 400, lines: runner });
    expect(runner.join("\n")).not.toMatch(/took over/);
    await finish(lead);
    expect(jobOf().status).toBe("done");
    expect(await finalAnswer()).toEqual(JSON.parse(parentSolution()));
  });

  test("I3_the_jobs_do_not_hold_up_the_runner", async () => {
    // The lead's loop hires for over 1.8 s (600 ms a post), beside the runner. A tick of the runner
    // in that time (it would reveal the drafts that are due) is not held up by it.
    const world = buildWorld({ postDelayMs: 600 });
    const lead = leadOf(world);
    await enter(world, lead);
    const running = lead.run(stop.signal);
    await delay(20);
    const started = Date.now();
    await enter(world, lead);
    expect(Date.now() - started).toBeLessThan(500);
    expect(jobOf().status).not.toBe("done");
    for (let waited = 0; (await lead.active()).length > 0 && waited < 800; waited++) {
      await delay(10);
    }
    stop.abort();
    await running;
    expect(jobOf().status).toBe("done");
  });
});

describe("swarm fix: N2, a note the lead wrote before a post is still there after a power cut", () => {
  test("N2_a_post_that_landed_just_before_a_power_cut_is_found_after_the_reboot_and_not_posted_again", async () => {
    const disk = new PowerFs();
    const world = buildWorld({
      hooks: {
        // The system had flushed what the lead had written so far, a moment before part 2 began:
        // an unlucky time, for the note about part 2 is written after it.
        beforeHire: (n) => {
          if (n === 1) disk.settle();
        },
        // Part 2 is on the chain. The power goes before the lead's client has an answer.
        afterLand: (n) => {
          if (n === 1) {
            disk.powerCut();
            throw new PowerCut("the post of part 2");
          }
        },
      },
    });
    const first = leadOf(world, { fs: disk });
    await enter(world, first);
    await first.tick();
    expect(world.children).toHaveLength(2);

    // The machine is back. A new lead reads the journal as the disk holds it.
    const lines: string[] = [];
    const second = leadOf(world, { fs: disk }, lines);
    await finish(second, 600, () => world.advance(10));
    const briefs = world.children.map((one) => one.input.briefHash);
    expect(briefs).toHaveLength(3);
    expect(new Set(briefs).size).toBe(3);
    expect(lines.join("\n")).toMatch(/part 02-key-audit was posted already, as task 12/);
    expect(JSON.parse(await disk.readFile(join(journalDir, "10.json"), "utf8")).status).toBe(
      "done",
    );
    expect(await finalAnswer()).toEqual(JSON.parse(parentSolution()));
  });
});

describe("swarm fix: N1, a post is sent again only when its transaction cannot land", () => {
  const distinct = (world: World) => new Set(world.children.map((one) => one.input.briefHash)).size;
  const postsOf = (world: World, n: number) =>
    world.events.filter((event) => event === `post ${n}`).length;
  const transient = () =>
    new TenderError("E_TIMEOUT", "TenderClient.send timed out; the transaction may land");

  test("N1_a_slow_post_that_lands_after_a_minute_is_not_hired_twice", async () => {
    // Part 2 is sent; the client gives up after 120 s; the transaction, held up by congestion, lands
    // 150 s after it was sent. A lead that called the post lost after 60 s would post it again.
    const world = buildWorld({ slowPost: { n: 1, giveUpSecs: 120, landsAfterSecs: 150 } });
    const lines: string[] = [];
    const lead = leadOf(world, {}, lines);
    await enter(world, lead);
    await finish(lead, 600, () => world.advance(10));

    world.advance(3600);
    world.settle();
    expect(world.children).toHaveLength(3);
    expect(distinct(world)).toBe(3);
    expect(postsOf(world, 1)).toBe(1);
    expect(jobOf().hires.map((one) => one.slug)).toEqual(SLUGS);
    expect(jobOf().status).toBe("done");
    expect(lines.join("\n")).toMatch(/part 02-key-audit was posted already, as task 12/);
    expect(await finalAnswer()).toEqual(JSON.parse(parentSolution()));
  });

  test("N1_a_transaction_that_lands_long_after_any_time_limit_is_never_sent_again", async () => {
    // It lands twenty hours after it was sent. No time limit is a proof that it will not: a
    // transaction is includable until its reference block is a day old.
    const world = buildWorld({
      commitSecs: 100_000,
      slowPost: { n: 1, giveUpSecs: 120, landsAfterSecs: 72_000 },
    });
    const lead = leadOf(world);
    await enter(world, lead);
    await finish(lead, 3000, () => world.advance(600));
    expect(world.children).toHaveLength(3);
    expect(distinct(world)).toBe(3);
    expect(postsOf(world, 1)).toBe(1);
    expect(jobOf().status).toBe("done");
  });

  test("N1_a_transaction_that_failed_on_chain_is_sent_once_more_with_a_new_intent", async () => {
    const error = new TenderError("E_UNKNOWN", "Exceeded the prepaid gas");
    const hashes: Array<string | undefined> = [];
    const world = buildWorld({
      failedPost: { n: 1, times: 1, error },
      hooks: {
        beforeLand: (n) => {
          if (n === 1) hashes.push(jobOf().intent?.tx?.txHash);
        },
      },
    });
    const lines: string[] = [];
    const lead = leadOf(world, {}, lines);
    await enter(world, lead);
    await finish(lead);
    expect(postsOf(world, 1)).toBe(2);
    expect(world.children).toHaveLength(3);
    expect(distinct(world)).toBe(3);
    expect(jobOf().status).toBe("done");
    expect(jobOf().failedPosts).toBeUndefined();
    // Two intents, two transactions.
    expect(hashes).toHaveLength(2);
    expect(new Set(hashes).size).toBe(2);
    expect(lines.join("\n")).toMatch(/failed on chain/);
  });

  test("N1_a_transaction_that_fails_on_chain_twice_ends_the_job_with_no_third_post", async () => {
    const error = new TenderError("E_UNKNOWN", "Exceeded the prepaid gas");
    const world = buildWorld({ failedPost: { n: 1, times: 5, error } });
    const lead = leadOf(world);
    await enter(world, lead);
    await finish(lead);
    expect(postsOf(world, 1)).toBe(2);
    expect(world.children).toHaveLength(1);
    expect(jobOf().status).toBe("abandoned");
    expect(jobOf().reason).toMatch(/failed on chain twice/);
    for (let pass = 0; pass < 5; pass++) await lead.tick();
    expect(postsOf(world, 1)).toBe(2);
  });

  test("N1_a_contract_refusal_found_by_the_status_ends_the_job_and_is_not_sent_again", async () => {
    // The client only heard a timeout; the chain says the contract refused it.
    const world = buildWorld({
      failedPost: {
        n: 1,
        times: 5,
        error: new TenderError("E_AUTH", "past the total cap"),
        clientSees: transient(),
      },
    });
    const lead = leadOf(world);
    await enter(world, lead);
    await finish(lead);
    expect(postsOf(world, 1)).toBe(1);
    expect(world.children).toHaveLength(1);
    expect(jobOf().status).toBe("abandoned");
    expect(jobOf().reason).toContain("E_AUTH");
  });

  test("N1_a_part_still_unresolved_when_the_deadline_nears_is_given_up_and_never_posted_again", async () => {
    // The transaction never lands, and the node never says it failed.
    const world = buildWorld({ slowPost: { n: 1, giveUpSecs: 120, landsAfterSecs: 1_000_000 } });
    const lines: string[] = [];
    const lead = leadOf(world, {}, lines);
    await enter(world, lead);
    await finish(lead, 3000, () => world.advance(60));
    expect(postsOf(world, 1)).toBe(1);
    expect(world.children).toHaveLength(1);
    expect(jobOf().status).toBe("abandoned");
    expect(jobOf().reason).toMatch(/unresolved/);
    // The journal keeps what the lead could not settle, so that a person can look it up.
    expect(jobOf().unresolved?.slug).toBe(SLUGS[1]);
    expect(jobOf().unresolved?.tx?.txHash).toMatch(/^tx-1-/);
    expect(jobOf().intent).toBeUndefined();
    expect(lines.join("\n")).toMatch(/giving up on task 10/);
    for (let pass = 0; pass < 5; pass++) await lead.tick();
    expect(postsOf(world, 1)).toBe(1);
    // The parent's entry is not stranded: its draft is the placeholder, and the runner reveals it.
    const draft = await state.getDraft(String(PARENT_ID));
    expect(Buffer.from(draft?.contentBase64 ?? "", "base64").toString()).toBe("placeholder");
    expect(draft?.dead).toBeUndefined();
    world.state.phase = "revealing";
    await enter(world, lead);
    expect(world.reveals).toHaveLength(1);
  });

  test("N1_a_signed_post_that_may_not_have_left_is_not_sent_again_either", async () => {
    // The socket went after the transaction was signed: the lead cannot tell whether it left.
    const world = buildWorld({ failPost: { n: 1, error: new Error("socket hang up") } });
    const lead = leadOf(world);
    await enter(world, lead);
    await finish(lead, 3000, () => world.advance(60));
    expect(postsOf(world, 1)).toBe(1);
    expect(jobOf().status).toBe("abandoned");
    expect(jobOf().unresolved?.tx).toBeDefined();
  });

  test("N1_a_post_that_was_never_signed_is_sent_again_at_once", async () => {
    // No transaction exists, so nothing can land: there is no time to wait out. No clock moves here.
    const world = buildWorld({ signFails: { n: 1 } });
    const lead = leadOf(world);
    await enter(world, lead);
    await finish(lead);
    expect(postsOf(world, 1)).toBe(2);
    expect(world.children).toHaveLength(3);
    expect(distinct(world)).toBe(3);
    expect(jobOf().status).toBe("done");
  });

  test("N1_an_unsigned_post_is_not_called_unsent_before_the_look_through_the_chain_is_over", async () => {
    // 1200 other tasks were made meanwhile. Even for a post that was never signed, the lead looks
    // through them all (a few pages a pass) before it posts the part again.
    const world = buildWorld({ signFails: { n: 1 }, crowd: 1200 });
    const lead = leadOf(world);
    await enter(world, lead);
    await lead.tick();
    await lead.tick();
    expect(postsOf(world, 1)).toBe(1);
    await finish(lead);
    expect(postsOf(world, 1)).toBe(2);
    expect(world.children).toHaveLength(3);
    expect(Math.max(...world.pageReads)).toBeLessThanOrEqual(50);
  });

  test("N1_the_hash_and_the_reference_block_are_in_the_journal_before_the_transaction_is_sent", async () => {
    const seen: Array<{ n: number; noted: JobTx["tx"]; signed: SignedTx }> = [];
    const world = buildWorld({
      hooks: { beforeLand: (n, signed) => seen.push({ n, noted: jobOf().intent?.tx, signed }) },
    });
    const lead = leadOf(world);
    await enter(world, lead);
    await finish(lead);
    expect(seen.map((one) => one.n)).toEqual([0, 1, 2]);
    for (const { noted, signed } of seen) {
      expect(noted).toEqual({
        txHash: signed.txHash,
        publicKey: signed.publicKey,
        nonce: String(signed.nonce),
        blockHash: signed.blockHash,
        blockHeight: String(signed.blockHeight),
      });
    }
  });

  test("N1_a_journal_that_cannot_note_the_hash_sends_nothing", async () => {
    // The folder cannot be synced just when the lead is to write the hash down.
    const disk = new PowerFs();
    let sent = false;
    const world = buildWorld({
      hooks: {
        beforeSign: (n) => {
          if (n === 1) disk.failDirSync = new Error("EIO: input/output error");
        },
        beforeLand: (n) => {
          if (n === 1) sent = true;
        },
      },
    });
    const lead = leadOf(world, { fs: disk });
    await enter(world, lead);
    await lead.tick();
    expect(sent).toBe(false);
    expect(world.children).toHaveLength(1);
  });

  test("N1_a_status_the_node_cannot_give_is_asked_again_and_not_taken_for_a_loss", async () => {
    const world = buildWorld({ lostPost: { n: 1 }, failTxStatus: 1 });
    const lines: string[] = [];
    const lead = leadOf(world, {}, lines);
    await enter(world, lead);
    await finish(lead);
    expect(postsOf(world, 1)).toBe(1);
    expect(world.children).toHaveLength(3);
    expect(distinct(world)).toBe(3);
    expect(lines.join("\n")).toMatch(/WARN task 10 \(hiring\) failed \(TenderError E_TIMEOUT\)/);
  });

  test("N1_a_node_that_forgot_the_transaction_is_backed_up_by_a_look_through_the_chain", async () => {
    const world = buildWorld({ lostPost: { n: 1 }, forgetTxs: true });
    const lines: string[] = [];
    const lead = leadOf(world, {}, lines);
    await enter(world, lead);
    await finish(lead);
    expect(postsOf(world, 1)).toBe(1);
    expect(world.children).toHaveLength(3);
    expect(lines.join("\n")).toMatch(/part 02-key-audit was posted already, as task 12/);
  });

  test("N1_a_post_among_hundreds_of_other_tasks_is_found_and_not_posted_again", async () => {
    // 260 tasks of other people were made on the chain before the lead's lost post landed, which is
    // more than a short look past the intent would read.
    const world = buildWorld({ lostPost: { n: 1 }, crowd: 260, forgetTxs: true });
    const lines: string[] = [];
    const lead = leadOf(world, {}, lines);
    await enter(world, lead);
    await finish(lead);
    expect(world.children).toHaveLength(3);
    expect(distinct(world)).toBe(3);
    expect(lines.join("\n")).toMatch(/part 02-key-audit was posted already, as task 272/);
    expect(jobOf().status).toBe("done");
  });

  test("N1_a_look_through_the_chain_that_is_not_finished_finds_the_post_on_a_later_pass", async () => {
    // 1200 other tasks, then the lead's. A pass reads a limited number of pages, so the post is
    // found on the third.
    const world = buildWorld({ lostPost: { n: 1 }, crowd: 1200, forgetTxs: true });
    const lines: string[] = [];
    const lead = leadOf(world, {}, lines);
    await enter(world, lead);
    await lead.tick();
    expect(world.children).toHaveLength(2);
    await lead.tick();
    expect(world.children).toHaveLength(2);
    expect(postsOf(world, 1)).toBe(1);
    await finish(lead);
    expect(world.children).toHaveLength(3);
    expect(distinct(world)).toBe(3);
    expect(lines.join("\n")).toMatch(/was posted already, as task 1212/);
    expect(Math.max(...world.pageReads)).toBeLessThanOrEqual(50);
  });
});

describe("swarm fix: N4, a job that never gets its entry does not block the lead until the deadline", () => {
  const second = (world: World): TaskContext => ({
    ...world.ctx,
    task: { ...world.ctx.task, id: "11" },
  });

  test("N4_a_placeholder_that_never_becomes_an_entry_is_let_go_after_a_while_and_the_next_parent_is_taken", async () => {
    // The runner's commit of the placeholder fails, and nothing sends it again.
    const world = buildWorld({
      failCommit: { error: new TenderError("E_UNKNOWN", "node down"), n: 1 },
    });
    const lines: string[] = [];
    const lead = leadOf(world, { entrySecs: 300 }, lines);
    await enter(world, lead);

    // Five minutes less a moment: still waiting for it, and still one parent at a time.
    world.advance(299);
    await lead.tick();
    expect(jobOf().status).toBe("hiring");
    expect(await lead.solve(second(world))).toBeNull();
    expect(lines.join("\n")).toMatch(/declining task 11: .*one parent at a time/);

    // Five minutes: nothing was ever hired, so nothing is lost by letting the job go.
    world.advance(2);
    await lead.tick();
    expect(jobOf().status).toBe("abandoned");
    expect(jobOf().reason).toMatch(/placeholder was not an entry/);
    expect(lines.join("\n")).toMatch(/giving up on task 10: .*nothing was spent/);
    expect(world.children).toHaveLength(0);
    expect(await lead.active()).toEqual([]);
    // The next parent is taken on.
    const next = await lead.solve(second(world));
    expect(text(next ?? undefined)).toBe("placeholder");
  });

  test("N4_an_entry_that_comes_in_time_is_hired_for_as_before", async () => {
    // The runner's commit fails once and is sent again four minutes later, inside the grace.
    const world = buildWorld({
      failCommit: { error: new TenderError("E_UNKNOWN", "node down"), n: 1 },
    });
    const lead = leadOf(world, { entrySecs: 300 });
    await enter(world, lead);
    world.advance(240);
    await lead.tick();
    expect(world.children).toHaveLength(0);
    expect(jobOf().status).toBe("hiring");
    await enter(world, lead);
    await finish(lead, 600, () => world.advance(1));
    expect(world.children).toHaveLength(3);
    expect(jobOf().status).toBe("done");
    expect(await finalAnswer()).toEqual(JSON.parse(parentSolution()));
  });

  test("N4_the_grace_is_a_whole_number_of_seconds_above_zero", () => {
    const world = buildWorld();
    expect(() => leadOf(world, { entrySecs: 0 })).toThrow(/entrySecs/);
    expect(() => leadOf(world, { entrySecs: 1.5 })).toThrow(/entrySecs/);
  });
});
