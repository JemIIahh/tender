import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LocalChain, startLocalChain, TenderClient } from "@tender/client";
import {
  canonicalJson,
  NETWORKS,
  parseTokenAmount,
  sha256Hex,
  type TaskDetailResponse,
  type TaskSummary,
  type TaskView,
  type TenderApi,
} from "@tender/shared";
import { afterAll, beforeAll, expect, test } from "vitest";
import { writeSyntheticHeldouts } from "../seeds/synthetic-heldout";
import { heldoutFileOf, missingHeldouts, privateDirOf } from "./lib/private-dir";
import { type SeedWindows, seed } from "./seed";

// The seed script against a local chain with Tender and a test token on it, and a fake API that
// keeps what is uploaded and says where it is served. What the chain holds of each task is read
// back and compared with the repository's own files, whose hashes are worked out here on their
// own: the script and the test agree only if the chain really holds what the files say. A seed's
// held-out checks are not among the repository's files (they are secret until the task is judged):
// they are read from the private directory when this machine has them, and are stand-ins of the
// right kind where it has not (CI), so the same posting is checked either way.

let chain: LocalChain;
/** Unsigned, for reading. */
let reader: TenderClient;

beforeAll(async () => {
  chain = await startLocalChain();
  reader = new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
  });
});

afterAll(async () => {
  await chain?.stop();
});

type Role = keyof LocalChain["accounts"];

/** A client that signs as the chain's account for `role`. */
const clientOf = (role: Role) =>
  new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
    signer: chain.accounts[role],
  });

const SEEDS = join(import.meta.dirname, "..", "seeds");

/** The private directory when it has every seed's held-out checks, else a directory of stand-ins. */
const STAND_IN_DIR: string | undefined = (() => {
  const slugs = readdirSync(SEEDS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (missingHeldouts(SEEDS, privateDirOf(), slugs).length === 0) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "tender-heldout-stand-in-"));
  writeSyntheticHeldouts(SEEDS, dir);
  return dir;
})();
const HELDOUT_DIR = STAND_IN_DIR ?? privateDirOf();

afterAll(() => {
  if (STAND_IN_DIR !== undefined) rmSync(STAND_IN_DIR, { recursive: true, force: true });
});

/** A file of a seed of the repository, as JSON; its held-out checks are in `HELDOUT_DIR`. */
const fileOf = (slug: string, name: string) =>
  JSON.parse(
    readFileSync(
      name === "heldout.json" ? heldoutFileOf(HELDOUT_DIR, slug) : join(SEEDS, slug, name),
      "utf8",
    ),
  ) as Record<string, unknown>;

/** The hash a task holds of a document: the SHA-256 of its canonical bytes. */
const hashOf = (document: object) => sha256Hex(canonicalJson(document));

/** The commitment a seed's task holds: the hash of its held-out checks, or none for a rubric seed. */
const commitmentOf = (slug: string) =>
  existsSync(heldoutFileOf(HELDOUT_DIR, slug)) ? hashOf(fileOf(slug, "heldout.json")) : null;

const unexpected = (method: string) => () => {
  throw new Error(`unexpected call to api.${method}`);
};

interface Blob {
  kind: string;
  sha256: string;
  uri: string;
  bytes: Uint8Array;
}

/** A task of the chain as the API's list gives it, which leaves the brief out. */
function summaryOf(task: TaskView): TaskSummary {
  return {
    id: task.id,
    title: null,
    category: null,
    tags: [],
    token: task.token,
    reward: task.reward,
    phase: task.phase,
    poster: task.poster,
    verifier: task.verifier,
    created_at: task.created_at,
    commit_deadline: task.commit_deadline,
    reveal_deadline: task.reveal_deadline,
    pick_deadline: task.pick_deadline,
    fallback_deadline: task.fallback_deadline,
    commit_count: task.commit_count,
    reveal_count: task.reveal_count,
    working_count: 0,
    judge_status: null,
    judge_reason: null,
    is_team_poster: false,
    parent: task.parent,
    outcome_kind: task.outcome?.kind ?? null,
  };
}

/** A task of the chain as the API's page of one task gives it, which has the brief's hash. */
function detailOf(task: TaskView): TaskDetailResponse {
  return {
    task: {
      ...summaryOf(task),
      brief_uri: task.brief_uri,
      brief_hash: task.brief_hash,
      criteria_hash: task.criteria_hash,
      heldout_commitment: task.heldout_commitment,
      max_entries: task.max_entries,
      max_winners: task.max_winners,
      invited: task.invited,
      fee_bps: task.fee_bps,
      outcome: null,
    },
    brief: null,
    criteria: null,
    entries: [],
    funders: task.funders,
    children: [],
    scorecard: null,
  };
}

/**
 * The API as far as the script uses it: it keeps every blob and held-out document it is given and
 * serves the URI `https://api.test/v1/blobs/<sha256>`. The held-out documents named in `served`
 * count as public already, as one that was judged is. Its tasks are the chain's, listed the way the
 * API lists them (newest first, for a poster, in pages), so that what the script finds of the
 * poster's tasks is what the chain holds. It says it serves the chain's network and contract.
 */
function recordingApi(served: ReadonlySet<string> = new Set()) {
  const blobs: Blob[] = [];
  const heldouts: { commitment: string; bytes: Uint8Array }[] = [];
  const api: TenderApi = {
    listTasks: async (filter = {}) => {
      const count = await reader.taskCount();
      const all: TaskView[] = [];
      for (let from = 1n; from <= count; from += 50n)
        all.push(...(await reader.getTasks(from, 50)));
      const matching = all
        .filter((task) => !filter.poster || task.poster === filter.poster)
        .filter((task) => !filter.cursor || BigInt(task.id) < BigInt(filter.cursor))
        .sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)));
      const size = filter.limit ?? 20;
      const page = matching.slice(0, size);
      const last = page.at(-1);
      return {
        tasks: page.map(summaryOf),
        next_cursor: matching.length > size && last !== undefined ? last.id : null,
      };
    },
    getTask: async (id) => {
      const task = await reader.getTask(id);
      return task === null ? null : detailOf(task);
    },
    listAgents: unexpected("listAgents"),
    getAgent: unexpected("getAgent"),
    listEntries: unexpected("listEntries"),
    health: async () => ({
      ok: true,
      network: chain.network,
      contract: chain.contractId,
      indexed_height: "1",
      chain_final_height: "1",
      lag_blocks: "0",
      waiting_for_chain: false,
    }),
    getScorecard: unexpected("getScorecard"),
    getBlob: async (sha256) => (served.has(sha256) ? new Uint8Array([1]) : null),
    uploadBlob: async ({ kind, bytes }) => {
      const sha256 = sha256Hex(bytes);
      const uri = `https://api.test/v1/blobs/${sha256}`;
      blobs.push({ kind, sha256, uri, bytes });
      return { sha256, uri };
    },
    uploadHeldout: async (commitment, bytes) => {
      heldouts.push({ commitment, bytes });
    },
    start: unexpected("start"),
    telegramLink: unexpected("telegramLink"),
    signIn: unexpected("signIn"),
  };
  return { api, blobs, heldouts };
}

/** How long each of a task's four windows lasts, in seconds, from the deadlines the chain holds. */
function windowsOf(task: TaskView) {
  const secs = (from: string, to: string) => Number((BigInt(to) - BigInt(from)) / 1_000_000_000n);
  return {
    commit_secs: secs(task.created_at, task.commit_deadline),
    reveal_secs: secs(task.commit_deadline, task.reveal_deadline),
    pick_secs: secs(task.reveal_deadline, task.pick_deadline),
    fallback_secs: secs(task.pick_deadline, task.fallback_deadline),
  };
}

interface Who {
  poster: string;
  windows?: ReturnType<typeof windowsOf>;
}

/** Reads task `id` back from the chain and checks it against the files of seed `slug`. */
async function expectPosted(id: bigint, slug: string, who: Who, blobs: readonly Blob[]) {
  const task = await reader.getTask(id);
  if (task === null) throw new Error(`${slug}: task ${id} is not on the chain`);
  const terms = fileOf(slug, "task.json") as {
    reward: string;
    max_winners: number;
    commit_secs: number;
    reveal_secs: number;
    pick_secs: number;
    fallback_secs: number;
  };
  const briefHash = hashOf(fileOf(slug, "brief.json"));
  const reward = `${parseTokenAmount(terms.reward, 6)}`;

  expect(task.poster, slug).toBe(who.poster);
  expect(task.token, slug).toBe(chain.tokenId);
  expect(task.reward, slug).toBe(reward);
  expect(task.verifier, slug).toBe(chain.accounts.judge.accountId);
  expect(task.brief_hash, slug).toBe(briefHash);
  expect(task.criteria_hash, slug).toBe(hashOf(fileOf(slug, "criteria.json")));
  expect(task.heldout_commitment, slug).toBe(commitmentOf(slug));
  // The URI is where the API said it keeps the brief.
  expect(task.brief_uri, slug).toBe(`https://api.test/v1/blobs/${briefHash}`);
  expect(
    blobs.map((blob) => blob.uri),
    slug,
  ).toContain(task.brief_uri);
  expect(windowsOf(task), slug).toEqual(
    who.windows ?? {
      commit_secs: terms.commit_secs,
      reveal_secs: terms.reveal_secs,
      pick_secs: terms.pick_secs,
      fallback_secs: terms.fallback_secs,
    },
  );
  expect(task.max_winners, slug).toBe(terms.max_winners);
  // Open to anyone, with no cap on entries and no parent. That holds for a rubric seed too: an open
  // rubric task is allowed (the Judge grades its first 50 entries), and the script posts no cap.
  expect(task.max_entries, slug).toBe(0);
  expect(task.invited, slug).toEqual([]);
  expect(task.parent, slug).toBeNull();
  // The poster funded all of it, and nobody has entered yet.
  expect(task.funders, slug).toEqual([{ account: who.poster, amount: reward }]);
  expect(task.commit_count, slug).toBe(0);
  // A task with the shortest windows may be past its commit window by the time it is read back.
  if (who.windows === undefined) expect(task.phase, slug).toBe("open");
  else expect(task.phase, slug).not.toBe("settled");
  return task;
}

/** One run of the script as `role`, with a new recording API. */
async function seedAs(role: Role, only: string[], extra: { windows?: SeedWindows } = {}) {
  const { api, blobs, heldouts } = recordingApi();
  const lines: string[] = [];
  const posted = await seed({
    client: clientOf(role),
    api,
    network: chain.network,
    poster: chain.accounts[role].accountId,
    judgeAccount: chain.accounts.judge.accountId,
    tokenId: chain.tokenId,
    heldoutDir: HELDOUT_DIR,
    only,
    log: (line) => lines.push(line),
    ...extra,
  });
  return { posted, lines, blobs, heldouts };
}

/** What a run can change on the chain: how many tasks there are, and what `role` holds. */
async function holdings(role: Role) {
  const account = chain.accounts[role].accountId;
  return {
    tasks: await reader.taskCount(),
    wallet: await reader.ftBalanceOf(chain.tokenId, account),
    vault: await reader.balanceOf(account, chain.tokenId),
    storage: await reader.storageBalanceOf(account),
  };
}

/** Waits until task `id` is in one of `phases`, as the chain works its phase out. */
async function waitForPhase(id: bigint, phases: readonly string[]) {
  const giveUp = Date.now() + 60_000;
  for (;;) {
    const task = await reader.getTask(id);
    if (task !== null && phases.includes(task.phase)) return;
    if (Date.now() > giveUp) throw new Error(`task ${id} is not ${phases.join(" or ")} yet`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

test("two_seeds_are_posted_and_each_task_reads_back_as_its_files_say", async () => {
  const poster = chain.accounts.poster;
  const client = clientOf("poster");
  const { api, blobs, heldouts } = recordingApi();
  const lines: string[] = [];
  const walletBefore = await client.ftBalanceOf(chain.tokenId, poster.accountId);
  const countBefore = await reader.taskCount();

  const posted = await seed({
    client,
    api,
    network: chain.network,
    poster: poster.accountId,
    judgeAccount: chain.accounts.judge.accountId,
    tokenId: chain.tokenId,
    heldoutDir: HELDOUT_DIR,
    only: ["near-account-regex", "invoice-extract"],
    log: (line) => lines.push(line),
  });

  // In slug order, whatever order `only` names them in.
  const first = countBefore + 1n;
  expect(posted).toEqual([
    { slug: "invoice-extract", taskId: first, status: "posted" },
    { slug: "near-account-regex", taskId: first + 1n, status: "posted" },
  ]);
  expect(await reader.taskCount()).toBe(countBefore + 2n);
  expect(lines).toEqual([
    "DEPOSITED 1.50 tUSDC",
    `SEEDED invoice-extract task=${first}`,
    `SEEDED near-account-regex task=${first + 1n}`,
  ]);
  for (const { slug, taskId } of posted) {
    await expectPosted(taskId, slug, { poster: poster.accountId }, blobs);
  }

  // The API got, for each seed in turn, its brief, its criteria and its held-out checks, as the
  // canonical bytes of the files.
  expect(blobs.map(({ kind }) => kind)).toEqual(["brief", "criteria", "brief", "criteria"]);
  expect(blobs.map(({ bytes }) => bytes)).toEqual([
    canonicalJson(fileOf("invoice-extract", "brief.json")),
    canonicalJson(fileOf("invoice-extract", "criteria.json")),
    canonicalJson(fileOf("near-account-regex", "brief.json")),
    canonicalJson(fileOf("near-account-regex", "criteria.json")),
  ]);
  expect(heldouts.map(({ commitment }) => commitment)).toEqual([
    hashOf(fileOf("invoice-extract", "heldout.json")),
    hashOf(fileOf("near-account-regex", "heldout.json")),
  ]);
  expect(heldouts.map(({ bytes }) => sha256Hex(bytes))).toEqual(
    heldouts.map(({ commitment }) => commitment),
  );

  // 0.50 and 1.00 left the wallet for the vault and the vault paid both rewards out to escrow.
  expect(await client.ftBalanceOf(chain.tokenId, poster.accountId)).toBe(walletBefore - 1_500_000n);
  expect(await client.balanceOf(poster.accountId, chain.tokenId)).toBe(0n);
});

test("a_vault_that_holds_part_of_the_rewards_is_topped_up_by_the_rest_and_no_more", async () => {
  const lead = chain.accounts.lead;
  const client = clientOf("lead");
  const { api, blobs } = recordingApi();
  const lines: string[] = [];
  await client.deposit(chain.tokenId, 100_000n);
  const walletBefore = await client.ftBalanceOf(chain.tokenId, lead.accountId);

  // sum-of-transfers pays 0.25, of which the vault holds 0.10.
  const posted = await seed({
    client,
    api,
    network: chain.network,
    poster: lead.accountId,
    judgeAccount: chain.accounts.judge.accountId,
    tokenId: chain.tokenId,
    heldoutDir: HELDOUT_DIR,
    only: ["sum-of-transfers"],
    log: (line) => lines.push(line),
  });

  expect(lines).toEqual([
    "DEPOSITED 0.15 tUSDC",
    `SEEDED sum-of-transfers task=${posted[0]?.taskId}`,
  ]);
  expect(await client.ftBalanceOf(chain.tokenId, lead.accountId)).toBe(walletBefore - 150_000n);
  expect(await client.balanceOf(lead.accountId, chain.tokenId)).toBe(0n);
  const [only] = posted;
  if (only === undefined) throw new Error("nothing was posted");
  await expectPosted(only.taskId, "sum-of-transfers", { poster: lead.accountId }, blobs);
});

test("all_thirty_seeds_are_posted_by_an_account_that_opens_with_the_storage_for_eight", async () => {
  const alice = chain.accounts.alice;
  const client = clientOf("alice");
  const { api, blobs, heldouts } = recordingApi();
  const lines: string[] = [];
  const countBefore = await reader.taskCount();

  const posted = await seed({
    client,
    api,
    network: chain.network,
    poster: alice.accountId,
    judgeAccount: chain.accounts.judge.accountId,
    tokenId: chain.tokenId,
    heldoutDir: HELDOUT_DIR,
    log: (line) => lines.push(line),
  });

  // The 0.1 NEAR that the account opened with pays for about eight tasks, and thirty need about
  // four times that. The script topped it up first, then the vault, and then every task was
  // posted: none ran out of storage.
  expect(lines[0]).toMatch(/^DEPOSITED 0\.\d+ NEAR for storage$/);
  expect(lines[1]).toBe("DEPOSITED 22.50 tUSDC");
  expect(lines.slice(2)).toEqual(posted.map(({ slug, taskId }) => `SEEDED ${slug} task=${taskId}`));
  expect(posted).toHaveLength(30);
  expect(posted.map(({ slug }) => slug)).toEqual([...posted.map(({ slug }) => slug)].sort());
  expect(posted.map(({ taskId }) => taskId)).toEqual(
    Array.from({ length: 30 }, (_, i) => countBefore + 1n + BigInt(i)),
  );
  for (const { slug, taskId } of posted) {
    await expectPosted(taskId, slug, { poster: alice.accountId }, blobs);
  }
  // Twenty-five have held-out checks to store. The five rubric seeds have none, and their tasks
  // read back with no commitment (expectPosted).
  expect(heldouts).toHaveLength(25);
  expect(await client.balanceOf(alice.accountId, chain.tokenId)).toBe(0n);
});

test("the_windows_option_sets_the_windows_of_the_task_on_chain", async () => {
  const bob = chain.accounts.bob;
  const client = clientOf("bob");
  const { api, blobs } = recordingApi();
  const shortest = NETWORKS.sandbox.minWindowSecs;
  const windows = {
    commit_secs: shortest,
    reveal_secs: shortest + 1,
    pick_secs: shortest + 2,
    fallback_secs: shortest + 3,
  };

  const [posted] = await seed({
    client,
    api,
    network: chain.network,
    poster: bob.accountId,
    judgeAccount: chain.accounts.judge.accountId,
    tokenId: chain.tokenId,
    heldoutDir: HELDOUT_DIR,
    only: ["base58-decoded-length"],
    windows,
    log: () => {},
  });

  if (posted === undefined) throw new Error("nothing was posted");
  const task = await expectPosted(
    posted.taskId,
    "base58-decoded-length",
    { poster: bob.accountId, windows },
    blobs,
  );
  // The seed's own windows are 600, 300, 600 and 600: none of them is left.
  expect(windowsOf(task)).toEqual(windows);
});

test("a_seed_whose_heldout_is_public_is_not_posted_and_its_reward_stays_with_the_poster", async () => {
  const poster = chain.accounts.poster;
  const client = clientOf("poster");
  const judged = hashOf(fileOf("semver-regex", "heldout.json"));
  const { api, blobs, heldouts } = recordingApi(new Set([judged]));
  const lines: string[] = [];
  const countBefore = await reader.taskCount();
  const walletBefore = await client.ftBalanceOf(chain.tokenId, poster.accountId);

  const posted = await seed({
    client,
    api,
    network: chain.network,
    poster: poster.accountId,
    judgeAccount: chain.accounts.judge.accountId,
    tokenId: chain.tokenId,
    heldoutDir: HELDOUT_DIR,
    only: ["semver-regex", "iso-date-regex"],
    log: (line) => lines.push(line),
  });

  // iso-date-regex pays 1.50 and semver-regex 1.00: only the first is paid for and posted. The
  // poster has no task with the checks of semver-regex, so there is no task to name for it.
  expect(posted).toEqual([{ slug: "iso-date-regex", taskId: countBefore + 1n, status: "posted" }]);
  // The seeds go in slug order, so the one that is posted comes before the one that is skipped.
  expect(lines).toEqual([
    "DEPOSITED 1.50 tUSDC",
    `SEEDED iso-date-regex task=${countBefore + 1n}`,
    "SKIP semver-regex (held-out already public)",
  ]);
  expect(await reader.taskCount()).toBe(countBefore + 1n);
  expect(await client.ftBalanceOf(chain.tokenId, poster.accountId)).toBe(walletBefore - 1_500_000n);
  // Nothing of the skipped seed went up.
  expect(heldouts.map(({ commitment }) => commitment)).not.toContain(judged);
  expect(blobs.map(({ sha256 }) => sha256)).not.toContain(
    hashOf(fileOf("semver-regex", "brief.json")),
  );
});

test("a_poster_whose_wallet_cannot_cover_the_rewards_posts_nothing_and_moves_nothing", async () => {
  // The keeper opens with 0.1 NEAR of storage, which does not cover thirty tasks, and with no tokens
  // at all. A script that paid for the storage first would have paid before it found the wallet
  // empty.
  const keeper = chain.accounts.keeper;
  const client = clientOf("keeper");
  const { api, blobs, heldouts } = recordingApi();
  const before = await holdings("keeper");

  const failure = await seed({
    client,
    api,
    network: chain.network,
    poster: keeper.accountId,
    judgeAccount: chain.accounts.judge.accountId,
    tokenId: chain.tokenId,
    heldoutDir: HELDOUT_DIR,
    log: () => {},
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect((failure as Error).message).toBe(
    `the vault of ${keeper.accountId} holds 0.00 tUSDC and the seeds need 22.50 tUSDC; ` +
      `its wallet holds 0.00 tUSDC of ${chain.tokenId}, so 22.50 tUSDC more is missing`,
  );
  // The tasks, the wallet, the vault and the storage balance are what they were.
  expect(await holdings("keeper")).toEqual(before);
  expect(blobs).toEqual([]);
  expect(heldouts).toEqual([]);
});

test("a_second_run_posts_nothing_again_and_a_seed_added_to_it_is_the_only_one_posted", async () => {
  const bob = chain.accounts.bob.accountId;

  const first = await seedAs("bob", ["distinct-signers-count", "meeting-actions-extract"]);
  const afterFirst = await holdings("bob");
  const second = await seedAs("bob", ["distinct-signers-count", "meeting-actions-extract"]);
  const afterSecond = await holdings("bob");

  const [one, two] = first.posted;
  if (one === undefined || two === undefined) throw new Error("the first run posted too little");
  expect(first.lines).toEqual([
    "DEPOSITED 1.00 tUSDC",
    `SEEDED distinct-signers-count task=${one.taskId}`,
    `SEEDED meeting-actions-extract task=${two.taskId}`,
  ]);
  // The second run found both tasks on the chain, by the checks they carry. It paid, uploaded and
  // posted nothing, and gave back the tasks.
  const stand = [
    { slug: "distinct-signers-count", taskId: one.taskId, status: "existing" },
    { slug: "meeting-actions-extract", taskId: two.taskId, status: "existing" },
  ];
  expect(second.posted).toEqual(stand);
  expect(second.lines).toEqual([
    `SKIP distinct-signers-count (held-out already used by task ${one.taskId})`,
    `SKIP meeting-actions-extract (held-out already used by task ${two.taskId})`,
  ]);
  expect(second.blobs).toEqual([]);
  expect(second.heldouts).toEqual([]);
  expect(afterSecond).toEqual(afterFirst);

  // A run that adds a third seed posts that one, and pays for that one alone.
  const third = await seedAs("bob", [
    "distinct-signers-count",
    "meeting-actions-extract",
    "sum-of-transfers",
  ]);
  const added = afterSecond.tasks + 1n;
  expect(third.posted).toEqual([
    ...stand,
    { slug: "sum-of-transfers", taskId: added, status: "posted" },
  ]);
  expect(third.lines).toEqual([
    "DEPOSITED 0.25 tUSDC",
    `SKIP distinct-signers-count (held-out already used by task ${one.taskId})`,
    `SKIP meeting-actions-extract (held-out already used by task ${two.taskId})`,
    `SEEDED sum-of-transfers task=${added}`,
  ]);
  await expectPosted(added, "sum-of-transfers", { poster: bob }, third.blobs);
  expect(await reader.taskCount()).toBe(added);
});

test("a_task_that_was_voided_has_settled_and_still_keeps_its_seed_from_being_posted_again", async () => {
  const lead = chain.accounts.lead.accountId;
  const shortest = NETWORKS.sandbox.minWindowSecs;
  const windows = {
    commit_secs: shortest,
    reveal_secs: shortest,
    pick_secs: shortest,
    fallback_secs: shortest,
  };
  const slug = "product-table-extract";

  const first = await seedAs("lead", [slug], { windows });
  const [posted] = first.posted;
  if (posted === undefined) throw new Error("the first run posted nothing");
  expect(first.lines).toEqual(["DEPOSITED 0.50 tUSDC", `SEEDED ${slug} task=${posted.taskId}`]);
  const skipped = [`SKIP ${slug} (held-out already used by task ${posted.taskId})`];
  const stands = [{ slug, taskId: posted.taskId, status: "existing" }];
  const leftAlone = async () => {
    const run = await seedAs("lead", [slug], { windows });
    expect(run.lines).toEqual(skipped);
    expect(run.posted).toEqual(stands);
  };

  // While the task is open the seed is up, and a run leaves it alone.
  await leftAlone();

  // Nobody enters. Once the reveal window is over the task is waiting for a pick: the same.
  await waitForPhase(posted.taskId, ["judging", "fallback", "expired"]);
  await leftAlone();

  // Anyone can void a task that nobody revealed to. It settles, and its reward is back in the vault.
  await clientOf("lead").voidTask(posted.taskId);
  const voided = await reader.getTask(posted.taskId);
  expect(voided?.phase).toBe("settled");
  expect(voided?.outcome?.kind).toBe("voided");
  expect(await reader.balanceOf(lead, chain.tokenId)).toBe(500_000n);

  // The task has settled, and its seed is still not posted again: the Judge refuses a task whose
  // checks an earlier task of the poster carries, whatever phase that task is in, so the second
  // task would be stuck. The refund stays in the vault, and no task is added.
  const countBefore = await reader.taskCount();
  await leftAlone();
  expect(await reader.taskCount()).toBe(countBefore);
  expect(await reader.balanceOf(lead, chain.tokenId)).toBe(500_000n);
});
