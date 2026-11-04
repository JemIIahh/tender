import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type ChildWindows,
  createLeadSolver,
  createOfflineSolver,
  createWeakSolver,
  LEAD_TAG,
  runAgent,
  type Solver,
} from "@tender/agents";
import {
  ApiClient,
  type LocalChain,
  registerLocalAgent,
  type Signer,
  TenderClient,
  TenderError,
  toTxResult,
} from "@tender/client";
import { createStateStore, type StateStore } from "@tender/mcp";
import { DelegateViewSchema, formatTokenAmount, type TaskDetail } from "@tender/shared";
import { Account, actions, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import {
  amountOf,
  budgetFor,
  checkHost,
  DemoError,
  type DemoScript,
  type Harness,
  limited,
  main,
  nodeVersion,
  readTask,
  ready,
  say,
  startChain,
  startUp,
  until,
  waiting,
} from "./demo-local";
import { REPO_ROOT } from "./lib/env";
import { seed } from "./seed";

/**
 * `pnpm exec tsx scripts/swarm-demo.ts`: a lead agent that hires its own specialists, on a local
 * chain, with nothing but Node and pnpm. It starts what `pnpm demo:local` starts (a local chain, and
 * the API, the indexer, the keeper and the Judge on an in-memory database) and then plays this:
 *
 * - The lead, alice and bob each register as an agent with the bond the contract names (contract
 *   Task 16b: only a registered agent whose bond the contract holds may enter an open task, and the
 *   lead enters the parent and alice and bob the sub-tasks). They do it with their own full-access
 *   keys, which register, unregister and claim and which a delegate key cannot, once the services are
 *   up so that the index sees it; the lead's bond is paid before its 6 tUSDC are put in the vault.
 * - The lead holds a **delegate key**: a function-call key for Tender, limited to `post_task`,
 *   `top_up_task`, `commit` and `reveal`, with a finite allowance (1 NEAR) for gas, that its
 *   account registered with `add_delegate` for 2 tUSDC a task and 6 tUSDC in all. The key can spend
 *   the lead's vault in those bounds and can do nothing else: it cannot withdraw, cannot raise its
 *   own caps, and cannot pick.
 * - The poster posts a **parent** task: a three-part research pack for 10 tUSDC, judged by the
 *   Judge on held-out checks of the whole document.
 * - The lead takes the parent on only because it should: the poster is the one it works for, the
 *   Judge verifies it, it pays in the token of the lead's key, its 9.50 tUSDC after the fee is more
 *   than the 6.00 tUSDC the sub-tasks cost, the key's remaining cap and the lead's vault cover that
 *   6.00, and the parent's commit window leaves time for every hire and for the sub-tasks to settle
 *   (a parent that fails one of these is declined, with nothing committed or spent). It then enters
 *   the parent with a placeholder (a sub-task can name a parent only if its poster has an entry on
 *   it) and returns to the runner at once. The rest is the lead's **job**, which a loop of its own
 *   drives (`lead.run`), from a journal on disk: it posts three **sub-tasks** under the parent with
 *   the delegate key (2 tUSDC each, one for each part), and waits for them. A fourth hire is tried,
 *   to show the cap: the contract refuses it with `E_AUTH`.
 * - Alice and bob enter the sub-tasks. Both enter all three, one with the right answer and one with a
 *   flawed one: alice has parts 1 and 3, bob part 2. The Judge scores them on the held-out checks
 *   and picks the right one in each.
 * - The lead takes the three winning answers, puts them together as `{"parts": [...]}`, commits that
 *   in place of the placeholder, reveals it when the parent's reveal window opens, and the Judge
 *   scores the whole against the parent's held-out checks and pays the lead.
 *
 * The lines it prints come from the API and the chain, and not from what an agent says it did:
 *
 *   Scripted demo agents run by the Tender team (offline solvers)
 *   CHAIN sandbox nearcore <the version the node reports>
 *   REGISTERED lead, alice, bob bond=<amount> each
 *   LEAD key <public key> per_task_cap=2.00 tUSDC total_cap=6.00 tUSDC methods=... allowance=1 NEAR
 *   PARENT task=<id>
 *   LEAD placeholder committed
 *   CHILD task=<id>                                    three times, as the API shows them
 *   LINEAGE parent=<id> children=<id>,<id>,<id> as listed by the API
 *   CAP the fourth hire of 1.00 tUSDC was refused with E_AUTH: the delegate key has spent 6.00 tUSDC of 6.00 tUSDC
 *   CHILD WON task=<id> by=<account>                   three times, as the Judge picks
 *   LEAD recommitted
 *   LEAD revealed
 *   PARENT PAID lead=<amount>                          what the parent paid after its fee
 *   MARGIN lead=<amount>                               that, less what the three sub-tasks cost
 *   SWARM OK
 *
 * The margin is not worked out from the plan. The paid amount is the parent's payout in the API, the
 * cost is the sum of the three sub-tasks' rewards in the API, and the demo checks the two against the
 * lead's vault on the chain before and after.
 *
 * It is plain about who the agents are: the banner and the line under it say that the lead, alice and
 * bob are the Tender team's own, that alice and bob answer from files, that no model runs, and that
 * the poster and the Judge are the team's too. `SWARM OK` is the last line, and it comes only after
 * everything the demo started has stopped and its files are gone, and only if every fact the
 * scenario rests on held. It shares its start, its stops and its failures with `pnpm demo:local`
 * (`main` of `./demo-local`).
 *
 * It takes about five minutes. The parent's commit window is what makes it long: the sub-tasks must
 * settle a minute before it ends, and the lead's last commit has to land inside it.
 */

// ---- The scenario ------------------------------------------------------------------------------

const PACK = join(REPO_ROOT, "scripts", "swarm-research-pack");
const CHILDREN = join(PACK, "children");
/** The parent is the folder `parent` of the pack, which `seed` posts as it posts any seed. */
const PARENT_SLUG = "parent";

const BANNER = "Scripted demo agents run by the Tender team (offline solvers)";

/**
 * The windows of the parent, in seconds, in place of the pack's own (an hour and more). The commit
 * window is the long one: the lead posts its sub-tasks in the first half minute, they settle in
 * 80 s (`CHILD_WINDOWS`), and the lead keeps a minute in hand after that to assemble and commit,
 * which comes to 170 s. 190 leaves room for a machine that is slow. The reveal window is wide
 * enough for an upload and a transaction, and the pick window for the Judge to score a document.
 */
const PARENT_WINDOWS = { commit_secs: 190, reveal_secs: 40, pick_secs: 60, fallback_secs: 20 };

/**
 * The windows of the sub-tasks. The sandbox takes none shorter than 5 s. The specialists look every
 * half second, a transaction takes two or three seconds, and each of them enters three sub-tasks in
 * a row, so the commit and reveal windows are 25 s. The pick window is wide enough for the Judge,
 * which looks every second, and costs the demo nothing, since a task is picked as soon as its
 * reveals close.
 */
const CHILD_WINDOWS: ChildWindows = {
  commit_secs: 25,
  reveal_secs: 25,
  pick_secs: 30,
  fallback_secs: 20,
};

/** The caps of the lead's delegate key, in tUSDC's smallest unit: 2.00 a task and 6.00 in all. */
const PER_TASK_CAP = 2_000_000n;
const TOTAL_CAP = 6_000_000n;
/**
 * The methods of the lead's function-call key. It enters tasks (`commit`, `reveal`) and hires
 * (`post_task`, `top_up_task`), and nothing else: no `pick`, no `withdraw`, no `add_delegate`.
 */
const KEY_METHODS = ["post_task", "top_up_task", "commit", "reveal"];
/**
 * The key's allowance for gas, in yoctoNEAR: 1 NEAR. A finite one (a key with none can spend all the
 * account's NEAR on fees), and meant to be far more than the dozen or so calls of the demo need.
 */
const KEY_ALLOWANCE = 10n ** 24n;
/** What the lead's storage balance with Tender gets besides the 0.1 NEAR a role starts with. */
const EXTRA_STORAGE = 2n * 10n ** 23n;
/** The fourth hire the cap refuses: within the per-task cap, so that it is the total cap that stops it. */
const FOURTH_REWARD = 1_000_000n;
/** The windows of that fourth hire, the shortest the sandbox takes. */
const FOURTH_WINDOW_SECS = 5;

/** How often the agents look for tasks to enter and reveals that are due. */
const AGENT_POLL_MS = 500;
/**
 * How long the lead takes to hire one part, as it plans it: a post is a transaction and two uploads,
 * which take two or three seconds on this chain. 10 s a part leaves room for a slow machine, and
 * keeps the third part of the parent's 190 s window inside the lead's plan (60 + 80 + 3 x 10 = 170).
 */
const LEAD_HIRE_SECS = 10;
/** How long a step that starts or posts something may take. */
const STEP_MS = 90_000;
/** How long one request to the API may take. */
const API_TIMEOUT_MS = 10_000;

/** The part of a sub-task: its `part-n` tag. */
const PARTS = { alice: ["part-1", "part-3"], bob: ["part-2"] } as const;

// ---- The agents --------------------------------------------------------------------------------

/**
 * A specialist: it answers the sub-tasks tagged with a part of its own with the right answer of the
 * pack, and any other sub-task with the flawed one. Both are read from the pack's files, and neither
 * is a model.
 */
function specialist(name: string, parts: readonly string[]): Solver {
  const right = createOfflineSolver(CHILDREN);
  const weak = createWeakSolver(CHILDREN);
  return {
    name,
    scripted: true,
    solve: (ctx) => (ctx.brief.tags.some((tag) => parts.includes(tag)) ? right : weak).solve(ctx),
  };
}

/** One agent's loop, which runs until `stop` aborts and ends the demo if it crashes. */
function launch(
  h: Harness,
  o: {
    name: string;
    client: TenderClient;
    api: ApiClient;
    state: StateStore;
    tags: readonly string[];
    solver: Solver;
    stop: AbortSignal;
  },
): Promise<void> {
  return runAgent({
    name: o.name,
    client: o.client,
    api: o.api,
    state: o.state,
    tags: o.tags,
    solver: o.solver,
    pollMs: AGENT_POLL_MS,
    log: h.log,
    signal: o.stop,
  }).catch((error: unknown) => h.fail(error));
}

// ---- The lead's key ----------------------------------------------------------------------------

/** What `equipLead` sets up: the key the lead signs with, and what the chain says of it. */
interface Equipped {
  /** The lead's account with the function-call key, which is the only key the lead's agent holds. */
  delegate: Signer;
  publicKey: string;
  /** The lead's vault after the deposit: what the lead has to spend, and keeps count of. */
  vaultBefore: bigint;
}

/**
 * The lead's owner sets the agent up with the full-access key, once: storage for the tasks it will
 * post, the 6 tUSDC it may spend in its vault, the function-call key, and the key's caps. Then the
 * full-access key is not used again; the agent holds the function-call key alone. The chain is asked
 * what it now holds: the key's permission, and the caps, before the demo goes on.
 */
async function equipLead(chain: LocalChain, reader: TenderClient): Promise<Equipped> {
  const owner = chain.accounts.lead;
  const admin = new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
    signer: owner,
  });
  await admin.storageDeposit(EXTRA_STORAGE);
  const { events } = await admin.deposit(chain.tokenId, TOTAL_CAP);
  const taken = events.find((event) => event.event === "deposit");
  if (taken?.event !== "deposit" || taken.data.amount !== TOTAL_CAP.toString()) {
    throw new DemoError(`Tender did not take the deposit of ${amountOf(TOTAL_CAP, chain.tokenId)}`);
  }

  const keyPair = KeyPair.fromRandom("ed25519");
  const publicKey = keyPair.getPublicKey().toString();
  const account = new Account(
    owner.accountId,
    new JsonRpcProvider({ url: chain.rpcUrl }),
    owner.privateKey as KeyPairString,
  );
  toTxResult(
    await account.signAndSendTransaction({
      receiverId: owner.accountId,
      actions: [
        actions.addFunctionCallAccessKey(
          keyPair.getPublicKey(),
          chain.contractId,
          KEY_METHODS,
          KEY_ALLOWANCE,
        ),
      ],
      waitUntil: "FINAL",
      throwOnFailure: false,
    }),
    chain.contractId,
  );
  await admin.addDelegate(publicKey, chain.tokenId, PER_TASK_CAP, TOTAL_CAP);

  // What the chain holds, and not what was sent. The access key first.
  const held = await reader.viewAccessKey(owner.accountId, publicKey);
  const permission = held?.permission;
  if (typeof permission !== "object" || !("FunctionCall" in permission)) {
    throw new DemoError("the lead's key is not a function-call key on the chain");
  }
  const call = permission.FunctionCall as {
    receiver_id: string;
    method_names: string[];
    allowance?: string | null;
  };
  if (call.receiver_id !== chain.contractId) {
    throw new DemoError(`the lead's key reaches ${call.receiver_id}, and not ${chain.contractId}`);
  }
  if (call.method_names.join(",") !== KEY_METHODS.join(",")) {
    throw new DemoError(`the lead's key may call ${call.method_names.join(",")}`);
  }
  if (call.allowance === undefined || call.allowance === null) {
    throw new DemoError("the lead's key has no cap on its allowance");
  }
  // Then the caps the account registered for it.
  const caps = await delegateOf(reader, owner.accountId, publicKey);
  if (caps === null) throw new DemoError("the chain has no caps for the lead's key");
  if (
    caps.token !== chain.tokenId ||
    BigInt(caps.per_task_cap) !== PER_TASK_CAP ||
    BigInt(caps.total_cap) !== TOTAL_CAP ||
    BigInt(caps.spent) !== 0n
  ) {
    throw new DemoError(`the caps of the lead's key are not the ones set: ${JSON.stringify(caps)}`);
  }

  const vaultBefore = await reader.balanceOf(owner.accountId, chain.tokenId);
  if (vaultBefore !== TOTAL_CAP) {
    throw new DemoError(`the lead's vault holds ${vaultBefore}, and not ${TOTAL_CAP}`);
  }
  say(
    `LEAD key ${publicKey} per_task_cap=${amountOf(PER_TASK_CAP, chain.tokenId)} ` +
      `total_cap=${amountOf(TOTAL_CAP, chain.tokenId)} methods=${call.method_names.join(",")} ` +
      `allowance=${formatTokenAmount(String(call.allowance), 24)} NEAR`,
  );
  return {
    delegate: { accountId: owner.accountId, privateKey: keyPair.toString() },
    publicKey,
    vaultBefore,
  };
}

/** `get_delegate` of the chain for one key of an account: its caps and what it has spent, or null. */
async function delegateOf(reader: TenderClient, account: string, publicKey: string) {
  const view = await reader.view<unknown>(reader.contractId, "get_delegate", {
    account_id: account,
    public_key: publicKey,
  });
  return view === null ? null : DelegateViewSchema.parse(view);
}

// ---- The scenario, step by step ----------------------------------------------------------------

const decode = (base64: string) => Buffer.from(base64, "base64").toString("utf8");

async function swarm(h: Harness): Promise<void> {
  checkHost();
  say(BANNER);
  say(
    "The lead, alice and bob are the Tender team's own agents, and no model runs. The lead hires " +
      "alice and bob with sub-tasks and assembles what they hand in. Alice and bob answer from files: " +
      "alice the right answers to parts 1 and 3 and a flawed one to part 2, bob the reverse. " +
      "The poster and the Judge are the team's too.",
  );

  const dir = resolve(await mkdtemp(join(tmpdir(), "tender-swarm-")));
  h.onExit("remove the temp files", () => rm(dir, { recursive: true, force: true }));
  h.onProcessExit(() =>
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  );
  const nodeTmp = join(dir, "node");
  await mkdir(nodeTmp);

  const chain = await startChain(h, nodeTmp);
  say(`CHAIN ${chain.network} nearcore ${await nodeVersion(chain.rpcUrl)}`);

  const { poster, lead, alice, bob, judge } = chain.accounts;
  const { services, reader: api } = await startUp(h, chain, dir, [
    "poster",
    "lead",
    "alice",
    "bob",
  ]);
  const token = chain.tokenId;
  const chainReader = new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
  });
  const clientOf = (signer: Signer) =>
    new TenderClient({
      network: chain.network,
      contractId: chain.contractId,
      rpcUrl: chain.rpcUrl,
      signer,
    });
  const apiOf = (signer: Signer) =>
    new ApiClient({
      baseUrl: services.publicUrl,
      signer,
      timeoutMs: API_TIMEOUT_MS,
      signal: h.signal,
    });

  // Every entrant is a registered agent with a bond, the lead included, which enters the parent.
  // The lead's bond is paid first, so that the 6 tUSDC it then deposits are all that its vault holds.
  const team = [
    ["lead", [LEAD_TAG]],
    ["alice", ["extraction"]],
    ["bob", ["extraction"]],
  ] as const;
  await limited(
    "registering the lead, alice and bob with a bond",
    STEP_MS,
    Promise.all(team.map(([role, tags]) => registerLocalAgent(chain, role, tags))),
    h.signal,
  );
  const bonded = await until(h, "REGISTERED", STEP_MS, async () => {
    const listed = await Promise.all(
      team.map(([role]) => api.getAgent(chain.accounts[role].accountId)),
    );
    const missing = team.filter((_, i) => listed[i]?.agent.status !== "active").map(([r]) => r);
    const bond = listed[0]?.agent.bond_amount;
    return missing.length > 0 || bond === undefined || bond === null
      ? waiting(`the API does not list ${missing.join(" and ")} as active with a bond yet`)
      : ready(bond);
  });
  say(`REGISTERED ${team.map(([role]) => role).join(", ")} bond=${amountOf(bonded, token)} each`);

  // The lead's owner sets its key and its caps. From here the agent holds the function-call key.
  const equipped = await equipLead(chain, chainReader);
  const delegate = equipped.delegate;

  // The poster posts the parent.
  const seeded = await limited(
    "posting the parent",
    STEP_MS,
    seed({
      client: clientOf(poster),
      api: apiOf(poster),
      network: chain.network,
      poster: poster.accountId,
      judgeAccount: judge.accountId,
      tokenId: token,
      seedsDir: PACK,
      // The pack is the demo's own, public in full: the parent's checks sit in its folder.
      heldoutDir: PACK,
      only: [PARENT_SLUG],
      windows: PARENT_WINDOWS,
      log: h.log,
    }),
    h.signal,
  );
  const [posted] = seeded.filter((task) => task.status === "posted");
  if (posted === undefined || seeded.length !== 1) {
    throw new DemoError(`expected the parent to be posted once, but got ${seeded.length} tasks`);
  }
  const parentId = posted.taskId;
  const parent = await until(h, "PARENT", STEP_MS, async () => {
    const found = await readTask(api, parentId);
    return found === undefined
      ? waiting(`the API does not list task ${parentId} yet`)
      : ready(found);
  });
  say(`PARENT task=${parentId}`);

  // Start the agents. The lead signs with its function-call key, for the chain and for the API.
  const stopAgents = new AbortController();
  const loops: Promise<void>[] = [];
  h.onExit("stop the agents", async () => {
    stopAgents.abort();
    await Promise.all(loops);
  });
  const leadState = createStateStore(join(dir, "agents", "lead"));
  const leadClient = clientOf(delegate);
  const leadApi = apiOf(delegate);
  const leadSolver = createLeadSolver({
    seedsDir: CHILDREN,
    client: leadClient,
    api: leadApi,
    judgeAccount: judge.accountId,
    // The lead takes on a parent only from the poster, in the token of its key, judged by the
    // Judge, and only if it pays more after its fee than the sub-tasks cost, the key and the vault
    // cover them, and the parent's window leaves time for all of it.
    token,
    delegateKey: equipped.publicKey,
    posters: [poster.accountId],
    journalDir: join(dir, "agents", "lead-jobs"),
    state: leadState,
    windows: CHILD_WINDOWS,
    hireSecs: LEAD_HIRE_SECS,
    pollMs: 1_000,
    log: h.log,
  });
  loops.push(
    launch(h, {
      name: "lead",
      client: leadClient,
      api: leadApi,
      state: leadState,
      tags: [LEAD_TAG],
      solver: leadSolver,
      stop: stopAgents.signal,
    }),
    // The lead's job (its hires, its waiting, its assembling) is a loop of its own beside the
    // runner's, so that no timeout of a solve cuts it short and no reveal waits on it.
    leadSolver.run(stopAgents.signal).catch((error: unknown) => h.fail(error)),
  );
  for (const [name, signer] of [
    ["alice", alice],
    ["bob", bob],
  ] as const) {
    loops.push(
      launch(h, {
        name,
        client: clientOf(signer),
        api: apiOf(signer),
        state: createStateStore(join(dir, "agents", name)),
        tags: ["extraction"],
        solver: specialist(name, PARTS[name]),
        stop: stopAgents.signal,
      }),
    );
  }

  const leadAccount = lead.accountId;

  // The lead enters the parent with a placeholder: the chain has its commitment, and the draft the
  // lead saved opens it.
  await until(h, "LEAD placeholder committed", budgetFor(parent.task.commit_deadline), async () => {
    const [entry, draft] = await Promise.all([
      chainReader.getEntry(parentId, leadAccount),
      leadState.getDraft(String(parentId)),
    ]);
    if (entry === null) return waiting("the lead has no entry on the parent yet");
    if (draft === null || draft.commitment !== entry.commitment) {
      return waiting("the lead's entry is not the one of its draft yet");
    }
    return decode(draft.contentBase64) === "placeholder"
      ? ready(true)
      : waiting("the lead's draft is not the placeholder");
  });
  say("LEAD placeholder committed");

  // The sub-tasks, as the API lists them under the parent.
  const seen: string[] = [];
  await until(h, "the three CHILD tasks", budgetFor(parent.task.commit_deadline), async () => {
    const found = await readTask(api, parentId);
    const children = found?.children ?? [];
    for (const id of children) {
      if (!seen.includes(id)) {
        seen.push(id);
        say(`CHILD task=${id}`);
      }
    }
    return children.length >= 3 ? ready(children) : waiting(`${children.length} of 3 posted`);
  });
  const childIds = seen.map(BigInt);
  if (childIds.length !== 3) throw new DemoError(`the lead posted ${childIds.length} sub-tasks`);

  // Each is the lead's, under the parent, judged by the Judge, and pays what the pack says.
  const children: TaskDetail[] = [];
  for (const id of childIds) {
    const found = await readTask(api, id);
    if (found === undefined) throw new DemoError(`the API does not list task ${id}`);
    const { task } = found;
    if (task.poster !== leadAccount || task.parent !== String(parentId)) {
      throw new DemoError(`task ${id} is not the lead's sub-task of the parent`);
    }
    if (task.verifier !== judge.accountId || task.token !== token) {
      throw new DemoError(`task ${id} is not judged by the Judge in ${token}`);
    }
    if (BigInt(task.reward) !== PER_TASK_CAP) {
      throw new DemoError(`task ${id} pays ${task.reward}, and not ${PER_TASK_CAP}`);
    }
    children.push(task);
  }

  // `GET /v1/tasks/<parent>` lists the three, and so does the listing by parent.
  const listed = (await api.getTask(parentId))?.children ?? [];
  const byParent = (await api.listTasks({ parent: parentId, limit: 50 })).tasks.map((t) => t.id);
  if (
    listed.join(",") !== seen.join(",") ||
    [...byParent].sort().join(",") !== [...seen].sort().join(",")
  ) {
    throw new DemoError(
      `the API lists the parent's children as ${listed.join(",")} and by parent as ${byParent.join(",")}, and the lead posted ${seen.join(",")}`,
    );
  }
  say(`LINEAGE parent=${parentId} children=${listed.join(",")} as listed by the API`);

  // A fourth hire. The key has spent its 6.00 tUSDC; a task of 1.00 would take it past the total
  // cap. It is a well-formed sub-task of the same parent, so that the cap is the only thing wrong.
  const [first] = children;
  if (first === undefined) throw new DemoError("no sub-task to model a fourth on");
  let refusal: unknown;
  try {
    await leadClient.postTask(
      {
        token,
        reward: FOURTH_REWARD,
        briefUri: first.brief_uri,
        briefHash: first.brief_hash,
        criteriaHash: first.criteria_hash,
        verifier: judge.accountId,
        commitSecs: FOURTH_WINDOW_SECS,
        revealSecs: FOURTH_WINDOW_SECS,
        pickSecs: FOURTH_WINDOW_SECS,
        fallbackSecs: FOURTH_WINDOW_SECS,
        parent: parentId,
      },
      { delegate: true },
    );
  } catch (error) {
    refusal = error;
  }
  if (!(refusal instanceof TenderError) || refusal.code !== "E_AUTH") {
    throw new DemoError(
      `expected the fourth hire to be refused with E_AUTH, and got ${
        refusal instanceof Error
          ? `${refusal.name} ${(refusal as { code?: string }).code ?? ""}`
          : "a hire that went through"
      }`,
    );
  }
  if (!/total cap/.test(refusal.message)) {
    throw new DemoError("the fourth hire was refused with E_AUTH, but not on the total cap");
  }
  const caps = await delegateOf(chainReader, leadAccount, equipped.publicKey);
  if (caps === null || BigInt(caps.spent) !== TOTAL_CAP) {
    throw new DemoError(
      `the key's spending is ${caps?.spent}, and the three hires cost ${TOTAL_CAP}`,
    );
  }
  say(
    `CAP the fourth hire of ${amountOf(FOURTH_REWARD, token)} was refused with E_AUTH: the delegate key has ` +
      `spent ${amountOf(caps.spent, token)} of ${amountOf(caps.total_cap, token)}`,
  );

  // Each sub-task is picked by the Judge, and its winner is a specialist.
  const lastPick = children.reduce((a, b) =>
    BigInt(a.pick_deadline) > BigInt(b.pick_deadline) ? a : b,
  );
  const winners = new Map<string, string>();
  await until(h, "the three CHILD WON picks", budgetFor(lastPick.pick_deadline), async () => {
    for (const id of seen) {
      if (winners.has(id)) continue;
      const found = await readTask(api, BigInt(id));
      const outcome = found?.task.outcome;
      if (outcome?.kind !== "picked") continue;
      if (outcome.by !== null && outcome.by !== judge.accountId) {
        throw new DemoError(`task ${id} was picked by ${outcome.by} and not by the Judge`);
      }
      const [winner, ...others] = outcome.winners;
      if (winner === undefined || others.length > 0) {
        throw new DemoError(`task ${id} was not won by one agent`);
      }
      winners.set(id, winner.account);
      say(`CHILD WON task=${id} by=${winner.account}`);
    }
    return winners.size === 3 ? ready(winners) : waiting(`${winners.size} of 3 picked`);
  });
  const expected = [alice, bob, alice].map((one) => one.accountId);
  const got = seen.map((id) => winners.get(id));
  if (got.join(",") !== expected.join(",")) {
    throw new DemoError(
      `the sub-tasks were won by ${got.join(",")}, and not by ${expected.join(",")}`,
    );
  }

  // The lead assembles the parts and commits them in place of the placeholder.
  const assembledAnswer = JSON.parse(
    await readFile(join(PACK, PARENT_SLUG, "solution.txt"), "utf8"),
  );
  await until(h, "LEAD recommitted", budgetFor(parent.task.commit_deadline), async () => {
    const [entry, draft] = await Promise.all([
      chainReader.getEntry(parentId, leadAccount),
      leadState.getDraft(String(parentId)),
    ]);
    if (entry === null || draft === null || entry.commitment !== draft.commitment) {
      return waiting("the lead's entry on the chain is not the one of its draft");
    }
    const content = decode(draft.contentBase64);
    if (content === "placeholder") return waiting("the lead's entry is still the placeholder");
    if (!isDeepStrictEqual(JSON.parse(content), assembledAnswer)) {
      throw new DemoError("what the lead committed is not the pack of the three winning answers");
    }
    return ready(true);
  });
  say("LEAD recommitted");

  // It reveals once the parent's commit window is over.
  await until(h, "LEAD revealed", budgetFor(parent.task.reveal_deadline), async () => {
    const found = await readTask(api, parentId);
    const mine = found?.entries.find((entry) => entry.account === leadAccount);
    return mine?.revealed === true ? ready(true) : waiting("the lead's entry is not revealed");
  });
  say("LEAD revealed");

  // The Judge scores the whole against the parent's held-out checks and pays the lead.
  const settled = await until(h, "PARENT PAID", budgetFor(parent.task.pick_deadline), async () => {
    const found = await readTask(api, parentId);
    if (found?.task.outcome?.kind !== "picked") return waiting("the parent is not picked yet");
    if (found.scorecard === null)
      return waiting("the parent is picked, its scorecard is not shown");
    return ready({ outcome: found.task.outcome, scorecard: found.scorecard, task: found.task });
  });
  const { outcome, scorecard } = settled;
  const [paidTo, ...others] = outcome.winners;
  if (outcome.by !== null && outcome.by !== judge.accountId) {
    throw new DemoError(`the parent was picked by ${outcome.by} and not by the Judge`);
  }
  if (paidTo === undefined || paidTo.account !== leadAccount || others.length > 0) {
    throw new DemoError("the parent was not won by the lead alone");
  }
  const score = scorecard.entries.find((entry) => entry.account === leadAccount)?.score;
  if (score !== 100) {
    throw new DemoError(`the Judge scored the lead's pack ${score} and not 100`);
  }
  if (BigInt(paidTo.amount) + BigInt(outcome.fee) !== BigInt(settled.task.reward)) {
    throw new DemoError("the payout and the fee do not make the parent's reward");
  }
  const paid = BigInt(paidTo.amount);
  say(`PARENT PAID lead=${amountOf(paid, token)}`);

  // The margin: what the parent paid, less what the three sub-tasks cost, and the vault agrees.
  const cost = children.reduce((sum, task) => sum + BigInt(task.reward), 0n);
  const margin = paid - cost;
  const vaultAfter = await until(h, "the lead's vault", STEP_MS, async () => {
    const held = await chainReader.balanceOf(leadAccount, token);
    return held === equipped.vaultBefore - cost + paid
      ? ready(held)
      : waiting(`the lead's vault holds ${held}`);
  });
  if (vaultAfter - equipped.vaultBefore !== margin) {
    throw new DemoError("the margin is not what the lead's vault gained");
  }
  if (margin <= 0n) throw new DemoError(`the lead made ${margin}, which is no profit`);
  say(`MARGIN lead=${amountOf(margin, token)}`);
}

// ---- The command line --------------------------------------------------------------------------

/** What `main` runs for the swarm demo. */
export const SWARM_SCRIPT: DemoScript = {
  run: swarm,
  ok: "SWARM OK",
  failed: "SWARM FAILED",
  name: "swarm",
};

// Only when run as the script, never when a test or another script imports from here.
if (import.meta.main) {
  const code = await main(SWARM_SCRIPT);
  await new Promise<void>((done) => process.stdout.write("", () => done()));
  await new Promise<void>((done) => process.stderr.write("", () => done()));
  process.exit(code);
}
