import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TenderError, type TxResult } from "@tender/client";
import { createStateStore, isDraftOf, type StateStore } from "@tender/mcp";
import {
  canonicalJson,
  computeCommitment,
  type PostTaskInput,
  type SpendOptions,
  sha256Hex,
  type TaskDetailResponse,
  type TaskOutcome,
} from "@tender/shared";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createLeadSolver, LEAD_TAG, type LeadApi, type LeadChain } from "../src/agents/lead";
import type { TaskContext } from "../src/types";
import {
  BRIEF,
  CRITERIA,
  JUDGE,
  POSTER,
  picked,
  taskDetailResponse,
  taskSpec,
  voided,
} from "./helpers";

// The lead agent of the swarm demo, with a stand-in chain and a stand-in API in one small world.
// The pack is the demo's own (scripts/swarm-research-pack), so the happy path also shows that what
// the lead assembles from the pack's solutions is the pack's parent solution.

const PACK = join(import.meta.dirname, "../../../scripts/swarm-research-pack");
const CHILDREN = join(PACK, "children");
const SLUGS = ["01-gas-ledger", "02-key-audit", "03-event-tally"];

const LEAD = "lead.test.near";
const ALICE = "alice.test.near";
const BOB = "bob.test.near";
/** A token the client's network knows the decimals of (6, so 2.00 is 2_000_000). */
const TOKEN = "tusdc.test.near";
const PARENT_ID = 10;
const NS = 1_000_000_000n;
/** The chain's clock at the start, in nanoseconds. Moves only when the world moves it. */
const T0 = 1_700_000_000n * NS;

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
  /** Makes the post of child number `n` (from 0) fail with this error. */
  failPost?: { n: number; error: Error };
  /** Makes the commit fail. */
  failCommit?: Error;
}

/** A small world: a chain with a clock, an index of tasks, and the events in the order they happen. */
function buildWorld(o: WorldOptions = {}) {
  const events: string[] = [];
  const children: Child[] = [];
  const blobs = new Map<string, Uint8Array>();
  const uploads: Array<{ kind: string; sha256: string }> = [];
  const heldouts: string[] = [];
  const commits: Array<{ taskId: bigint; commitment: string }> = [];
  let now = T0;

  const parentCommitDeadline = T0 + BigInt(o.commitSecs ?? 3600) * NS;
  const nextId = () => BigInt(PARENT_ID + 1 + children.length);

  const client: LeadChain = {
    network: "testnet",
    contractId: "tender.test.near",
    accountId: LEAD,
    async commit(taskId, commitment) {
      events.push("commit");
      if (o.failCommit !== undefined) throw o.failCommit;
      commits.push({ taskId, commitment });
      return { txHash: "tx-commit" } as TxResult;
    },
    async postTask(input, opts) {
      const n = children.length;
      events.push(`post ${n}`);
      if (o.failPost?.n === n) throw o.failPost.error;
      const id = nextId();
      children.push({ id, input, opts, polls: 0 });
      // A post takes a few seconds of chain time.
      now += 3n * NS;
      return { txHash: `tx-post-${n}`, taskId: id } as TxResult & { taskId: bigint };
    },
    async blockTimestampNs() {
      return now;
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

  const api: LeadApi = {
    async uploadBlob(blob) {
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
      return blobs.get(sha256) ?? null;
    },
  };

  const parent = taskDetailResponse(
    taskSpec({ id: PARENT_ID, tags: [LEAD_TAG], phase: "open", poster: POSTER }),
  );
  const ctx: TaskContext = {
    task: {
      ...parent.task,
      token: TOKEN,
      reward: "10000000",
      created_at: String(T0),
      commit_deadline: String(parentCommitDeadline),
    },
    brief: { ...BRIEF, tags: [LEAD_TAG] },
    criteria: CRITERIA,
  };

  return { client, api, ctx, events, children, uploads, heldouts, commits, blobs, now: () => now };
}

let dirs: string[] = [];
let state: StateStore;
let stateDir: string;
/** Ends every wait a test leaves behind, so that no lead outlives its test. */
let stop: AbortController;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "lead-state-"));
  dirs = [stateDir];
  state = createStateStore(stateDir);
  stop = new AbortController();
});
afterEach(() => {
  stop.abort();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function solverOf(
  world: ReturnType<typeof buildWorld>,
  more: Partial<Parameters<typeof createLeadSolver>[0]> = {},
  lines: string[] = [],
) {
  return createLeadSolver({
    seedsDir: CHILDREN,
    client: world.client,
    api: world.api,
    judgeAccount: JUDGE,
    state,
    pollMs: 1,
    signal: stop.signal,
    log: (line) => lines.push(line),
    ...more,
  });
}

describe("the lead's job on a swarm task", () => {
  test("commits_a_placeholder_then_hires_three_under_a_delegate_key_then_assembles_the_pack", async () => {
    const world = buildWorld();
    const lines: string[] = [];
    const answer = await solverOf(world, {}, lines).solve(world.ctx);

    // The placeholder is the first thing on chain: a child needs an entry on the parent.
    expect(world.events[0]).toBe("commit");
    expect(world.events.filter((event) => event === "commit")).toHaveLength(1);
    expect(world.commits[0]?.taskId).toBe(BigInt(PARENT_ID));

    // Three children, in the order of the pack, each uploaded before it is posted.
    expect(world.children).toHaveLength(3);
    const order = world.events.filter((event) => event !== "commit");
    expect(order).toEqual([
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

    // The pack's parent solution is the parts in order, whoever won each.
    expect(answer).not.toBeNull();
    const parentSolution = readFileSync(join(PACK, "parent", "solution.txt"), "utf8");
    expect(JSON.parse(new TextDecoder().decode(answer ?? new Uint8Array()))).toEqual(
      JSON.parse(parentSolution),
    );
    expect(lines.some((line) => line.includes("placeholder"))).toBe(true);
  });

  test("the_placeholder_is_a_draft_that_opens_its_commitment_and_is_marked_committed", async () => {
    const world = buildWorld();
    await solverOf(world).solve(world.ctx);

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
    expect(draft.contractId).toBe("tender.test.near");
    expect(draft.taskCreatedAt).toBe(world.ctx.task.created_at);
    expect(draft.committedAt).toBeDefined();
    expect(draft.revealedUri).toBeUndefined();
  });

  test("the_parts_follow_the_pack_s_order_when_the_children_settle_in_another", async () => {
    const world = buildWorld({ settleOn: [4, 3, 2], winners: [BOB, ALICE, BOB] });
    const answer = await solverOf(world).solve(world.ctx);
    const parentSolution = readFileSync(join(PACK, "parent", "solution.txt"), "utf8");
    expect(JSON.parse(new TextDecoder().decode(answer ?? new Uint8Array()))).toEqual(
      JSON.parse(parentSolution),
    );
  });

  test("the_winner_s_content_is_taken_by_the_winner_and_not_by_the_order_of_commits", async () => {
    // The stand-in lists the loser first. Contents that differ per child show it went by the winner.
    const contents = SLUGS.map((_, index) => JSON.stringify({ child: index }));
    const world = buildWorld({ contents });
    const answer = await solverOf(world).solve(world.ctx);
    expect(JSON.parse(new TextDecoder().decode(answer ?? new Uint8Array()))).toEqual({
      parts: [{ child: 0 }, { child: 1 }, { child: 2 }],
    });
  });

  test("a_content_that_is_not_json_stays_a_string_in_its_part", async () => {
    const contents = [solutionOf(SLUGS[0] ?? ""), "plain words", solutionOf(SLUGS[2] ?? "")];
    const world = buildWorld({ contents });
    const answer = await solverOf(world).solve(world.ctx);
    const parts = JSON.parse(new TextDecoder().decode(answer ?? new Uint8Array())).parts;
    expect(parts[1]).toBe("plain words");
  });

  test("windows_given_to_the_lead_replace_the_pack_s", async () => {
    const world = buildWorld({ commitSecs: 170 });
    const windows = { commit_secs: 20, reveal_secs: 20, pick_secs: 30, fallback_secs: 20 };
    await solverOf(world, { windows }).solve(world.ctx);
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
    await solverOf(world, { windows }).solve(world.ctx);
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
    expect(await solverOf(world).solve(ctx)).toBeNull();
    expect(world.events).toEqual([]);
  });

  test("a_parent_with_no_room_for_the_pack_s_windows_is_left_alone_before_anything_is_committed", async () => {
    // The pack's windows take 1500 s; a parent with 100 s to its commit deadline cannot wait.
    const world = buildWorld({ commitSecs: 100 });
    const lines: string[] = [];
    expect(await solverOf(world, {}, lines).solve(world.ctx)).toBeNull();
    expect(world.events).toEqual([]);
    expect(lines.join("\n")).toMatch(/commit deadline/);
  });

  test("a_parent_that_leaves_the_windows_but_not_the_minute_in_hand_is_left_alone", async () => {
    // The windows take 70 s. A commit deadline 100 s away leaves room for them, and not for them
    // and a minute to assemble in. With no margin the same parent is hired for.
    const windows = { commit_secs: 20, reveal_secs: 20, pick_secs: 30, fallback_secs: 20 };
    const tight = buildWorld({ commitSecs: 100 });
    expect(await solverOf(tight, { windows }).solve(tight.ctx)).toBeNull();
    expect(tight.events).toEqual([]);

    const relaxed = buildWorld({ commitSecs: 100 });
    await solverOf(relaxed, { windows, marginSecs: 0 }).solve(relaxed.ctx);
    expect(relaxed.children).toHaveLength(3);
  });

  test("a_commit_that_fails_ends_the_job_before_any_hire", async () => {
    const world = buildWorld({ failCommit: new TenderError("E_PHASE", "too late") });
    const lines: string[] = [];
    expect(await solverOf(world, {}, lines).solve(world.ctx)).toBeNull();
    expect(world.children).toHaveLength(0);
    expect(lines.join("\n")).toContain("E_PHASE");
  });

  test("a_post_that_the_contract_refuses_ends_the_job_and_says_why", async () => {
    const world = buildWorld({
      failPost: { n: 1, error: new TenderError("E_AUTH", "past the total cap") },
    });
    const lines: string[] = [];
    expect(await solverOf(world, {}, lines).solve(world.ctx)).toBeNull();
    expect(world.children).toHaveLength(1);
    expect(lines.join("\n")).toContain("E_AUTH");
  });

  test("a_child_that_is_voided_ends_the_job_with_no_answer", async () => {
    const world = buildWorld({ voidChild: 2 });
    const lines: string[] = [];
    expect(await solverOf(world, {}, lines).solve(world.ctx)).toBeNull();
    expect(lines.join("\n")).toMatch(/voided/);
  });

  test("children_that_never_settle_end_the_job_at_the_parent_s_commit_deadline", async () => {
    const world = buildWorld({ stall: { secs: 600 } });
    const lines: string[] = [];
    expect(await solverOf(world, {}, lines).solve(world.ctx)).toBeNull();
    expect(lines.join("\n")).toMatch(/commit deadline/);
  });

  test("an_abort_ends_the_wait_at_once", async () => {
    const controller = new AbortController();
    const world = buildWorld({ stall: { secs: 0 } });
    const solving = solverOf(world, { signal: controller.signal, pollMs: 5 }).solve(world.ctx);
    setTimeout(() => controller.abort(), 50);
    expect(await solving).toBeNull();
  });

  test("an_empty_pack_is_a_mistake_found_when_the_solver_is_made", () => {
    const empty = mkdtempSync(join(tmpdir(), "lead-empty-"));
    dirs.push(empty);
    const world = buildWorld();
    expect(() => createLeadSolver({ ...solverOptions(world), seedsDir: empty })).toThrow(
      /no sub-tasks/,
    );
  });

  test("a_child_whose_files_do_not_fit_is_found_when_the_solver_is_made", () => {
    const bad = mkdtempSync(join(tmpdir(), "lead-bad-"));
    dirs.push(bad);
    mkdirSync(join(bad, "01-broken"));
    writeFileSync(join(bad, "01-broken", "task.json"), "{}");
    const world = buildWorld();
    expect(() => createLeadSolver({ ...solverOptions(world), seedsDir: bad })).toThrow(/01-broken/);
  });
});

describe("the solver itself", () => {
  test("is_named_the_lead_and_is_not_a_scripted_one", () => {
    const solver = solverOf(buildWorld());
    expect(solver.name).toBe("lead");
    expect(solver.scripted).toBe(false);
  });
});

function solverOptions(
  world: ReturnType<typeof buildWorld>,
): Parameters<typeof createLeadSolver>[0] {
  return {
    seedsDir: CHILDREN,
    client: world.client,
    api: world.api,
    judgeAccount: JUDGE,
    state,
    pollMs: 1,
  };
}
