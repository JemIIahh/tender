import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TenderClient } from "@tender/client";
import { createStateStore } from "@tender/mcp";
import {
  BriefSchema,
  canonicalJson,
  HIRER_ACCEPTS_CRITERIA,
  type Service,
  sha256Hex,
  type TaskView,
  type TenderApi,
} from "@tender/shared";
import { afterEach, expect, test } from "vitest";
import { planAssistedImport } from "../src/services/assistance-planner";
import { auditCsv, findDuplicateRecords } from "../src/services/data-quality";
import { utilityRequest } from "../src/services/escrow";
import {
  createEscrowAssistedSolver,
  type EscrowAssistanceOptions,
} from "../src/services/escrow-assistance";
import type { TaskContext } from "../src/types";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const NS = 1_000_000_000n;
async function world() {
  const directory = await mkdtemp(join(tmpdir(), "tender-assistance-test-"));
  dirs.push(directory);
  const state = createStateStore(join(directory, "drafts"));
  const journalDir = join(directory, "jobs");
  const account = "planner.testnet";
  const token = "token.testnet";
  const brief = BriefSchema.parse({
    version: 1,
    title: "Check an import",
    summary: "Team test.",
    instructions: JSON.stringify({
      operation: "import-readiness",
      csv: "id,quantity\nA,2\nA,3\n",
      required_columns: ["id"],
      key_columns: ["id"],
    }),
    category: "data",
    tags: ["import-readiness"],
    output: { format: "json", max_bytes: 16384 },
  });
  const task = {
    id: "1",
    poster: "poster.testnet",
    verifier: "poster.testnet",
    token,
    reward: "1000000",
    fee_bps: 500,
    brief_hash: sha256Hex(canonicalJson(brief)),
    criteria_hash: sha256Hex(canonicalJson(HIRER_ACCEPTS_CRITERIA)),
    created_at: "1",
    commit_deadline: String(1000n * NS),
    outcome: null,
    invited: [],
  } as unknown as TaskView;
  const ctx = { task, brief, criteria: HIRER_ACCEPTS_CRITERIA } as unknown as TaskContext;
  const listings = ["csv-audit", "duplicate-records"].map(
    (capability, i) =>
      ({
        id: String(i + 1),
        provider: "provider.testnet",
        agent: "specialist.testnet",
        title: capability,
        description: "Untrusted listing words.",
        price: "100000",
        token,
        available: true,
        status: "active",
        payment_mode: "escrow",
        output_format: "json",
        category: "data",
        tags: [capability],
        verification: { kind: "hirer" },
        commit_secs: 10,
        reveal_secs: 10,
        pick_secs: 30,
      }) as Service,
  );
  let now = 10n * NS;
  let spent = 0n;
  let cap = 200000n;
  let vault = 1000000n;
  let fullAccess = false;
  let unlimitedGas = false;
  let delegateAcceptor = false;
  let placeholder = true;
  let losePost = false;
  let pending = false;
  let failDisk = false;
  let wrongHash = false;
  let badResult = false;
  let losePick = false;
  const tasks = new Map<string, TaskView>([["1", task]]);
  const entries = new Map<
    string,
    {
      account: string;
      task_id: string;
      content_hash: string;
      uri: string;
      committed_at_block: string;
    }
  >();
  const blobs = new Map<string, Uint8Array>();
  const txs = new Map<string, string>();
  const posts: unknown[] = [];
  const picks: unknown[] = [];
  const commits: unknown[] = [];
  let uploads = 0;
  const api = {
    async getService(id: bigint) {
      const service = listings.find((s) => s.id === String(id));
      return service ? { service } : null;
    },
    async getBlob(hash: string) {
      return blobs.get(hash) ?? null;
    },
    async uploadBlob(input: { bytes: Uint8Array }) {
      uploads++;
      const hash = sha256Hex(input.bytes);
      blobs.set(hash, input.bytes);
      return { hash, uri: `blob:${hash}` };
    },
  } as unknown as TenderApi;
  function client(role: "worker" | "spender" | "acceptor") {
    return {
      network: "testnet",
      accountId: account,
      contractId: "contract.testnet",
      publicKey: `public-${role}`,
      async viewAccessKey() {
        return {
          permission: fullAccess
            ? "FullAccess"
            : {
                FunctionCall: {
                  receiver_id: "contract.testnet",
                  method_names:
                    role === "worker"
                      ? ["commit", "reveal"]
                      : role === "spender"
                        ? ["post_task"]
                        : ["pick"],
                  allowance: unlimitedGas ? null : "100000000000000000000000",
                },
              },
        };
      },
      async view(_contract: string, _method: string, args: { public_key: string }) {
        return args.public_key === "public-spender" || delegateAcceptor
          ? { token, per_task_cap: "100000", total_cap: String(cap), spent: String(spent) }
          : null;
      },
      async balanceOf() {
        return vault;
      },
      async blockTimestampNs() {
        return now;
      },
      async getTask(id: bigint) {
        return tasks.get(String(id)) ?? null;
      },
      async getEntry(id: bigint) {
        return String(id) === "1"
          ? placeholder
            ? { commitment: "placeholder" }
            : null
          : (entries.get(String(id)) ?? null);
      },
      async postTask(
        input: {
          reward: bigint;
          briefHash: string;
          criteriaHash: string;
          parent: bigint;
          invited: string[];
        },
        opts: unknown,
        hooks: { beforeSend(tx: unknown): Promise<void> },
      ) {
        if (failDisk) throw new Error("disk unavailable before signing");
        const id = String(2 + posts.length);
        const txHash = `tx-${id}`;
        await hooks.beforeSend({ txHash });
        posts.push({ input, opts });
        spent += input.reward;
        vault -= input.reward;
        tasks.set(id, {
          ...task,
          id,
          poster: account,
          verifier: account,
          parent: String(input.parent),
          reward: String(input.reward),
          brief_hash: input.briefHash,
          criteria_hash: input.criteriaHash,
          invited: input.invited,
          max_entries: 1,
          max_winners: 1,
          commit_deadline: String(20n * NS),
          reveal_deadline: String(30n * NS),
          pick_deadline: String(100n * NS),
        });
        txs.set(txHash, id);
        if (losePost) {
          losePost = false;
          throw new Error("socket lost after payment");
        }
        return { taskId: BigInt(id), txHash };
      },
      async txStatus(hash: string) {
        return pending
          ? { kind: "unknown" }
          : { kind: "executed", result: { returnValue: txs.get(hash) } };
      },
      async send(call: { args: { task_id: string; winners: unknown[] } }) {
        picks.push(call);
        const child = tasks.get(call.args.task_id);
        if (child)
          child.outcome = { kind: "picked", winners: call.args.winners } as TaskView["outcome"];
        if (losePick) {
          losePick = false;
          throw new Error("pick response lost");
        }
        return {};
      },
      async commit(id: bigint, commitment: string) {
        commits.push({ id, commitment });
        return {};
      },
    } as unknown as TenderClient;
  }
  const options: EscrowAssistanceOptions = {
    worker: client("worker"),
    spender: client("spender"),
    acceptor: client("acceptor"),
    api,
    state,
    journalDir,
    token,
    posters: [task.poster],
    verifiers: [task.verifier],
    minProfit: 10000n,
    plan: planAssistedImport,
    services: listings.map((s, i) => ({
      capability: ["csv-audit", "duplicate-records"][i] as string,
      serviceId: s.id,
      agent: s.agent,
      provider: s.provider,
      maxPrice: 100000n,
    })),
  };
  const make = () => createEscrowAssistedSolver(options);
  async function deliver() {
    now = 40n * NS;
    for (const [id, child] of tasks) {
      if (id === "1") continue;
      const brief = JSON.parse(new TextDecoder().decode(blobs.get(child.brief_hash)));
      const request = utilityRequest(brief.instructions);
      const result =
        request?.operation === "csv-audit"
          ? auditCsv(request.input)
          : findDuplicateRecords(request?.input);
      const bytes = canonicalJson(badResult ? { fabricated: true } : result);
      const hash = sha256Hex(bytes);
      blobs.set(hash, wrongHash ? canonicalJson({ replaced: true }) : bytes);
      entries.set(id, {
        account: listings[0]?.agent ?? "",
        task_id: id,
        content_hash: hash,
        uri: `blob:${hash}`,
        committed_at_block: "10",
      });
    }
  }
  return {
    options,
    make,
    ctx,
    task,
    listings,
    posts,
    picks,
    commits,
    state,
    journalDir,
    deliver,
    uploads: () => uploads,
    spent: () => spent,
    flags: (f: {
      cap?: bigint;
      vault?: bigint;
      fullAccess?: boolean;
      unlimitedGas?: boolean;
      delegateAcceptor?: boolean;
      placeholder?: boolean;
      losePost?: boolean;
      pending?: boolean;
      failDisk?: boolean;
      wrongHash?: boolean;
      badResult?: boolean;
      losePick?: boolean;
      now?: bigint;
    }) => {
      cap = f.cap ?? cap;
      vault = f.vault ?? vault;
      fullAccess = f.fullAccess ?? fullAccess;
      unlimitedGas = f.unlimitedGas ?? unlimitedGas;
      delegateAcceptor = f.delegateAcceptor ?? delegateAcceptor;
      placeholder = f.placeholder ?? placeholder;
      losePost = f.losePost ?? losePost;
      pending = f.pending ?? pending;
      failDisk = f.failDisk ?? failDisk;
      wrongHash = f.wrongHash ?? wrongHash;
      badResult = f.badResult ?? badResult;
      losePick = f.losePick ?? losePick;
      now = f.now ?? now;
    },
  };
}

test("discovers two approved capabilities, hires with the delegate, validates, pays and composes the parent", async () => {
  const w = await world();
  const solver = w.make();
  expect(await solver.solve(w.ctx)).not.toBeNull();
  await solver.tick();
  expect(w.posts).toHaveLength(2);
  expect(w.posts[0]).toMatchObject({
    opts: { delegate: true },
    input: { parent: 1n, invited: ["specialist.testnet"] },
  });
  await w.deliver();
  for (let i = 0; i < 3; i++) await solver.tick();
  expect(w.picks).toHaveLength(2);
  expect(w.spent()).toBe(200000n);
  expect(w.commits).toHaveLength(1);
  const draft = await w.state.getDraft("1");
  const answer = JSON.parse(Buffer.from(draft?.contentBase64 ?? "", "base64").toString());
  expect(answer.decision).toBe("review_required");
  expect(answer.duplicates.duplicate_group_count).toBe(1);
  expect((await solver.jobs())[0]?.status).toBe("done");
  expect(await solver.solve(w.ctx)).toBeNull();
});

test("a timed-out signed purchase is recovered after restart without hiring twice", async () => {
  const w = await world();
  w.flags({ losePost: true });
  let solver = w.make();
  await solver.solve(w.ctx);
  await expect(solver.tick()).rejects.toThrow(/socket lost/);
  expect(w.posts).toHaveLength(1);
  solver = w.make();
  await solver.tick();
  expect(w.posts).toHaveLength(2);
  await w.deliver();
  for (let i = 0; i < 3; i++) await solver.tick();
  expect(w.picks).toHaveLength(2);
  expect(w.posts).toHaveLength(2);
});

test("unknown signed transaction blocks further purchases even after restart", async () => {
  const w = await world();
  w.flags({ losePost: true, pending: true });
  const solver = w.make();
  await solver.solve(w.ctx);
  await expect(solver.tick()).rejects.toThrow();
  for (let i = 0; i < 3; i++) await w.make().tick();
  expect(w.posts).toHaveLength(1);
});

test("an ambiguous acceptance reads the settled outcome and cannot pay twice", async () => {
  const w = await world();
  const solver = w.make();
  await solver.solve(w.ctx);
  await solver.tick();
  await w.deliver();
  w.flags({ losePick: true });
  await expect(solver.tick()).rejects.toThrow(/pick response/);
  for (let i = 0; i < 3; i++) await w.make().tick();
  expect(w.picks).toHaveLength(2);
  expect(w.commits).toHaveLength(1);
});

test.each(["badResult", "wrongHash"] as const)(
  "%s refuses acceptance and the parent answer",
  async (flag) => {
    const w = await world();
    const solver = w.make();
    await solver.solve(w.ctx);
    await solver.tick();
    w.flags({ [flag]: true });
    await w.deliver();
    await solver.tick();
    expect(w.picks).toHaveLength(0);
    expect(w.commits).toHaveLength(0);
    expect((await solver.jobs())[0]?.status).toBe("abandoned");
  },
);

test.each([
  "cap",
  "vault",
  "profit",
  "deadline",
  "poster",
  "provider",
  "price",
  "paused",
  "wrongToken",
  "brief",
])("%s gate refuses before uploading or spending", async (gate) => {
  const w = await world();
  if (gate === "cap") w.flags({ cap: 100000n });
  if (gate === "vault") w.flags({ vault: 0n });
  if (gate === "profit") w.task.reward = "200000";
  if (gate === "deadline") w.task.commit_deadline = String(60n * NS);
  if (gate === "poster") w.task.poster = "stranger.testnet";
  if (gate === "brief") w.ctx.brief.instructions += " ";
  if (gate === "provider") for (const s of w.listings) s.provider = "stranger.testnet";
  if (gate === "price") for (const s of w.listings) s.price = "100001";
  if (gate === "paused") for (const s of w.listings) s.status = "paused";
  if (gate === "wrongToken") for (const s of w.listings) s.token = "other.testnet";
  expect(await w.make().solve(w.ctx)).toBeNull();
  expect(w.posts).toHaveLength(0);
  expect(w.uploads()).toBe(0);
});

test.each(["fullAccess", "unlimitedGas", "delegateAcceptor"] as const)(
  "refuses unsafe %s key configuration",
  async (flag) => {
    const w = await world();
    w.flags({ [flag]: true });
    await expect(w.make().solve(w.ctx)).rejects.toThrow();
    expect(w.posts).toHaveLength(0);
  },
);

test("changed listing or parent after planning stops before a purchase", async () => {
  const w = await world();
  const solver = w.make();
  await solver.solve(w.ctx);
  if (w.listings[0]) w.listings[0].price = "99999";
  await solver.tick();
  expect(w.posts).toHaveLength(0);
  expect((await solver.jobs())[0]?.status).toBe("abandoned");
});

test("only one parent is worked on, and no child is posted without the placeholder entry", async () => {
  const w = await world();
  const solver = w.make();
  await solver.solve(w.ctx);
  expect(await solver.solve({ ...w.ctx, task: { ...w.ctx.task, id: "99" } })).toBeNull();
  w.flags({ placeholder: false });
  await solver.tick();
  expect(w.posts).toHaveLength(0);
});

test("journal damage and changed owner policy fail closed after restart", async () => {
  const w = await world();
  const solver = w.make();
  await solver.solve(w.ctx);
  const path = join(w.journalDir, "1.json");
  const text = await readFile(path, "utf8");
  await writeFile(path, text.replace('"working"', '"done"'));
  await expect(w.make().tick()).rejects.toThrow(/damaged/);
  await writeFile(path, text);
  w.options.minProfit = 20000n;
  await expect(w.make().tick()).rejects.toThrow(/configuration/);
  expect(w.posts).toHaveLength(0);
});

test("unsupported input is declined without a model call or service purchase", async () => {
  const w = await world();
  expect(
    planAssistedImport({
      ...w.ctx,
      brief: { ...w.ctx.brief, instructions: '{"operation":"arbitrary"}' },
    }),
  ).toBeNull();
  expect(
    planAssistedImport({
      ...w.ctx,
      brief: {
        ...w.ctx.brief,
        instructions: '{"operation":"import-readiness","csv":"id\\nA,2","key_columns":["id"]}',
      },
    }),
  ).toBeNull();
});

test("chooses the least expensive approved compatible service", async () => {
  const w = await world();
  const alternative = { ...w.listings[0], id: "3", price: "90000" } as Service;
  w.listings.push(alternative);
  w.options.services = [
    ...w.options.services,
    {
      capability: "csv-audit",
      serviceId: "3",
      provider: alternative.provider,
      agent: alternative.agent,
      maxPrice: 100000n,
    },
  ];
  const solver = w.make();
  await solver.solve(w.ctx);
  await solver.tick();
  expect(w.posts[0]).toMatchObject({ input: { reward: 90000n } });
  expect(w.spent()).toBe(190000n);
});

test("canonical task IDs are required before creating a journal", async () => {
  const w = await world();
  const ctx = { ...w.ctx, task: { ...w.ctx.task, id: "0x1" } };
  expect(await w.make().solve(ctx)).toBeNull();
  expect(await w.make().jobs()).toEqual([]);
});

test("simultaneous planners sharing a journal cannot buy for two parents", async () => {
  const w = await world();
  const answers = await Promise.allSettled([w.make().solve(w.ctx), w.make().solve(w.ctx)]);
  expect(
    answers.filter((answer) => answer.status === "fulfilled" && answer.value !== null),
  ).toHaveLength(1);
  await w.make().tick();
  expect(w.posts).toHaveLength(2);
});

test("expired acceptance leaves a visible abandoned job and pays nothing", async () => {
  const w = await world();
  const solver = w.make();
  await solver.solve(w.ctx);
  await solver.tick();
  await w.deliver();
  w.flags({ now: 200n * NS });
  await solver.tick();
  expect(w.picks).toHaveLength(0);
  expect((await solver.jobs())[0]?.reason).toMatch(/acceptance window expired/);
});
