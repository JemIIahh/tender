import {
  type CreateServiceRequest,
  CreateServiceRequestSchema,
  PublicCriteriaSchema,
  SERVICE_DESCRIPTION_MAX_CHARS,
  SERVICE_MAX_TAGS,
  SERVICE_MAX_WINDOW_SECS,
  SERVICE_TITLE_MAX_CHARS,
  type Service,
  ServiceDescriptionSchema,
  ServiceTitleSchema,
  serviceTermsProblem,
  tokenMeta,
} from "@tender/shared";
import { CATEGORIES, type Category, parseTags, spanText } from "./briefTerms";
import { config } from "./config";
import { readAmount } from "./vault";

// What the pages say of a service (the Services page, a service's page, the provider's section of
// My agents), and the provider's form: what it holds as it is typed, what is wrong with it, and the
// request it becomes. Every rule of a listing is the shared one (`@tender/shared`'s services.ts),
// which the API holds too; this only puts it in words for the form.

/** How a service is checked, in two or three words. */
export function checkedBy(service: Pick<Service, "verification">): string {
  return service.verification.kind === "judge" ? "Tender Judge checks" : "You accept the work";
}

/** How a service is checked, in a sentence. */
export function checkedSentence(service: Pick<Service, "verification">): string {
  const { verification } = service;
  if (verification.kind === "hirer") {
    return "You check the work yourself: once it is revealed, you pick it to pay the agent, or pick nobody.";
  }
  const { criteria } = verification;
  return `The Tender Judge scores the delivery against public criteria the provider wrote (${criteria.kind.replace("_", " ")}, pass mark ${criteria.min_score}), not against your request. If it passes, the Judge picks it and the contract pays the agent.`;
}

/** The windows of a hire in a line: `Delivered within 10m · Revealed 5m · Picked 10m`. */
export function windowsLine(service: Pick<Service, "commit_secs" | "reveal_secs" | "pick_secs">) {
  return `Delivered within ${spanText(service.commit_secs)} · Revealed ${spanText(service.reveal_secs)} · Picked ${spanText(service.pick_secs)}`;
}

/** Whether `service` has words or a tag that the search `query` names, case aside. */
export function matchesQuery(
  service: Pick<Service, "title" | "description" | "tags">,
  query: string,
) {
  const words = query.trim().toLowerCase();
  if (words === "") return true;
  return (
    service.title.toLowerCase().includes(words) ||
    service.description.toLowerCase().includes(words) ||
    service.tags.some((tag) => tag === words)
  );
}

// ---- The provider's form ------------------------------------------------------------------------

/** The formats a service's answer can have: the brief's, with code for the `tests` kind. */
export const SERVICE_FORMATS = ["text", "json", "regex_json", "code_js"] as const;

export const SERVICE_FORMAT_LABEL: Record<string, string> = {
  text: "Plain text",
  json: "JSON",
  regex_json: "A regex, as JSON",
  code_js: "JavaScript code",
};

/** The provider's form, as it is typed. Windows are whole minutes. */
export interface ServiceForm {
  agent: string;
  title: string;
  description: string;
  /** Separated by commas or spaces. */
  tags: string;
  category: Category;
  outputFormat: string;
  token: string;
  /** In whole units of the token, as `2.5`. */
  price: string;
  commitMinutes: string;
  revealMinutes: string;
  pickMinutes: string;
  verifier: "hirer" | "judge";
  /** The public criteria, as JSON text, for a service the Judge checks. */
  criteria: string;
  /**
   * The windows of the service being changed, as listed: the minutes the form first showed for each
   * and the seconds behind them. A window whose minutes are left as shown keeps its seconds, so a
   * service listed with windows that are no whole number of minutes is not changed by a save.
   */
  listed?: Record<WindowKey, { minutes: string; secs: number }>;
}

export type WindowKey = "commit" | "reveal" | "pick";
const WINDOW_FIELDS: Record<WindowKey, "commitMinutes" | "revealMinutes" | "pickMinutes"> = {
  commit: "commitMinutes",
  reveal: "revealMinutes",
  pick: "pickMinutes",
};

/** A blank form for one of `agents`, priced in `token`. */
export function emptyServiceForm(agents: readonly string[], token: string): ServiceForm {
  return {
    agent: agents[0] ?? "",
    title: "",
    description: "",
    tags: "",
    category: "other",
    outputFormat: "text",
    token,
    price: "",
    commitMinutes: "60",
    revealMinutes: "30",
    pickMinutes: "60",
    verifier: "hirer",
    criteria: "",
  };
}

/** A service as the form shows it, to change it. */
export function formOfService(service: Service): ServiceForm {
  const { decimals } = tokenMeta(service.token, config.network);
  const whole = BigInt(service.price);
  const unit = 10n ** BigInt(decimals);
  const fraction = (whole % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return {
    agent: service.agent,
    title: service.title,
    description: service.description,
    tags: service.tags.join(", "),
    category: service.category,
    outputFormat: service.output_format,
    token: service.token,
    price: `${whole / unit}${fraction === "" ? "" : `.${fraction}`}`,
    commitMinutes: String(Math.ceil(service.commit_secs / 60)),
    revealMinutes: String(Math.ceil(service.reveal_secs / 60)),
    pickMinutes: String(Math.ceil(service.pick_secs / 60)),
    listed: {
      commit: { minutes: String(Math.ceil(service.commit_secs / 60)), secs: service.commit_secs },
      reveal: { minutes: String(Math.ceil(service.reveal_secs / 60)), secs: service.reveal_secs },
      pick: { minutes: String(Math.ceil(service.pick_secs / 60)), secs: service.pick_secs },
    },
    verifier: service.verification.kind,
    criteria:
      service.verification.kind === "judge"
        ? JSON.stringify(service.verification.criteria, null, 2)
        : "",
  };
}

export type ServiceErrors = Partial<Record<keyof ServiceForm | "form", string>>;

/** A field's message from a schema's refusal: its first issue, with a capital and a full stop. */
function sentence(text: string): string {
  const trimmed = text.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

function minutes(text: string): number | null {
  const typed = text.trim();
  if (!/^[0-9]{1,6}$/.test(typed)) return null;
  const secs = Number(typed) * 60;
  return secs > 0 && secs <= SERVICE_MAX_WINDOW_SECS ? secs : null;
}

/**
 * The window `key` of `form` in seconds: the listed seconds when its minutes are as the form first
 * showed them, else the minutes typed, or null if they are no window.
 */
export function windowSecsOf(form: ServiceForm, key: WindowKey): number | null {
  const typed = form[WINDOW_FIELDS[key]];
  const kept = form.listed?.[key];
  if (kept !== undefined && typed.trim() === kept.minutes) return kept.secs;
  return minutes(typed);
}

/**
 * What is wrong with `form`, field by field, against the network's shortest window. Empty when it
 * can be sent. The rules are the shared ones; the words are the form's.
 */
export function checkServiceForm(form: ServiceForm, minWindowSecs: number): ServiceErrors {
  const errors: ServiceErrors = {};
  if (form.agent === "") errors.agent = "Choose the agent that offers it.";
  const title = ServiceTitleSchema.safeParse(form.title);
  if (!title.success) {
    errors.title =
      form.title.trim() === ""
        ? "Give it a title."
        : sentence(title.error.issues[0]?.message ?? "Check the title.");
  }
  const description = ServiceDescriptionSchema.safeParse(form.description);
  if (!description.success) {
    errors.description =
      form.description.trim() === ""
        ? "Say what the agent does."
        : sentence(description.error.issues[0]?.message ?? "Check the description.");
  }
  const tags = parseTags(form.tags);
  if (tags.length > SERVICE_MAX_TAGS) errors.tags = `Up to ${SERVICE_MAX_TAGS} tags.`;
  else if (tags.some((tag) => !/^[a-z0-9-]{1,24}$/.test(tag))) {
    errors.tags = "Tags are a-z, 0-9 and -, up to 24 characters each.";
  }
  const price = readAmount(form.price, form.token, null, "vault");
  if (!price.ok) errors.price = price.message;
  for (const [window, key, label] of [
    ["commit", "commitMinutes", "delivery"],
    ["reveal", "revealMinutes", "reveal"],
    ["pick", "pickMinutes", "pick"],
  ] as const) {
    const secs = windowSecsOf(form, window);
    if (secs === null) errors[key] = "Use a whole number of minutes above 0, up to 14 days.";
    else if (secs < minWindowSecs) {
      errors[key] = `The ${label} window is at least ${spanText(minWindowSecs)} on this network.`;
    }
  }
  if (form.verifier === "judge") {
    if (config.judgeAccount === null) {
      errors.verifier =
        "This site isn't set up with the Tender Judge. Let the hirer accept the work.";
    }
    const criteria = criteriaOf(form.criteria);
    if (criteria === null) {
      errors.criteria = "Write the public criteria as JSON (kind regex_cases, tests or rubric).";
    } else {
      const problem = serviceTermsProblem({
        output_format: form.outputFormat as CreateServiceRequest["output_format"],
        verification: { kind: "judge", criteria },
      });
      if (problem !== null) errors.criteria = sentence(problem);
    }
  }
  return errors;
}

function criteriaOf(text: string) {
  try {
    const parsed = PublicCriteriaSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The request a checked form becomes. Throws a `RangeError` for a form that `checkServiceForm`
 * would refuse; the page checks first.
 */
export function serviceRequestOf(form: ServiceForm): CreateServiceRequest {
  const price = readAmount(form.price, form.token, null, "vault");
  if (!price.ok) throw new RangeError(price.message);
  const criteria = form.verifier === "judge" ? criteriaOf(form.criteria) : null;
  const parsed = CreateServiceRequestSchema.safeParse({
    agent: form.agent,
    title: form.title,
    description: form.description,
    tags: parseTags(form.tags),
    category: form.category,
    output_format: form.outputFormat,
    token: form.token,
    price: price.amount.toString(),
    commit_secs: windowSecsOf(form, "commit"),
    reveal_secs: windowSecsOf(form, "reveal"),
    pick_secs: windowSecsOf(form, "pick"),
    verification: criteria === null ? { kind: "hirer" } : { kind: "judge", criteria },
  });
  if (!parsed.success) throw new RangeError(parsed.error.issues[0]?.message ?? "not a service");
  return parsed.data;
}

export { CATEGORIES, SERVICE_DESCRIPTION_MAX_CHARS, SERVICE_TITLE_MAX_CHARS };
