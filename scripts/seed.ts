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
  type ListTasksResponse,
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
import { PRIVATE_DIR_VARIABLE, privateDirOf } from "./lib/private-dir";

/**
 * The seed script. It posts the seed tasks under `seeds/<slug>/`, in slug order, as the poster. A
 * seed is three public files: `task.json` (the reward, token, windows, winners and verifier),
 * `brief.json` and `criteria.json`, and, when the criteria have a held-out part, its checks in
 * `heldout.json`. The checks are secret until the task is judged, so they are not in the
 * repository: they are read from `<private dir>/<slug>/heldout.json`, where the private dir is
 * `$TENDER_SEEDS_PRIVATE_DIR`, or `seeds-private/` of the repository (git ignores it) when that is
 * not set. A seed whose criteria have a held-out part and whose file is not there stops the run
 * before anything is posted: a task is never posted without its checks. For each seed the script
 * uploads the brief and the criteria as canonical JSON, stores the held-out checks with the API
 * (which serves them to nobody until the task is judged), and posts the task with its hashes. It
 * prints one line as each seed is dealt with, and as the poster is topped up:
 *
 *   DEPOSITED <amount> NEAR for storage                storage was short; the poster added to it
 *   DEPOSITED <amount> <symbol>                        vault was short; the poster put in the rest
 *   SKIP <slug> (held-out already public)              judged, and its checks are out
 *   SKIP <slug> (held-out already used by task <id>)   a task of the poster has these checks
 *   SKIP <slug> (already posted as task <id>)          no checks; its brief is up, not settled
 *   SEEDED <slug> task=<id>                            posted
 *   FAILED <slug>                                      stopped here; earlier seeds stay posted
 *
 * Held-out checks are single-use, and the script keeps to that three ways. A task's checks are
 * published in its scorecard when it is judged (P05-P12), so a seed whose commitment the API
 * serves already is skipped, and never posted again. The Judge also refuses a task whose
 * commitment an earlier task of the same poster carries, in whatever phase that task is, settled
 * or not (it names the lowest id), so a seed whose commitment is one of the poster's tasks' is
 * skipped as well: its reward would sit in escrow for a task that no one could judge. And two
 * seeds of one run with the same checks are refused before anything happens, since the second
 * could not be judged.
 *
 * A salt is single-use too. A scorecard publishes the checks with their salt, and new checks under
 * a salt that is public are as guessable from their commitment as checks with no salt. So a seed
 * about to be posted whose salt a scorecard of one of the poster's tasks has published already
 * stops the run before anything is paid, and the message says how to draw a new salt
 * (`scripts/salt-heldout.ts`, which draws one for checks it did not salt).
 *
 * Running the script again posts nothing twice. Before it pays or uploads anything, it asks the API
 * for the poster's tasks, page after page, and reads every one of them, since the list leaves out
 * the commitment and the brief hash, and the task has both. A settled task counts like any other,
 * for its checks are spent; one that ran out its windows and that no one has voided holds its
 * reward besides. A seed with no held-out part has no commitment to go by, and is skipped when the
 * poster has a task with its brief that has not settled. So a run that stopped half way is
 * finished by running it again. The API's index trails the chain by a block or two, and a run that
 * starts the moment another ends may not see the tasks of that one yet.
 *
 * It gives back each seed it posted ("posted") and each it left alone for a task of the poster
 * ("existing"), with the id of that task, so that the caller can find them all. A seed that was
 * skipped for public checks, and that no task of the poster carries, has no task to name, and is
 * not among them.
 *
 * What the poster pays. A task's reward moves from the poster's vault into escrow, and the contract
 * refuses a task the vault cannot pay for. Each task is also recorded on the contract, and the
 * poster's storage balance pays for its bytes. So before it uploads anything, the script works out
 * what the seeds it is about to post cost and reads what the poster holds: its storage balance,
 * and for each token its vault and its wallet. If a wallet cannot cover what its vault lacks of the
 * rewards, it stops and says how much is missing, and nothing has moved. Only then does it top up
 * what the poster lacks: NEAR for the storage balance, and the rewards, token by token, from the
 * poster's wallet into its vault (one deposit for each). The client has no call for the poster's
 * NEAR, so a poster that lacks it fails at the storage deposit, the first thing the script moves.
 * It deposits and does not just fail because a fresh deploy and a fresh local chain both start with
 * an empty vault and a storage balance of 0.1 NEAR, which pays for eight tasks and not for ten,
 * and nothing else in the repository deposits for the owner. A deposit stays the poster's: the
 * vault and the storage balance pay it out again on request.
 *
 * Where it posts. It refuses mainnet, whatever it is given: plan 07 owns that launch, which needs
 * the owner's approval. And before any money moves it asks the API which network and contract it
 * serves, and stops if they are not the client's: the tasks it would look for and the checks it
 * would store would be those of another deployment.
 *
 * Everything that can be wrong with the files is found before the API or the chain is asked
 * anything: a seed that does not read, does not fit its schemas, or shares its held-out checks
 * with another stops the run with nothing posted.
 *
 * The windows. A seed's `task.json` gives its four windows. The flags can set them for a run,
 * over every seed's own:
 *
 *   --commit-until <time>     the commit deadline, a UTC time written as 2026-11-18T16:00:00Z. Each
 *                             seed's commit_secs is the time from just before its post_task to then,
 *                             rounded up to the second. The chain counts the window from the block
 *                             that runs the post, so the deadline on chain is that time or a few
 *                             seconds after it, as long as this machine's clock agrees with the chain's
 *   --reveal-secs <n>         the reveal window of every seed, in seconds
 *   --pick-secs <n>           the pick window
 *   --fallback-secs <n>       the fallback window
 *
 * Each window a flag sets has to be one the contract takes: from its min_window_secs (read from
 * get_config) to its max_window_secs, which is MAX_WINDOW_SECS, 1,209,600 seconds (14 days). So a
 * commit deadline is at most 14 days away. A time or a number of seconds that does not read stops
 * the command line before it reads anything. A commit deadline that has passed, and a window the
 * contract would refuse, stop the run once the files are read, before anything is paid or
 * uploaded. Without the flags the windows are the seeds' own, and the chain is not asked for its
 * config.
 *
 *   pnpm seed --network testnet [--only <slug>[,<slug>...]] [--commit-until <time>]
 *     [--reveal-secs <n>] [--pick-secs <n>] [--fallback-secs <n>]
 */

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The four windows of a task, in seconds, under the names `task.json` gives them. */
export interface SeedWindows {
  commit_secs: number;
  reveal_secs: number;
  pick_secs: number;
  fallback_secs: number;
}

/** The windows the flags `--reveal-secs`, `--pick-secs` and `--fallback-secs` set, in seconds. */
export type WindowSecs = Partial<Pick<SeedWindows, "reveal_secs" | "pick_secs" | "fallback_secs">>;

/**
 * What `seed` needs of a `TenderClient` (X-12): the network and contract it is for, the account it
 * signs as, the post, the poster's balance in the vault and in its wallet, the deposit that tops
 * the vault up, the storage balance and deposit that pay for the tasks' records, and the config,
 * whose window limits are read when the run sets windows of its own. Tests pass a fake with these
 * members.
 */
export type SeedChain = Pick<
  TenderClient,
  | "network"
  | "contractId"
  | "accountId"
  | "postTask"
  | "balanceOf"
  | "ftBalanceOf"
  | "deposit"
  | "storageBalanceOf"
  | "storageDeposit"
  | "getConfig"
>;

export interface SeedOptions {
  /** Signs as the poster, with a full-access key: a post and a deposit each attach 1 yoctoNEAR. */
  client: SeedChain;
  /**
   * Signed in as the poster, since the uploads are the poster's. Asked which network and contract
   * it serves, which held-out checks are public and which tasks the poster has, and given the
   * uploads. It has to be the API of the client's deployment.
   */
  api: TenderApi;
  /** Never `"mainnet"`: see the top of this file. */
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
  /**
   * Where the held-out checks are: `<heldoutDir>/<slug>/heldout.json` for each seed that has a
   * held-out part. `$TENDER_SEEDS_PRIVATE_DIR` by default, else the repository's `seeds-private/`.
   * Never `seedsDir`: the seeds' own folders are public.
   */
  heldoutDir?: string;
  /** Post only these seeds, by slug. A slug that is no seed is an error. */
  only?: readonly string[];
  /** Replaces the windows of every seed, for a demo or a test that cannot wait a whole phase. */
  windows?: SeedWindows;
  /**
   * The commit deadline of every seed the run posts, in milliseconds since the epoch
   * (`--commit-until`). Each seed's `commit_secs` is worked out just before its `post_task`: the
   * time from then to this, rounded up to the second (`commitSecsUntil`). It wins over the
   * `commit_secs` of `windows` and of the seed's `task.json`.
   */
  commitUntil?: number;
  /** Replaces these windows of every seed (`--reveal-secs` and the rest), over `windows`. */
  windowSecs?: WindowSecs;
  /** The clock `commitUntil` is counted from, in milliseconds since the epoch. `Date.now` by default. */
  now?: () => number;
  /** Receives each line the script prints. Defaults to `console.log`. */
  log?: (line: string) => void;
  /** Where `deployments/` is. The repository root by default, or what `TENDER_ENV_DIR` names. */
  dir?: string;
}

/**
 * A seed and the task that stands for it: one this run `"posted"`, or one the poster `"existing"`
 * had already, whose seed the run left alone.
 */
export interface SeededTask {
  slug: string;
  taskId: bigint;
  status: "posted" | "existing";
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

/** Whether `json` is an object with a `salt` key, as a held-out document needs (`HeldoutSchema`). */
function hasSalt(json: unknown): boolean {
  return typeof json === "object" && json !== null && Object.hasOwn(json, "salt");
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
    // ENOTDIR: a part of the path is a file, as when the private directory is named by a file.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
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
  /** The salt of `heldout`, when there is one. */
  heldoutSalt?: string;
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
  heldoutDir: string,
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

  // The criteria say whether a held-out part stands behind them, and the private directory has to
  // agree: a task whose checks are missing cannot be judged, and checks nobody posts are no secret
  // kept. The checks are in the private directory and never in the seed's own (public) folder.
  const heldoutFile = await readJson(
    join(heldoutDir, slug),
    "heldout.json",
    `${slug}/heldout.json`,
  );
  let heldout: Doc | undefined;
  let heldoutSalt: string | undefined;
  if (criteria.has_heldout) {
    if (heldoutFile === null) {
      throw new Error(
        `held-out for ${slug} not found in ${heldoutDir}; set ${PRIVATE_DIR_VARIABLE}`,
      );
    }
    if (!hasSalt(heldoutFile.json)) {
      throw new Error(
        `${slug}/heldout.json has no salt, so its commitment could be guessed: add one with ` +
          `pnpm exec tsx scripts/salt-heldout.ts ${heldoutDir}`,
      );
    }
    const checks = parsed(HeldoutSchema, heldoutFile.json, `${slug}/heldout.json`);
    if (!heldoutMatchesCriteria(criteria, checks)) {
      throw new Error(`${slug}/heldout.json is not a held-out document of kind ${criteria.kind}`);
    }
    heldout = docOf(checks, `${slug}/heldout.json`);
    heldoutSalt = checks.salt;
  } else if (heldoutFile !== null) {
    throw new Error(
      `${slug}/heldout.json exists in ${heldoutDir}, and ${slug}/criteria.json has no held-out part`,
    );
  }

  const token = await tokenOf(terms.token, slug, o, deployed);
  return {
    slug,
    brief: docOf(brief, `${slug}/brief.json`),
    criteria: docOf(criteria, `${slug}/criteria.json`),
    heldout,
    ...(heldoutSalt !== undefined && { heldoutSalt }),
    token,
    reward: rewardOf(terms.reward, token, o.network, slug),
    verifier: terms.verifier === "judge" ? o.judgeAccount : o.poster,
    windows: withWindowSecs(o.windows ?? terms.windows, o.windowSecs),
    maxWinners: terms.maxWinners,
  };
}

// ---- Windows ------------------------------------------------------------------------------------

/** `windows` with the windows that `secs` sets in place of its own. A window `secs` leaves out stays. */
function withWindowSecs(windows: SeedWindows, secs: WindowSecs = {}): SeedWindows {
  return {
    commit_secs: windows.commit_secs,
    reveal_secs: secs.reveal_secs ?? windows.reveal_secs,
    pick_secs: secs.pick_secs ?? windows.pick_secs,
    fallback_secs: secs.fallback_secs ?? windows.fallback_secs,
  };
}

/**
 * The commit window, in whole seconds, from `at` to the deadline `until` (both in milliseconds
 * since the epoch), rounded up. The chain counts the window from the block that runs the post,
 * which comes after `at`, so the deadline it records is `until` or a few seconds after it, and not
 * before it as long as the clock that gave `at` agrees with the chain's.
 */
export function commitSecsUntil(until: number, at: number): number {
  return Math.ceil((until - at) / 1000);
}

/** A time in milliseconds since the epoch as `--commit-until` writes it: `2026-11-18T16:00:00Z`. */
function utcOf(ms: number): string {
  return new Date(ms).toISOString().replace(/\.000Z$/, "Z");
}

/** A UTC time to the second, as `--commit-until` takes it. */
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * The time `text` names, in milliseconds since the epoch, or undefined unless it is a UTC time
 * written as `YYYY-MM-DDTHH:MM:SSZ` that exists. `Date.parse` takes many forms, reads one with no
 * zone as local time, and rolls over a day or an hour that does not exist (the 30th of February
 * is the 2nd of March, the 24th hour the next day), so only that one form is let through, and only
 * when it reads back the same.
 */
export function parseUtcTime(text: string): number | undefined {
  if (!UTC_TIME.test(text)) return undefined;
  const ms = Date.parse(text);
  return Number.isFinite(ms) && utcOf(ms) === text ? ms : undefined;
}

/** What the contract takes of a window, in seconds (`get_config`): from `min` to `max`. */
interface WindowLimits {
  min: number;
  max: number;
}

/**
 * Checks the windows that the run sets, `commitUntil` and `windowSecs`, and gives what the contract
 * takes of a window. The commit deadline has to be a time that has not passed. Every window the run
 * sets, the commit window counted from now among them, has to be from the contract's
 * `min_window_secs` to its `max_window_secs` (`MAX_WINDOW_SECS` of the contract, 14 days), or the
 * post would fail with `E_WINDOW`. It throws, naming each window that is wrong, before anything is
 * paid or uploaded. It gives undefined, and asks the chain nothing, when the run sets no window: the
 * windows are then the seeds' own, as they always were.
 */
async function windowLimits(o: SeedOptions, now: () => number): Promise<WindowLimits | undefined> {
  const secs = Object.entries(o.windowSecs ?? {}).filter(
    (set): set is [string, number] => set[1] !== undefined,
  );
  if (o.commitUntil === undefined && secs.length === 0) return undefined;
  const { commitUntil } = o;
  if (commitUntil !== undefined) {
    if (!Number.isFinite(commitUntil)) {
      throw new Error("the commit deadline is not a time: give milliseconds since the epoch");
    }
    if (commitUntil <= now())
      throw new Error(`the commit deadline ${utcOf(commitUntil)} has passed`);
  }
  const wrong = secs.filter(([, value]) => !Number.isSafeInteger(value));
  if (wrong.length > 0) {
    throw new Error(wrong.map(([name]) => `${name} is not a whole number of seconds`).join("; "));
  }

  const config = await o.client.getConfig();
  const limits = { min: config.min_window_secs, max: config.max_window_secs };
  const taken = (value: number) => value >= limits.min && value <= limits.max;
  const faults: string[] = [];
  if (commitUntil !== undefined) {
    const commit = commitSecsUntil(commitUntil, now());
    if (!taken(commit)) {
      faults.push(`the commit deadline ${utcOf(commitUntil)} is ${commit} seconds away`);
    }
  }
  for (const [name, value] of secs) if (!taken(value)) faults.push(`${name} is ${value}`);
  if (faults.length > 0) {
    throw new Error(
      `${faults.join("; ")}: the contract takes a window of ${limits.min} to ${limits.max} ` +
        "seconds (its min_window_secs and max_window_secs)",
    );
  }
  return limits;
}

/**
 * The commit window of a seed that is about to be posted: its own, or, when the run has a commit
 * deadline, the time from now to it, read off `now` at this moment. Throws if that time has fallen
 * below the contract's least window since the run began: the post would fail with `E_WINDOW`, and
 * the seed is not posted.
 */
function commitSecsOf(
  o: SeedOptions,
  seed: Prepared,
  now: () => number,
  limits: WindowLimits | undefined,
): number {
  if (o.commitUntil === undefined) return seed.windows.commit_secs;
  const secs = commitSecsUntil(o.commitUntil, now());
  if (limits !== undefined && secs < limits.min) {
    throw new Error(
      `${seed.slug}: the commit deadline ${utcOf(o.commitUntil)} is ${secs} seconds away now, ` +
        `less than the contract's min_window_secs of ${limits.min}`,
    );
  }
  return secs;
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

/** What the poster has to add before the seeds can be posted. */
interface Funding {
  /** NEAR, in yoctoNEAR, for the storage balance. 0 when the balance covers the seeds. */
  storage: bigint;
  /** By token: what moves from the poster's wallet into its vault. Only the tokens it lacks. */
  deposits: Map<string, bigint>;
}

/**
 * Works out what the poster has to add for `seeds` to be posted, and moves nothing. The storage
 * balance has to cover the tasks and the vault slots of the tokens. The 0.1 NEAR that a fresh
 * account opens with pays for eight tasks, not for ten, and a task that runs out of storage fails
 * with `E_STORAGE` after the ones before it are posted. The estimate is the most the contract can
 * charge, so the deposit may be a little more than it takes: what stays unused can be withdrawn.
 * The vault has to hold the sum of the rewards, in each token, and the wallet has to cover what the
 * vault lacks. Every token is looked at before this answers, and a wallet that falls short fails
 * the run with what is missing of each, before the first deposit.
 */
async function planFunding(o: SeedOptions, seeds: readonly Prepared[]): Promise<Funding> {
  const needs = new Map<string, bigint>();
  for (const { token, reward } of seeds) needs.set(token, (needs.get(token) ?? 0n) + reward);

  const bytes = BigInt(seeds.length) * TASK_STORAGE_BYTES + BigInt(needs.size) * VAULT_SLOT_BYTES;
  const storage = storageShortfall(await o.client.storageBalanceOf(o.poster), bytes);

  const deposits = new Map<string, bigint>();
  const missing: string[] = [];
  for (const [token, needed] of needs) {
    const held = await o.client.balanceOf(o.poster, token);
    if (held >= needed) continue;
    const short = needed - held;
    const wallet = await o.client.ftBalanceOf(token, o.poster);
    if (wallet >= short) {
      deposits.set(token, short);
    } else {
      missing.push(
        `the vault of ${o.poster} holds ${show(held, token, o.network)} and the seeds need ${show(needed, token, o.network)}; ` +
          `its wallet holds ${show(wallet, token, o.network)} of ${token}, so ${show(short - wallet, token, o.network)} more is missing`,
      );
    }
  }
  if (missing.length > 0) throw new Error(missing.join("\n"));
  return { storage, deposits };
}

/**
 * Moves what `planFunding` found to be missing: the NEAR for the storage first, since a vault slot
 * is paid for out of the storage balance too, then the rewards, one deposit for each token. It
 * throws when a deposit does not come out the way it should.
 */
async function fund(o: SeedOptions, plan: Funding, log: (line: string) => void): Promise<void> {
  if (plan.storage > 0n) {
    await o.client.storageDeposit(plan.storage);
    log(`DEPOSITED ${formatTokenAmount(plan.storage, NEAR_DECIMALS)} NEAR for storage`);
  }
  for (const [token, short] of plan.deposits) {
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

/**
 * Uploads a seed's documents and posts its task. Gives the task's id. A run with a commit deadline
 * works out the seed's commit window last, after the uploads and just before the post.
 */
async function post(
  o: SeedOptions,
  seed: Prepared,
  now: () => number,
  limits: WindowLimits | undefined,
): Promise<bigint> {
  const briefUri = await upload(o.api, "brief", seed.slug, seed.brief);
  await upload(o.api, "criteria", seed.slug, seed.criteria);
  if (seed.heldout !== undefined) await o.api.uploadHeldout(seed.heldout.hash, seed.heldout.bytes);
  const commitSecs = commitSecsOf(o, seed, now, limits);
  const { taskId } = await o.client.postTask({
    token: seed.token,
    reward: seed.reward,
    briefUri,
    briefHash: seed.brief.hash,
    criteriaHash: seed.criteria.hash,
    heldoutCommitment: seed.heldout?.hash,
    verifier: seed.verifier,
    commitSecs,
    revealSecs: seed.windows.reveal_secs,
    pickSecs: seed.windows.pick_secs,
    fallbackSecs: seed.windows.fallback_secs,
    maxWinners: seed.maxWinners,
  });
  return taskId;
}

/** The most tasks the API puts in a page of its list. */
const LIST_PAGE = 50;

/** What the tasks the poster has already say about the seeds. */
interface Earlier {
  /** By held-out commitment: the oldest task of the poster that carries it, in any phase. */
  byCommitment: Map<string, bigint>;
  /** By brief hash: the oldest task of the poster that has not settled. */
  unsettledByBrief: Map<string, bigint>;
  /** By salt: the oldest task of the poster whose scorecard published held-out checks with it. */
  publishedSalts: Map<string, bigint>;
}

/**
 * The poster's tasks, read through the API: the list gives the ids, newest first and without the
 * commitment or the brief hash, so this pages through it to the end, and then reads each task,
 * oldest first, for those two. The Judge counts a task of the poster in every phase against a
 * commitment, settled ones too, so every task is read. An API that fails to answer stops the run,
 * and so does one whose list does not end or names a task it does not know: a list that could not
 * be read in full is not a list of nothing.
 */
async function tasksOf(api: TenderApi, poster: string): Promise<Earlier> {
  const ids = new Set<bigint>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: ListTasksResponse = await api.listTasks({ poster, limit: LIST_PAGE, cursor });
    for (const task of page.tasks) {
      // The API lists the poster's tasks only; the check keeps out a task that is not.
      if (task.poster === poster) ids.add(BigInt(task.id));
    }
    cursor = page.next_cursor;
    if (cursor !== null) {
      if (cursors.has(cursor)) {
        throw new Error(
          `the list of the tasks of ${poster} does not end: cursor ${cursor} came twice`,
        );
      }
      cursors.add(cursor);
    }
  } while (cursor !== null);

  const earlier: Earlier = {
    byCommitment: new Map(),
    unsettledByBrief: new Map(),
    publishedSalts: new Map(),
  };
  // The oldest first, so that it is the one that a commitment or brief posted more than once is
  // named by: the Judge names the lowest id as well.
  for (const id of [...ids].sort((a, b) => Number(a - b))) {
    const found = await api.getTask(id);
    if (found === null) {
      throw new Error(`the API lists task ${id} of ${poster}, and has no such task`);
    }
    const { heldout_commitment: commitment, brief_hash: brief, phase } = found.task;
    if (commitment !== null && !earlier.byCommitment.has(commitment)) {
      earlier.byCommitment.set(commitment, id);
    }
    if (phase !== "settled" && !earlier.unsettledByBrief.has(brief)) {
      earlier.unsettledByBrief.set(brief, id);
    }
    const salt = publishedSaltOf(found.scorecard?.heldout);
    if (salt !== undefined && !earlier.publishedSalts.has(salt)) {
      earlier.publishedSalts.set(salt, id);
    }
  }
  return earlier;
}

/** The salt of held-out checks a scorecard published, if they have one. */
function publishedSaltOf(heldout: unknown): string | undefined {
  if (typeof heldout !== "object" || heldout === null) return undefined;
  const salt = (heldout as { salt?: unknown }).salt;
  return typeof salt === "string" ? salt : undefined;
}

/**
 * Throws when a seed about to be posted carries a salt that a scorecard of the poster's has
 * published already: its checks would be guessable from their commitment, as if they had no salt.
 * A seed whose whole document was published is skipped before this (its checks are public), so
 * what is here has new checks under an old salt, as a seed rewritten after it was judged would.
 */
function refusePublishedSalts(
  seeds: readonly Prepared[],
  earlier: Earlier,
  heldoutDir: string,
): void {
  for (const { slug, heldoutSalt } of seeds) {
    const taskId = heldoutSalt === undefined ? undefined : earlier.publishedSalts.get(heldoutSalt);
    if (taskId === undefined) continue;
    throw new Error(
      `${slug}/heldout.json has the salt that the scorecard of task ${taskId} published, so its ` +
        `checks could be guessed from their commitment: give it a new salt (delete "salt" from ` +
        `the file and run pnpm exec tsx scripts/salt-heldout.ts ${heldoutDir})`,
    );
  }
}

/**
 * Throws when two seeds hold the same held-out checks. The Judge takes a poster's checks once, so
 * the second of the two tasks would sit in escrow with no one able to judge it.
 */
function refuseSharedHeldout(seeds: readonly Prepared[]): void {
  const slugsByChecks = new Map<string, string[]>();
  for (const { slug, heldout } of seeds) {
    if (heldout === undefined) continue;
    slugsByChecks.set(heldout.hash, [...(slugsByChecks.get(heldout.hash) ?? []), slug]);
  }
  for (const slugs of slugsByChecks.values()) {
    if (slugs.length > 1) {
      throw new Error(
        `${slugs.join(", ")} share their held-out checks, and the Judge takes a poster's checks once: give each seed its own`,
      );
    }
  }
}

/** The most blocks the API's index may be behind the chain for the run to go on (review M4). */
const MAX_INDEX_LAG_BLOCKS = 10n;

/**
 * Stops the run when the API is not the client's. The API says which network and contract it
 * serves, and the tasks it lists, the checks it is asked about and the uploads it takes are those
 * of that contract. Both are names, not secrets, so the message shows them. An API that fails to
 * answer stops the run too.
 *
 * It stops while the API's index is more than `MAX_INDEX_LAG_BLOCKS` blocks behind the chain
 * (review M4). The run goes by the poster's tasks as the API lists them, so a stalled index would
 * miss the latest ones, and a seed that an earlier run posted would be posted again; the Judge
 * would turn the copy away (its held-out checks are used), and its reward would sit in escrow
 * until the keeper voided it.
 */
async function checkApi(o: SeedOptions): Promise<void> {
  const served = await o.api.health();
  const { network, contractId } = o.client;
  if (served.network !== network || served.contract !== contractId) {
    throw new Error(
      `the API serves ${served.contract} on ${served.network}, but the client is set for ${contractId} on ${network}: they have to be the same deployment`,
    );
  }
  if (BigInt(served.lag_blocks) > MAX_INDEX_LAG_BLOCKS) {
    throw new Error(
      `the API's index is ${served.lag_blocks} blocks behind the chain, and its list of the poster's tasks may miss the latest ones, which would post a seed again: wait until it is at most ${MAX_INDEX_LAG_BLOCKS} behind`,
    );
  }
}

/** Why a seed is left alone, and the poster's task that stands for it, if one is known. */
interface Skip {
  reason: string;
  taskId?: bigint;
}

/**
 * Whether a seed is left alone, and why. A seed with checks goes by the commitment of its checks:
 * public already (P05-P12), or carried by a task of the poster, in any phase (the Judge's rule).
 * One without has no commitment to go by, so it goes by its brief, and a task with that brief that
 * has not settled.
 */
function skipOf(prepared: Prepared, judged: boolean, earlier: Earlier): Skip | undefined {
  const { heldout, brief } = prepared;
  const used = heldout === undefined ? undefined : earlier.byCommitment.get(heldout.hash);
  if (judged) return { reason: "held-out already public", taskId: used };
  if (used !== undefined) return { reason: `held-out already used by task ${used}`, taskId: used };
  if (heldout === undefined) {
    const up = earlier.unsettledByBrief.get(brief.hash);
    if (up !== undefined) return { reason: `already posted as task ${up}`, taskId: up };
  }
  return undefined;
}

const MAINNET_REFUSED =
  "mainnet is not seeded by this script: plan 07 owns the mainnet launch, which needs the owner's approval";

/**
 * Posts the seeds of `seedsDir` (or those of `only`), in slug order. Gives each seed it posted and
 * each it left alone for a task of the poster, in slug order, with the id of that task. See the top
 * of this file for what each seed goes through, what the script prints, and how the vault is
 * funded.
 *
 * Throws for mainnet, whether `network` or the client says it; if `network` and the client's network
 * differ; if the client does not sign as the poster; naming the seed, if its files are wrong, its
 * held-out file is not in the private directory, two seeds share their held-out checks, or a seed
 * to post carries a salt that a scorecard of the poster has published; if `commitUntil` has
 * passed, or a window that `commitUntil` or `windowSecs` sets is one the contract would refuse; if
 * the API is not the client's deployment, or its index is more than 10 blocks behind the chain; if
 * the poster's wallet cannot cover the rewards the vault lacks; if the API's list of the poster's
 * tasks cannot be read in full; and with the API's or the chain's own error if either refuses a
 * step. The seeds posted before a failure stay posted, and running the script again finishes the
 * rest.
 */
export async function seed(o: SeedOptions): Promise<SeededTask[]> {
  const log = o.log ?? console.log;
  const now = o.now ?? Date.now;
  if (o.network === "mainnet" || o.client.network === "mainnet") throw new Error(MAINNET_REFUSED);
  // The token is chosen by `network` and the API is checked against the client's: one network.
  if (o.network !== o.client.network) {
    throw new Error(
      `the seeds are for ${o.network}, but the client is set for ${o.client.network}: they have to be the same network`,
    );
  }
  // The vault, the post and the "poster" verifier must all be this one account's.
  if (o.client.accountId !== o.poster) {
    const signs = o.client.accountId === undefined ? "has no signer" : "signs as another account";
    throw new Error(`the client ${signs}, but it has to sign as the poster ${o.poster}`);
  }
  const seedsDir = o.seedsDir ?? join(REPO_ROOT, "seeds");
  const heldoutDir = o.heldoutDir ?? privateDirOf();
  const slugs = await chooseSlugs(seedsDir, o.only);

  let deployment: Promise<Deployment | null> | undefined;
  const deployed = () => {
    deployment ??= readDeployment(o.network, o.dir);
    return deployment;
  };
  const seeds: Prepared[] = [];
  for (const slug of slugs) seeds.push(await prepare(o, seedsDir, heldoutDir, slug, deployed));
  refuseSharedHeldout(seeds);
  // Nothing is asked when there is nothing to post.
  if (seeds.length === 0) return [];

  // The windows the run sets are checked against the contract's limits before the API is asked
  // anything, and so before anything is paid or uploaded.
  const limits = await windowLimits(o, now);
  await checkApi(o);

  // P05-P12: a task's held-out checks are single-use. Once the API serves them the task was
  // judged, and posting the seed again would ship its answers, so it is not posted. An API that
  // fails to answer is no answer: it stops the run, since "not public" is not what it said.
  const judged = new Set<string>();
  for (const { slug, heldout } of seeds) {
    if (heldout !== undefined && (await o.api.getBlob(heldout.hash)) !== null) judged.add(slug);
  }
  const earlier = await tasksOf(o.api, o.poster);
  const skips = new Map<string, Skip>();
  for (const prepared of seeds) {
    const skip = skipOf(prepared, judged.has(prepared.slug), earlier);
    if (skip !== undefined) skips.set(prepared.slug, skip);
  }

  // The poster pays for what it posts, and what it lacks is found out before any of it is paid.
  const toPost = seeds.filter(({ slug }) => !skips.has(slug));
  refusePublishedSalts(toPost, earlier, heldoutDir);
  if (toPost.length > 0) {
    const plan = await planFunding(o, toPost);
    await fund(o, plan, log);
  }

  const done: SeededTask[] = [];
  for (const prepared of seeds) {
    const { slug } = prepared;
    const skip = skips.get(slug);
    if (skip !== undefined) {
      log(`SKIP ${slug} (${skip.reason})`);
      if (skip.taskId !== undefined) done.push({ slug, taskId: skip.taskId, status: "existing" });
      continue;
    }
    let taskId: bigint;
    try {
      taskId = await post(o, prepared, now, limits);
    } catch (error) {
      log(`FAILED ${slug}`);
      throw error;
    }
    log(`SEEDED ${slug} task=${taskId}`);
    done.push({ slug, taskId, status: "posted" });
  }
  return done;
}

// ---- The command line ---------------------------------------------------------------------------

const USAGE =
  "usage: pnpm seed --network testnet [--only <slug>[,<slug>...]] [--commit-until <time>] " +
  "[--reveal-secs <n>] [--pick-secs <n>] [--fallback-secs <n>]";

/** The flags that set a window in seconds, and the window each sets. */
const SECS_FLAGS = {
  "reveal-secs": "reveal_secs",
  "pick-secs": "pick_secs",
  "fallback-secs": "fallback_secs",
} as const;

/**
 * The windows `--reveal-secs`, `--pick-secs` and `--fallback-secs` set, or undefined when none is
 * given. Each is a whole number of seconds above 0, written in digits. Whether the contract takes
 * it is for `seed` to find out, from the chain. Throws a `UsageError` naming the flag, without its
 * value, which can be anything that was pasted.
 */
function windowSecsOf(
  values: Partial<Record<keyof typeof SECS_FLAGS, string>>,
): WindowSecs | undefined {
  const secs: WindowSecs = {};
  for (const [flag, window] of Object.entries(SECS_FLAGS) as [
    keyof typeof SECS_FLAGS,
    keyof WindowSecs,
  ][]) {
    const text = values[flag];
    if (text === undefined) continue;
    const value = /^[0-9]+$/.test(text) ? Number(text) : Number.NaN;
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new UsageError(`--${flag} must be a whole number of seconds above 0\n${USAGE}`);
    }
    secs[window] = value;
  }
  return Object.keys(secs).length === 0 ? undefined : secs;
}

/** The time of `--commit-until`, in milliseconds since the epoch. Throws a `UsageError` without the value. */
function commitUntilOf(text: string): number {
  const ms = parseUtcTime(text);
  if (ms === undefined) {
    throw new UsageError(
      `--commit-until must be a UTC time written as YYYY-MM-DDTHH:MM:SSZ, such as 2026-11-18T16:00:00Z\n${USAGE}`,
    );
  }
  return ms;
}

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

/**
 * Where the command line looks for the held-out checks: `TENDER_SEEDS_PRIVATE_DIR` of the process,
 * else that of `.env` (or `.env.deploy.testnet`), else the repository's `seeds-private/`. The
 * process comes first so that a shell can point one run elsewhere without editing a file.
 */
function privateDirOfCli(dir: string | undefined): string {
  const fromFiles = loadEnv("testnet", { dir })[PRIVATE_DIR_VARIABLE];
  const fromProcess = process.env[PRIVATE_DIR_VARIABLE];
  return privateDirOf({
    [PRIVATE_DIR_VARIABLE]: (fromProcess ?? "").trim() === "" ? fromFiles : fromProcess,
  });
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
  /** Where the env files and `deployments/` are. The repository root by default, or what `TENDER_ENV_DIR` names. */
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
    let values: {
      network?: string;
      only?: string[];
      "commit-until"?: string;
    } & Partial<Record<keyof typeof SECS_FLAGS, string>>;
    try {
      values = parseArgs({
        args: [...args],
        options: {
          network: { type: "string" },
          only: { type: "string", multiple: true },
          "commit-until": { type: "string" },
          "reveal-secs": { type: "string" },
          "pick-secs": { type: "string" },
          "fallback-secs": { type: "string" },
        },
      }).values;
    } catch (error) {
      throw new UsageError(`${messageOf(error)}\n${USAGE}`);
    }
    const only = values.only === undefined ? undefined : slugsOf(values.only);
    if (only?.length === 0) throw new UsageError(`--only needs at least one seed slug\n${USAGE}`);
    const until = values["commit-until"];
    const commitUntil = until === undefined ? undefined : commitUntilOf(until);
    const windowSecs = windowSecsOf(values);
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
      // Only when a flag is given: without the flags, `seed` is called as it always was.
      ...(commitUntil !== undefined && { commitUntil }),
      ...(windowSecs !== undefined && { windowSecs }),
      log: out,
      dir: options.dir,
      heldoutDir: privateDirOfCli(options.dir),
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
