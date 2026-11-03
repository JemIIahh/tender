import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ApiClient, TenderClient, TenderError, type TxResult } from "@tender/client";
import {
  ApiError,
  canonicalJson,
  type HealthResponse,
  NETWORKS,
  type NetworkId,
  type Phase,
  type PostTaskInput,
  type StorageView,
  sha256Hex,
  type TaskDetailResponse,
  type TaskSummary,
  type TenderApi,
} from "@tender/shared";
import { KeyPair } from "near-api-js";
import { afterEach, expect, test, vi } from "vitest";
import { writeSyntheticHeldouts } from "../seeds/synthetic-heldout";
import { missingHeldouts, PRIVATE_DIR_VARIABLE, privateDirOf } from "./lib/private-dir";
import { loadTarget, main, type SeedChain, type SeedOptions, seed } from "./seed";

// Everything here runs without a chain, an API or the network. The API and the chain are fakes the
// test steers; the seeds are real files in a temporary directory (or, in one test, the repository's
// own), because what the script reads is files. A seed's held-out checks are kept apart from its
// public files, as in the repository (they are secret until the task is judged): each directory of
// seeds a test makes has a private directory of its own beside it. The command line is tested with
// a stand-in for `seed`, as deploy's and the key script's are.

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A new directory holding the given files, whose names may have directories in them. */
async function dirWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tender-seed-unit-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

const PARENT = "tender-dev-20261030.testnet";
const POSTER = `poster.${PARENT}`;
const JUDGE = `judge.${PARENT}`;
const CONTRACT = `tender.${PARENT}`;
const TOKEN = `tusdc.${PARENT}`;
const USDC = NETWORKS.testnet.usdc ?? "";
const ONE_TOKEN = 1_000_000n;
/** Shaped like a key, and recognisable in any output: it must never be printed. */
const LEAKY = "ed25519:LEAKY-KEY-MATERIAL-that-must-never-be-printed";

// ---- Seeds --------------------------------------------------------------------------------------

const TASK = {
  reward: "0.25",
  token: "tusdc",
  commit_secs: 600,
  reveal_secs: 300,
  pick_secs: 600,
  fallback_secs: 600,
  max_winners: 1,
  verifier: "judge",
};

const CRITERIA = {
  version: 1,
  kind: "exact",
  min_score: 100,
  split: "winner_take_all",
  has_heldout: true,
  normalize: ["trim"],
};

const RUBRIC = {
  version: 1,
  kind: "rubric",
  min_score: 70,
  split: "winner_take_all",
  has_heldout: false,
  rubric: [{ criterion: "Is the answer right?", weight: 5 }],
};

/** A brief that is its own for each slug, with its keys out of canonical order. */
const briefOf = (slug: string) => ({
  version: 1,
  title: `Task ${slug}`,
  summary: `The task ${slug}.`,
  instructions: `Answer ${slug}.`,
  category: "other",
  tags: ["seed"],
  output: { format: "text", max_bytes: 100 },
});

const heldoutOf = (slug: string) => ({ exact: { expected: [slug] } });

/** The text of a file the seed's folder holds. A string is written as it is, anything else as JSON. */
type FileSpec = string | object | null;

interface SeedSpec {
  task?: FileSpec;
  brief?: FileSpec;
  criteria?: FileSpec;
  /** Null: the private directory has no `heldout.json` for the seed. */
  heldout?: FileSpec;
}

const taskWith = (overrides: object) => ({ ...TASK, ...overrides });

/** The private directory of each directory of seeds `seedsDir` made: where its held-out checks are. */
const PRIVATE_OF = new Map<string, string>();

/**
 * A directory of seeds, written pretty printed, so the file's bytes are not the canonical bytes.
 * The held-out checks go to a private directory of their own (`PRIVATE_OF`), never into the
 * seed's folder, which is the public half.
 */
async function seedsDir(spec: Record<string, SeedSpec>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tender-seeds-"));
  const privateDir = await mkdtemp(join(tmpdir(), "tender-heldout-"));
  dirs.push(dir, privateDir);
  PRIVATE_OF.set(dir, privateDir);
  for (const [slug, files] of Object.entries(spec)) {
    await mkdir(join(dir, slug));
    const documents: Record<string, FileSpec> = {
      "task.json": files.task === undefined ? TASK : files.task,
      "brief.json": files.brief === undefined ? briefOf(slug) : files.brief,
      "criteria.json": files.criteria === undefined ? CRITERIA : files.criteria,
    };
    for (const [name, document] of Object.entries(documents)) {
      if (document === null) continue;
      const text = typeof document === "string" ? document : JSON.stringify(document, null, 2);
      await writeFile(join(dir, slug, name), text);
    }
    const checks = files.heldout === undefined ? heldoutOf(slug) : files.heldout;
    if (checks !== null) {
      await mkdir(join(privateDir, slug));
      const text = typeof checks === "string" ? checks : JSON.stringify(checks, null, 2);
      await writeFile(join(privateDir, slug, "heldout.json"), text);
    }
  }
  return dir;
}

/** The hash of the canonical bytes of a document, which is what a task holds of it. */
const hashOf = (document: object) => sha256Hex(canonicalJson(document));

// ---- Fakes --------------------------------------------------------------------------------------

const unexpected = (method: string) => () => {
  throw new Error(`unexpected call to api.${method}`);
};

const tx = (txHash = "tx-1"): TxResult => ({
  txHash,
  events: [],
  returnValue: undefined,
  receipts: [],
});

/** More storage than any test here spends: 1 NEAR. */
const ROOMY: StorageView = {
  total: `${10n ** 24n}`,
  available: `${10n ** 24n}`,
  used_bytes: "100",
};

/** A wallet that holds more than any test spends. */
const RICH = 10n ** 12n;

/** `bytes` of contract storage, in yoctoNEAR. */
const storageBytes = (count: bigint) => count * 10n ** 19n;

const storageOf = (free: bigint): StorageView => ({
  total: `${storageBytes(free)}`,
  available: `${storageBytes(free)}`,
  used_bytes: "83",
});

interface Upload {
  kind: string;
  contentType: string;
  bytes: Uint8Array;
  uri: string;
}

/** A task the API knows of, as far as the script looks at one. */
interface Listed {
  id: bigint;
  poster: string;
  briefHash: string;
  /** Null: the task has no held-out checks. */
  heldoutCommitment: string | null;
  phase: Phase;
}

interface ListedOptions {
  poster?: string;
  /** The seed whose held-out checks the task carries: its own seed's by default. Null: none. */
  heldout?: string | null;
}

/** The task of `poster` whose brief is that of seed `slug`, in `phase`, with the checks of a seed. */
const listedOf = (
  id: bigint,
  slug: string,
  phase: Phase,
  { poster = POSTER, heldout = slug }: ListedOptions = {},
): Listed => ({
  id,
  poster,
  briefHash: hashOf(briefOf(slug)),
  heldoutCommitment: heldout === null ? null : hashOf(heldoutOf(heldout)),
  phase,
});

/** The list leaves a task's brief out, as the API's does. */
function summaryOf(task: Listed): TaskSummary {
  return {
    id: `${task.id}`,
    title: null,
    category: null,
    tags: [],
    token: TOKEN,
    reward: "250000",
    phase: task.phase,
    poster: task.poster,
    verifier: JUDGE,
    created_at: "1",
    commit_deadline: "2",
    reveal_deadline: "3",
    pick_deadline: "4",
    fallback_deadline: "5",
    commit_count: 0,
    reveal_count: 0,
    working_count: 0,
    judge_status: null,
    judge_reason: null,
    is_team_poster: false,
    parent: null,
    outcome_kind: null,
  };
}

function detailOf(task: Listed): TaskDetailResponse {
  return {
    task: {
      ...summaryOf(task),
      brief_uri: `https://api.test/v1/blobs/${task.briefHash}`,
      brief_hash: task.briefHash,
      criteria_hash: "c".repeat(64),
      heldout_commitment: task.heldoutCommitment,
      max_entries: 0,
      max_winners: 1,
      invited: [],
      fee_bps: 500,
      outcome: null,
    },
    brief: null,
    criteria: null,
    entries: [],
    funders: [],
    children: [],
    scorecard: null,
  };
}

interface ApiOptions {
  /** The hashes the API serves, as it serves a blob that is public. */
  served?: ReadonlySet<string>;
  /** What `uploadBlob` says it stored the bytes as, in place of their hash. */
  storedAs?: string;
  /** Tasks the API lists besides those that were posted through the fake chain. */
  tasks?: readonly Listed[];
  /** The tasks that were posted through the fake chain. A world supplies them. */
  posted?: () => readonly Listed[];
  /** The most tasks a page holds, whatever limit is asked for: a server may give fewer. */
  pageSize?: number;
  /** Lists the tasks of every poster, whatever poster is asked for. */
  ignorePoster?: boolean;
  /** Gives the same cursor to every page, so that the list never ends. */
  stuck?: boolean;
  /** The tasks `getTask` does not know, though they are listed. */
  vanished?: ReadonlySet<bigint>;
  /** What the API says it serves, in place of the testnet and the contract of the tests. */
  serves?: Partial<Pick<HealthResponse, "network" | "contract" | "lag_blocks">>;
  /** `health` fails with this, as an API does that cannot read the chain. */
  unhealthy?: Error;
}

/** The API, as far as the seed script uses it. `trace` hears every call, in order. */
function fakeApi(trace: string[], options: ApiOptions = {}) {
  const uploads: Upload[] = [];
  const heldouts: { commitment: string; bytes: Uint8Array }[] = [];
  const known = () => [...(options.tasks ?? []), ...(options.posted?.() ?? [])];
  // Newest first, a cursor that is the id of the last task of the page before (exclusive), and no
  // cursor after the last page: the way the API's list pages.
  let pages = 0;
  const listTasks = vi.fn<TenderApi["listTasks"]>(async (filter = {}) => {
    trace.push("listTasks");
    // A script that cannot stop asking would spin without ever yielding to a test's timeout.
    if (++pages > 100) throw new Error("the fake API was asked for more than 100 pages");
    if (options.stuck) return { tasks: [], next_cursor: "9" };
    const matching = known()
      .filter((task) => options.ignorePoster || !filter.poster || task.poster === filter.poster)
      .filter((task) => !filter.cursor || task.id < BigInt(filter.cursor))
      .sort((a, b) => Number(b.id - a.id));
    const size = Math.min(filter.limit ?? 20, options.pageSize ?? 50);
    const page = matching.slice(0, size);
    const last = page.at(-1);
    return {
      tasks: page.map(summaryOf),
      next_cursor: matching.length > size && last !== undefined ? `${last.id}` : null,
    };
  });
  const getTask = vi.fn<TenderApi["getTask"]>(async (id) => {
    trace.push("getTask");
    const task = known().find((candidate) => candidate.id === id);
    return task === undefined || options.vanished?.has(id) ? null : detailOf(task);
  });
  const health = vi.fn<TenderApi["health"]>(async () => {
    trace.push("health");
    if (options.unhealthy) throw options.unhealthy;
    return {
      ok: true,
      network: "testnet",
      contract: CONTRACT,
      indexed_height: "100",
      chain_final_height: "100",
      lag_blocks: "0",
      waiting_for_chain: false,
      ...options.serves,
    };
  });
  const getBlob = vi.fn<TenderApi["getBlob"]>(async (sha256) => {
    trace.push("getBlob");
    return options.served?.has(sha256) ? new Uint8Array([1]) : null;
  });
  const uploadBlob = vi.fn<TenderApi["uploadBlob"]>(async (blob) => {
    trace.push(`uploadBlob ${blob.kind}`);
    const sha256 = options.storedAs ?? sha256Hex(blob.bytes);
    const uri = `https://api.test/v1/blobs/${sha256}`;
    uploads.push({ kind: blob.kind, contentType: blob.contentType, bytes: blob.bytes, uri });
    return { sha256, uri };
  });
  const uploadHeldout = vi.fn<TenderApi["uploadHeldout"]>(async (commitment, bytes) => {
    trace.push("uploadHeldout");
    heldouts.push({ commitment, bytes });
  });
  const api: TenderApi = {
    listTasks,
    getTask,
    listAgents: unexpected("listAgents"),
    getAgent: unexpected("getAgent"),
    listEntries: unexpected("listEntries"),
    health,
    getScorecard: unexpected("getScorecard"),
    getBlob,
    uploadBlob,
    uploadHeldout,
    start: unexpected("start"),
    telegramLink: unexpected("telegramLink"),
    signIn: unexpected("signIn"),
  };
  return { api, uploads, heldouts, health, getBlob, uploadBlob, uploadHeldout, listTasks, getTask };
}

interface ChainOptions {
  /** What the poster's vault holds, by token. */
  vault?: ReadonlyMap<string, bigint>;
  /** What the poster's wallet holds, by token. A token not listed is `RICH`. */
  wallet?: ReadonlyMap<string, bigint>;
  /** The poster's storage balance with Tender; null: it has never deposited. */
  storage?: StorageView | null;
  /** A token that hands every deposit back, so that Tender logs no `deposit`. */
  refuseDeposits?: boolean;
  /** The 1-based call of `postTask` that fails, with this error. */
  failPost?: { call: number; error: Error };
  /** The account the client signs as. */
  accountId?: string;
  /** The client has no signer. */
  unsigned?: boolean;
  /** The network and the contract the client is set for, in place of the testnet and the tests'. */
  network?: NetworkId;
  contractId?: string;
}

/** A chain with a vault, a wallet and a storage balance for the poster, which `trace` hears. */
function fakeChain(trace: string[], options: ChainOptions = {}) {
  const vault = new Map(options.vault ?? []);
  const wallet = new Map(options.wallet ?? []);
  let storage: StorageView | null = options.storage === undefined ? ROOMY : options.storage;
  const posts: PostTaskInput[] = [];
  let lastId = 0n;
  // The failure comes once: a call that follows it, after a run was stopped, goes through.
  let failing = options.failPost;

  const balanceOf = vi.fn<SeedChain["balanceOf"]>(async (_account, token) => {
    trace.push("balanceOf");
    return vault.get(token) ?? 0n;
  });
  const ftBalanceOf = vi.fn<SeedChain["ftBalanceOf"]>(async (token) => {
    trace.push("ftBalanceOf");
    return wallet.get(token) ?? RICH;
  });
  const deposit = vi.fn<SeedChain["deposit"]>(async (token, amount) => {
    trace.push("deposit");
    // A deposit the token hands back does not fail: it just leaves no `deposit` event.
    if (options.refuseDeposits) return tx();
    wallet.set(token, (wallet.get(token) ?? RICH) - amount);
    vault.set(token, (vault.get(token) ?? 0n) + amount);
    return {
      ...tx(),
      events: [
        {
          event: "deposit",
          data: { account: POSTER, token, amount: `${amount}`, sender: POSTER },
          receiptId: "r-1",
          logIndex: 0,
        },
      ],
    };
  });
  const storageBalanceOf = vi.fn<SeedChain["storageBalanceOf"]>(async () => {
    trace.push("storageBalanceOf");
    return storage;
  });
  const storageDeposit = vi.fn<SeedChain["storageDeposit"]>(async (amount) => {
    trace.push("storageDeposit");
    const held = storage === null ? 0n : BigInt(storage.available);
    storage = { total: `${held + amount}`, available: `${held + amount}`, used_bytes: "83" };
    return tx();
  });
  const postTask = vi.fn<SeedChain["postTask"]>(async (input) => {
    trace.push("postTask");
    if (failing?.call === posts.length + 1) {
      const { error } = failing;
      failing = undefined;
      throw error;
    }
    const held = vault.get(input.token) ?? 0n;
    if (held < input.reward)
      throw new TenderError("E_FUNDS", "E_FUNDS: insufficient vault balance");
    vault.set(input.token, held - input.reward);
    posts.push(input);
    lastId += 1n;
    return { ...tx(), taskId: lastId };
  });

  const client: SeedChain = {
    network: options.network ?? "testnet",
    contractId: options.contractId ?? CONTRACT,
    accountId: options.unsigned ? undefined : (options.accountId ?? POSTER),
    postTask,
    balanceOf,
    ftBalanceOf,
    deposit,
    storageBalanceOf,
    storageDeposit,
  };
  return {
    client,
    vault,
    wallet,
    posts,
    balanceOf,
    ftBalanceOf,
    deposit,
    storageBalanceOf,
    storageDeposit,
    postTask,
  };
}

/** What `seed` is given besides the client and the API, which the tests make. */
type PlayOptions = Partial<Omit<SeedOptions, "client" | "api">>;

interface RunOptions extends PlayOptions {
  chain?: ChainOptions;
  api?: ApiOptions;
}

/** A fake chain and a fake API that know of each other: what the one posts, the other lists. */
interface World {
  /** Every call to either, in order. */
  trace: string[];
  /** Every line the script printed. */
  lines: string[];
  chain: ReturnType<typeof fakeChain>;
  api: ReturnType<typeof fakeApi>;
}

function worldOf(options: Pick<RunOptions, "chain" | "api"> = {}): World {
  const trace: string[] = [];
  const chain = fakeChain(trace, options.chain);
  // A task posted through the chain is on the API's list at once, in the phase a new task is in.
  const posted = (): Listed[] =>
    chain.posts.map((post, i) => ({
      id: BigInt(i + 1),
      poster: POSTER,
      briefHash: post.briefHash,
      heldoutCommitment: post.heldoutCommitment ?? null,
      phase: "open",
    }));
  const api = fakeApi(trace, { ...options.api, posted });
  return { trace, lines: [], chain, api };
}

/**
 * One call of `seed` in `world`, on testnet with the test token and no record of a deployment.
 * `result` is what it returned, or `failure` what it threw. `trace` and `lines` are those of this
 * call alone, so that a second call in the same world can be told from the first.
 */
async function play(world: World, dir: string | undefined, options: PlayOptions = {}) {
  const calls = world.trace.length;
  const printed = world.lines.length;
  const settled = await seed({
    client: world.chain.client,
    api: world.api.api,
    network: "testnet",
    poster: POSTER,
    judgeAccount: JUDGE,
    tokenId: TOKEN,
    seedsDir: dir,
    heldoutDir: dir === undefined ? undefined : PRIVATE_OF.get(dir),
    log: (line) => world.lines.push(line),
    ...options,
  }).then(
    (result) => ({ result, failure: undefined }),
    (failure: unknown) => ({ result: undefined, failure }),
  );
  return { ...settled, trace: world.trace.slice(calls), lines: world.lines.slice(printed) };
}

/**
 * `seed` on a directory of seeds, in a new world. `spec` is the seeds to write into a new
 * directory, the path of one that exists, or null for the repository's own.
 */
async function run(spec: Record<string, SeedSpec> | string | null, options: RunOptions = {}) {
  const dir =
    spec === null || typeof spec === "string" ? (spec ?? undefined) : await seedsDir(spec);
  const world = worldOf(options);
  const { chain: _chain, api: _api, ...rest } = options;
  const played = await play(world, dir, rest);
  return { ...played, dir, chain: world.chain, api: world.api };
}

/** What a run did to the API and the chain: nothing at all. */
const UNTOUCHED: string[] = [];

/** A seed the run posted, and the task it became. */
const seeded = (slug: string, taskId: bigint) => ({ slug, taskId, status: "posted" as const });

/** A seed the run left alone because the poster has this task for it. */
const existing = (slug: string, taskId: bigint) => ({ slug, taskId, status: "existing" as const });

// ---- What goes up, and in what order ------------------------------------------------------------

test("seed_uploads_the_brief_then_the_criteria_then_the_heldout_and_posts_their_canonical_bytes", async () => {
  const dir = await seedsDir({ alpha: {} });

  const { result, lines, chain, api, trace } = await run(dir);

  // One seed: the brief, the criteria, the held-out checks, and only then the task.
  expect(trace.filter((call) => call.startsWith("upload") || call === "postTask")).toEqual([
    "uploadBlob brief",
    "uploadBlob criteria",
    "uploadHeldout",
    "postTask",
  ]);
  const brief = canonicalJson(briefOf("alpha"));
  const criteria = canonicalJson(CRITERIA);
  const heldout = canonicalJson(heldoutOf("alpha"));
  expect(api.uploads.map(({ kind, contentType }) => [kind, contentType])).toEqual([
    ["brief", "application/json"],
    ["criteria", "application/json"],
  ]);
  expect(api.uploads[0]?.bytes).toEqual(brief);
  expect(api.uploads[1]?.bytes).toEqual(criteria);
  expect(api.heldouts[0]?.bytes).toEqual(heldout);
  // The bytes are canonical, not the file's own: the file is pretty printed, in the author's order.
  expect(Buffer.from(brief).equals(readFileSync(join(dir, "alpha", "brief.json")))).toBe(false);

  // The task holds the URI the API gave, and the hashes of the bytes that went up.
  expect(chain.posts).toEqual([
    {
      token: TOKEN,
      reward: 250_000n,
      briefUri: `https://api.test/v1/blobs/${sha256Hex(brief)}`,
      briefHash: sha256Hex(brief),
      criteriaHash: sha256Hex(criteria),
      heldoutCommitment: sha256Hex(heldout),
      verifier: JUDGE,
      commitSecs: 600,
      revealSecs: 300,
      pickSecs: 600,
      fallbackSecs: 600,
      maxWinners: 1,
    },
  ]);
  expect(result).toEqual([seeded("alpha", 1n)]);
  // The vault was empty, so the reward went in first.
  expect(lines).toEqual(["DEPOSITED 0.25 tUSDC", "SEEDED alpha task=1"]);
});

test("the_heldout_commitment_is_the_sha256_of_the_canonical_bytes_that_were_stored", async () => {
  const { chain, api } = await run({ alpha: {}, beta: {} });

  expect(api.heldouts).toHaveLength(2);
  for (const [i, { commitment, bytes }] of api.heldouts.entries()) {
    const slug = i === 0 ? "alpha" : "beta";
    expect(bytes).toEqual(canonicalJson(heldoutOf(slug)));
    expect(commitment).toBe(sha256Hex(bytes));
    expect(chain.posts[i]?.heldoutCommitment).toBe(commitment);
  }
  // Each seed has checks of its own, so each has a commitment of its own.
  expect(api.heldouts[0]?.commitment).not.toBe(api.heldouts[1]?.commitment);
});

test("a_seed_without_a_heldout_part_is_posted_with_no_commitment_and_nothing_stored", async () => {
  const { result, chain, api } = await run({ rubric: { criteria: RUBRIC, heldout: null } });

  expect(result).toEqual([seeded("rubric", 1n)]);
  expect(chain.posts[0]?.heldoutCommitment).toBeUndefined();
  expect(chain.posts[0]?.criteriaHash).toBe(hashOf(RUBRIC));
  expect(api.uploadHeldout).not.toHaveBeenCalled();
  // There is nothing to find out about: no commitment, so no question for the API.
  expect(api.getBlob).not.toHaveBeenCalled();
});

// ---- Where the held-out checks are --------------------------------------------------------------

test("the_heldout_is_read_from_the_private_directory_and_never_from_the_seeds_own_folder", async () => {
  // A seed's folder is the public half of the seed. A heldout.json in it is not the seed's checks,
  // and the run does not read it: it would be committed with the rest, and the checks would be out.
  const dir = await seedsDir({ alpha: { heldout: null } });
  await writeFile(join(dir, "alpha", "heldout.json"), JSON.stringify(heldoutOf("alpha")));

  const { failure, trace, lines } = await run(dir);

  expect((failure as Error).message).toBe(
    `held-out for alpha not found in ${PRIVATE_OF.get(dir)}; set TENDER_SEEDS_PRIVATE_DIR`,
  );
  expect(trace).toEqual(UNTOUCHED);
  expect(lines).toEqual([]);
});

test("a_seed_whose_heldout_is_not_found_stops_the_run_before_any_seed_is_posted", async () => {
  // alpha is fine and comes first: it must not be posted while beta is found out, and no task is
  // ever posted without its checks.
  const dir = await seedsDir({ alpha: {}, beta: { heldout: null } });

  const { failure, trace, lines, chain } = await run(dir);

  expect((failure as Error).message).toBe(
    `held-out for beta not found in ${PRIVATE_OF.get(dir)}; set TENDER_SEEDS_PRIVATE_DIR`,
  );
  expect(trace).toEqual(UNTOUCHED);
  expect(lines).toEqual([]);
  expect(chain.posts).toEqual([]);
});

test("a_private_directory_that_is_not_there_gives_the_same_error", async () => {
  const dir = await seedsDir({ alpha: {} });
  const missing = join(tmpdir(), "tender-heldout-that-does-not-exist");

  const { failure, trace } = await run(dir, { heldoutDir: missing });

  expect((failure as Error).message).toBe(
    `held-out for alpha not found in ${missing}; set TENDER_SEEDS_PRIVATE_DIR`,
  );
  expect(trace).toEqual(UNTOUCHED);
});

test("a_private_directory_that_is_a_file_gives_the_same_error", async () => {
  const dir = await seedsDir({ alpha: {} });
  const file = join(await dirWith({ "not-a-directory": "x" }), "not-a-directory");

  const { failure, trace } = await run(dir, { heldoutDir: file });

  expect((failure as Error).message).toBe(
    `held-out for alpha not found in ${file}; set TENDER_SEEDS_PRIVATE_DIR`,
  );
  expect(trace).toEqual(UNTOUCHED);
});

test("without_a_heldoutDir_the_private_directory_is_the_one_the_variable_names", async () => {
  const dir = await seedsDir({ alpha: {} });
  vi.stubEnv(PRIVATE_DIR_VARIABLE, PRIVATE_OF.get(dir));

  const { result, api } = await run(dir, { heldoutDir: undefined });

  expect(result).toEqual([seeded("alpha", 1n)]);
  expect(api.heldouts[0]?.bytes).toEqual(canonicalJson(heldoutOf("alpha")));
});

test("with_nothing_set_the_private_directory_is_seeds_private_of_the_repository", async () => {
  vi.stubEnv(PRIVATE_DIR_VARIABLE, "");
  const dir = await seedsDir({ alpha: {} });

  const { failure } = await run(dir, { heldoutDir: undefined });

  // The seed is made up, so the repository's own seeds-private/ has nothing for it.
  expect((failure as Error).message).toBe(
    `held-out for alpha not found in ${join(import.meta.dirname, "..", "seeds-private")}; set TENDER_SEEDS_PRIVATE_DIR`,
  );
});

test("seeds_go_in_slug_order_whatever_order_the_folder_lists_them_in", async () => {
  const { result, lines } = await run({ gamma: {}, alpha: {}, beta: {} });

  expect(result).toEqual([seeded("alpha", 1n), seeded("beta", 2n), seeded("gamma", 3n)]);
  expect(lines).toEqual([
    "DEPOSITED 0.75 tUSDC",
    "SEEDED alpha task=1",
    "SEEDED beta task=2",
    "SEEDED gamma task=3",
  ]);
});

test("a_folder_that_is_a_file_is_not_a_seed", async () => {
  const dir = await seedsDir({ alpha: {} });
  await writeFile(join(dir, "README.md"), "Held-out checks are single-use.");

  const { result } = await run(dir);

  expect(result).toEqual([seeded("alpha", 1n)]);
});

// ---- The verifier -------------------------------------------------------------------------------

test("the_verifier_resolves_to_the_judge_or_to_the_poster", async () => {
  const { chain } = await run({
    alpha: { task: taskWith({ verifier: "judge" }) },
    beta: { task: taskWith({ verifier: "poster" }) },
  });

  expect(chain.posts.map((post) => post.verifier)).toEqual([JUDGE, POSTER]);
});

// ---- The reward ---------------------------------------------------------------------------------

test("the_reward_is_converted_exactly_with_the_decimals_of_the_token", async () => {
  // 0.29 times 100 is 28.999999999999996 as a float, and 1.15 times 100 is 114.99999999999999.
  const rewards = ["0.25", "0.29", "1.15", "1.50", "2.00", "0.01", "3", "10.000001"];
  const spec = Object.fromEntries(
    rewards.map((reward, i) => [`seed-${i}`, { task: taskWith({ reward }) }]),
  );

  const { chain } = await run(spec);

  expect(chain.posts.map((post) => post.reward)).toEqual([
    250_000n,
    290_000n,
    1_150_000n,
    1_500_000n,
    2_000_000n,
    10_000n,
    3_000_000n,
    10_000_001n,
  ]);
});

test("a_reward_that_is_no_amount_of_the_token_stops_the_run_before_anything_is_asked", async () => {
  const bad = ["1,5", "1.", ".5", "-1.00", "1e3", " 1.00", "0.2500001", ""];
  for (const reward of bad) {
    const { failure, trace } = await run({
      alpha: {},
      beta: { task: taskWith({ reward }) },
    });

    expect(failure, JSON.stringify(reward)).toBeInstanceOf(Error);
    expect((failure as Error).message, JSON.stringify(reward)).toContain(
      `beta: its reward ${JSON.stringify(reward)} is no amount of tUSDC: `,
    );
    expect(trace).toEqual(UNTOUCHED);
  }
});

test("a_token_whose_decimals_are_unknown_is_refused_and_not_guessed_at", async () => {
  const { failure, trace } = await run({ alpha: {} }, { tokenId: "mystery.testnet" });

  expect((failure as Error).message).toBe(
    "alpha: cannot turn its reward into units, since the decimals of mystery.testnet are unknown on testnet",
  );
  expect(trace).toEqual(UNTOUCHED);
});

// ---- The token ----------------------------------------------------------------------------------

/** A deployment record, as the deploy script writes it. */
function deployment(network: string, tusdc: string, usdc?: string) {
  return {
    network,
    contract: CONTRACT,
    tokens: usdc === undefined ? { tusdc } : { tusdc, usdc },
    accounts: { tender: CONTRACT, poster: POSTER },
    wasmSha256: "ab".repeat(32),
    deployHeight: "12345",
    deployedAt: "2026-10-30T10:00:00.000Z",
  };
}

test("usdc_is_the_networks_usdc_and_tusdc_is_the_token_of_the_deployment_record", async () => {
  const dir = await dirWith({
    "deployments/testnet.json": JSON.stringify(deployment("testnet", TOKEN, USDC)),
  });

  const { chain, lines } = await run(
    {
      alpha: { task: taskWith({ token: "usdc", reward: "1.00" }) },
      beta: { task: taskWith({ token: "tusdc", reward: "0.50" }) },
    },
    { tokenId: undefined, dir },
  );

  expect(chain.posts.map(({ token, reward }) => [token, reward])).toEqual([
    [USDC, ONE_TOKEN],
    [TOKEN, 500_000n],
  ]);
  // One deposit for each token, each as large as the rewards in that token.
  expect(chain.deposit.mock.calls).toEqual([
    [USDC, ONE_TOKEN],
    [TOKEN, 500_000n],
  ]);
  expect(lines).toEqual([
    "DEPOSITED 1.00 USDC",
    "DEPOSITED 0.50 tUSDC",
    "SEEDED alpha task=1",
    "SEEDED beta task=2",
  ]);
});

test("tokenId_decides_the_token_of_every_seed_and_no_record_is_read", async () => {
  // `dir` has no record at all: a read would fail the run.
  const dir = await dirWith({});

  const { chain } = await run(
    {
      alpha: { task: taskWith({ token: "usdc" }) },
      beta: { task: taskWith({ token: "tusdc" }) },
    },
    { tokenId: TOKEN, dir },
  );

  expect(chain.posts.map((post) => post.token)).toEqual([TOKEN, TOKEN]);
});

test("a_token_that_has_no_answer_says_so_and_names_the_seed", async () => {
  const none = await dirWith({});

  // The sandbox has no USDC.
  const usdc = await run(
    { alpha: { task: taskWith({ token: "usdc" }) } },
    { network: "sandbox", chain: { network: "sandbox" }, tokenId: undefined, dir: none },
  );
  expect((usdc.failure as Error).message).toBe(
    'alpha pays in "usdc", and there is none on sandbox: pass tokenId',
  );

  // No deployment record, no test token.
  const tusdc = await run({ alpha: {} }, { tokenId: undefined, dir: none });
  expect((tusdc.failure as Error).message).toBe(
    'alpha pays in "tusdc", and deployments/testnet.json does not exist: deploy first, or pass tokenId',
  );

  // The record of another network does not do.
  const other = await dirWith({
    "deployments/testnet.json": JSON.stringify(deployment("sandbox", TOKEN)),
  });
  const wrong = await run({ alpha: {} }, { tokenId: undefined, dir: other });
  expect((wrong.failure as Error).message).toMatch(/testnet\.json is not a deployment record/);

  for (const { trace } of [usdc, tusdc, wrong]) expect(trace).toEqual(UNTOUCHED);
});

// ---- Windows and winners ------------------------------------------------------------------------

test("a_seed_is_posted_with_the_windows_and_winners_of_its_task_json", async () => {
  const { chain } = await run({
    alpha: {
      task: taskWith({
        commit_secs: 61,
        reveal_secs: 62,
        pick_secs: 63,
        fallback_secs: 64,
        max_winners: 3,
      }),
    },
  });

  expect(chain.posts[0]).toMatchObject({
    commitSecs: 61,
    revealSecs: 62,
    pickSecs: 63,
    fallbackSecs: 64,
    maxWinners: 3,
  });
});

test("the_windows_option_replaces_the_windows_of_every_seed", async () => {
  const windows = { commit_secs: 15, reveal_secs: 10, pick_secs: 20, fallback_secs: 25 };

  const { chain } = await run(
    { alpha: {}, beta: { task: taskWith({ commit_secs: 61, max_winners: 2 }) } },
    { windows },
  );

  for (const post of chain.posts) {
    expect([post.commitSecs, post.revealSecs, post.pickSecs, post.fallbackSecs]).toEqual([
      15, 10, 20, 25,
    ]);
  }
  // Only the windows: the winners are the seed's own.
  expect(chain.posts.map((post) => post.maxWinners)).toEqual([1, 2]);
});

// ---- Choosing seeds -----------------------------------------------------------------------------

test("only_posts_the_seeds_it_names_in_slug_order", async () => {
  const dir = await seedsDir({ alpha: {}, beta: {}, gamma: {} });

  const { result, chain, api } = await run(dir, { only: ["gamma", "alpha"] });

  expect(result).toEqual([seeded("alpha", 1n), seeded("gamma", 2n)]);
  expect(chain.posts).toHaveLength(2);
  // beta's held-out checks were never stored.
  expect(api.heldouts.map((h) => h.commitment)).toEqual([
    hashOf(heldoutOf("alpha")),
    hashOf(heldoutOf("gamma")),
  ]);
  // And the rewards that were made good are those of the two.
  expect(chain.deposit.mock.calls).toEqual([[TOKEN, 500_000n]]);
});

test("only_with_a_slug_that_is_no_seed_names_it_and_posts_nothing", async () => {
  const { failure, trace } = await run(
    { alpha: {}, beta: {} },
    { only: ["alpha", "nonesuch", "nor-this"] },
  );

  expect((failure as Error).message).toBe(
    "no such seed: nonesuch, nor-this (the seeds are alpha, beta)",
  );
  expect(trace).toEqual(UNTOUCHED);
});

test("only_with_no_slugs_posts_nothing", async () => {
  const { result, lines, trace } = await run({ alpha: {} }, { only: [] });

  expect(result).toEqual([]);
  expect(lines).toEqual([]);
  expect(trace).toEqual(UNTOUCHED);
});

// ---- Held-out checks that are public already (P05-P12) ------------------------------------------

test("a_seed_whose_heldout_is_already_public_is_skipped_and_the_others_are_posted", async () => {
  const served = new Set([hashOf(heldoutOf("beta"))]);

  const { result, lines, chain, api } = await run(
    { alpha: {}, beta: {}, gamma: {} },
    { api: { served } },
  );

  // The line comes in the seed's turn, between the seeds that are posted.
  expect(lines).toEqual([
    "DEPOSITED 0.50 tUSDC",
    "SEEDED alpha task=1",
    "SKIP beta (held-out already public)",
    "SEEDED gamma task=2",
  ]);
  expect(result).toEqual([seeded("alpha", 1n), seeded("gamma", 2n)]);
  // Nothing of beta went up, and the vault was filled for two rewards, not three.
  expect(api.heldouts.map((h) => h.commitment)).toEqual([
    hashOf(heldoutOf("alpha")),
    hashOf(heldoutOf("gamma")),
  ]);
  expect(api.uploads.map((u) => u.bytes)).not.toContainEqual(canonicalJson(briefOf("beta")));
  expect(chain.deposit.mock.calls).toEqual([[TOKEN, 500_000n]]);
  // It asked about the commitment of every seed that has checks, and of nothing else.
  expect(api.getBlob.mock.calls.map(([sha256]) => sha256)).toEqual([
    hashOf(heldoutOf("alpha")),
    hashOf(heldoutOf("beta")),
    hashOf(heldoutOf("gamma")),
  ]);
});

test("when_every_seed_was_judged_nothing_is_posted_and_the_poster_pays_nothing", async () => {
  const served = new Set([hashOf(heldoutOf("alpha")), hashOf(heldoutOf("beta"))]);

  const { result, lines, trace } = await run({ alpha: {}, beta: {} }, { api: { served } });

  // The poster has no task for either, so there is no task to name.
  expect(result).toEqual([]);
  expect(lines).toEqual([
    "SKIP alpha (held-out already public)",
    "SKIP beta (held-out already public)",
  ]);
  // Which API it is, the two questions about the checks, and the poster's tasks: nothing was paid,
  // uploaded or posted.
  expect(trace).toEqual(["health", "getBlob", "getBlob", "listTasks"]);
});

test("an_api_that_fails_to_say_whether_the_heldout_is_public_stops_the_run", async () => {
  const dir = await seedsDir({ alpha: {}, beta: {} });
  const trace: string[] = [];
  const chain = fakeChain(trace);
  const { api, getBlob } = fakeApi(trace);
  const outage = new ApiError(503, { error: "unavailable", message: "no" });
  getBlob.mockImplementationOnce(async () => {
    trace.push("getBlob");
    throw outage;
  });

  await expect(
    seed({
      client: chain.client,
      api,
      network: "testnet",
      poster: POSTER,
      judgeAccount: JUDGE,
      tokenId: TOKEN,
      seedsDir: dir,
      heldoutDir: PRIVATE_OF.get(dir),
      log: () => {},
    }),
  ).rejects.toBe(outage);

  // "Not public" is not what it said, so no seed was posted on the strength of it.
  expect(trace).toEqual(["health", "getBlob"]);
});

// ---- The vault ----------------------------------------------------------------------------------

test("the_vault_is_topped_up_by_the_shortfall_from_the_posters_wallet", async () => {
  // 0.25 + 1.50 + 0.29 = 2.04 in all, and the vault holds 0.50 of it.
  const { chain, lines, result } = await run(
    {
      alpha: {},
      beta: { task: taskWith({ reward: "1.50" }) },
      gamma: { task: taskWith({ reward: "0.29" }) },
    },
    { chain: { vault: new Map([[TOKEN, 500_000n]]), wallet: new Map([[TOKEN, 5_000_000n]]) } },
  );

  expect(chain.deposit.mock.calls).toEqual([[TOKEN, 1_540_000n]]);
  expect(chain.wallet.get(TOKEN)).toBe(5_000_000n - 1_540_000n);
  expect(lines[0]).toBe("DEPOSITED 1.54 tUSDC");
  // The three rewards were paid out of it, to the last unit.
  expect(result).toHaveLength(3);
  expect(chain.vault.get(TOKEN)).toBe(0n);
});

test("a_vault_that_holds_enough_is_left_alone", async () => {
  const { chain, lines } = await run(
    { alpha: {}, beta: {} },
    { chain: { vault: new Map([[TOKEN, 700_000n]]) } },
  );

  expect(chain.deposit).not.toHaveBeenCalled();
  expect(chain.ftBalanceOf).not.toHaveBeenCalled();
  expect(lines).toEqual(["SEEDED alpha task=1", "SEEDED beta task=2"]);
  expect(chain.vault.get(TOKEN)).toBe(200_000n);
});

test("a_wallet_that_cannot_cover_the_shortfall_stops_the_run_and_says_how_much_is_missing", async () => {
  const { failure, trace } = await run(
    { alpha: {}, beta: { task: taskWith({ reward: "1.79" }) } },
    { chain: { vault: new Map([[TOKEN, 500_000n]]), wallet: new Map([[TOKEN, 1_000_000n]]) } },
  );

  // 2.04 are needed, 0.50 is in the vault, so 1.54 is wanted of a wallet that holds 1.00.
  expect((failure as Error).message).toBe(
    `the vault of ${POSTER} holds 0.50 tUSDC and the seeds need 2.04 tUSDC; ` +
      `its wallet holds 1.00 tUSDC of ${TOKEN}, so 0.54 tUSDC more is missing`,
  );
  // Nothing was deposited, uploaded or posted.
  expect(trace.filter((call) => /deposit|upload|postTask/i.test(call))).toEqual([]);
});

test("a_wallet_that_falls_short_moves_nothing_not_even_the_near_for_the_storage", async () => {
  // The storage balance is short too. A poster who paid for the storage first would have paid.
  const { failure, trace, chain } = await run(
    { alpha: {}, beta: {} },
    { chain: { storage: storageOf(1_000n), wallet: new Map([[TOKEN, 100_000n]]) } },
  );

  expect((failure as Error).message).toBe(
    `the vault of ${POSTER} holds 0.00 tUSDC and the seeds need 0.50 tUSDC; ` +
      `its wallet holds 0.10 tUSDC of ${TOKEN}, so 0.40 tUSDC more is missing`,
  );
  // The storage balance, the vault and the wallet were read, and that was all.
  expect(trace.slice(-3)).toEqual(["storageBalanceOf", "balanceOf", "ftBalanceOf"]);
  expect(chain.storageDeposit).not.toHaveBeenCalled();
  expect(chain.deposit).not.toHaveBeenCalled();
  expect(trace.filter((call) => /deposit|upload|postTask/i.test(call))).toEqual([]);
});

test("every_token_is_checked_before_any_is_deposited_and_each_that_falls_short_is_named", async () => {
  const dir = await dirWith({
    "deployments/testnet.json": JSON.stringify(deployment("testnet", TOKEN, USDC)),
  });
  const spec = {
    alpha: { task: taskWith({ token: "usdc", reward: "1.00" }) },
    beta: { task: taskWith({ token: "tusdc", reward: "0.50" }) },
  };
  const attempt = (wallet: Array<[string, bigint]>) =>
    run(spec, {
      tokenId: undefined,
      dir,
      chain: { storage: storageOf(1_000n), wallet: new Map(wallet) },
    });
  const usdcShort =
    `the vault of ${POSTER} holds 0.00 USDC and the seeds need 1.00 USDC; ` +
    `its wallet holds 0.40 USDC of ${USDC}, so 0.60 USDC more is missing`;
  const tusdcShort =
    `the vault of ${POSTER} holds 0.00 tUSDC and the seeds need 0.50 tUSDC; ` +
    `its wallet holds 0.10 tUSDC of ${TOKEN}, so 0.40 tUSDC more is missing`;

  // The wallet of the first token covers its reward, and still it is not deposited: the second
  // token falls short, and the run moves nothing.
  const one = await attempt([[TOKEN, 100_000n]]);
  expect((one.failure as Error).message).toBe(tusdcShort);

  // Both fall short: both are said, in the order of the seeds, one to a line.
  const both = await attempt([
    [USDC, 400_000n],
    [TOKEN, 100_000n],
  ]);
  expect((both.failure as Error).message).toBe(`${usdcShort}\n${tusdcShort}`);

  for (const { chain, trace } of [one, both]) {
    expect(chain.storageDeposit).not.toHaveBeenCalled();
    expect(chain.deposit).not.toHaveBeenCalled();
    expect(trace.filter((call) => /deposit|upload|postTask/i.test(call))).toEqual([]);
  }
});

test("a_deposit_that_tender_hands_back_stops_the_run_before_anything_is_uploaded", async () => {
  const { failure, trace } = await run({ alpha: {} }, { chain: { refuseDeposits: true } });

  expect((failure as Error).message).toBe(
    `Tender did not take the deposit of 0.25 tUSDC from ${POSTER}; ` +
      `is the poster registered with Tender, and is ${TOKEN} on its list of tokens?`,
  );
  expect(trace.filter((call) => call.startsWith("upload") || call === "postTask")).toEqual([]);
});

// ---- The storage balance ------------------------------------------------------------------------

test("the_storage_balance_is_topped_up_before_the_vault_and_before_anything_is_uploaded", async () => {
  // Two tasks cost at most 2 * 1,600 bytes, and a vault slot 200: 3,400. The balance holds 1,000.
  const { chain, lines, trace } = await run(
    { alpha: {}, beta: {} },
    { chain: { storage: storageOf(1_000n) } },
  );

  expect(chain.storageDeposit.mock.calls).toEqual([[storageBytes(2_400n)]]);
  expect(lines[0]).toBe("DEPOSITED 0.024 NEAR for storage");
  // The questions to the API come first. Then the poster is read in full (storage, vault, wallet)
  // and topped up the same way round, and only then do the seeds go up.
  const questions = ["health", "getBlob", "listTasks", "getTask"];
  expect(trace.filter((call) => !questions.includes(call)).slice(0, 5)).toEqual([
    "storageBalanceOf",
    "balanceOf",
    "ftBalanceOf",
    "storageDeposit",
    "deposit",
  ]);
  expect(trace.indexOf("storageDeposit")).toBeLessThan(trace.indexOf("uploadBlob brief"));
});

test("a_storage_balance_that_covers_the_tasks_is_left_alone", async () => {
  const { chain, lines } = await run(
    { alpha: {}, beta: {} },
    { chain: { storage: storageOf(3_400n) } },
  );

  expect(chain.storageDeposit).not.toHaveBeenCalled();
  expect(lines.some((line) => line.includes("NEAR"))).toBe(false);
});

test("a_poster_that_never_deposited_registers_with_the_deposit_that_covers_its_tasks", async () => {
  const { chain, lines } = await run({ alpha: {}, beta: {} }, { chain: { storage: null } });

  // 3,400 bytes, and up to 133 more for the account's own record, as storageShortfall allows.
  expect(chain.storageDeposit.mock.calls).toEqual([[storageBytes(3_533n)]]);
  expect(lines[0]).toBe("DEPOSITED 0.03533 NEAR for storage");
});

test("the_storage_a_run_needs_grows_with_the_tasks_it_posts_and_not_with_those_it_skips", async () => {
  const served = new Set([hashOf(heldoutOf("beta")), hashOf(heldoutOf("gamma"))]);

  // One task and one vault slot: 1,800 bytes. 1,700 are free.
  const { chain } = await run(
    { alpha: {}, beta: {}, gamma: {} },
    { api: { served }, chain: { storage: storageOf(1_700n) } },
  );

  expect(chain.storageDeposit.mock.calls).toEqual([[storageBytes(100n)]]);
});

// ---- Seeds that are posted already, and checks that are spent -----------------------------------

test("a_second_run_over_the_same_seeds_posts_nothing_and_pays_nothing", async () => {
  const dir = await seedsDir({ alpha: {}, beta: {} });
  const world = worldOf();

  const first = await play(world, dir);
  const second = await play(world, dir);

  expect(first.result).toEqual([seeded("alpha", 1n), seeded("beta", 2n)]);
  // Nothing was posted, and the caller is told which task each seed is.
  expect(second.result).toEqual([existing("alpha", 1n), existing("beta", 2n)]);
  expect(second.lines).toEqual([
    "SKIP alpha (held-out already used by task 1)",
    "SKIP beta (held-out already used by task 2)",
  ]);
  // It asked which API it has, what is public, then for the poster's tasks and for each of them:
  // it paid, uploaded and posted nothing.
  expect(second.trace).toEqual(["health", "getBlob", "getBlob", "listTasks", "getTask", "getTask"]);
  expect(world.chain.posts).toHaveLength(2);
  expect(world.chain.deposit).toHaveBeenCalledTimes(1);
  expect(world.api.uploads).toHaveLength(4);
  expect(world.api.heldouts).toHaveLength(2);
});

test("a_run_that_stopped_half_way_is_finished_by_running_it_again", async () => {
  const dir = await seedsDir({ alpha: {}, beta: {}, gamma: {} });
  const stop = new TenderError("E_STORAGE", "E_STORAGE: insufficient storage balance");
  const world = worldOf({ chain: { failPost: { call: 2, error: stop } } });

  const first = await play(world, dir);
  const second = await play(world, dir);

  expect(first.failure).toBe(stop);
  expect(first.lines).toEqual(["DEPOSITED 0.75 tUSDC", "SEEDED alpha task=1", "FAILED beta"]);
  // alpha is up, so it is not posted twice; the vault still holds the rewards of the two left.
  expect(second.lines).toEqual([
    "SKIP alpha (held-out already used by task 1)",
    "SEEDED beta task=2",
    "SEEDED gamma task=3",
  ]);
  expect(second.result).toEqual([existing("alpha", 1n), seeded("beta", 2n), seeded("gamma", 3n)]);
  expect(world.chain.deposit).toHaveBeenCalledTimes(1);
});

test("a_task_of_the_poster_with_the_same_heldout_stops_its_seed_in_every_phase_settled_too", async () => {
  // The Judge refuses a task whose checks an earlier task of the poster carries, whatever phase
  // that task is in: a settled task, or one that was voided, has spent its checks as well.
  for (const phase of ["open", "revealing", "judging", "fallback", "expired", "settled"] as const) {
    const { result, lines, chain, api } = await run(
      { alpha: {} },
      { api: { tasks: [listedOf(100n, "alpha", phase)] } },
    );

    expect(result, phase).toEqual([existing("alpha", 100n)]);
    expect(lines, phase).toEqual(["SKIP alpha (held-out already used by task 100)"]);
    expect(chain.deposit, phase).not.toHaveBeenCalled();
    expect(chain.storageDeposit, phase).not.toHaveBeenCalled();
    expect(chain.postTask, phase).not.toHaveBeenCalled();
    // The list does not say what checks a task carries, so the task is read whatever its phase.
    expect(api.getTask, phase).toHaveBeenCalledWith(100n);
  }
});

test("a_task_with_other_documents_but_the_same_heldout_stops_the_seed_all_the_same", async () => {
  // What counts is the commitment: the Judge looks at nothing else of the earlier task.
  const tasks = [listedOf(100n, "other", "settled", { heldout: "alpha" })];

  const { result, lines } = await run({ alpha: {} }, { api: { tasks } });

  expect(result).toEqual([existing("alpha", 100n)]);
  expect(lines).toEqual(["SKIP alpha (held-out already used by task 100)"]);
});

test("a_task_with_the_brief_of_the_seed_and_other_heldout_does_not_stop_it", async () => {
  // A seed whose checks were rewritten is a task of its own, whatever its brief.
  const tasks = [listedOf(100n, "alpha", "open", { heldout: "other" })];

  const { result, lines } = await run({ alpha: {} }, { api: { tasks } });

  expect(result).toEqual([seeded("alpha", 1n)]);
  expect(lines).toEqual(["DEPOSITED 0.25 tUSDC", "SEEDED alpha task=1"]);
});

test("the_oldest_task_with_the_checks_is_the_one_named_whatever_its_phase", async () => {
  const tasks = [
    listedOf(9n, "alpha", "open"),
    listedOf(3n, "alpha", "settled"),
    listedOf(7n, "alpha", "judging"),
  ];

  const { lines, api } = await run({ alpha: {} }, { api: { tasks } });

  // The Judge names the lowest id, and so does the script. Every task is read, oldest first.
  expect(lines).toEqual(["SKIP alpha (held-out already used by task 3)"]);
  expect(api.getTask.mock.calls.map(([id]) => id)).toEqual([3n, 7n, 9n]);
});

test("a_seed_whose_heldout_is_public_is_skipped_for_that_and_still_gets_the_task_that_used_it", async () => {
  const served = new Set([hashOf(heldoutOf("alpha"))]);

  const { result, lines, chain } = await run(
    { alpha: {} },
    { api: { served, tasks: [listedOf(100n, "alpha", "settled")] } },
  );

  // Public is the reason that is printed: the single-use rule (P05-P12) holds whatever the lookup
  // finds. The settled task is the one the caller can look the seed up by.
  expect(result).toEqual([existing("alpha", 100n)]);
  expect(lines).toEqual(["SKIP alpha (held-out already public)"]);
  expect(chain.postTask).not.toHaveBeenCalled();
});

test("a_seed_that_is_judged_is_skipped_for_its_public_checks_whether_or_not_it_is_up", async () => {
  const served = new Set([hashOf(heldoutOf("alpha"))]);
  const tasks = [listedOf(100n, "alpha", "open"), listedOf(101n, "beta", "open")];

  const { lines } = await run({ alpha: {}, beta: {} }, { api: { served, tasks } });

  expect(lines).toEqual([
    "SKIP alpha (held-out already public)",
    "SKIP beta (held-out already used by task 101)",
  ]);
});

test("a_task_of_another_poster_does_not_stand_in_the_way", async () => {
  const theirs = listedOf(100n, "alpha", "open", { poster: `someone.${PARENT}` });

  const asked = await run({ alpha: {} }, { api: { tasks: [theirs] } });
  const ignored = await run({ alpha: {} }, { api: { tasks: [theirs], ignorePoster: true } });

  // The Judge looks at the poster's own tasks only: someone else may post the same checks.
  for (const { result, lines } of [asked, ignored]) {
    expect(result).toEqual([seeded("alpha", 1n)]);
    expect(lines).toEqual(["DEPOSITED 0.25 tUSDC", "SEEDED alpha task=1"]);
  }
  // It asks for the poster's tasks, in the biggest pages the API gives ...
  expect(asked.api.listTasks).toHaveBeenCalledWith({ poster: POSTER, limit: 50, cursor: null });
  // ... and keeps a task of someone else out even when the API lists it all the same.
  expect(ignored.api.getTask).not.toHaveBeenCalled();
});

test("the_posters_tasks_are_read_page_after_page_to_the_last", async () => {
  // Six tasks, the oldest of them the seed's, and an API that gives two to a page.
  const tasks = [
    listedOf(100n, "alpha", "open"),
    ...[101n, 102n, 103n, 104n, 105n].map((id) => listedOf(id, `other-${id}`, "open")),
  ];

  const { lines, api } = await run({ alpha: {} }, { api: { tasks, pageSize: 2 } });

  expect(lines).toEqual(["SKIP alpha (held-out already used by task 100)"]);
  // Newest first, each page from the cursor of the one before, until there is none.
  expect(api.listTasks.mock.calls.map(([filter]) => filter?.cursor)).toEqual([null, "104", "102"]);
  expect(api.getTask.mock.calls.map(([id]) => id)).toEqual([100n, 101n, 102n, 103n, 104n, 105n]);
});

test("a_seed_that_is_posted_already_is_not_paid_for_again", async () => {
  // beta alone needs one task and one vault slot, 1,800 bytes of storage, and 1,700 are free.
  const { result, lines, chain } = await run(
    { alpha: {}, beta: {} },
    { api: { tasks: [listedOf(100n, "alpha", "open")] }, chain: { storage: storageOf(1_700n) } },
  );

  expect(result).toEqual([existing("alpha", 100n), seeded("beta", 1n)]);
  expect(chain.storageDeposit.mock.calls).toEqual([[storageBytes(100n)]]);
  expect(chain.deposit.mock.calls).toEqual([[TOKEN, 250_000n]]);
  expect(lines).toEqual([
    "DEPOSITED 0.001 NEAR for storage",
    "DEPOSITED 0.25 tUSDC",
    "SKIP alpha (held-out already used by task 100)",
    "SEEDED beta task=1",
  ]);
});

test("a_seed_without_checks_is_skipped_for_a_task_with_its_brief_that_has_not_settled", async () => {
  const rubric = { rubric: { criteria: RUBRIC, heldout: null } };
  const up = (phase: Phase) => ({
    api: { tasks: [listedOf(100n, "rubric", phase, { heldout: null })] },
  });

  // It has no commitment to go by, so the brief decides: a task that is up stands for the seed ...
  const open = await run(rubric, up("open"));
  expect(open.result).toEqual([existing("rubric", 100n)]);
  expect(open.lines).toEqual(["SKIP rubric (already posted as task 100)"]);
  expect(open.chain.postTask).not.toHaveBeenCalled();

  // ... and one that has settled spent no checks, so the seed can be posted again.
  const settled = await run(rubric, up("settled"));
  expect(settled.result).toEqual([seeded("rubric", 1n)]);
  expect(settled.lines).toEqual(["DEPOSITED 0.25 tUSDC", "SEEDED rubric task=1"]);
});

test("the_result_gives_each_seed_a_task_stands_for_in_slug_order_and_how_it_came_to_be", async () => {
  const served = new Set([hashOf(heldoutOf("delta")), hashOf(heldoutOf("echo"))]);
  const tasks = [listedOf(40n, "alpha", "settled"), listedOf(41n, "delta", "open")];

  const { result, lines } = await run(
    { alpha: {}, beta: {}, delta: {}, echo: {} },
    { api: { served, tasks } },
  );

  // alpha is spent by task 40, beta is posted now, delta is public and has task 41. echo is
  // public, and no task of the poster carries its checks: there is no task to name, so no entry.
  expect(result).toEqual([existing("alpha", 40n), seeded("beta", 1n), existing("delta", 41n)]);
  expect(lines).toEqual([
    "DEPOSITED 0.25 tUSDC",
    "SKIP alpha (held-out already used by task 40)",
    "SEEDED beta task=1",
    "SKIP delta (held-out already public)",
    "SKIP echo (held-out already public)",
  ]);
});

test("seeds_that_share_their_heldout_checks_are_refused_before_anything_is_asked", async () => {
  // beta's file holds the document that alpha's does, written another way: one set of checks.
  const { failure, trace, lines } = await run({
    alpha: {},
    beta: { heldout: '{"exact":\n{"expected": ["alpha"]}}' },
    gamma: { heldout: heldoutOf("alpha") },
  });

  expect((failure as Error).message).toBe(
    "alpha, beta, gamma share their held-out checks, and the Judge takes a poster's checks once: give each seed its own",
  );
  expect(trace).toEqual(UNTOUCHED);
  expect(lines).toEqual([]);
});

test("seeds_that_share_their_checks_are_fine_when_only_one_of_them_is_posted", async () => {
  const spec = { alpha: {}, beta: { heldout: heldoutOf("alpha") } };

  const { result, failure } = await run(spec, { only: ["beta"] });

  expect(failure).toBeUndefined();
  expect(result).toEqual([seeded("beta", 1n)]);
});

test("an_api_that_fails_to_list_the_posters_tasks_stops_the_run_before_anything_is_paid", async () => {
  const dir = await seedsDir({ alpha: {}, beta: {} });
  const world = worldOf();
  const outage = new ApiError(503, { error: "unavailable", message: "no" });
  world.api.listTasks.mockImplementationOnce(async () => {
    world.trace.push("listTasks");
    throw outage;
  });

  const { failure, trace, lines } = await play(world, dir);

  // "No tasks" is not what it said, so nothing was paid, uploaded or posted on the strength of it.
  expect(failure).toBe(outage);
  expect(trace).toEqual(["health", "getBlob", "getBlob", "listTasks"]);
  expect(lines).toEqual([]);
});

test("a_list_that_never_ends_is_an_error_and_not_a_hang", async () => {
  const { failure, trace } = await run({ alpha: {} }, { api: { stuck: true } });

  expect((failure as Error).message).toBe(
    `the list of the tasks of ${POSTER} does not end: cursor 9 came twice`,
  );
  expect(trace).toEqual(["health", "getBlob", "listTasks", "listTasks"]);
});

test("a_listed_task_that_the_api_then_does_not_know_stops_the_run", async () => {
  const { failure, trace } = await run(
    { alpha: {} },
    { api: { tasks: [listedOf(100n, "other", "open")], vanished: new Set([100n]) } },
  );

  expect((failure as Error).message).toBe(
    `the API lists task 100 of ${POSTER}, and has no such task`,
  );
  expect(trace.filter((call) => /deposit|upload|postTask/i.test(call))).toEqual([]);
});

// ---- Which deployment ---------------------------------------------------------------------------

test("an_api_of_another_deployment_is_refused_with_both_named_before_anything_else_is_asked", async () => {
  const elsewhere = `tender.elsewhere.${PARENT}`;
  const cases = [
    {
      what: "the API serves another network",
      options: { api: { serves: { network: "sandbox" } } },
      message: `the API serves ${CONTRACT} on sandbox, but the client is set for ${CONTRACT} on testnet`,
    },
    {
      what: "the API serves another contract",
      options: { api: { serves: { contract: elsewhere } } },
      message: `the API serves ${elsewhere} on testnet, but the client is set for ${CONTRACT} on testnet`,
    },
    {
      what: "the client is set for another contract",
      options: { chain: { contractId: elsewhere } },
      message: `the API serves ${CONTRACT} on testnet, but the client is set for ${elsewhere} on testnet`,
    },
  ];

  for (const { what, options, message } of cases) {
    const { failure, trace, lines } = await run({ alpha: {} }, options);

    expect((failure as Error).message, what).toBe(
      `${message}: they have to be the same deployment`,
    );
    // Only the API was asked who it is: nothing was checked, listed, paid, uploaded or posted.
    expect(trace, what).toEqual(["health"]);
    expect(lines, what).toEqual([]);
  }
});

test("a_client_set_for_another_network_than_the_seeds_is_refused_before_anything_is_asked", async () => {
  // The token is chosen by the seeds' network and the API is checked against the client's: review
  // M4's nit. They are one network, or nothing is read or asked.
  const { failure, trace, lines } = await run({ alpha: {} }, { chain: { network: "sandbox" } });

  expect((failure as Error).message).toBe(
    "the seeds are for testnet, but the client is set for sandbox: they have to be the same network",
  );
  expect(trace).toEqual(UNTOUCHED);
  expect(lines).toEqual([]);
});

test("an_index_more_than_10_blocks_behind_stops_the_run_before_anything_else_is_asked", async () => {
  // Review M4. A stalled index misses the poster's latest tasks, so a seed that an earlier run
  // posted would be posted again, and the Judge would turn the copy away. Ten blocks are let by.
  const behind = await run({ alpha: {} }, { api: { serves: { lag_blocks: "11" } } });

  expect((behind.failure as Error).message).toBe(
    "the API's index is 11 blocks behind the chain, and its list of the poster's tasks may miss the latest ones, which would post a seed again: wait until it is at most 10 behind",
  );
  expect(behind.trace).toEqual(["health"]);
  expect(behind.lines).toEqual([]);

  const edge = await run({ alpha: {} }, { api: { serves: { lag_blocks: "10" } } });
  expect(edge.failure).toBeUndefined();
  expect(edge.trace).toContain("postTask");
});

test("an_api_that_cannot_say_which_deployment_it_is_stops_the_run", async () => {
  const outage = new ApiError(503, { error: "chain_unavailable", message: "no" });

  const { failure, trace } = await run({ alpha: {} }, { api: { unhealthy: outage } });

  expect(failure).toBe(outage);
  expect(trace).toEqual(["health"]);
});

// ---- Failures -----------------------------------------------------------------------------------

test("a_failed_post_stops_the_run_names_the_seed_and_leaves_the_earlier_tasks_posted", async () => {
  const failure = new TenderError("E_STORAGE", "E_STORAGE: insufficient storage balance", {
    txHash: "tx-9",
  });

  const run1 = await run(
    { alpha: {}, beta: {}, gamma: {} },
    { chain: { failPost: { call: 2, error: failure } } },
  );

  // The very error, so its code and transaction reach whoever catches it.
  expect(run1.failure).toBe(failure);
  expect(run1.lines).toEqual(["DEPOSITED 0.75 tUSDC", "SEEDED alpha task=1", "FAILED beta"]);
  expect(run1.chain.posts).toHaveLength(1);
  // gamma was never started.
  expect(run1.api.uploads.map((u) => u.bytes)).not.toContainEqual(canonicalJson(briefOf("gamma")));
});

test("an_upload_the_api_stored_under_another_hash_stops_the_seed_before_it_is_posted", async () => {
  const other = "0".repeat(64);

  const { failure, lines, chain } = await run({ alpha: {} }, { api: { storedAs: other } });

  expect((failure as Error).message).toBe(
    `the API stored the brief of alpha as ${other}, and not as ${hashOf(briefOf("alpha"))}`,
  );
  expect(lines).toEqual(["DEPOSITED 0.25 tUSDC", "FAILED alpha"]);
  expect(chain.postTask).not.toHaveBeenCalled();
});

test("a_client_that_is_not_the_poster_is_refused_before_anything_is_asked", async () => {
  const other = await run({ alpha: {} }, { chain: { accountId: `someone.${PARENT}` } });
  expect((other.failure as Error).message).toBe(
    `the client signs as another account, but it has to sign as the poster ${POSTER}`,
  );

  const unsigned = await run({ alpha: {} }, { chain: { unsigned: true } });
  expect((unsigned.failure as Error).message).toBe(
    `the client has no signer, but it has to sign as the poster ${POSTER}`,
  );

  expect(other.trace).toEqual(UNTOUCHED);
  expect(unsigned.trace).toEqual(UNTOUCHED);
});

test("seed_refuses_mainnet_whether_the_option_or_the_client_says_it_and_before_it_reads_a_file", async () => {
  // The folder of seeds does not exist: a run that got as far as reading it would fail on that.
  const nowhere = join(tmpdir(), "tender-seeds-that-do-not-exist");
  const byOption = await run(nowhere, { network: "mainnet" });
  const byClient = await run(nowhere, { chain: { network: "mainnet" } });

  for (const { failure, trace, lines } of [byOption, byClient]) {
    expect((failure as Error).message).toBe(
      "mainnet is not seeded by this script: plan 07 owns the mainnet launch, which needs the owner's approval",
    );
    expect(trace).toEqual(UNTOUCHED);
    expect(lines).toEqual([]);
  }
});

// ---- Seeds that are wrong -----------------------------------------------------------------------

test("a_seed_that_is_wrong_stops_the_run_before_the_api_or_the_chain_is_asked_anything", async () => {
  const cases: Array<[string, SeedSpec, RegExp]> = [
    ["no task.json", { task: null }, /^beta\/task\.json does not exist$/],
    ["a task.json that is not JSON", { task: "{nope" }, /^beta\/task\.json is not valid JSON$/],
    [
      "a task.json that is a list",
      { task: [] },
      /^beta\/task\.json is not a seed's terms: it is not an object$/,
    ],
    [
      "a misspelt key",
      { task: { ...TASK, commit_sec: 600 } },
      /beta\/task\.json is not a seed's terms: "commit_sec" is none of /,
    ],
    [
      "a reward that is a number",
      { task: taskWith({ reward: 0.25 }) },
      /terms: reward must be text in token units/,
    ],
    [
      "another token",
      { task: taskWith({ token: "dai" }) },
      /terms: token must be "usdc" or "tusdc"/,
    ],
    [
      "another verifier",
      { task: taskWith({ verifier: "owner" }) },
      /terms: verifier must be "judge" or "poster"/,
    ],
    [
      "no winners",
      { task: taskWith({ max_winners: 0 }) },
      /terms: max_winners must be a whole number above 0/,
    ],
    [
      "a window in text",
      { task: taskWith({ reveal_secs: "300" }) },
      /terms: reveal_secs must be a whole number of seconds above 0/,
    ],
    [
      "a window in fractions of a second",
      { task: taskWith({ pick_secs: 1.5 }) },
      /terms: pick_secs must be a whole number of seconds above 0/,
    ],
    ["a brief that is not JSON", { brief: "<html>" }, /^beta\/brief\.json is not valid JSON$/],
    [
      "a brief with no title",
      { brief: { ...briefOf("beta"), title: "" } },
      /^beta\/brief\.json does not fit its schema, first at title: /,
    ],
    [
      "a brief with a key of its own",
      { brief: { ...briefOf("beta"), attachements: [] } },
      /^beta\/brief\.json does not fit its schema, first at the document: /,
    ],
    [
      "criteria of no kind",
      { criteria: { ...CRITERIA, kind: "vibes" } },
      /^beta\/criteria\.json does not fit its schema, first at kind: /,
    ],
    [
      "checks that are missing",
      { heldout: null },
      /^held-out for beta not found in .+; set TENDER_SEEDS_PRIVATE_DIR$/,
    ],
    [
      "checks the criteria do not have",
      { criteria: RUBRIC },
      /^beta\/heldout\.json exists in .+, and beta\/criteria\.json has no held-out part$/,
    ],
    [
      "checks of another kind",
      { heldout: { regex_cases: { match: ["a"], no_match: ["b"] } } },
      /^beta\/heldout\.json is not a held-out document of kind exact$/,
    ],
    [
      "checks with nothing in them",
      { heldout: { exact: { expected: [] } } },
      /^beta\/heldout\.json does not fit its schema, first at exact\.expected: /,
    ],
  ];

  for (const [what, broken, message] of cases) {
    // alpha is fine, and comes before: it must not be posted while beta is found out.
    const { failure, trace, lines } = await run({ alpha: {}, beta: broken });

    expect(failure, what).toBeInstanceOf(Error);
    expect((failure as Error).message, what).toMatch(message);
    expect(trace, what).toEqual(UNTOUCHED);
    expect(lines, what).toEqual([]);
  }
});

test("a_folder_of_seeds_that_is_missing_is_an_error", async () => {
  const { failure, trace } = await run(join(tmpdir(), "tender-seeds-that-do-not-exist"));

  expect((failure as NodeJS.ErrnoException).code).toBe("ENOENT");
  expect(trace).toEqual(UNTOUCHED);
});

// ---- Secrets ------------------------------------------------------------------------------------

test("no_secret_reaches_a_log_line_or_an_error_of_a_run_that_succeeds_or_fails", async () => {
  // The client and the API of a real run hold a key and a bearer token. These carry one each, to
  // show that nothing the script prints or throws comes from them.
  const secretive = { privateKey: LEAKY, token: LEAKY };
  const dir = await seedsDir({ alpha: {}, beta: {} });
  const attempt = async (chain: ChainOptions, served: ApiOptions = {}) => {
    const trace: string[] = [];
    const lines: string[] = [];
    const fake = fakeChain(trace, chain);
    const { api } = fakeApi(trace, served);
    const failure = await seed({
      client: Object.assign(fake.client, secretive),
      api: Object.assign(api, secretive),
      network: "testnet",
      poster: POSTER,
      judgeAccount: JUDGE,
      tokenId: TOKEN,
      seedsDir: dir,
      heldoutDir: PRIVATE_OF.get(dir),
      log: (line) => lines.push(line),
    }).then(
      () => "",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    return [...lines, failure].join("\n");
  };

  const ok = await attempt({});
  const poor = await attempt({ wallet: new Map([[TOKEN, 1n]]) });
  const refused = await attempt({ refuseDeposits: true });
  const failed = await attempt({
    failPost: { call: 1, error: new TenderError("E_AUTH", "E_AUTH: attach exactly 1 yoctoNEAR") },
  });
  const elsewhere = await attempt({}, { serves: { network: "mainnet" } });

  for (const output of [ok, poor, refused, failed, elsewhere]) {
    expect(output).not.toContain("LEAKY");
    expect(output).not.toContain("ed25519");
  }
  // And the runs did what they were meant to: the first posted, the others stopped.
  expect(ok).toContain("SEEDED beta task=2");
  expect(poor).toContain("more is missing");
  expect(refused).toContain("did not take the deposit");
  expect(failed).toContain("FAILED alpha");
  expect(elsewhere).toContain("they have to be the same deployment");
});

// ---- The seeds of the repository ----------------------------------------------------------------

test("the_thirty_seeds_of_the_repository_are_posted_in_slug_order_with_the_hashes_of_their_files", async () => {
  const root = join(import.meta.dirname, "..", "seeds");
  const slugs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  // The held-out checks are the real ones when this machine has them (the private directory), and
  // stand-ins of the right kind where it does not, so that the counts and the hashes are checked
  // everywhere. Either way a task's commitment has to be the hash of the file it was posted from.
  const real = privateDirOf();
  let held = real;
  if (missingHeldouts(root, real, slugs).length > 0) {
    held = await mkdtemp(join(tmpdir(), "tender-heldout-stand-in-"));
    dirs.push(held);
    writeSyntheticHeldouts(root, held);
  }
  const fileOf = (slug: string, name: string): object =>
    JSON.parse(readFileSync(join(name === "heldout.json" ? held : root, slug, name), "utf8"));

  // No `seedsDir`: the script finds the repository's own.
  const { result, chain, api, lines, failure } = await run(null, { heldoutDir: held });

  expect(failure).toBeUndefined();
  expect(slugs).toHaveLength(30);
  expect(result?.map((posted) => posted.slug)).toEqual(slugs);
  expect(result?.map((posted) => posted.status)).toEqual(slugs.map(() => "posted"));
  expect(lines.filter((line) => line.startsWith("SEEDED "))).toHaveLength(30);
  expect(chain.posts.map((post) => post.briefHash)).toEqual(
    slugs.map((slug) => hashOf(fileOf(slug, "brief.json"))),
  );
  expect(chain.posts.map((post) => post.criteriaHash)).toEqual(
    slugs.map((slug) => hashOf(fileOf(slug, "criteria.json"))),
  );
  // A rubric seed has no held-out checks, so its task carries no commitment.
  const withChecks = slugs.filter((slug) => existsSync(join(held, slug, "heldout.json")));
  expect(withChecks).toHaveLength(25);
  expect(chain.posts.map((post) => post.heldoutCommitment)).toEqual(
    slugs.map((slug) =>
      withChecks.includes(slug) ? hashOf(fileOf(slug, "heldout.json")) : undefined,
    ),
  );
  expect(api.heldouts).toHaveLength(25);
  // Every reward from 0.25 to 1.50, in units: 22.50 in all, which is what the vault was filled with.
  const rewards = chain.posts.map((post) => post.reward);
  expect(rewards.every((reward) => reward >= 250_000n && reward <= 1_500_000n)).toBe(true);
  expect(rewards.reduce((sum, reward) => sum + reward, 0n)).toBe(22_500_000n);
  expect(chain.deposit.mock.calls).toEqual([[TOKEN, 22_500_000n]]);
  expect(new Set(chain.posts.map((post) => post.verifier))).toEqual(new Set([JUDGE]));
});

// ---- The command line ---------------------------------------------------------------------------

const KEY = KeyPair.fromRandom("ed25519").toString();
const API_URL = "https://api.tender.example";
const ENV_FILE = ".env.deploy.testnet";

/** The env file the deploy leaves, and `.env` with the URL of the API, which the deploy cannot know. */
function deployed(extra = ""): Record<string, string> {
  return {
    ".env": `TENDER_API_URL=${API_URL}\n`,
    [ENV_FILE]: `${[
      `TENDER_CONTRACT=${CONTRACT}`,
      `POSTER_ACCOUNT=${POSTER}`,
      `POSTER_FULL_ACCESS_KEY=${KEY}`,
      `JUDGE_ACCOUNT=${JUDGE}`,
      extra,
    ]
      .filter((line) => line !== "")
      .join("\n")}\n`,
  };
}

/** Runs the command line against the files in a new directory, with `seed` replaced. */
async function runCli(
  files: Record<string, string>,
  args: string[],
  stand: typeof seed = async (o) => {
    o.log?.("SEEDED alpha task=1");
    return [seeded("alpha", 1n)];
  },
) {
  const dir = await dirWith(files);
  const out: string[] = [];
  const err: string[] = [];
  const fake = vi.fn<typeof seed>(stand);
  const code = await main(args, {
    dir,
    out: (line) => out.push(line),
    err: (text) => err.push(text),
    seed: fake,
  });
  return { code, out, err: err.join("\n"), seed: fake, dir };
}

test("cli_seeds_testnet_as_the_poster_with_the_judge_and_the_api_of_the_env_files", async () => {
  const fetched: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      fetched.push(String(url));
      return new Response(null, { status: 404 });
    }),
  );
  const sha256 = "ab".repeat(32);

  const {
    code,
    out,
    err,
    seed: fake,
    dir,
  } = await runCli(deployed(), ["--network", "testnet"], async (o) => {
    // The API client it was given reads the blob from the URL of the env file.
    await o.api.getBlob(sha256);
    o.log?.("SEEDED alpha task=1");
    return [];
  });

  expect(code).toBe(0);
  expect(err).toBe("");
  // Only the script's own lines reach stdout.
  expect(out).toEqual(["SEEDED alpha task=1"]);
  expect(fake).toHaveBeenCalledTimes(1);
  const options = fake.mock.calls[0]?.[0];
  expect(options).toMatchObject({
    network: "testnet",
    poster: POSTER,
    judgeAccount: JUDGE,
    dir,
  });
  expect(options?.only).toBeUndefined();
  // The client signs as the poster, on the contract of the env file and the network's own RPC.
  expect(options?.client).toBeInstanceOf(TenderClient);
  expect(options?.client).toMatchObject({
    network: "testnet",
    contractId: CONTRACT,
    rpcUrl: NETWORKS.testnet.rpcUrl,
    accountId: POSTER,
  });
  expect(options?.api).toBeInstanceOf(ApiClient);
  expect(fetched).toEqual([`${API_URL}/v1/blobs/${sha256}`]);
});

test("cli_gives_seed_the_private_directory_of_the_env_file_unless_the_process_names_one", async () => {
  const privateDirOfRun = async (files: Record<string, string>) => {
    const { seed: fake, code } = await runCli(files, ["--network", "testnet"]);
    expect(code).toBe(0);
    return fake.mock.calls[0]?.[0].heldoutDir;
  };

  // Nothing set anywhere: seeds-private/ of the repository.
  vi.stubEnv(PRIVATE_DIR_VARIABLE, "");
  expect(await privateDirOfRun(deployed())).toBe(join(import.meta.dirname, "..", "seeds-private"));
  // The env file names it.
  expect(await privateDirOfRun(deployed(`${PRIVATE_DIR_VARIABLE}=/vault/heldout`))).toBe(
    "/vault/heldout",
  );
  // The process comes first, so that a shell can point one run elsewhere.
  vi.stubEnv(PRIVATE_DIR_VARIABLE, "/elsewhere/heldout");
  expect(await privateDirOfRun(deployed(`${PRIVATE_DIR_VARIABLE}=/vault/heldout`))).toBe(
    "/elsewhere/heldout",
  );
});

test("cli_takes_the_seeds_from_only_whether_it_is_given_once_or_often", async () => {
  const only = async (args: string[]) => {
    const { seed: fake, code } = await runCli(deployed(), ["--network", "testnet", ...args]);
    expect(code, args.join(" ")).toBe(0);
    return fake.mock.calls[0]?.[0].only;
  };

  expect(await only(["--only", "alpha"])).toEqual(["alpha"]);
  expect(await only(["--only", "alpha,beta"])).toEqual(["alpha", "beta"]);
  expect(await only(["--only", "alpha, beta", "--only", "gamma"])).toEqual([
    "alpha",
    "beta",
    "gamma",
  ]);
  expect(await only([])).toBeUndefined();

  for (const args of [
    ["--only", ""],
    ["--only", " , "],
  ]) {
    const refused = await runCli(deployed(), ["--network", "testnet", ...args]);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/--only needs at least one seed slug/);
    expect(refused.seed).not.toHaveBeenCalled();
  }
});

test("cli_refuses_mainnet_the_sandbox_and_anything_else_without_touching_anything", async () => {
  const cases: Array<[string[], RegExp]> = [
    [["--network", "mainnet"], /mainnet.*plan 07/s],
    [["--network", "sandbox"], /sandbox.*tests/s],
    [["--network", "devnet"], /unknown network "devnet"/],
    [[], /usage: .*--network testnet/],
    [["--network", "testnet", "--force"], /force/],
    [["--network", "testnet", "alpha"], /alpha/],
    [["--network"], /network/],
  ];
  for (const [args, message] of cases) {
    const { code, err, out, seed: fake } = await runCli(deployed(), args);

    expect(code, args.join(" ")).toBe(1);
    expect(err, args.join(" ")).toMatch(message);
    expect(out).toEqual([]);
    expect(fake).not.toHaveBeenCalled();
  }
});

test("cli_names_every_variable_it_lacks", async () => {
  const { code, err, seed: fake } = await runCli({}, ["--network", "testnet"]);

  expect(code).toBe(1);
  for (const variable of [
    "TENDER_CONTRACT",
    "TENDER_API_URL",
    "POSTER_ACCOUNT",
    "POSTER_FULL_ACCESS_KEY",
    "JUDGE_ACCOUNT",
  ]) {
    expect(err).toContain(variable);
  }
  expect(fake).not.toHaveBeenCalled();
});

test("cli_names_the_variable_that_is_wrong_and_never_shows_its_value", async () => {
  const files = (name: string, value: string): Record<string, string> => {
    const base = deployed();
    return {
      ...base,
      [ENV_FILE]: (base[ENV_FILE] ?? "").replace(
        new RegExp(`^${name}=.*$`, "m"),
        `${name}=${value}`,
      ),
    };
  };
  const cases: Array<[string, Record<string, string>]> = [
    ["TENDER_CONTRACT", files("TENDER_CONTRACT", LEAKY)],
    ["POSTER_ACCOUNT", files("POSTER_ACCOUNT", LEAKY)],
    ["JUDGE_ACCOUNT", files("JUDGE_ACCOUNT", LEAKY)],
    ["POSTER_FULL_ACCESS_KEY", files("POSTER_FULL_ACCESS_KEY", LEAKY)],
    [
      "TENDER_API_URL",
      { ...deployed(), ".env": `TENDER_API_URL=http://elsewhere.example/${LEAKY}\n` },
    ],
    [
      "TENDER_API_URL",
      { ...deployed(), ".env": `TENDER_API_URL=https://user:${LEAKY}@api.example\n` },
    ],
    ["TENDER_API_URL", { ...deployed(), ".env": `TENDER_API_URL=${LEAKY}\n` }],
  ];
  for (const [variable, setup] of cases) {
    const { code, err, out, seed: fake } = await runCli(setup, ["--network", "testnet"]);

    expect(code, variable).toBe(1);
    expect(err, variable).toContain(variable);
    expect(err, variable).not.toContain("LEAKY");
    expect(out).toEqual([]);
    expect(fake).not.toHaveBeenCalled();
  }
});

test("cli_prints_a_failure_with_its_code_and_exits_1_and_never_prints_the_key", async () => {
  const attempt = async (failure: unknown) => {
    const { code, err, out } = await runCli(deployed(), ["--network", "testnet"], async () => {
      throw failure;
    });
    return { code, err, out };
  };

  expect(await attempt(new Error("the RPC is down"))).toEqual({
    code: 1,
    err: "seed failed: the RPC is down",
    out: [],
  });
  expect(
    await attempt(
      new TenderError("E_STORAGE", "E_STORAGE: insufficient storage balance", {
        txHash: "6kSpdaiEGudXLa4p",
      }),
    ),
  ).toEqual({
    code: 1,
    err: "seed failed with E_STORAGE\nE_STORAGE: insufficient storage balance\ntransaction 6kSpdaiEGudXLa4p",
    out: [],
  });

  // The key is in the env file, and in the client the stand-in is given. It is in no output.
  const { err, out } = await runCli(deployed(), ["--network", "testnet"], async (o) => {
    o.log?.("SEEDED alpha task=1");
    throw new Error("the API refused");
  });
  const printed = [err, ...out].join("\n");
  expect(printed).not.toContain(KEY);
  expect(printed).not.toContain(KEY.slice("ed25519:".length));
});

test("load_target_reads_the_network_file_over_the_plain_env_file_and_trims_what_it_reads", async () => {
  const dir = await dirWith({
    ".env": `TENDER_API_URL=${API_URL}\nPOSTER_ACCOUNT=other.testnet\nTENDER_CONTRACT=other.testnet\n`,
    [ENV_FILE]:
      `TENDER_CONTRACT=  ${CONTRACT}  \nPOSTER_ACCOUNT=${POSTER}\n` +
      `POSTER_FULL_ACCESS_KEY= ${KEY} \nJUDGE_ACCOUNT=${JUDGE}\n`,
  });

  expect(loadTarget("testnet", { dir })).toEqual({
    network: "testnet",
    contractId: CONTRACT,
    poster: { accountId: POSTER, privateKey: KEY },
    judgeAccount: JUDGE,
    apiUrl: API_URL,
  });
});
