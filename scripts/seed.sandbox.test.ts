import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type LocalChain, startLocalChain, TenderClient } from "@tender/client";
import {
  canonicalJson,
  NETWORKS,
  parseTokenAmount,
  sha256Hex,
  type TaskView,
  type TenderApi,
} from "@tender/shared";
import { afterAll, beforeAll, expect, test } from "vitest";
import { seed } from "./seed";

// The seed script against a local chain with Tender and a test token on it, and a fake API that
// keeps what is uploaded and says where it is served. What the chain holds of each task is read
// back and compared with the repository's own files, whose hashes are worked out here on their
// own: the script and the test agree only if the chain really holds what the files say.

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

/** A file of a seed of the repository, as JSON. */
const fileOf = (slug: string, name: string) =>
  JSON.parse(readFileSync(join(SEEDS, slug, name), "utf8")) as Record<string, unknown>;

/** The hash a task holds of a document: the SHA-256 of its canonical bytes. */
const hashOf = (document: object) => sha256Hex(canonicalJson(document));

const unexpected = (method: string) => () => {
  throw new Error(`unexpected call to api.${method}`);
};

interface Blob {
  kind: string;
  sha256: string;
  uri: string;
  bytes: Uint8Array;
}

/**
 * The API as far as the script uses it: it keeps every blob and held-out document it is given and
 * serves the URI `https://api.test/v1/blobs/<sha256>`. The held-out documents named in `served`
 * count as public already, as one that was judged is.
 */
function recordingApi(served: ReadonlySet<string> = new Set()) {
  const blobs: Blob[] = [];
  const heldouts: { commitment: string; bytes: Uint8Array }[] = [];
  const api: TenderApi = {
    listTasks: unexpected("listTasks"),
    getTask: unexpected("getTask"),
    listAgents: unexpected("listAgents"),
    getAgent: unexpected("getAgent"),
    listEntries: unexpected("listEntries"),
    health: unexpected("health"),
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
  expect(task.heldout_commitment, slug).toBe(hashOf(fileOf(slug, "heldout.json")));
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
  // Open to anyone, with no cap on entries and no parent.
  expect(task.max_entries, slug).toBe(0);
  expect(task.invited, slug).toEqual([]);
  expect(task.parent, slug).toBeNull();
  // The poster funded all of it, and nobody has entered yet.
  expect(task.funders, slug).toEqual([{ account: who.poster, amount: reward }]);
  expect(task.phase, slug).toBe("open");
  expect(task.commit_count, slug).toBe(0);
  return task;
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
    only: ["near-account-regex", "invoice-extract"],
    log: (line) => lines.push(line),
  });

  // In slug order, whatever order `only` names them in.
  const first = countBefore + 1n;
  expect(posted).toEqual([
    { slug: "invoice-extract", taskId: first },
    { slug: "near-account-regex", taskId: first + 1n },
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

test("all_ten_seeds_are_posted_by_an_account_that_opens_with_the_storage_for_eight", async () => {
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
    log: (line) => lines.push(line),
  });

  // The 0.1 NEAR that the account opened with pays for about eight tasks. The script topped it up
  // first, then the vault, and then every task was posted: none ran out of storage.
  expect(lines[0]).toMatch(/^DEPOSITED 0\.\d+ NEAR for storage$/);
  expect(lines[1]).toBe("DEPOSITED 7.00 tUSDC");
  expect(lines.slice(2)).toEqual(posted.map(({ slug, taskId }) => `SEEDED ${slug} task=${taskId}`));
  expect(posted).toHaveLength(10);
  expect(posted.map(({ slug }) => slug)).toEqual([...posted.map(({ slug }) => slug)].sort());
  expect(posted.map(({ taskId }) => taskId)).toEqual(
    Array.from({ length: 10 }, (_, i) => countBefore + 1n + BigInt(i)),
  );
  for (const { slug, taskId } of posted) {
    await expectPosted(taskId, slug, { poster: alice.accountId }, blobs);
  }
  expect(heldouts).toHaveLength(10);
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
    only: ["semver-regex", "iso-date-regex"],
    log: (line) => lines.push(line),
  });

  // iso-date-regex pays 1.50 and semver-regex 1.00: only the first is paid for and posted.
  expect(posted).toEqual([{ slug: "iso-date-regex", taskId: countBefore + 1n }]);
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

test("a_poster_whose_wallet_cannot_cover_the_rewards_posts_nothing_and_is_told_what_is_missing", async () => {
  // The keeper opens with storage and no tokens at all.
  const keeper = chain.accounts.keeper;
  const client = clientOf("keeper");
  const { api, blobs, heldouts } = recordingApi();
  const countBefore = await reader.taskCount();

  const failure = await seed({
    client,
    api,
    network: chain.network,
    poster: keeper.accountId,
    judgeAccount: chain.accounts.judge.accountId,
    tokenId: chain.tokenId,
    only: ["near-account-regex"],
    log: () => {},
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect((failure as Error).message).toBe(
    `the vault of ${keeper.accountId} holds 0.00 tUSDC and the seeds need 1.00 tUSDC; ` +
      `its wallet holds 0.00 tUSDC of ${chain.tokenId}, so 1.00 tUSDC more is missing`,
  );
  expect(await reader.taskCount()).toBe(countBefore);
  expect(blobs).toEqual([]);
  expect(heldouts).toEqual([]);
});
