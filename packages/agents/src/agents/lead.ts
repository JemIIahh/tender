import { Buffer } from "node:buffer";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TenderClient } from "@tender/client";
import type { Draft, StateStore } from "@tender/mcp";
import {
  BriefSchema,
  canonicalJson,
  computeCommitment,
  HeldoutSchema,
  heldoutMatchesCriteria,
  PublicCriteriaSchema,
  parseTokenAmount,
  randomSalt,
  sha256Hex,
  type TaskDetailResponse,
  type TenderApi,
  tokenMeta,
} from "@tender/shared";
import type { Solver, TaskContext } from "../types";

// The lead agent of a swarm: it takes a parent task that is too big to answer alone, hires
// specialists for its parts with sub-tasks of its own, and answers the parent with what they hand in.
// It is a `Solver`, so the ordinary runner (`runAgent`) finds the parent, announces the work, commits
// and reveals; what is the lead's own is everything between "the runner asks" and "the runner
// commits":
//
// 1. It commits a placeholder to the parent and saves it as a draft. A sub-task can name a parent
//    only if its poster has an entry on it (`E_PARENT`), so the entry comes first. The placeholder is
//    the commitment of "placeholder" under a fresh salt. It is harmless: if the lead dies here, the
//    draft opens it, the runner reveals it, it fails the parent's schema, and the parent is not paid.
// 2. It posts one sub-task for each folder of `seedsDir`, in name order, with `parent` set, the
//    Judge as verifier and `{ delegate: true }`: the lead's client signs with a function-call key,
//    which cannot attach a deposit, so each post spends the lead's own vault within the caps its
//    account registered for that key (`add_delegate`). The brief, the criteria and the held-out
//    checks are uploaded first, by the lead, who is the poster of the sub-task.
// 3. It waits for every sub-task to be picked, and fetches each winner's revealed result.
// 4. It returns `{ "parts": [result of the first, result of the second, ...] }`. The runner commits
//    that, which replaces the placeholder (a second commit by an entrant replaces its commitment),
//    saves a new draft over the placeholder's, and reveals it once the parent's reveal window opens.
//    That commit is the lead's re-commit, and it has to land before the parent's commit deadline.
//
// Time is the one hard constraint. A sub-task's pick deadline may not be later than its parent's
// commit deadline (the contract, I12), and the lead needs time left to assemble and commit. So the
// lead posts a sub-task only if its three windows end `marginSecs` (60 s) before the parent's
// commit deadline, by the chain's clock; if the first cannot, it commits nothing and leaves the
// parent alone, and if a later one cannot, or a sub-task is voided, or the deadline comes first, it
// answers null and the parent goes unanswered. Whatever it hired by then is on chain and runs on.

/** The tag of the parent tasks the lead takes on. No sub-task carries it. */
export const LEAD_TAG = "swarm";

/** What the placeholder commitment opens to. */
const PLACEHOLDER = "placeholder";
/** How much of the parent's commit window the lead keeps in hand after its last sub-task is due. */
const DEFAULT_MARGIN_SECS = 60;
/** How long the lead waits between two looks at its sub-tasks. */
const DEFAULT_POLL_MS = 2_000;
const NS_PER_SEC = 1_000_000_000n;
const NO_SIGNER = "this lead's client has no signer, so it cannot commit or post";

/** The four windows of a task, in seconds, under the names `task.json` gives them. */
export interface ChildWindows {
  commit_secs: number;
  reveal_secs: number;
  pick_secs: number;
  fallback_secs: number;
}

/**
 * What the lead needs of a `TenderClient`: the network and contract its drafts are bound to, the
 * account it signs as, the commit, the post, and the chain's clock.
 */
export type LeadChain = Pick<
  TenderClient,
  "network" | "contractId" | "accountId" | "commit" | "postTask" | "blockTimestampNs"
>;

/** What the lead needs of the API: the sub-tasks it watches, and the uploads of a poster. */
export type LeadApi = Pick<TenderApi, "getTask" | "getBlob" | "uploadBlob" | "uploadHeldout">;

export interface LeadSolverOptions {
  /**
   * The folder of the sub-tasks: one folder for each, in the format of the seeds (`task.json`,
   * `brief.json`, `criteria.json`, `heldout.json` when the criteria have a held-out part). They are
   * posted in name order, and their results are the parts, in the same order. Only the files the
   * lead posts from are read; a `solution.txt` beside them is for whoever plays the specialists.
   */
  seedsDir: string;
  /** Signs as the lead. For a swarm it signs with a delegate key, and the posts carry no deposit. */
  client: LeadChain;
  /** Signed in as the lead: the uploads are the poster's. */
  api: LeadApi;
  /** The account that a sub-task's `"judge"` verifier means. */
  judgeAccount: string;
  /** Where the lead's drafts live: the same store the runner uses, so the runner reveals them. */
  state: StateStore;
  /** Replaces the windows of every sub-task, for a demo that cannot wait a whole phase. */
  windows?: ChildWindows;
  /** Seconds before the parent's commit deadline by which every sub-task must be due. Default 60. */
  marginSecs?: number;
  /** Milliseconds between two looks at the sub-tasks. Default 2000. */
  pollMs?: number;
  /** Receives the lead's lines. Default: `console.log`. */
  log?: (line: string) => void;
  /** Ends the wait for the sub-tasks at once when it aborts. */
  signal?: AbortSignal;
}

// ---- The sub-tasks ------------------------------------------------------------------------------

/** A document as it goes up: its canonical bytes, and the SHA-256 of them that goes on chain. */
interface Doc {
  bytes: Uint8Array;
  hash: string;
}

/** One sub-task, read and checked: its documents as they go up, and its terms. */
interface ChildSpec {
  slug: string;
  brief: Doc;
  criteria: Doc;
  heldout?: Doc;
  /** In the token's units, as text: `"2.00"`. */
  reward: string;
  windows: ChildWindows;
  maxWinners: number;
  verifier: "judge" | "poster";
}

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

const isCount = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) > 0;

const docOf = (value: unknown): Doc => {
  const bytes = canonicalJson(value);
  return { bytes, hash: sha256Hex(bytes) };
};

function readJson(dir: string, slug: string, name: string): unknown {
  let text: string;
  try {
    text = readFileSync(join(dir, name), "utf8");
  } catch {
    throw new Error(`${slug}/${name} cannot be read`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${slug}/${name} is not valid JSON`);
  }
}

interface Schema<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] };
      };
}

function parsed<T>(schema: Schema<T>, json: unknown, where: string): T {
  const result = schema.safeParse(json);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const at =
    issue === undefined ? "the document" : issue.path.map(String).join(".") || "the document";
  throw new Error(
    `${where} does not fit its schema, first at ${at}${issue ? `: ${issue.message}` : ""}`,
  );
}

/** Reads and checks one sub-task folder. Nothing here touches the API or the chain. */
function readChild(dir: string, slug: string): ChildSpec {
  const terms = readJson(dir, slug, "task.json");
  const where = `${slug}/task.json`;
  if (typeof terms !== "object" || terms === null || Array.isArray(terms)) {
    throw new Error(`${where} is not a task's terms: it is not an object`);
  }
  const t = terms as Record<string, unknown>;
  const extra = Object.keys(t).filter((key) => !TERMS_KEYS.includes(key));
  if (extra.length > 0)
    throw new Error(`${where} has keys that are not terms: ${extra.join(", ")}`);
  if (typeof t.reward !== "string")
    throw new Error(`${where}: reward must be text, such as "2.00"`);
  if (t.verifier !== "judge" && t.verifier !== "poster") {
    throw new Error(`${where}: verifier must be "judge" or "poster"`);
  }
  if (!isCount(t.max_winners))
    throw new Error(`${where}: max_winners must be a whole number above 0`);
  const secs = (key: keyof ChildWindows): number => {
    const value = t[key];
    if (!isCount(value))
      throw new Error(`${where}: ${key} must be a whole number of seconds above 0`);
    return value;
  };

  const brief = parsed(BriefSchema, readJson(dir, slug, "brief.json"), `${slug}/brief.json`);
  const criteria = parsed(
    PublicCriteriaSchema,
    readJson(dir, slug, "criteria.json"),
    `${slug}/criteria.json`,
  );
  let heldout: Doc | undefined;
  if (criteria.has_heldout) {
    const checks = parsed(
      HeldoutSchema,
      readJson(dir, slug, "heldout.json"),
      `${slug}/heldout.json`,
    );
    if (!heldoutMatchesCriteria(criteria, checks)) {
      throw new Error(`${slug}/heldout.json is not a held-out document of kind ${criteria.kind}`);
    }
    heldout = docOf(checks);
  }
  return {
    slug,
    brief: docOf(brief),
    criteria: docOf(criteria),
    heldout,
    reward: t.reward,
    windows: {
      commit_secs: secs("commit_secs"),
      reveal_secs: secs("reveal_secs"),
      pick_secs: secs("pick_secs"),
      fallback_secs: secs("fallback_secs"),
    },
    maxWinners: t.max_winners,
    verifier: t.verifier,
  };
}

/** Every sub-task folder of `seedsDir`, in name order. Throws for a folder that does not fit. */
function readChildren(seedsDir: string): ChildSpec[] {
  const slugs = readdirSync(seedsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (slugs.length === 0)
    throw new Error(`${seedsDir} has no sub-tasks: a lead needs at least one`);
  return slugs.map((slug) => readChild(join(seedsDir, slug), slug));
}

// ---- The lead -----------------------------------------------------------------------------------

/** What a log line says of an error: its name and its code, never its message (it can quote a URL). */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code)
    ? `${error.name} ${code}`
    : error.name;
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** A winner's result as the part it is: the JSON it holds, or else the text itself. */
function partOf(bytes: Uint8Array): unknown {
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** A sub-task the lead has posted, and what it is waiting for. */
interface Hired {
  id: bigint;
  slug: string;
  /** The winner's result once the sub-task is picked and the bytes are in hand. */
  result?: Uint8Array;
}

export function createLeadSolver(o: LeadSolverOptions): Solver {
  const { client, api, state } = o;
  const log = (line: string) => (o.log ?? console.log)(`lead: ${line}`);
  const marginSecs = o.marginSecs ?? DEFAULT_MARGIN_SECS;
  const pollMs = o.pollMs ?? DEFAULT_POLL_MS;
  // Read now, so a pack that is wrong fails when the lead is made and not on the first parent.
  const specs = readChildren(o.seedsDir);

  /** The windows a sub-task is posted with. */
  const windowsOf = (spec: ChildSpec): ChildWindows => o.windows ?? spec.windows;
  const settleSecs = (w: ChildWindows) => w.commit_secs + w.reveal_secs + w.pick_secs;

  /**
   * Whether a sub-task posted at `now` is due, at its pick deadline, `marginSecs` before `deadline`.
   * The contract's own rule needs less (I12: no later than the deadline); the margin is the lead's
   * time to assemble and commit.
   */
  function room(now: bigint, deadline: bigint, spec: ChildSpec): string | null {
    const needs = settleSecs(windowsOf(spec));
    const left = (deadline - now) / NS_PER_SEC - BigInt(marginSecs);
    if (left >= BigInt(needs)) return null;
    return (
      `part ${spec.slug} needs ${needs} s from its post to its pick deadline, and the parent's commit deadline ` +
      `leaves ${left < 0n ? 0 : left} s less a ${marginSecs} s margin, so it is not posted`
    );
  }

  /** Commits the placeholder and saves it as the parent's draft. */
  async function placeholder(ctx: TaskContext, account: string): Promise<void> {
    const taskId = BigInt(ctx.task.id);
    const bytes = new TextEncoder().encode(PLACEHOLDER);
    const contentHash = sha256Hex(bytes);
    const salt = randomSalt();
    const draft: Draft = {
      taskId: ctx.task.id,
      contentBase64: Buffer.from(bytes).toString("base64"),
      contentHash,
      salt,
      commitment: computeCommitment(taskId, account, contentHash, salt),
      contractId: client.contractId,
      taskCreatedAt: ctx.task.created_at,
    };
    // On disk before the commit leaves, as the runner does: a crash after it leaves the salt behind.
    // A commit that fails leaves this draft unmarked, and the runner settles it as it settles any
    // draft of a commit it is unsure of (`recoverCommit`): it asks the chain, and sends it again.
    await state.saveDraft(draft);
    await client.commit(taskId, draft.commitment);
    await state.saveDraft({ ...draft, committedAt: new Date().toISOString() });
    log(`committed a placeholder to task ${ctx.task.id}, which lets it post sub-tasks of it`);
  }

  /** Uploads a sub-task's documents and posts it under `parent`. Gives its id. */
  async function hire(ctx: TaskContext, account: string, spec: ChildSpec): Promise<bigint> {
    const upload = async (kind: "brief" | "criteria", doc: Doc): Promise<string> => {
      const stored = await api.uploadBlob({
        kind,
        contentType: "application/json",
        bytes: doc.bytes,
      });
      // The post pins the hash on chain: a blob stored under another one could not be judged.
      if (stored.sha256 !== doc.hash) {
        throw new Error(`the API stored the ${kind} of ${spec.slug} under another hash`);
      }
      return stored.uri;
    };
    const briefUri = await upload("brief", spec.brief);
    await upload("criteria", spec.criteria);
    if (spec.heldout !== undefined) await api.uploadHeldout(spec.heldout.hash, spec.heldout.bytes);

    const meta = tokenMeta(ctx.task.token, client.network);
    if (meta.symbol === ctx.task.token) {
      throw new Error(`the decimals of ${ctx.task.token} are unknown on ${client.network}`);
    }
    const w = windowsOf(spec);
    const posted = await client.postTask(
      {
        token: ctx.task.token,
        reward: parseTokenAmount(spec.reward, meta.decimals),
        briefUri,
        briefHash: spec.brief.hash,
        criteriaHash: spec.criteria.hash,
        heldoutCommitment: spec.heldout?.hash,
        verifier: spec.verifier === "judge" ? o.judgeAccount : account,
        commitSecs: w.commit_secs,
        revealSecs: w.reveal_secs,
        pickSecs: w.pick_secs,
        fallbackSecs: w.fallback_secs,
        maxWinners: spec.maxWinners,
        parent: BigInt(ctx.task.id),
      },
      { delegate: true },
    );
    return posted.taskId;
  }

  /**
   * Looks at a sub-task once. Gives "voided" if it was voided, true if it is picked and the winner's
   * result is now in `hired.result`, false if there is nothing to take yet.
   */
  async function look(hired: Hired): Promise<boolean | "voided"> {
    const found: TaskDetailResponse | null = await api.getTask(hired.id);
    // The index trails the chain: a task posted a moment ago may not be there yet.
    const outcome = found?.task.outcome;
    if (found === null || outcome === null || outcome === undefined) return false;
    if (outcome.kind === "voided") return "voided";
    const winner = outcome.winners[0]?.account;
    const hash = found.entries.find((one) => one.account === winner)?.content_hash ?? null;
    if (hash === null) return false;
    // The API serves a result from its task's reveal deadline, and a pick comes after it.
    const bytes = await api.getBlob(hash);
    if (bytes === null) return false;
    hired.result = bytes;
    log(`task ${hired.id} (${hired.slug}) was won by ${winner}`);
    return true;
  }

  async function work(ctx: TaskContext): Promise<Uint8Array | null> {
    const account = client.accountId;
    if (account === undefined) throw new Error(NO_SIGNER);
    const deadline = BigInt(ctx.task.commit_deadline);

    // Nothing is committed for a parent that has no time for the first part.
    const first = specs[0];
    const early =
      first === undefined ? null : room(await client.blockTimestampNs(), deadline, first);
    if (early !== null) {
      log(`leaving task ${ctx.task.id} alone: ${early}`);
      return null;
    }

    await placeholder(ctx, account);

    const hired: Hired[] = [];
    for (const spec of specs) {
      if (o.signal?.aborted) return null;
      const why = room(await client.blockTimestampNs(), deadline, spec);
      if (why !== null) {
        log(`giving up on task ${ctx.task.id}: ${why}`);
        return null;
      }
      const id = await hire(ctx, account, spec);
      hired.push({ id, slug: spec.slug });
      log(`hired for part ${spec.slug}: task ${id}`);
    }

    // Wait for every part, looking at each that is still open once in a round.
    while (hired.some((one) => one.result === undefined)) {
      if (o.signal?.aborted) return null;
      for (const one of hired) {
        if (one.result !== undefined) continue;
        const seen = await look(one);
        if (seen === "voided") {
          log(`giving up on task ${ctx.task.id}: task ${one.id} (${one.slug}) was voided`);
          return null;
        }
      }
      if (hired.every((one) => one.result !== undefined)) break;
      if ((await client.blockTimestampNs()) >= deadline) {
        log(
          `giving up on task ${ctx.task.id}: the sub-tasks had not settled when its commit deadline came`,
        );
        return null;
      }
      await sleep(pollMs, o.signal);
    }

    const parts = hired.map((one) => partOf(one.result ?? new Uint8Array()));
    log(`assembled ${parts.length} parts for task ${ctx.task.id}`);
    return new TextEncoder().encode(JSON.stringify({ parts }));
  }

  return {
    name: "lead",
    // Its answer is worked out from what other agents hand in, not read from a file.
    scripted: false,
    async solve(ctx) {
      if (!ctx.brief.tags.includes(LEAD_TAG)) return null;
      try {
        return await work(ctx);
      } catch (error) {
        log(`ERROR task ${ctx.task.id} failed (${describe(error)})`);
        return null;
      }
    },
  };
}
