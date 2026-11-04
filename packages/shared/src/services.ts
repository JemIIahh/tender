import { z } from "zod";
import { AgentSummarySchema } from "./api";
import { plainTextSchema } from "./board";
import { type Brief, BriefSchema } from "./brief";
import { canonicalJson } from "./canonical";
import { MAX_RESULT_BYTES } from "./constants";
import { type PublicCriteria, PublicCriteriaSchema } from "./criteria";
import { sha256Hex } from "./hash";
import { AccountIdSchema, HashHexSchema, U64StringSchema, U128StringSchema } from "./primitives";
import { rubricCriteriaProblem } from "./rubric";

// Services: what an agent service provider (ASP) offers for hire, at a fixed price.
//
// A service is a listing the API keeps, off chain, for one of the provider's agents: the provider
// itself, or one of its sub-accounts (`bot.acme.near` for `acme.near`, the registry's `asp`). It
// says what the agent does, what it costs, how long it takes and who checks the work. Nothing about
// it is on chain until someone hires it.
//
// A hire is an ordinary task, a pinned one: the hirer posts it with the offering agent as its only
// invited entrant (`max_entries` 1), the listed price as its reward, escrowed by the contract, and
// the service's windows. The brief is the hirer's request with a reference to the service, and the
// criteria are the service's (`hireDocuments`). The agent delivers by commit and reveal, the verifier
// picks, and the contract pays the agent the price less the platform fee. A hire that nothing is
// delivered for is voided by the existing paths, and the contract gives the whole price back.
//
// The listing's words are the provider's, and the request's the hirer's: plain text, under the
// question board's rules (`plainTextSchema`). They are shown as text and read by a model as data.

/** The most characters of a service's title, counted in code points. */
export const SERVICE_TITLE_MAX_CHARS = 80;
/** The most characters of a service's description. */
export const SERVICE_DESCRIPTION_MAX_CHARS = 1_000;
/** The most tags a service lists. */
export const SERVICE_MAX_TAGS = 5;
/** The most characters of a hirer's request. The brief's instructions hold 8,000. */
export const HIRE_REQUEST_MAX_CHARS = 4_000;
/** The most services one provider keeps listed, paused ones included (lane ruling). */
export const SERVICES_PER_PROVIDER = 50;
/** The longest window the contract takes, in seconds (`MAX_WINDOW_SECS` in types.rs): 14 days. */
export const SERVICE_MAX_WINDOW_SECS = 1_209_600;

/**
 * The bytes of Tender storage a hire can use: a post with no invite list takes at most 1,587
 * (`POST_TASK_BYTES` in apps/web/lib/post.ts says how), and the one invited account adds its Borsh
 * form, a 4-byte length and up to 64 bytes. 1,655, rounded up.
 */
export const HIRE_TASK_BYTES = 1_700n;

/** What every hire says of its money, on the page and in the tool's answer alike. */
export const HIRE_MONEY_NOTE =
  "The price is escrowed by the Tender contract when you hire. If the agent delivers and the " +
  "verifier picks the delivery, the agent is paid the price less the platform fee. If nothing is " +
  "delivered, or nothing is picked, the whole price comes back to you.";

/**
 * The criteria kinds that the Judge takes only from the team's posters in v1 (C16 in
 * packages/judge/src/intake.ts): a hire of a service checked by one of them, posted by anyone
 * else, is refused by the Judge, and the hirer picks in the fallback window or the task voids.
 */
export const JUDGE_TEAM_ONLY_KINDS: ReadonlySet<PublicCriteria["kind"]> = new Set([
  "tests",
  "rubric",
]);

/** The fixed text of a service's title: one line of plain text. */
export const ServiceTitleSchema = plainTextSchema(SERVICE_TITLE_MAX_CHARS).refine(
  (text) => !/[\n\r]/.test(text),
  "expected one line, without line breaks",
);
export const ServiceDescriptionSchema = plainTextSchema(SERVICE_DESCRIPTION_MAX_CHARS);
/** A hirer's request: plain text, which the brief carries to the agent. */
export const HireRequestSchema = plainTextSchema(HIRE_REQUEST_MAX_CHARS);

const ServiceTagsSchema = z
  .array(BriefSchema.shape.tags.element)
  .max(SERVICE_MAX_TAGS)
  .refine((tags) => new Set(tags).size === tags.length, "expected each tag once");

/**
 * The highest price a service may ask, in the token's smallest unit: the contract's
 * `MAX_REWARD_LIMIT` (`u128::MAX / 10_000`, types.rs), above which no token can be allowlisted, so
 * no task could be posted at it.
 */
export const SERVICE_MAX_PRICE = (2n ** 128n - 1n) / 10_000n;

/**
 * A price: a u128 above 0 and at most `SERVICE_MAX_PRICE`, in the token's smallest unit. A refine
 * runs even after the u128 check has failed, so the bound is read only of a value that is one (a
 * throw inside it would escape `safeParse`).
 */
const PriceSchema = U128StringSchema.refine(
  (value) => value !== "0",
  "expected a price above 0",
).refine(
  (value) => !U128StringSchema.safeParse(value).success || BigInt(value) <= SERVICE_MAX_PRICE,
  `expected a price of at most ${SERVICE_MAX_PRICE}, the most a task can pay`,
);

/** A window in seconds, within the contract's cap; the network's shortest is the API's to check. */
const WindowSecsSchema = z.int().min(1).max(SERVICE_MAX_WINDOW_SECS);

export const ServiceStatusSchema = z.enum(["active", "paused"]);
export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;

/**
 * Who checks the work of a hire: the hirer itself, who picks it or not, or the Tender Judge,
 * against public criteria the provider lists. The criteria are the existing kinds; which of them
 * a service can use is `verificationProblem`'s.
 */
export const ServiceVerificationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("hirer") }),
  z.strictObject({ kind: z.literal("judge"), criteria: PublicCriteriaSchema }),
]);
export type ServiceVerification = z.infer<typeof ServiceVerificationSchema>;

/** The fields a provider writes, as a create sends them and an update may send some of. */
const termFields = {
  title: ServiceTitleSchema,
  description: ServiceDescriptionSchema,
  tags: ServiceTagsSchema,
  category: BriefSchema.shape.category,
  output_format: BriefSchema.shape.output.shape.format,
  token: AccountIdSchema,
  price: PriceSchema,
  commit_secs: WindowSecsSchema,
  reveal_secs: WindowSecsSchema,
  pick_secs: WindowSecsSchema,
  verification: ServiceVerificationSchema,
};

/** Everything a service's terms hold, once each field is checked. */
export type ServiceTerms = z.infer<z.ZodObject<typeof termFields>>;

/**
 * Why `terms` cannot be a service, or null. The rules that span fields, checked after each field:
 *
 * - a service checked by the Judge carries no held-out checks (`has_heldout` false): a hire is
 *   posted from the listing, and no one could commit to hidden answers for a request that is not
 *   written yet. So `exact` and `json_schema`, for which the Judge needs held-out checks, cannot be
 *   used (the Judge rejects them without);
 * - one entrant, one winner: the split is `winner_take_all`;
 * - `regex_cases` and `tests` have at least one public example, which is what the Judge checks
 *   with when there are no held-out checks (it refuses `tests` without);
 * - a `rubric` keeps the rubric rules of `@tender/shared` (`rubricCriteriaProblem`);
 * - the answer's format is the one the kind reads: `regex_json` for `regex_cases`, `code_js` for
 *   `tests`, and text or JSON for a `rubric`.
 */
export function serviceTermsProblem(
  terms: Pick<ServiceTerms, "verification" | "output_format">,
): string | null {
  const { verification, output_format } = terms;
  if (verification.kind === "hirer") return null;
  const criteria = verification.criteria;
  if (criteria.has_heldout) {
    return "a service's criteria have no held-out checks: has_heldout must be false";
  }
  if (criteria.kind === "exact" || criteria.kind === "json_schema") {
    return `the Judge needs held-out checks for kind ${criteria.kind}, which a service cannot carry: use regex_cases, tests or rubric, or let the hirer accept the work`;
  }
  if (criteria.split !== "winner_take_all") {
    return 'a hire has one entrant: the split must be "winner_take_all"';
  }
  switch (criteria.kind) {
    case "regex_cases":
      if (criteria.examples.match.length + criteria.examples.no_match.length === 0) {
        return "kind regex_cases needs at least one example to check with";
      }
      return output_format === "regex_json"
        ? null
        : "kind regex_cases reads a regex: output_format must be regex_json";
    case "tests":
      if (criteria.examples.length === 0) return "kind tests needs at least one example case";
      return output_format === "code_js"
        ? null
        : "kind tests reads code: output_format must be code_js";
    case "rubric": {
      const problem = rubricCriteriaProblem(criteria);
      if (problem !== null) return `the rubric breaks a rule (${problem})`;
      return output_format === "text" || output_format === "json"
        ? null
        : "kind rubric reads text or JSON: output_format must be text or json";
    }
  }
}

/** `POST /v1/services`: a new service, for `agent`, by the signed-in provider. */
export const CreateServiceRequestSchema = z
  .strictObject({ agent: AccountIdSchema, ...termFields })
  .superRefine((terms, ctx) => {
    const problem = serviceTermsProblem(terms);
    if (problem !== null)
      ctx.addIssue({ code: "custom", message: problem, path: ["verification"] });
  });
export type CreateServiceRequest = z.infer<typeof CreateServiceRequestSchema>;

/**
 * `POST /v1/services/:id`: the fields to change, and the status. The agent stays the one the service
 * was listed for. The rules that span fields are checked on the service as it would be after.
 */
export const UpdateServiceRequestSchema = z
  .strictObject({
    title: termFields.title.optional(),
    description: termFields.description.optional(),
    tags: termFields.tags.optional(),
    category: termFields.category.optional(),
    output_format: termFields.output_format.optional(),
    token: termFields.token.optional(),
    price: termFields.price.optional(),
    commit_secs: termFields.commit_secs.optional(),
    reveal_secs: termFields.reveal_secs.optional(),
    pick_secs: termFields.pick_secs.optional(),
    verification: termFields.verification.optional(),
    status: ServiceStatusSchema.optional(),
  })
  .refine((update) => Object.keys(update).length > 0, "expected at least one field to change");
export type UpdateServiceRequest = z.infer<typeof UpdateServiceRequestSchema>;

// ---- What the API shows -------------------------------------------------------------------------

/**
 * How a service is checked, as the API shows it. A Judge-checked one has its criteria and their
 * hash, which is the `criteria_hash` every hire of it carries on chain, and the account of the Judge
 * that the API serves (`JUDGE_ACCOUNT`), which every hire of it names as its verifier: null when the
 * API has none, and then the service cannot be hired.
 */
export const ServiceVerificationViewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hirer") }),
  z.object({
    kind: z.literal("judge"),
    criteria: PublicCriteriaSchema,
    criteria_hash: HashHexSchema,
    judge: AccountIdSchema.nullable(),
  }),
]);
export type ServiceVerificationView = z.infer<typeof ServiceVerificationViewSchema>;

/**
 * A service as the API shows it (`GET /v1/services`, `GET /v1/services/:id`). `agent_record` is the
 * offering agent as the index has it, the same record `GET /v1/agents/:account` gives: its wins,
 * entries and earnings are the contract's counts, and null only while the index holds no agent of
 * that account. `available` says whether it can be hired now: the service is active, and its agent
 * is an active agent that holds a bond. `is_team` says the team runs the agent, or its provider.
 */
export const ServiceSchema = z.object({
  id: U64StringSchema,
  provider: AccountIdSchema,
  agent: AccountIdSchema,
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  category: BriefSchema.shape.category,
  output_format: BriefSchema.shape.output.shape.format,
  token: AccountIdSchema,
  price: U128StringSchema,
  commit_secs: z.int(),
  reveal_secs: z.int(),
  pick_secs: z.int(),
  verification: ServiceVerificationViewSchema,
  status: ServiceStatusSchema,
  available: z.boolean(),
  is_team: z.boolean(),
  /** ISO 8601 in UTC to the millisecond. */
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  agent_record: AgentSummarySchema.nullable(),
});
export type Service = z.infer<typeof ServiceSchema>;

/** `GET /v1/services`, newest first. `next_cursor` is the last id of the page, null at the end. */
export const ListServicesResponseSchema = z.object({
  services: z.array(ServiceSchema),
  next_cursor: U64StringSchema.nullable(),
});
export type ListServicesResponse = z.infer<typeof ListServicesResponseSchema>;

/** `GET /v1/services/:id`, `POST /v1/services` and `POST /v1/services/:id`. */
export const ServiceResponseSchema = z.object({ service: ServiceSchema });
export type ServiceResponse = z.infer<typeof ServiceResponseSchema>;

/** What `GET /v1/services` can be filtered by. A field left out is no filter. */
export interface ListServicesFilter {
  /** Words that the title or the description contains, as typed: 1 to 80 characters. */
  q?: string;
  /** Only services that list this tag. */
  tag?: string;
  /** Only the services of this provider. */
  provider?: string;
  /** Only the services this agent offers. */
  agent?: string;
  /** Only services priced in this token. */
  token?: string;
  /** Only services priced at most this, in `token`'s smallest unit: it needs `token`. */
  maxPrice?: bigint;
  /**
   * `available` (the default): those that can be hired now. `all`: every service, paused ones and
   * those whose agent cannot take work too, as a provider's dashboard lists them.
   */
  status?: "available" | "all";
  /** Page size, from 1 to 50. The API's default is 20. */
  limit?: number;
  /** The `next_cursor` of the page before. Null or absent: the first page. */
  cursor?: string | null;
}

// ---- A hire -------------------------------------------------------------------------------------

/**
 * The criteria of a hire that the hirer accepts: one point, that the hirer accepts the work. The
 * hirer is the verifier and picks, so no one scores against it; it says on chain how the work is
 * checked.
 */
export const HIRER_ACCEPTS_CRITERIA: PublicCriteria = Object.freeze({
  version: 1,
  kind: "rubric",
  min_score: 1,
  split: "winner_take_all",
  has_heldout: false,
  rubric: [
    {
      criterion: "The hirer accepts the delivery as what the service and the request ask for",
      weight: 1,
    },
  ],
}) as PublicCriteria;

/** The SHA-256 of `HIRER_ACCEPTS_CRITERIA`'s canonical bytes: the `criteria_hash` of every such hire. */
export const HIRER_ACCEPTS_CRITERIA_HASH = sha256Hex(canonicalJson(HIRER_ACCEPTS_CRITERIA));

/** The `criteria_hash` that every hire of `service` carries on chain. */
export function hireCriteriaHash(service: Pick<Service, "verification">): string {
  return service.verification.kind === "judge"
    ? service.verification.criteria_hash
    : HIRER_ACCEPTS_CRITERIA_HASH;
}

/**
 * Whether `criteriaHash` is the criteria of a hire of `agent`: those of a hire the hirer accepts, the
 * same for every service (`HIRER_ACCEPTS_CRITERIA_HASH`), or those every hire of one of `services`
 * that `agent` offers carries (`hireCriteriaHash`). The agent runner asks it of a task that invites
 * its agent; `isHireTask` asks it of the one account a task invites.
 */
export function isHireCriteriaOf(
  criteriaHash: string,
  agent: string,
  services: readonly Pick<Service, "agent" | "verification">[],
): boolean {
  return (
    criteriaHash === HIRER_ACCEPTS_CRITERIA_HASH ||
    services.some(
      (service) => service.agent === agent && hireCriteriaHash(service) === criteriaHash,
    )
  );
}

/**
 * The account a task is pinned to the way a hire is: it invites exactly one account and takes one
 * entry (`max_entries` 1), as `hireTerms` posts a hire. That account, or null for a task of any
 * other shape. The agent runner takes a hire only when this is its own agent.
 */
export function hireeOf(task: { invited: readonly string[]; max_entries: number }): string | null {
  const [agent, ...others] = task.invited;
  return task.max_entries === 1 && agent !== undefined && others.length === 0 ? agent : null;
}

/**
 * Whether a task's terms mark it as a hire of a service: it is pinned as a hire is (`hireeOf`), and
 * it carries the criteria of a hire of that account (`isHireCriteriaOf`). It says what the task is,
 * not whether its terms meet the service's: `hireMismatch` is that. `GET /v1/tasks` with
 * `hire=true` filters by the same rule, in SQL, and the API's test holds the two together.
 */
export function isHireTask(
  task: { invited: readonly string[]; max_entries: number; criteria_hash: string },
  services: readonly Pick<Service, "agent" | "verification">[],
): boolean {
  const agent = hireeOf(task);
  return agent !== null && isHireCriteriaOf(task.criteria_hash, agent, services);
}

/** What `hireMismatch` reads of a task: the fields of its detail that a hire fixes. */
export interface HireTaskTerms {
  poster: string;
  verifier: string;
  token: string;
  /** A u128 as a decimal string. */
  reward: string;
  criteria_hash: string;
  /** Nanoseconds since the epoch, as decimal strings. */
  created_at: string;
  commit_deadline: string;
  reveal_deadline: string;
  pick_deadline: string;
}

const NS_PER_SEC = 1_000_000_000n;

/**
 * Why the task `task`, which carries `service`'s criteria hash, is not a hire of `service` that its
 * agent should take, or null if it is one. A hire pays in the service's token, at least its price;
 * names the verifier the service says (the Judge the API serves, or the poster itself); and has
 * windows at least as long as the service's. The service must be active. The task's invited list and
 * entry cap are the caller's to check first, as they do not depend on the service. The reasons are
 * for a log line: they quote the task's and the service's figures, and no words of either.
 */
export function hireMismatch(task: HireTaskTerms, service: Service): string | null {
  const name = `service ${service.id}`;
  if (service.status !== "active") return `${name} is paused`;
  if (task.criteria_hash !== hireCriteriaHash(service)) {
    return `its criteria are not ${name}'s`;
  }
  if (task.token !== service.token) {
    return `it pays in ${task.token}, and ${name} is priced in ${service.token}`;
  }
  const { verification } = service;
  if (verification.kind === "judge") {
    if (verification.judge === null || task.verifier !== verification.judge) {
      return `${name} is checked by the Judge, and the task names ${task.verifier} as its verifier`;
    }
  } else if (task.verifier !== task.poster) {
    return `${name} is checked by the hirer, and the task names ${task.verifier} as its verifier, not its poster`;
  }
  if (BigInt(task.reward) < BigInt(service.price)) {
    return `it pays ${task.reward}, below the ${service.price} that ${name} costs`;
  }
  const created = BigInt(task.created_at);
  const commit = BigInt(task.commit_deadline);
  const reveal = BigInt(task.reveal_deadline);
  const pick = BigInt(task.pick_deadline);
  if (
    commit - created < BigInt(service.commit_secs) * NS_PER_SEC ||
    reveal - commit < BigInt(service.reveal_secs) * NS_PER_SEC ||
    pick - reveal < BigInt(service.pick_secs) * NS_PER_SEC
  ) {
    return `its windows are shorter than ${name}'s`;
  }
  return null;
}

/** What a hire is made of: the service's terms, as the API showed them. */
export type HiredService = Pick<
  Service,
  | "id"
  | "provider"
  | "agent"
  | "title"
  | "description"
  | "tags"
  | "category"
  | "output_format"
  | "token"
  | "price"
  | "commit_secs"
  | "reveal_secs"
  | "pick_secs"
  | "verification"
>;

/** A hire's two public documents, as the canonical bytes that are uploaded and hashed on chain. */
export interface HireDocuments {
  brief: Brief;
  briefBytes: Uint8Array;
  briefHash: string;
  criteria: PublicCriteria;
  criteriaBytes: Uint8Array;
  criteriaHash: string;
}

/**
 * The brief and the criteria of a hire of `service` with `request`, the hirer's words, which must
 * fit `HireRequestSchema` (trimmed as it trims them; a `ZodError` otherwise). The brief carries the
 * request first and then the reference to the service, so that the agent's solver reads the request
 * as the task. The criteria are the service's own for the Judge (so every hire of it has the
 * service's `criteria_hash`), or `HIRER_ACCEPTS_CRITERIA`.
 */
export function hireDocuments(service: HiredService, request: string): HireDocuments {
  const words = HireRequestSchema.parse(request);
  const brief = BriefSchema.parse({
    version: 1,
    title: `Hire: ${service.title}`,
    summary: `A hire of service ${service.id}, offered by ${service.agent}, at its listed price.`,
    instructions:
      `${words}\n\n---\n` +
      `This task hires service ${service.id} on Tender, "${service.title}", offered by ` +
      `${service.agent} (provider ${service.provider}). The request above is the hirer's. ` +
      `The service's description, in the provider's words:\n${service.description}`,
    category: service.category,
    tags: service.tags,
    output: { format: service.output_format, max_bytes: MAX_RESULT_BYTES },
  });
  const criteria =
    service.verification.kind === "judge" ? service.verification.criteria : HIRER_ACCEPTS_CRITERIA;
  const briefBytes = canonicalJson(brief);
  const criteriaBytes = canonicalJson(criteria);
  return {
    brief,
    briefBytes,
    briefHash: sha256Hex(briefBytes),
    criteria,
    criteriaBytes,
    criteriaHash: sha256Hex(criteriaBytes),
  };
}

/** The terms of the pinned task that hires `service`, but for the documents' uri and hashes. */
export interface HireTerms {
  token: string;
  reward: bigint;
  /** Undefined: the hirer, as the poster, verifies. */
  verifier: string | undefined;
  invited: string[];
  maxEntries: 1;
  maxWinners: 1;
  commitSecs: number;
  revealSecs: number;
  pickSecs: number;
  /** The same as the pick window (lane ruling): the hirer's own window to pick after the Judge's. */
  fallbackSecs: number;
}

/**
 * The task terms of a hire: the price as the reward, the agent as the one invited entrant, the
 * service's windows, and the Judge as the verifier when the service says so (`judgeAccount`, which
 * must be set then and be the Judge the service names; a `RangeError` otherwise).
 */
export function hireTerms(service: HiredService, judgeAccount: string | null): HireTerms {
  let verifier: string | undefined;
  if (service.verification.kind === "judge") {
    if (judgeAccount === null)
      throw new RangeError("this service is checked by the Judge, and no Judge account is set");
    // The agent takes a hire only if it names the Judge the API names (`hireMismatch`).
    if (service.verification.judge !== judgeAccount) {
      throw new RangeError(
        `this service is checked by the Judge ${service.verification.judge ?? "(none)"}, and the Judge here is ${judgeAccount}`,
      );
    }
    verifier = judgeAccount;
  }
  return {
    token: service.token,
    reward: BigInt(service.price),
    verifier,
    invited: [service.agent],
    maxEntries: 1,
    maxWinners: 1,
    commitSecs: service.commit_secs,
    revealSecs: service.reveal_secs,
    pickSecs: service.pick_secs,
    fallbackSecs: service.pick_secs,
  };
}

/** The four windows of a hire of `service`, added up: how long it can take, at the most. */
export function hireSpanSecs(service: Pick<Service, "commit_secs" | "reveal_secs" | "pick_secs">) {
  return service.commit_secs + service.reveal_secs + 2 * service.pick_secs;
}
