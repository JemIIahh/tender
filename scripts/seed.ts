import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ApiClient, type Signer, TenderClient, TenderError } from "@tender/client";
import {
  AccountIdSchema,
  BriefSchema,
  canonicalJson,
  formatTokenAmount,
  HeldoutSchema,
  heldoutMatchesCriteria,
  NETWORKS,
  type NetworkId,
  PublicCriteriaSchema,
  parseTokenAmount,
  sha256Hex,
  storageShortfall,
  type TenderApi,
  tokenMeta,
} from "@tender/shared";
import { type Deployment, parseKey, readDeployment, UsageError } from "./deploy";
import { loadEnv, REPO_ROOT } from "./lib/env";

/**
 * The seed script. It posts the seed tasks under `seeds/<slug>/`, in slug order, as the poster. A
 * seed is four files: `task.json` (the reward, token, windows, winners and verifier), `brief.json`,
 * `criteria.json` and, when the criteria have a held-out part, `heldout.json`. For each seed it
 * uploads the brief and the criteria as canonical JSON, stores the held-out checks with the API
 * (which serves them to nobody until the task is judged), and posts the task with its hashes. It
 * prints one line as each seed is dealt with, and as the poster is topped up:
 *
 *   DEPOSITED <amount> NEAR for storage     the storage balance was short, and the poster added to it
 *   DEPOSITED <amount> <symbol>             the vault was short, and the poster put in the difference
 *   SKIP <slug> (held-out already public)   the seed was judged and its checks are out: not posted
 *   SEEDED <slug> task=<id>                 the seed is posted
 *   FAILED <slug>                           the run stopped at this seed; the ones before it are posted
 *
 * Held-out checks are single-use (P05-P12). A task's checks are published in its scorecard when it
 * is judged, so a seed whose commitment the API serves already is skipped, and never posted again.
 * Only that case is known: a seed that was posted and is still open looks the same as one never
 * posted, so after a run that stopped half way, run again with `--only` and the slugs left.
 *
 * What the poster pays. A task's reward moves from the poster's vault into escrow, and the contract
 * refuses a task the vault cannot pay for. Each task is also recorded on the contract, and the
 * poster's storage balance pays for its bytes. So before it uploads anything, the script works out
 * what the seeds it is about to post cost, and tops up what the poster lacks: NEAR for the storage
 * balance, and the rewards, token by token, from the poster's wallet into its vault (one deposit
 * for each). If the wallet cannot cover the rewards, it stops and says how much is missing. It
 * deposits and does not just fail because a fresh deploy and a fresh local chain both start with
 * an empty vault and a storage balance of 0.1 NEAR, which pays for eight tasks and not for ten,
 * and nothing else in the repository deposits for the owner. A deposit stays the poster's: the
 * vault and the storage balance pay it out again on request.
 *
 * Everything that can be wrong with the files is found before the API or the chain is asked
 * anything: a seed that does not read, or does not fit its schemas, stops the run with nothing
 * posted.
 *
 *   pnpm seed --network testnet [--only <slug>[,<slug>...]]
 */

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The four windows of a task, in seconds, under the names `task.json` gives them. */
export interface SeedWindows {
  commit_secs: number;
  reveal_secs: number;
  pick_secs: number;
  fallback_secs: number;
}

/**
 * What `seed` needs of a `TenderClient` (X-12): the account it signs as, the post, the poster's
 * balance in the vault and in its wallet, the deposit that tops the vault up, and the storage
 * balance and deposit that pay for the tasks' records. Tests pass a fake with these members.
 */
export type SeedChain = Pick<
  TenderClient,
  | "accountId"
  | "postTask"
  | "balanceOf"
  | "ftBalanceOf"
  | "deposit"
  | "storageBalanceOf"
  | "storageDeposit"
>;

export interface SeedOptions {
  /** Signs as the poster, with a full-access key: a post and a deposit each attach 1 yoctoNEAR. */
  client: SeedChain;
  /** Signed in as the poster. */
  api: TenderApi;
  network: NetworkId;
  /** The posting account: a seed whose verifier is `"poster"` resolves to it. */
  poster: string;
  /** A seed whose verifier is `"judge"` resolves to this account. */
  judgeAccount: string;
  /**
   * Overrides the token mapping: every seed pays in this token, whichever of `"usdc"` and
   * `"tusdc"` its `task.json` names. Without it, `"usdc"` is the network's USDC and `"tusdc"` is
   * the test token of `deployments/<network>.json`. A local chain, which has no record, passes its
   * own token.
   */
  tokenId?: string;
  /** Where the seeds are. The repository's `seeds/` by default. */
  seedsDir?: string;
  /** Post only these seeds, by slug. A slug that is no seed is an error. */
  only?: readonly string[];
  /** Replaces the windows of every seed, for a demo or a test that cannot wait a whole phase. */
  windows?: SeedWindows;
  /** Receives each line the script prints. Defaults to `console.log`. */
  log?: (line: string) => void;
  /** Where `deployments/` is. The repository root by default. */
  dir?: string;
}

/** A seed that was posted, and the task it became. */
export interface SeededTask {
  slug: string;
  taskId: bigint;
}

// ---- The files of a seed ------------------------------------------------------------------------

/** The terms of a seed, as its `task.json` writes them. */
interface SeedTerms {
  /** In the token's units, as text: `"0.25"`. */
  reward: string;
  token: "usdc" | "tusdc";
  windows: SeedWindows;
  maxWinners: number;
  verifier: "judge" | "poster";
}

/** The keys of a `task.json`, and no others. */
const TERMS_KEYS = [
  "commit_secs",
  "fallback_secs",
  "max_winners",
  "pick_secs",
  "reveal_secs",
  "reward",
  "token",
  "verifier",
];

/** Whether `value` is a whole number above 0. */
const isCount = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) > 0;

/**
 * The terms in a seed's `task.json`. A key that is not one of the eight fails, since a misspelt
 * `commit_sec` would otherwise be an absent one. `where` names the file in the errors.
 */
function parseTerms(json: unknown, where: string): SeedTerms {
  const bad = (what: string) => new Error(`${where} is not a seed's terms: ${what}`);
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw bad("it is not an object");
  }
  const terms = json as Record<string, unknown>;
  const extra = Object.keys(terms).filter((key) => !TERMS_KEYS.includes(key));
  if (extra.length > 0) {
    throw bad(
      `${extra.map((key) => JSON.stringify(key)).join(", ")} is none of ${TERMS_KEYS.join(", ")}`,
    );
  }
  const { reward, token, verifier, max_winners: maxWinners } = terms;
  if (typeof reward !== "string") throw bad('reward must be text in token units, such as "0.25"');
  if (token !== "usdc" && token !== "tusdc") throw bad('token must be "usdc" or "tusdc"');
  if (verifier !== "judge" && verifier !== "poster") {
    throw bad('verifier must be "judge" or "poster"');
  }
  if (!isCount(maxWinners)) throw bad("max_winners must be a whole number above 0");
  const seconds = (key: keyof SeedWindows): number => {
    const secs = terms[key];
    if (!isCount(secs)) throw bad(`${key} must be a whole number of seconds above 0`);
    return secs;
  };
  return {
    reward,
    token,
    verifier,
    maxWinners,
    windows: {
      commit_secs: seconds("commit_secs"),
      reveal_secs: seconds("reveal_secs"),
      pick_secs: seconds("pick_secs"),
      fallback_secs: seconds("fallback_secs"),
    },
  };
}

/** A document as it goes up: its canonical bytes, and the SHA-256 of them that goes on chain. */
interface Doc {
  bytes: Uint8Array;
  hash: string;
}

function docOf(value: unknown, where: string): Doc {
  let bytes: Uint8Array;
  try {
    bytes = canonicalJson(value);
  } catch (error) {
    throw new Error(`${where} cannot be written as canonical JSON: ${messageOf(error)}`, {
      cause: error,
    });
  }
  return { bytes, hash: sha256Hex(bytes) };
}

/** The schema of `@tender/shared` that reads a document, as far as this script uses it. */
interface Schema<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] };
      };
}

/** `json` as `schema` reads it, or an error that names the file and the first thing wrong. */
function parsed<T>(schema: Schema<T>, json: unknown, where: string): T {
  const result = schema.safeParse(json);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const fault =
    issue === undefined
      ? "the document"
      : `${issue.path.map(String).join(".") || "the document"}: ${issue.message}`;
  throw new Error(`${where} does not fit its schema, first at ${fault}`);
}

/** The JSON in `dir/name`, in an object because the JSON itself can be `null`. Null: no such file. */
async function readJson(
  dir: string,
  name: string,
  where: string,
): Promise<{ json: unknown } | null> {
  let text: string;
  try {
    text = await readFile(join(dir, name), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return { json: JSON.parse(text) };
  } catch {
    throw new Error(`${where} is not valid JSON`);
  }
}

/** The JSON in `dir/name`, which has to be there. */
async function requireJson(dir: string, slug: string, name: string): Promise<unknown> {
  const found = await readJson(dir, name, `${slug}/${name}`);
  if (found === null) throw new Error(`${slug}/${name} does not exist`);
  return found.json;
}

/** A seed, read and checked: its documents as they go up, and its terms made exact. */
interface Prepared {
  slug: string;
  brief: Doc;
  criteria: Doc;
  /** Absent when the criteria have no held-out part. */
  heldout?: Doc;
  token: string;
  /** In the token's smallest unit. */
  reward: bigint;
  verifier: string;
  windows: SeedWindows;
  maxWinners: number;
}

/** The seeds to post: every folder of `seedsDir` in slug order, or those of `only`. */
async function chooseSlugs(
  seedsDir: string,
  only: readonly string[] | undefined,
): Promise<string[]> {
  const all = (await readdir(seedsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (only === undefined) return all;
  const unknown = only.filter((slug) => !all.includes(slug));
  if (unknown.length > 0) {
    throw new Error(`no such seed: ${unknown.join(", ")} (the seeds are ${all.join(", ")})`);
  }
  return all.filter((slug) => only.includes(slug));
}

/**
 * The token a seed pays in. `tokenId` decides it when given. Otherwise `"usdc"` is Circle's USDC
 * on the network, which the sandbox lacks, and `"tusdc"` is the test token that the deploy made
 * and `deployments/<network>.json` names.
 */
async function tokenOf(
  kind: SeedTerms["token"],
  slug: string,
  o: SeedOptions,
  deployed: () => Promise<Deployment | null>,
): Promise<string> {
  if (o.tokenId !== undefined) return o.tokenId;
  if (kind === "usdc") {
    const { usdc } = NETWORKS[o.network];
    if (usdc === undefined) {
      throw new Error(`${slug} pays in "usdc", and there is none on ${o.network}: pass tokenId`);
    }
    return usdc;
  }
  const deployment = await deployed();
  if (deployment === null) {
    throw new Error(
      `${slug} pays in "tusdc", and deployments/${o.network}.json does not exist: deploy first, or pass tokenId`,
    );
  }
  return deployment.tokens.tusdc;
}

/**
 * `reward`, a decimal in `token`'s units, in its smallest unit, exactly: the digits are read as
 * text, never as a float. `tokenMeta` does not guess the decimals of a token it does not know (it
 * answers with the account id for a symbol and 0 decimals), and a reward of "1.00" in no decimals
 * is not an amount, so such a token is refused.
 */
function rewardOf(reward: string, token: string, network: NetworkId, slug: string): bigint {
  const meta = tokenMeta(token, network);
  if (meta.symbol === token) {
    throw new Error(
      `${slug}: cannot turn its reward into units, since the decimals of ${token} are unknown on ${network}`,
    );
  }
  try {
    return parseTokenAmount(reward, meta.decimals);
  } catch (error) {
    throw new Error(
      `${slug}: its reward ${JSON.stringify(reward)} is no amount of ${meta.symbol}: ${messageOf(error)}`,
      {
        cause: error,
      },
    );
  }
}

/** Reads and checks one seed. Nothing here touches the API or the chain. */
async function prepare(
  o: SeedOptions,
  seedsDir: string,
  slug: string,
  deployed: () => Promise<Deployment | null>,
): Promise<Prepared> {
  const dir = join(seedsDir, slug);
  const terms = parseTerms(await requireJson(dir, slug, "task.json"), `${slug}/task.json`);
  const brief = parsed(
    BriefSchema,
    await requireJson(dir, slug, "brief.json"),
    `${slug}/brief.json`,
  );
  const criteria = parsed(
    PublicCriteriaSchema,
    await requireJson(dir, slug, "criteria.json"),
    `${slug}/criteria.json`,
  );

  // The criteria say whether a held-out part stands behind them, and the folder has to agree: a
  // task whose checks are missing cannot be judged, and checks nobody posts are no secret kept.
  const heldoutFile = await readJson(dir, "heldout.json", `${slug}/heldout.json`);
  let heldout: Doc | undefined;
  if (criteria.has_heldout) {
    if (heldoutFile === null) {
      throw new Error(
        `${slug}/criteria.json has a held-out part, and ${slug}/heldout.json does not exist`,
      );
    }
    const checks = parsed(HeldoutSchema, heldoutFile.json, `${slug}/heldout.json`);
    if (!heldoutMatchesCriteria(criteria, checks)) {
      throw new Error(`${slug}/heldout.json is not a held-out document of kind ${criteria.kind}`);
    }
    heldout = docOf(checks, `${slug}/heldout.json`);
  } else if (heldoutFile !== null) {
    throw new Error(`${slug}/heldout.json exists, and ${slug}/criteria.json has no held-out part`);
  }

  const token = await tokenOf(terms.token, slug, o, deployed);
  return {
    slug,
    brief: docOf(brief, `${slug}/brief.json`),
    criteria: docOf(criteria, `${slug}/criteria.json`),
    heldout,
    token,
    reward: rewardOf(terms.reward, token, o.network, slug),
    verifier: terms.verifier === "judge" ? o.judgeAccount : o.poster,
    windows: o.windows ?? terms.windows,
    maxWinners: terms.maxWinners,
  };
}

// ---- Posting ------------------------------------------------------------------------------------

/** `amount` of `token` for a message: `7.00 tUSDC`. */
function show(amount: bigint, token: string, network: NetworkId): string {
  const { symbol, decimals } = tokenMeta(token, network);
  return `${formatTokenAmount(amount, decimals)} ${symbol}`;
}

/**
 * What posting a task charges the poster's storage balance, at most, in bytes (`post_task`): 787
 * for the task record, with the longest account ids and URI that the contract takes (40 bytes of
 * overhead, a 9-byte key and a 738-byte value), and the 800 it reserves for the task's outcome.
 * Seeds are posted open to anyone, so the record has no invited accounts.
 */
const TASK_STORAGE_BYTES = 1_600n;

/** What the poster's vault slot for a token charges, at most, the first time a deposit makes it. */
const VAULT_SLOT_BYTES = 200n;

/** NEAR is counted in yoctoNEAR: 10^24 of them make one. */
const NEAR_DECIMALS = 24;

/**
 * Makes sure the poster's storage balance with Tender covers the `tasks` that are to be posted and
 * the vault slots of `tokens` tokens, and deposits the difference in NEAR where it does not. The
 * 0.1 NEAR that a fresh account opens with pays for eight tasks, not for ten, and a task that
 * runs out of storage fails with `E_STORAGE` after the ones before it are posted. The estimate is
 * the most the contract can charge, so the deposit may be a little more than it takes: what stays
 * unused can be withdrawn.
 */
async function fundStorage(
  o: SeedOptions,
  tasks: number,
  tokens: number,
  log: (line: string) => void,
): Promise<void> {
  const bytes = BigInt(tasks) * TASK_STORAGE_BYTES + BigInt(tokens) * VAULT_SLOT_BYTES;
  const short = storageShortfall(await o.client.storageBalanceOf(o.poster), bytes);
  if (short === 0n) return;
  await o.client.storageDeposit(short);
  log(`DEPOSITED ${formatTokenAmount(short, NEAR_DECIMALS)} NEAR for storage`);
}

/**
 * Makes sure the poster's vault holds the sum of the rewards that are to be posted, in each token,
 * and deposits the difference from the poster's wallet where it does not. It throws, with the
 * amount that is missing, when the wallet cannot cover the difference, and when the deposit does
 * not come out the way it should.
 */
async function fundVault(
  o: SeedOptions,
  needs: ReadonlyMap<string, bigint>,
  log: (line: string) => void,
): Promise<void> {
  for (const [token, needed] of needs) {
    const held = await o.client.balanceOf(o.poster, token);
    if (held >= needed) continue;
    const short = needed - held;
    const wallet = await o.client.ftBalanceOf(token, o.poster);
    if (wallet < short) {
      throw new Error(
        `the vault of ${o.poster} holds ${show(held, token, o.network)} and the seeds need ${show(needed, token, o.network)}; ` +
          `its wallet holds ${show(wallet, token, o.network)} of ${token}, so ${show(short - wallet, token, o.network)} more is missing`,
      );
    }
    const { events } = await o.client.deposit(token, short);
    // A deposit that Tender refuses is handed back and does not fail, so only the event shows it.
    const taken = events.find((e) => e.event === "deposit");
    if (taken?.event !== "deposit" || taken.data.amount !== short.toString()) {
      throw new Error(
        `Tender did not take the deposit of ${show(short, token, o.network)} from ${o.poster}; ` +
          `is the poster registered with Tender, and is ${token} on its list of tokens?`,
      );
    }
    log(`DEPOSITED ${show(short, token, o.network)}`);
  }
}

/** Uploads a brief or criteria document and gives the URI it is served at. */
async function upload(
  api: TenderApi,
  kind: "brief" | "criteria",
  slug: string,
  doc: Doc,
): Promise<string> {
  const stored = await api.uploadBlob({ kind, contentType: "application/json", bytes: doc.bytes });
  // The task is pinned to the hash on chain: a blob stored under another one could not be judged.
  if (stored.sha256 !== doc.hash) {
    throw new Error(
      `the API stored the ${kind} of ${slug} as ${stored.sha256}, and not as ${doc.hash}`,
    );
  }
  return stored.uri;
}

/** Uploads a seed's documents and posts its task. Gives the task's id. */
async function post(o: SeedOptions, seed: Prepared): Promise<bigint> {
  const briefUri = await upload(o.api, "brief", seed.slug, seed.brief);
  await upload(o.api, "criteria", seed.slug, seed.criteria);
  if (seed.heldout !== undefined) await o.api.uploadHeldout(seed.heldout.hash, seed.heldout.bytes);
  const { taskId } = await o.client.postTask({
    token: seed.token,
    reward: seed.reward,
    briefUri,
    briefHash: seed.brief.hash,
    criteriaHash: seed.criteria.hash,
    heldoutCommitment: seed.heldout?.hash,
    verifier: seed.verifier,
    commitSecs: seed.windows.commit_secs,
    revealSecs: seed.windows.reveal_secs,
    pickSecs: seed.windows.pick_secs,
    fallbackSecs: seed.windows.fallback_secs,
    maxWinners: seed.maxWinners,
  });
  return taskId;
}

/**
 * Posts the seeds of `seedsDir` (or those of `only`), in slug order, and gives the ones it posted
 * with the ids of their tasks. A seed that is skipped is not among them. See the top of this file
 * for what each seed goes through, what the script prints, and how the vault is funded.
 *
 * Throws, naming the seed, if its files are wrong; if the poster's wallet cannot cover the rewards
 * the vault lacks; and with the API's or the chain's own error if either refuses a step. The seeds
 * posted before a failure stay posted.
 */
export async function seed(o: SeedOptions): Promise<SeededTask[]> {
  const log = o.log ?? console.log;
  // The vault, the post and the "poster" verifier must all be this one account's.
  if (o.client.accountId !== o.poster) {
    const signs = o.client.accountId === undefined ? "has no signer" : "signs as another account";
    throw new Error(`the client ${signs}, but it has to sign as the poster ${o.poster}`);
  }
  const seedsDir = o.seedsDir ?? join(REPO_ROOT, "seeds");
  const slugs = await chooseSlugs(seedsDir, o.only);

  let deployment: Promise<Deployment | null> | undefined;
  const deployed = () => {
    deployment ??= readDeployment(o.network, o.dir);
    return deployment;
  };
  const seeds: Prepared[] = [];
  for (const slug of slugs) seeds.push(await prepare(o, seedsDir, slug, deployed));

  // P05-P12: a task's held-out checks are single-use. Once the API serves them the task was
  // judged, and posting the seed again would ship its answers, so it is not posted. An API that
  // fails to answer is no answer: it stops the run, since "not public" is not what it said.
  const judged = new Set<string>();
  for (const { slug, heldout } of seeds) {
    if (heldout !== undefined && (await o.api.getBlob(heldout.hash)) !== null) judged.add(slug);
  }
  const toPost = seeds.filter(({ slug }) => !judged.has(slug));

  // The poster pays for what it posts: NEAR for the storage, then tokens for the rewards. The
  // storage comes first, since a vault slot is paid for out of it too.
  const needs = new Map<string, bigint>();
  for (const { token, reward } of toPost) needs.set(token, (needs.get(token) ?? 0n) + reward);
  if (toPost.length > 0) {
    await fundStorage(o, toPost.length, needs.size, log);
    await fundVault(o, needs, log);
  }

  const posted: SeededTask[] = [];
  for (const prepared of seeds) {
    const { slug } = prepared;
    if (judged.has(slug)) {
      log(`SKIP ${slug} (held-out already public)`);
      continue;
    }
    let taskId: bigint;
    try {
      taskId = await post(o, prepared);
    } catch (error) {
      log(`FAILED ${slug}`);
      throw error;
    }
    log(`SEEDED ${slug} task=${taskId}`);
    posted.push({ slug, taskId });
  }
  return posted;
}

// ---- The command line ---------------------------------------------------------------------------

const USAGE = "usage: pnpm seed --network testnet [--only <slug>[,<slug>...]]";

const MAINNET_REFUSED =
  "mainnet is not seeded by this script: plan 07 owns the mainnet launch, which needs the owner's approval";

/**
 * What is said when a variable does not hold an account id. The value is never in it: it may be a
 * private key that landed in the wrong variable, and what is printed ends up in logs.
 */
const notAccountId = (variable: string) =>
  `${variable} is not a valid NEAR account id (its value is not shown, since a private key may have been put there)`;

/** What the seed script runs against, from the env files. */
export interface SeedTarget {
  network: NetworkId;
  /** Tender's account. */
  contractId: string;
  /** The poster, with the full-access key that the deploy made for it (P02-R27). */
  poster: Signer;
  judgeAccount: string;
  /** Where the Tender API is served. */
  apiUrl: string;
}

/** The variables of `.env` and `.env.deploy.testnet` that a seed run needs. */
const REQUIRED = [
  "TENDER_CONTRACT",
  "TENDER_API_URL",
  "POSTER_ACCOUNT",
  "POSTER_FULL_ACCESS_KEY",
  "JUDGE_ACCOUNT",
] as const;

/**
 * The target for `network` from the command line: for testnet, the contract, the API's URL, the
 * poster and its key, and the Judge's account, from `.env` and `.env.deploy.testnet` of `dir`.
 * Throws a `UsageError` for every other network, and an `Error` that names the variable (and
 * never shows its value) for one that is missing or is not what it should be. It reads no more
 * than those two files and uses no network.
 */
export function loadTarget(
  network: string | undefined,
  options: { dir?: string } = {},
): SeedTarget {
  if (network === undefined) throw new UsageError(USAGE);
  if (network === "mainnet") throw new UsageError(MAINNET_REFUSED);
  if (network === "sandbox") {
    throw new UsageError(
      "the sandbox is seeded by tests and the local demo, which start the chain and call seed(); " +
        `the command line seeds testnet.\n${USAGE}`,
    );
  }
  if (network !== "testnet") {
    throw new UsageError(`unknown network ${JSON.stringify(network)}\n${USAGE}`);
  }
  const env = loadEnv("testnet", { dir: options.dir, required: REQUIRED });
  const accountOf = (variable: "TENDER_CONTRACT" | "POSTER_ACCOUNT" | "JUDGE_ACCOUNT") => {
    const id = env[variable].trim();
    if (!AccountIdSchema.safeParse(id).success) throw new UsageError(notAccountId(variable));
    return id;
  };
  const poster: Signer = {
    accountId: accountOf("POSTER_ACCOUNT"),
    privateKey: parseKey(env.POSTER_FULL_ACCESS_KEY.trim(), "POSTER_FULL_ACCESS_KEY").toString(),
  };
  return {
    network: "testnet",
    contractId: accountOf("TENDER_CONTRACT"),
    poster,
    judgeAccount: accountOf("JUDGE_ACCOUNT"),
    apiUrl: env.TENDER_API_URL.trim(),
  };
}

/** What the command line prints on a failure: the code and the transaction of a `TenderError`. */
export function describeFailure(error: unknown): string {
  if (error instanceof TenderError) {
    const tx = error.txHash === undefined ? "" : `\ntransaction ${error.txHash}`;
    return `seed failed with ${error.code}\n${error.message}${tx}`;
  }
  return `seed failed: ${messageOf(error)}`;
}

export interface CliOptions {
  /** Where the env files and `deployments/` are. The repository root by default. */
  dir?: string;
  /** Receives the script's lines. Defaults to `console.log`. */
  out?: (line: string) => void;
  /** Receives what is said about a failure. Defaults to `console.error`. */
  err?: (text: string) => void;
  /** The function to run; the real one by default. */
  seed?: typeof seed;
}

/** The slugs of the `--only` flags, each of which may list several, comma separated. */
function slugsOf(flags: readonly string[]): string[] {
  return flags
    .flatMap((flag) => flag.split(","))
    .map((slug) => slug.trim())
    .filter((slug) => slug !== "");
}

/** Runs the command line and returns the exit code: 0 after the seeds are dealt with, else 1. */
export async function main(args: readonly string[], options: CliOptions = {}): Promise<number> {
  const out = options.out ?? console.log;
  const err = options.err ?? console.error;
  try {
    let values: { network?: string; only?: string[] };
    try {
      values = parseArgs({
        args: [...args],
        options: { network: { type: "string" }, only: { type: "string", multiple: true } },
      }).values;
    } catch (error) {
      throw new UsageError(`${messageOf(error)}\n${USAGE}`);
    }
    const only = values.only === undefined ? undefined : slugsOf(values.only);
    if (only?.length === 0) throw new UsageError(`--only needs at least one seed slug\n${USAGE}`);
    const target = loadTarget(values.network, options);

    const client = new TenderClient({
      network: target.network,
      contractId: target.contractId,
      signer: target.poster,
    });
    let api: ApiClient;
    try {
      api = new ApiClient({ baseUrl: target.apiUrl, signer: target.poster });
    } catch (error) {
      // The client's own messages name what is wrong with a URL and never quote it.
      throw new UsageError(`TENDER_API_URL cannot be used: ${messageOf(error)}`);
    }
    await (options.seed ?? seed)({
      client,
      api,
      network: target.network,
      poster: target.poster.accountId,
      judgeAccount: target.judgeAccount,
      only,
      log: out,
      dir: options.dir,
    });
    return 0;
  } catch (error) {
    err(error instanceof UsageError ? error.message : describeFailure(error));
    return 1;
  }
}

// Only when run as the script, never when a test or another script imports from here.
if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
