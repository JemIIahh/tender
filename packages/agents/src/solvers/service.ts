import type { TenderClient } from "@tender/client";
// Types only: the payment code (and its x402 libraries) loads on the first purchase, so importing
// `@tender/agents` loads none of it.
import type { PurchaseOptions } from "@tender/payments";
import { canonicalJson, type Service, sha256Hex, type TenderApi } from "@tender/shared";
import type { Solver, TaskContext } from "../types";

export type CapabilityPlan =
  | { kind: "answer"; bytes: Uint8Array }
  | { kind: "decline" }
  | { kind: "need_service"; capability: string; input: unknown; serviceId?: string };

export interface CapabilityPolicy {
  tag: string;
  /** Explicit provider approval, independent of the task's untrusted instructions. */
  providers: readonly string[];
  maxPrice: string;
}

export interface ServiceAssistedSolverOptions {
  name: string;
  /** True for a programmed demonstration; no claim that a model made the hiring decision. */
  scripted: boolean;
  chain: Pick<TenderClient, "getTask" | "blockTimestampNs" | "contractId">;
  api: Pick<TenderApi, "listServices" | "getService">;
  buyer: Omit<PurchaseOptions, "requestId" | "maxPrice">;
  capabilities: Readonly<Record<string, CapabilityPolicy>>;
  posters: readonly string[];
  verifiers: readonly string[];
  /** Expected margin if this single-winner task pays; winning is not guaranteed. */
  minMargin: bigint;
  /** Time reserved for the paid call and the final commitment, in milliseconds. */
  minRunwayMs: number;
  plan(ctx: TaskContext): Promise<CapabilityPlan>;
  /** Validate the paid response as data, then compose the original task's answer. */
  complete(ctx: TaskContext, capability: string, response: unknown): Promise<Uint8Array | null>;
  log?(event: string): void;
}

/** Opt-in capability routing for an ordinary task runner. Never enabled by a task's text. */
export function createServiceAssistedSolver(options: ServiceAssistedSolverOptions): Solver {
  if (
    options.minMargin < 0n ||
    !Number.isSafeInteger(options.minRunwayMs) ||
    options.minRunwayMs < 1
  ) {
    throw new Error("Expected a nonnegative margin and a positive time reserve.");
  }
  const log = options.log ?? (() => {});
  return {
    name: options.name,
    scripted: options.scripted,
    async solve(ctx) {
      const plan = await options.plan(ctx);
      if (plan.kind === "answer") return plan.bytes;
      if (plan.kind === "decline") return null;
      const policy = Object.hasOwn(options.capabilities, plan.capability)
        ? options.capabilities[plan.capability]
        : undefined;
      if (!policy) {
        log("DECLINE: capability has no owner-approved purchase policy");
        return null;
      }
      log(`GAP: task ${ctx.task.id} needs capability ${policy.tag}`);
      // A finalized chain read, not a cached API phase, decides whether a call may still help.
      async function canBuy(price: bigint): Promise<boolean> {
        const task = await options.chain.getTask(BigInt(ctx.task.id));
        const now = await options.chain.blockTimestampNs();
        if (
          task?.phase !== "open" ||
          task.outcome !== null ||
          task.max_winners !== 1 ||
          task.brief_hash !== ctx.task.brief_hash ||
          task.criteria_hash !== ctx.task.criteria_hash ||
          task.token !== options.buyer.asset ||
          !options.posters.includes(task.poster) ||
          !options.verifiers.includes(task.verifier)
        )
          return false;
        if (BigInt(task.commit_deadline) - now < BigInt(options.minRunwayMs) * 1_000_000n)
          return false;
        const reward = BigInt(task.reward);
        const afterFee = reward - (reward * BigInt(task.fee_bps)) / 10_000n;
        return afterFee - price >= options.minMargin;
      }
      const ceiling = BigInt(policy.maxPrice);
      if (ceiling <= 0n || !(await canBuy(ceiling))) {
        log("DECLINE: task terms, time reserve or expected margin do not permit a purchase");
        return null;
      }
      const page = await options.api.listServices({
        tag: policy.tag,
        token: options.buyer.asset,
        maxPrice: ceiling,
        status: "available",
        limit: 50,
      });
      const eligible = (service: Service) =>
        (plan.serviceId === undefined || service.id === plan.serviceId) &&
        service.payment_mode === "x402" &&
        service.available &&
        service.status === "active" &&
        service.token === options.buyer.asset &&
        service.tags.includes(policy.tag) &&
        policy.providers.includes(service.provider) &&
        service.agent !== options.buyer.payer &&
        BigInt(service.price) <= ceiling;
      const offered = page.services.filter(eligible).sort((a, b) => {
        const price = BigInt(a.price) - BigInt(b.price);
        return price < 0n ? -1 : price > 0n ? 1 : BigInt(a.id) < BigInt(b.id) ? -1 : 1;
      })[0];
      if (!offered) {
        log("DECLINE: no approved ASP offers the needed capability within budget");
        return null;
      }
      const fresh = await options.api.getService(BigInt(offered.id));
      if (!fresh || !eligible(fresh.service) || !(await canBuy(BigInt(fresh.service.price)))) {
        log("DECLINE: service or original task changed before purchase");
        return null;
      }
      const requestId = sha256Hex(
        canonicalJson({
          contract: options.chain.contractId,
          task: ctx.task.id,
          brief: ctx.task.brief_hash,
          payer: options.buyer.payer,
        }),
      );
      const { purchaseX402Service } = await import("@tender/payments");
      const result = await purchaseX402Service(fresh.service, plan.input, {
        ...options.buyer,
        requestId,
        maxPrice: policy.maxPrice,
      });
      log(
        `CAPABILITY RESULT: task ${ctx.task.id}, service ${fresh.service.id}, listed price ${fresh.service.price} atomic units (retries reuse the receipt)`,
      );
      return options.complete(ctx, plan.capability, result.body);
    },
  };
}
