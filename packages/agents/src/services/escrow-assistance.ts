import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TenderClient } from "@tender/client";
import { type Draft, isDraftOf, type StateStore } from "@tender/mcp";
import {
  canonicalJson,
  computeCommitment,
  DelegateViewSchema,
  hireDocuments,
  hireTerms,
  pickCall,
  randomSalt,
  ScorecardSchema,
  type Service,
  sha256Hex,
  type TenderApi,
  U64StringSchema,
} from "@tender/shared";
import { writeFileAtomic } from "../agents/lead";
import { lockJournal } from "../agents/lead-lock";
import type { Solver, TaskContext } from "../types";

type Chain = Pick<
  TenderClient,
  | "accountId"
  | "publicKey"
  | "contractId"
  | "network"
  | "view"
  | "viewAccessKey"
  | "getTask"
  | "getEntry"
  | "blockTimestampNs"
  | "balanceOf"
  | "postTask"
  | "txStatus"
  | "send"
  | "commit"
>;
type Api = Pick<TenderApi, "getService" | "getBlob" | "uploadBlob">;

/** This binding is owner configuration, never a claim inferred from a listing's description. */
export interface ApprovedEscrowService {
  capability: string;
  serviceId: string;
  agent: string;
  provider: string;
  maxPrice: bigint;
}
export interface AssistanceNeed {
  capability: string;
  request: string;
}
export interface AssistancePlan {
  needs: AssistanceNeed[];
  /** Owner-supplied checks, executed again after a restart. False means no payment. */
  validate(index: number, result: unknown): boolean;
  compose(results: unknown[]): unknown;
}
export interface EscrowAssistanceOptions {
  /** Commit/reveal work key, capped post_task delegate, and separate non-delegate pick key. */
  worker: Chain;
  spender: Chain;
  acceptor: Chain;
  api: Api;
  state: StateStore;
  journalDir: string;
  token: string;
  posters: readonly string[];
  verifiers: readonly string[];
  services: readonly ApprovedEscrowService[];
  /** Deterministic capability planner. Task text and service descriptions are only data. */
  plan(ctx: TaskContext): AssistancePlan | null;
  minProfit: bigint;
  /** Estimated upload/post time per sequential hire, plus final assembly margin. */
  hireSecs?: number;
  marginSecs?: number;
}
type Step = {
  capability: string;
  request: string;
  service: Service;
  /** Recorded before broadcasting. An unknown signed transaction is never posted again. */
  transaction?: string;
  taskId?: string;
  resultHash?: string;
  accepted?: boolean;
};
type Job = {
  version: 1;
  binding: string;
  context: TaskContext;
  steps: Step[];
  status: "working" | "done" | "abandoned";
  reason?: string;
};
const NS = 1_000_000_000n;
const PLACEHOLDER = new TextEncoder().encode("Awaiting specialist services.");
const same = (a: unknown, b: unknown) =>
  sha256Hex(canonicalJson(a)) === sha256Hex(canonicalJson(b));
const termsOf = (service: Service) => {
  const terms = hireTerms(service, null);
  return { ...terms, reward: String(terms.reward) };
};

/**
 * Restartable, one-parent-at-a-time escrow coordinator. `solve` commits a placeholder through
 * the ordinary runner; `tick` never waits for a child deadline and replaces the parent's draft
 * once its services have settled. Keep ticking the ordinary runner too, for reveals.
 * The hosted utility workers use it only in the explicitly configured escrow assistance mode.
 */
export function createEscrowAssistedSolver(o: EscrowAssistanceOptions): Solver & {
  ready(): Promise<void>;
  tick(): Promise<void>;
  jobs(): Promise<
    ReadonlyArray<{ parent: string; status: string; children: string[]; reason?: string }>
  >;
} {
  const { worker, spender, acceptor, api } = o;
  const account = worker.accountId;
  const hireSecs = o.hireSecs ?? 30;
  const marginSecs = o.marginSecs ?? 60;
  if (
    !account ||
    !o.posters.length ||
    !o.verifiers.length ||
    !o.services.length ||
    o.minProfit < 0n ||
    !Number.isSafeInteger(hireSecs) ||
    hireSecs < 1 ||
    !Number.isSafeInteger(marginSecs) ||
    marginSecs < 1
  )
    throw new Error(
      "Assistance needs an identity, allowlists, nonnegative margin and bounded timing.",
    );
  if (worker.network === "mainnet")
    throw new Error("Assistance is limited to sandbox and testnet.");
  for (const client of [spender, acceptor]) {
    if (
      client.accountId !== account ||
      client.contractId !== worker.contractId ||
      client.network !== worker.network
    )
      throw new Error("Assistance clients must use the same account, contract and network.");
  }
  if (
    !worker.publicKey ||
    !spender.publicKey ||
    !acceptor.publicKey ||
    new Set([worker.publicKey, spender.publicKey, acceptor.publicKey]).size !== 3
  )
    throw new Error("Work, spending and acceptance require three distinct scoped keys.");
  for (const service of o.services) {
    U64StringSchema.parse(service.serviceId);
    if (!service.capability || service.maxPrice <= 0n || service.agent === account)
      throw new Error("Invalid approved service binding.");
  }
  const directory = resolve(o.journalDir);
  const binding = sha256Hex(
    canonicalJson({
      network: worker.network,
      contract: worker.contractId,
      account,
      keys: [worker.publicKey, spender.publicKey, acceptor.publicKey],
      token: o.token,
      posters: o.posters,
      verifiers: o.verifiers,
      minProfit: String(o.minProfit),
      services: o.services.map((s) => ({ ...s, maxPrice: String(s.maxPrice) })),
      hireSecs,
      marginSecs,
    }),
  );
  const save = (job: Job) =>
    writeFileAtomic(
      fs,
      join(directory, `${job.context.task.id}.json`),
      JSON.stringify({ hash: sha256Hex(canonicalJson(job)), job }),
    );
  async function load(): Promise<Job[]> {
    const names = await fs.readdir(directory);
    const jobs: Job[] = [];
    for (const name of names.filter((name) => /^(0|[1-9][0-9]*)\.json$/.test(name))) {
      const envelope = JSON.parse(await fs.readFile(join(directory, name), "utf8"));
      const job = envelope.job as Job;
      if (
        !job ||
        envelope.hash !== sha256Hex(canonicalJson(job)) ||
        job.version !== 1 ||
        job.binding !== binding ||
        `${job.context.task.id}.json` !== name
      )
        throw new Error("Assistance journal is damaged or belongs to different configuration.");
      jobs.push(job);
    }
    return jobs;
  }
  async function locked<T>(fn: () => Promise<T>): Promise<T> {
    const lock = lockJournal(directory, () => {});
    try {
      return await fn();
    } finally {
      lock.release();
    }
  }
  async function keys() {
    for (const [client, methods] of [
      [worker, ["commit", "reveal"]],
      [spender, ["post_task"]],
      [acceptor, ["pick"]],
    ] as const) {
      const key = await client.viewAccessKey(account as string, client.publicKey as string);
      const permission = key?.permission;
      if (!permission || typeof permission !== "object" || !("FunctionCall" in permission))
        throw new Error("Assistance refuses a full-access or missing hosted key.");
      const call = permission.FunctionCall;
      const allowance = "allowance" in call ? call.allowance : undefined;
      if (
        call.receiver_id !== worker.contractId ||
        !call.method_names.length ||
        typeof allowance !== "string" ||
        !/^[0-9]+$/.test(allowance) ||
        BigInt(allowance) <= 0n ||
        call.method_names.some((m) => !(methods as readonly string[]).includes(m)) ||
        methods.some((m) => !call.method_names.includes(m))
      )
        throw new Error("Assistance keys have unexpected receiver or methods.");
    }
    const delegate = await spender.view<unknown>(worker.contractId, "get_delegate", {
      account_id: account,
      public_key: spender.publicKey,
    });
    const caps = DelegateViewSchema.parse(delegate);
    if (caps.token !== o.token) throw new Error("Spending delegate uses another token.");
    if (
      (await acceptor.view(worker.contractId, "get_delegate", {
        account_id: account,
        public_key: acceptor.publicKey,
      })) != null
    )
      throw new Error("Acceptance key must not be a spending delegate.");
    return caps;
  }
  async function parent(ctx: TaskContext) {
    if (!U64StringSchema.safeParse(ctx.task.id).success) return null;
    const fresh = await worker.getTask(BigInt(ctx.task.id));
    if (
      !fresh ||
      fresh.id !== ctx.task.id ||
      fresh.outcome ||
      fresh.poster !== ctx.task.poster ||
      fresh.verifier !== ctx.task.verifier ||
      fresh.token !== o.token ||
      fresh.created_at !== ctx.task.created_at ||
      fresh.brief_hash !== ctx.task.brief_hash ||
      fresh.criteria_hash !== ctx.task.criteria_hash ||
      fresh.reward !== ctx.task.reward ||
      fresh.fee_bps !== ctx.task.fee_bps ||
      fresh.commit_deadline !== ctx.task.commit_deadline ||
      !o.posters.includes(fresh.poster) ||
      !o.verifiers.includes(fresh.verifier) ||
      (fresh.invited.length > 0 && !fresh.invited.includes(account as string)) ||
      sha256Hex(canonicalJson(ctx.brief)) !== fresh.brief_hash ||
      sha256Hex(canonicalJson(ctx.criteria)) !== fresh.criteria_hash ||
      ctx.brief.output.format !== "json"
    )
      return null;
    return fresh;
  }
  function approved(service: Service, need: AssistanceNeed) {
    const allowed = o.services.find(
      (s) =>
        s.serviceId === service.id &&
        s.capability === need.capability &&
        s.agent === service.agent &&
        s.provider === service.provider &&
        BigInt(service.price) <= s.maxPrice,
    );
    return (
      !!allowed &&
      service.available &&
      service.status === "active" &&
      service.agent !== account &&
      service.token === o.token &&
      service.payment_mode !== "x402" &&
      service.verification.kind === "hirer" &&
      service.output_format === "json" &&
      BigInt(service.price) > 0n &&
      [service.commit_secs, service.reveal_secs, service.pick_secs].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      )
    );
  }
  async function budget(ctx: TaskContext, steps: Step[]) {
    const caps = await keys();
    const cost = steps.reduce((sum, step) => sum + BigInt(step.service.price), 0n);
    const unpaid = steps.filter((step) => !step.taskId && !step.transaction);
    const remaining = unpaid.reduce((sum, step) => sum + BigInt(step.service.price), 0n);
    const gross = BigInt(ctx.task.reward);
    const net = gross - (gross * BigInt(ctx.task.fee_bps)) / 10_000n;
    if (
      net < cost + o.minProfit ||
      remaining > BigInt(caps.total_cap) - BigInt(caps.spent) ||
      unpaid.some((step) => BigInt(step.service.price) > BigInt(caps.per_task_cap)) ||
      remaining > (await spender.balanceOf(account as string, o.token))
    )
      return false;
    const now = await worker.blockTimestampNs();
    // Children run concurrently, but each post needs time. Include the entire acceptance window.
    return unpaid.every(
      (step, i) =>
        now +
          BigInt(
            (i + 1) * hireSecs +
              step.service.commit_secs +
              step.service.reveal_secs +
              step.service.pick_secs +
              marginSecs,
          ) *
            NS <
        BigInt(ctx.task.commit_deadline),
    );
  }
  async function abandon(job: Job, reason: string) {
    job.status = "abandoned";
    job.reason = reason;
    await save(job);
  }
  async function select(plan: AssistancePlan): Promise<Step[] | null> {
    if (!plan.needs.length || plan.needs.length > 4) return null;
    const steps: Step[] = [];
    for (const need of plan.needs) {
      const candidates: Service[] = [];
      for (const binding of o.services.filter((s) => s.capability === need.capability)) {
        const found = await api.getService(BigInt(binding.serviceId));
        if (found && approved(found.service, need)) candidates.push(found.service);
      }
      candidates.sort((a, b) =>
        BigInt(a.price) < BigInt(b.price)
          ? -1
          : BigInt(a.price) > BigInt(b.price)
            ? 1
            : BigInt(a.id) < BigInt(b.id)
              ? -1
              : 1,
      );
      const service = candidates[0];
      if (!service) return null;
      hireDocuments(service, need.request); // Reject overlong requests before any upload or spend.
      steps.push({ ...need, service });
    }
    return steps;
  }
  async function advance(job: Job) {
    if (
      !(await parent(job.context)) ||
      (await worker.blockTimestampNs()) + BigInt(marginSecs) * NS >=
        BigInt(job.context.task.commit_deadline)
    )
      return abandon(job, "Parent changed, settled, or no longer has time.");
    const plan = o.plan(job.context);
    if (
      !plan ||
      !same(
        plan.needs,
        job.steps.map(({ capability, request }) => ({ capability, request })),
      )
    )
      return abandon(job, "Capability plan changed; no further purchases.");
    // The runner must first have committed its placeholder. This also satisfies the parent link.
    if (!(await worker.getEntry(BigInt(job.context.task.id), account as string))) return;
    if (!(await budget(job.context, job.steps)))
      return abandon(job, "Budget, delegate or deadline gate refused.");
    for (const step of job.steps) {
      if (!step.taskId && step.transaction) {
        const status = await spender.txStatus(step.transaction);
        if (status.kind === "executed") {
          step.taskId = U64StringSchema.parse(status.result.returnValue);
          await save(job);
        } else if (status.kind === "failed") return abandon(job, "A signed hire failed on chain.");
        else return; // Unknown or pending may still land. Never send another post.
      }
      if (step.taskId) continue;
      const fresh = (await api.getService(BigInt(step.service.id)))?.service;
      if (
        !fresh ||
        !approved(fresh, step) ||
        hireDocuments(fresh, step.request).briefHash !==
          hireDocuments(step.service, step.request).briefHash ||
        !same(termsOf(fresh), termsOf(step.service))
      )
        return abandon(job, "Service terms changed before purchase.");
      if (!(await parent(job.context)) || !(await budget(job.context, job.steps)))
        return abandon(job, "Parent or spending gate changed before purchase.");
      const documents = hireDocuments(step.service, step.request);
      const brief = await api.uploadBlob({
        kind: "brief",
        contentType: "application/json",
        bytes: documents.briefBytes,
      });
      await api.uploadBlob({
        kind: "criteria",
        contentType: "application/json",
        bytes: documents.criteriaBytes,
      });
      const terms = hireTerms(step.service, null);
      const posted = await spender.postTask(
        {
          ...terms,
          briefUri: brief.uri,
          briefHash: documents.briefHash,
          criteriaHash: documents.criteriaHash,
          parent: BigInt(job.context.task.id),
        },
        { delegate: true },
        {
          beforeSend: async (tx) => {
            step.transaction = tx.txHash;
            await save(job);
          },
        },
      );
      step.taskId = String(posted.taskId);
      await save(job);
    }
    const results: unknown[] = [];
    for (const [index, step] of job.steps.entries()) {
      const id = BigInt(step.taskId as string);
      const task = await worker.getTask(id);
      const documents = hireDocuments(step.service, step.request);
      if (!task) return;
      if (
        task.poster !== account ||
        task.verifier !== account ||
        task.token !== o.token ||
        task.parent !== job.context.task.id ||
        task.reward !== step.service.price ||
        task.brief_hash !== documents.briefHash ||
        task.criteria_hash !== documents.criteriaHash ||
        task.invited.length !== 1 ||
        task.invited[0] !== step.service.agent ||
        task.max_winners !== 1 ||
        task.max_entries !== 1
      )
        return abandon(job, "Child does not match the recorded hire.");
      if (task.outcome?.kind === "voided") return abandon(job, "A service hire was voided.");
      if ((await worker.blockTimestampNs()) < BigInt(task.reveal_deadline)) continue;
      const entry = await worker.getEntry(id, step.service.agent);
      if (!entry?.content_hash) continue;
      if (entry.task_id !== step.taskId || entry.account !== step.service.agent)
        return abandon(job, "Entry does not belong to the recorded hire and specialist.");
      const bytes = await api.getBlob(entry.content_hash);
      if (!bytes) continue;
      if (
        bytes.length > documents.brief.output.max_bytes ||
        sha256Hex(bytes) !== entry.content_hash
      )
        return abandon(job, "Service result size or hash mismatch.");
      let result: unknown;
      try {
        result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        return abandon(job, "Service returned invalid JSON.");
      }
      if (!plan.validate(index, result))
        return abandon(job, "Service result failed owner-configured validation; no acceptance.");
      if (!task.outcome) {
        if ((await worker.blockTimestampNs()) >= BigInt(task.pick_deadline))
          return abandon(job, "Service acceptance window expired.");
        const winners = [{ account: step.service.agent, bps: 10_000 }];
        const scorecard = canonicalJson(
          ScorecardSchema.parse({
            version: 1,
            task_id: step.taskId,
            verifier: account,
            kind: documents.criteria.kind,
            criteria_hash: documents.criteriaHash,
            heldout_commitment: null,
            heldout: null,
            tie_break: "score desc, committed_at_block asc, account asc",
            entries: [
              {
                account: entry.account,
                content_hash: entry.content_hash,
                uri: entry.uri,
                committed_at_block: entry.committed_at_block,
                score: 100,
                passed: true,
                reasons: ["Passed the Tender team's configured service-result check."],
              },
            ],
            winners,
            generated_at: new Date().toISOString(),
            judge: { software: "tender-escrow-assistance/1", model: null },
          }),
        );
        const blob = await api.uploadBlob({
          kind: "scorecard",
          contentType: "application/json",
          bytes: scorecard,
        });
        // Repeating pick after an ambiguous response cannot pay twice: read finalized outcome first.
        await acceptor.send(
          pickCall(worker.contractId, id, winners, sha256Hex(scorecard), blob.uri),
        );
        return; // Do not use an answer until the chain confirms that its hire settled.
      }
      if (
        task.outcome.winners.length !== 1 ||
        task.outcome.winners[0]?.account !== step.service.agent ||
        task.outcome.winners[0]?.bps !== 10_000
      )
        return abandon(job, "Service outcome does not pay the selected specialist.");
      step.resultHash = entry.content_hash;
      step.accepted = true;
      results[index] = result;
    }
    await save(job);
    if (!job.steps.every((step, index) => step.accepted && Object.hasOwn(results, index))) return;
    const bytes = canonicalJson(plan.compose(results));
    if (bytes.length > job.context.brief.output.max_bytes)
      return abandon(job, "Combined answer exceeds parent output limit.");
    if (
      !(await parent(job.context)) ||
      (await worker.blockTimestampNs()) + BigInt(marginSecs) * NS >=
        BigInt(job.context.task.commit_deadline)
    )
      return abandon(job, "Parent deadline reached before final commit.");
    const contentHash = sha256Hex(bytes);
    let draft: Draft | null = await o.state.getDraft(job.context.task.id);
    if (
      !draft ||
      draft.contentHash !== contentHash ||
      draft.contractId !== worker.contractId ||
      draft.taskCreatedAt !== job.context.task.created_at ||
      !isDraftOf(draft, account as string)
    ) {
      const salt = randomSalt();
      draft = {
        taskId: job.context.task.id,
        contentBase64: Buffer.from(bytes).toString("base64"),
        contentHash,
        salt,
        commitment: computeCommitment(
          BigInt(job.context.task.id),
          account as string,
          contentHash,
          salt,
        ),
        contractId: worker.contractId,
        taskCreatedAt: job.context.task.created_at,
      };
      await o.state.saveDraft(draft);
    }
    await worker.commit(BigInt(job.context.task.id), draft.commitment);
    await o.state.saveDraft({ ...draft, committedAt: new Date().toISOString() });
    job.status = "done";
    await save(job);
  }
  return {
    name: "Tender team escrow-assisted planner",
    scripted: true,
    async ready() {
      await locked(async () => {
        await keys();
        await load();
      });
    },
    async solve(ctx) {
      return locked(async () => {
        const jobs = await load();
        if (jobs.some((job) => job.context.task.id === ctx.task.id || job.status === "working"))
          return null;
        if (!(await parent(ctx))) return null;
        const plan = o.plan(ctx);
        if (!plan) return null;
        const steps = await select(plan);
        if (!steps || !(await budget(ctx, steps))) return null;
        await save({ version: 1, binding, context: ctx, steps, status: "working" });
        return PLACEHOLDER;
      });
    },
    async tick() {
      await locked(async () => {
        for (const job of await load()) if (job.status === "working") await advance(job);
      });
    },
    async jobs() {
      return locked(async () =>
        (await load()).map((job) => ({
          parent: job.context.task.id,
          status: job.status,
          children: job.steps.flatMap((s) => (s.taskId ? [s.taskId] : [])),
          ...(job.reason ? { reason: job.reason } : {}),
        })),
      );
    },
  };
}
