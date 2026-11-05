import {
  AccountIdSchema,
  type Brief,
  BriefSchema,
  ConfigViewSchema,
  canonicalJson,
  criterionKey,
  depositCall,
  HeldoutSchema,
  heldoutMatchesCriteria,
  MAX_RESULT_BYTES,
  MAX_URI_BYTES,
  type PublicCriteria,
  PublicCriteriaSchema,
  postTaskCall,
  RUBRIC_MAX_CRITERIA,
  RUBRIC_MAX_CRITERION_CHARS,
  RUBRIC_MAX_ENTRIES,
  RUBRIC_MIN_SCORE,
  type RubricProblem,
  randomSalt,
  rubricCriteriaProblem,
  sha256Hex,
  splitReward,
  storageDepositCall,
  storageShortfall,
  type TenderCall,
  tokenMeta,
} from "@tender/shared";
import {
  type AnswerFormat,
  type Category,
  type CheckKind,
  FORMAT_LABEL,
  KINDS,
  type KindInfo,
  parseTags,
  spanText,
} from "./briefTerms";
import { config } from "./config";
import { RpcError, view } from "./rpc";
import { describeAmount, readAmount, type StorageBalance, type VaultData } from "./vault";

// What the post form (components/post) knows about a task: the form a person fills in, what is
// wrong with it, the three documents it is turned into, and the calls that post them. The
// components hold the state and show the words; every rule is here, so that a test can state it.
//
// The held-out checks are the one secret in the form. Nothing here puts their text in an error,
// and `DocumentError` never quotes a document that holds them.

/** The most seconds a window may last, as the contract has it (`MAX_WINDOW_SECS`): 14 days. */
export const MAX_WINDOW_SECS = 1_209_600;

/** The most agents a task can invite, as the contract has it (`MAX_INVITED`, types.rs). */
export const MAX_INVITED = 20;

/**
 * The bytes of Tender storage a post can use, with a little to spare. `post_task` charges the poster
 * `40 + 1 + 8 + Borsh(Task)` bytes for the task record and holds `OUTCOME_RESERVE_BYTES` (800) back
 * for its outcome (contract/tender/src/tasks.rs, `post_task` and the test that measures what it
 * charges; types.rs). A task the form writes (no invite list, no parent) has a Borsh(Task) of 738
 * bytes at the most: three account ids at their longest (204), a 256-byte brief address (260), two
 * hashes (64), the held-out commitment (33), one funder (88) and 89 of fixed fields. So the most is
 * 787 + 800 = 1,587 bytes. This is the figure the review of the wizard (06-T4) derived. An invite
 * list adds its accounts to the record (`inviteBytes`), and a post adds those bytes to this figure.
 */
export const POST_TASK_BYTES = 1_600n;

/**
 * What a first deposit of a token adds: its slot in the vault, charged to the account the deposit is
 * for, `VAULT_SLOT_MAX_BYTES` (types.rs) at the most. `ft_on_transfer` (vault.rs) refuses a deposit
 * whose slot the storage cannot pay for, the token hands it back, and `post_task` then fails with
 * `E_FUNDS`. So a post that opens a slot sets this much aside as well.
 */
export const VAULT_SLOT_BYTES = 200n;

// ---- The form -----------------------------------------------------------------------------------

// The categories, the kinds of check and the formats by name, tags and a window's length in words
// are in lib/briefTerms.ts, for the pages that only say them; the form's rules about them are here.
export {
  type AnswerFormat,
  CATEGORIES,
  type Category,
  type CheckKind,
  FORMAT_LABEL,
  KINDS,
  type KindInfo,
  parseTags,
  spanText,
} from "./briefTerms";

/** The same formats in the middle of a sentence, where `FORMAT_LABEL` would have a capital. */
export const FORMAT_PHRASE: Record<AnswerFormat, string> = {
  text: "plain text",
  json: "JSON",
  regex_json: "a regex, as JSON",
};

/** The formats each kind of check can score. The Judge reads the answer as this. */
const FORMATS_FOR_KIND: Record<CheckKind, readonly AnswerFormat[]> = {
  exact: ["text", "json"],
  json_schema: ["json"],
  regex_cases: ["regex_json"],
  rubric: ["text", "json"],
};

/** The kinds to offer: the rubric is for team accounts only. */
export function kindsFor(canRubric: boolean): readonly KindInfo[] {
  return canRubric ? KINDS : KINDS.filter(({ kind }) => kind !== "rubric");
}

/** The format an answer has under `kind`: the one it has already if the kind can score it. */
export function formatForKind(kind: CheckKind, current: AnswerFormat): AnswerFormat {
  const allowed = FORMATS_FOR_KIND[kind];
  return allowed.includes(current) ? current : (allowed[0] ?? "text");
}

export type Verifier = "judge" | "me" | "other";
/**
 * How the windows are set: from one deadline (`deadline`), which the page works the other windows
 * out from, or each by hand under More options (`custom`).
 */
export type Timing = "deadline" | "custom";
export type WindowName = "commit" | "reveal" | "pick" | "fallback";
export const WINDOW_NAMES: readonly WindowName[] = ["commit", "reveal", "pick", "fallback"];
export type DurationUnit = "seconds" | "minutes" | "hours" | "days";
export const DURATION_UNITS: readonly DurationUnit[] = ["seconds", "minutes", "hours", "days"];

/** A window as it is typed: a count of whole units. */
export interface Duration {
  amount: string;
  unit: DurationUnit;
}

/** A value the Judge checks inside a JSON answer: `equals` is JSON text. */
export interface Assertion {
  path: string;
  equals: string;
}

/** A point of a rubric: `weight` is typed. */
export interface RubricRow {
  criterion: string;
  weight: string;
}

/**
 * What the post form collects, as it is typed: text stays text until a check reads it, so that a
 * half-written number or a half-written schema is something the form can hold.
 */
export interface PostForm {
  // Brief
  title: string;
  summary: string;
  instructions: string;
  /** Not asked for: every task the page posts is `other`. The brief's schema needs one. */
  category: Category;
  /** Separated by commas or spaces. */
  tags: string;
  outputFormat: AnswerFormat;
  maxBytes: string;

  // Checks
  kind: CheckKind;
  /** The pass mark, 0 to 100. */
  minScore: string;
  /** `exact`: the steps both sides go through before they are compared. */
  trim: boolean;
  lowercase: boolean;
  collapseWs: boolean;
  /** `exact`, held out: the answers that are accepted, one to a line. */
  expected: string;
  /** `json_schema`, public: the schema, as JSON text. */
  schema: string;
  /** `json_schema`, held out: values the Judge checks in the answer. */
  assertions: Assertion[];
  /** `regex_cases`, public: strings to match and not to match, one to a line. */
  examplesMatch: string;
  examplesNoMatch: string;
  /** `regex_cases`, held out: more of the same. The Judge scores on these if there are any. */
  heldoutMatch: string;
  heldoutNoMatch: string;
  /**
   * The salt of the held-out checks: 32 random bytes as 64 lowercase hex characters, drawn once for
   * the form (`emptyForm`), so that every document the steps make of it, the one Review offers as a
   * file and the one that is posted, has the same commitment. Without it a short answer could be
   * found by hashing likely answers until one gives the commitment on chain. Not shown or typed.
   */
  heldoutSalt: string;
  /** `rubric`, public. */
  rubric: RubricRow[];

  // Reward
  /** The token's account id; empty until chosen, which is `defaultToken`. */
  token: string;
  amount: string;
  timing: Timing;
  /**
   * When agents stop answering, as a `datetime-local` field holds it: `YYYY-MM-DDTHH:mm`, in the
   * viewer's time zone. The commit window runs from the post to it.
   */
  deadline: string;
  /** The windows of `custom`. */
  custom: Record<WindowName, Duration>;
  verifier: Verifier;
  otherVerifier: string;

  // Who can enter
  /** The agents invited, one account to a line or separated by commas; empty: anyone can enter. */
  invited: string;
  /** The most entries an invite-only task takes; empty: as many as are invited. */
  maxEntries: string;
}

export interface Windows {
  commit: number;
  reveal: number;
  pick: number;
  fallback: number;
}

/** The quick picks beside the deadline, from the time they are pressed. */
export const QUICK_DEADLINES: ReadonlyArray<{ label: string; secs: number }> = [
  { label: "1 h", secs: 3_600 },
  { label: "24 h", secs: 86_400 },
  { label: "3 days", secs: 259_200 },
  { label: "1 week", secs: 604_800 },
];

/** The deadline a new form has: a day from now. */
export const DEFAULT_DEADLINE_SECS = 86_400;

export const WINDOW_TEXT: Record<WindowName, { label: string; detail: string }> = {
  commit: { label: "Answer", detail: "Agents send sealed answers (commit)." },
  reveal: { label: "Open", detail: "Agents open what they sent (reveal)." },
  pick: { label: "Pick", detail: "The checker picks the winner." },
  fallback: { label: "Fallback", detail: "If the checker doesn't, you can." },
};

const MINUTE_MS = 60_000;

/** `ms` as a `datetime-local` value in the viewer's time zone, to the minute. */
export function deadlineInput(ms: number): string {
  const at = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}`;
}

/** The deadline `secs` from `nowMs`, rounded up to the next whole minute, as the field holds it. */
export function deadlineIn(secs: number, nowMs: number): string {
  return deadlineInput(Math.ceil((nowMs + secs * 1000) / MINUTE_MS) * MINUTE_MS);
}

/** The time a `datetime-local` value names, in ms, or null if it names none. */
export function deadlineMs(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value.trim())) return null;
  // A date and time with no offset is read in the viewer's time zone.
  const ms = new Date(value.trim()).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** To five minutes, so that a press a few minutes after the deadline was set gives the same. */
const roundToFiveMinutes = (secs: number) => Math.round(secs / 300) * 300;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * The windows of a task whose agents answer for `commitSecs`: opening their answers takes a twelfth
 * of that (5 minutes to 12 hours), the pick a sixth (10 minutes to 2 days), and the poster's
 * fallback six times the pick (10 minutes to 3 days), each to five minutes. A day to answer gives
 * 2 hours, 4 hours and a day. Every window it gives but the first is 5 minutes to 3 days, which
 * every network's limits take; the first is the deadline's, and is checked against them.
 */
export function windowsForDeadline(commitSecs: number): Windows {
  const pick = clamp(roundToFiveMinutes(commitSecs / 6), 600, 172_800);
  return {
    commit: commitSecs,
    reveal: clamp(roundToFiveMinutes(commitSecs / 12), 300, 43_200),
    pick,
    fallback: clamp(pick * 6, 600, 259_200),
  };
}

const UNIT_SECS: Record<DurationUnit, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3_600,
  days: 86_400,
};

/** The `Custom` windows, filled with the seconds of `windows` in the largest unit that fits. */
export function durationsOf(windows: Windows): Record<WindowName, Duration> {
  const durations = {} as Record<WindowName, Duration>;
  for (const name of WINDOW_NAMES) {
    const secs = windows[name];
    const unit: DurationUnit =
      secs % 86_400 === 0
        ? "days"
        : secs % 3_600 === 0
          ? "hours"
          : secs % 60 === 0
            ? "minutes"
            : "seconds";
    durations[name] = { amount: String(secs / UNIT_SECS[unit]), unit };
  }
  return durations;
}

/**
 * A new form. `judgeAccount`: the Judge is the default verifier if this build knows its account.
 * The deadline is a day after `nowMs` (now unless said).
 */
export function emptyForm(options: { judgeAccount: string | null; nowMs?: number }): PostForm {
  const nowMs = options.nowMs ?? Date.now();
  return {
    title: "",
    summary: "",
    instructions: "",
    category: "other",
    tags: "",
    outputFormat: "text",
    maxBytes: "4096",
    kind: "exact",
    minScore: "100",
    trim: true,
    lowercase: false,
    collapseWs: false,
    expected: "",
    schema: "",
    assertions: [{ path: "", equals: "" }],
    examplesMatch: "",
    examplesNoMatch: "",
    heldoutMatch: "",
    heldoutNoMatch: "",
    heldoutSalt: randomSalt(),
    rubric: [{ criterion: "", weight: "5" }],
    token: "",
    amount: "",
    timing: "deadline",
    deadline: deadlineIn(DEFAULT_DEADLINE_SECS, nowMs),
    custom: durationsOf(windowsForDeadline(DEFAULT_DEADLINE_SECS)),
    verifier: options.judgeAccount === null ? "me" : "judge",
    otherVerifier: "",
    invited: "",
    maxEntries: "",
  };
}

/** The accounts in `text`, as typed: separated by commas, spaces or lines, each trimmed. */
export function accountsOf(text: string): string[] {
  return text.split(/[\s,]+/).filter((account) => account !== "");
}

/** The agents a form invites, in the order typed. */
export function invitedOf(form: PostForm): string[] {
  return accountsOf(form.invited);
}

/**
 * The bytes the invite list adds to the task record the contract charges for: Borsh writes each
 * account as its length (4 bytes) and its bytes. `POST_TASK_BYTES` holds an empty list.
 */
export function inviteBytes(form: PostForm): bigint {
  const encoder = new TextEncoder();
  return invitedOf(form).reduce(
    (sum, account) => sum + 4n + BigInt(encoder.encode(account).length),
    0n,
  );
}

/**
 * The `max_entries` a form posts: 0, no limit, for a task open to anyone (the contract takes a
 * limit only with an invite list); for an invite-only one, the number typed, or as many as are
 * invited (each agent has one entry, so that is no limit either, and it is what a rubric task
 * needs: 1 to `RUBRIC_MAX_ENTRIES`). NaN for a number that is not one, which the checks refuse.
 */
export function maxEntriesOf(form: PostForm): number {
  const invited = invitedOf(form).length;
  if (invited === 0) return 0;
  const typed = form.maxEntries.trim();
  if (typed === "") return invited;
  return /^[0-9]{1,9}$/.test(typed) ? Number(typed) : Number.NaN;
}

// ---- Reading what was typed ---------------------------------------------------------------------

/** The characters in `text`, as the schemas count them: code points, not UTF-16 units. */
const length = (text: string): number => [...text].length;

/**
 * The cases in `text`, one to a line. A line break is the end of a case, and a line with nothing
 * but spaces on it is no case. Spaces inside a case stay, since a regex can care about them; so a
 * case that is only spaces, or empty, cannot be written here.
 */
export function linesOf(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() !== "");
}

const TAG = /^[a-z0-9-]{1,24}$/;
/** A path into a JSON answer, as the Judge reads one: `$`, `.key` and `[0]`. */
const ASSERTION_PATH = /^\$(?:\.[^.[]+|\[(?:0|[1-9]\d*)\])*$/;

type JsonText = { ok: true; value: unknown } | { ok: false };

function parseJson(text: string): JsonText {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** The rows of a list that the person has written something in. A row of nothing is left out. */
export function filledAssertions(form: PostForm): Assertion[] {
  return form.assertions.filter((row) => row.path.trim() !== "" || row.equals.trim() !== "");
}

export function filledRubric(form: PostForm): RubricRow[] {
  return form.rubric.filter((row) => row.criterion.trim() !== "" || row.weight.trim() !== "");
}

// ---- What is wrong with the form ----------------------------------------------------------------

/**
 * Problems by the field they belong to, in the order the fields are on the page. A key is the id of
 * the field without its `post-` prefix, so that the page can take the person to the first one.
 * `form` is a problem that belongs to no single field.
 */
export type Errors = Record<string, string>;

export function checkBrief(form: PostForm): Errors {
  const errors: Errors = {};

  const title = form.title.trim();
  if (title === "") errors.title = "Give the task a title.";
  else if (length(title) > 120) errors.title = "Use 120 characters or fewer.";

  if (length(form.summary.trim()) > 280) errors.summary = "Use 280 characters or fewer.";

  const instructions = form.instructions.trim();
  if (instructions === "") errors.instructions = "Tell agents what to do.";
  else if (length(instructions) > 8000) errors.instructions = "Use 8,000 characters or fewer.";

  const tags = parseTags(form.tags);
  const bad = tags.find((tag) => !TAG.test(tag));
  if (bad !== undefined) {
    errors.tags = `Tags use a to z, 0 to 9 and "-", up to 24 characters. Change "${bad}".`;
  } else if (tags.length > 8) {
    errors.tags = "Use 8 tags or fewer.";
  }

  const bytes = form.maxBytes.trim();
  if (!/^[0-9]{1,7}$/.test(bytes) || Number(bytes) < 1 || Number(bytes) > MAX_RESULT_BYTES) {
    errors.maxBytes = `Use a whole number from 1 to ${MAX_RESULT_BYTES.toLocaleString("en-US")}.`;
  }

  // What the schema would turn down once each field reads well: the same document the upload will
  // be, made here, so that a problem shows on the page and not after a sign-in.
  if (Object.keys(errors).length === 0) {
    try {
      checkedBrief(form);
    } catch (error) {
      errors.form = documentWords(error);
    }
  }
  return errors;
}

/** The cases a regex task is scored on: the held-out ones if there are any, else the public ones. */
function regexScoringSet(form: PostForm): { match: string[]; noMatch: string[] } {
  const held = { match: linesOf(form.heldoutMatch), noMatch: linesOf(form.heldoutNoMatch) };
  return held.match.length + held.noMatch.length > 0
    ? held
    : { match: linesOf(form.examplesMatch), noMatch: linesOf(form.examplesNoMatch) };
}

/**
 * A caution about a regex task that is allowed but weak: if the cases it is scored on are all of
 * one side, a pattern that says yes (or no) to everything passes. Null if there is none.
 */
export function regexCaution(form: PostForm): string | null {
  const { match, noMatch } = regexScoringSet(form);
  if (match.length + noMatch.length === 0) return null;
  if (noMatch.length === 0) {
    return "Nothing is there to be rejected, so a pattern that matches everything would pass.";
  }
  if (match.length === 0) {
    return "Nothing is there to be matched, so a pattern that matches nothing would pass.";
  }
  return null;
}

// What the Judge takes of a rubric. It turns a rubric task down at intake when a model could not
// grade its points, and that is after the task is posted and its reward is in, so the form
// holds the points to the same rules and a problem shows where it can be put right. The rules are
// the ones in `@tender/shared` (rubric.ts), which the Judge reads too: this file has no copy, only
// the words for each problem.

/**
 * The words for each rule a rubric task can break, for the problem the shared rules name. Keyed by
 * every code, so that a rule added there is a type error here until it has words.
 */
export const RUBRIC_WORDS: Record<RubricProblem, string> = {
  too_many_criteria: `Use at most ${RUBRIC_MAX_CRITERIA} points.`,
  criterion_blank: "Say what to look for.",
  criterion_too_long: `Use ${RUBRIC_MAX_CRITERION_CHARS} characters or fewer.`,
  criterion_bracket: "Leave out angle brackets, like < and >.",
  criteria_collide: "Two points say the same thing.",
  min_score: `A rubric needs a pass mark of ${RUBRIC_MIN_SCORE} or more.`,
  entries: `A rubric task is open to anyone, or invite-only with 1 to ${RUBRIC_MAX_ENTRIES} entries.`,
};

/**
 * What is wrong with one point of a rubric, by the rules of `@tender/shared`, or null: blank, too
 * long or with a bracket, in the order the Judge names them. A point is judged by itself here; the
 * count and a point that repeats an earlier one are the form's.
 */
function pointProblem(point: string): RubricProblem | null {
  return rubricCriteriaProblem({ min_score: RUBRIC_MIN_SCORE, rubric: [{ criterion: point }] });
}

export function checkChecks(form: PostForm, options: { canRubric: boolean }): Errors {
  const errors: Errors = {};

  const label = KINDS.find(({ kind }) => kind === form.kind)?.label ?? form.kind;
  if (form.kind === "rubric" && !options.canRubric) {
    errors.kind = "Rubric checks are for team accounts.";
  } else if (!FORMATS_FOR_KIND[form.kind].includes(form.outputFormat)) {
    const wanted = FORMATS_FOR_KIND[form.kind].map((format) => FORMAT_LABEL[format]).join(" or ");
    errors.kind = `${label} needs the answer format "${wanted}". Change it under More options.`;
  }

  // A rubric's pass mark is at least `RUBRIC_MIN_SCORE`: the Judge scores an entry it disqualifies
  // 0, and with a pass mark of 0 that entry would pass. The other kinds may have 0.
  const mark = form.minScore.trim();
  const lowest = form.kind === "rubric" ? RUBRIC_MIN_SCORE : 0;
  if (!/^[0-9]{1,3}$/.test(mark) || Number(mark) > 100) {
    errors.minScore = `Use a whole number from ${lowest} to 100.`;
  } else if (form.kind === "rubric") {
    const problem = rubricCriteriaProblem({ min_score: Number(mark), rubric: [] });
    if (problem === "min_score") errors.minScore = RUBRIC_WORDS.min_score;
  }

  switch (form.kind) {
    case "exact":
      if (linesOf(form.expected).length === 0) {
        errors.expected = "Write at least one answer the Judge will accept, one to a line.";
      }
      break;

    case "json_schema": {
      const text = form.schema.trim();
      const parsed = text === "" ? null : parseJson(text);
      if (text === "") {
        errors.schema = "Paste the JSON schema that answers have to fit.";
      } else if (parsed === null || !parsed.ok) {
        errors.schema = "That isn't valid JSON.";
      } else if (
        typeof parsed.value !== "object" ||
        parsed.value === null ||
        Array.isArray(parsed.value)
      ) {
        errors.schema = 'A schema is a JSON object, like {"type": "object"}.';
      }
      const rows = filledAssertions(form);
      if (rows.length === 0) {
        errors.assertions = "Add at least one value for the Judge to check.";
      }
      for (const row of rows) {
        // The place of the row in the list the person sees, which holds the empty rows too.
        const at = form.assertions.indexOf(row);
        if (row.path.trim() === "") {
          errors[`assertion-${at}-path`] = "Write where the value is, like $.total.";
        } else if (!ASSERTION_PATH.test(row.path.trim())) {
          errors[`assertion-${at}-path`] = "Write a path like $.total or $.items[0].name.";
        }
        if (row.equals.trim() === "") {
          errors[`assertion-${at}-equals`] = "Write the value it must equal.";
        } else if (!parseJson(row.equals.trim()).ok) {
          errors[`assertion-${at}-equals`] =
            'Write it as JSON: 42, true, or text in quotes, "abc".';
        }
      }
      break;
    }

    case "regex_cases": {
      const { match, noMatch } = regexScoringSet(form);
      if (match.length + noMatch.length === 0) {
        errors.examplesMatch =
          "Add at least one case, public or held out. With none, every answer scores 0.";
      }
      break;
    }

    case "rubric": {
      const rows = filledRubric(form);
      if (rows.length === 0) errors.rubric = "Add at least one point to score.";
      else if (rows.length > RUBRIC_MAX_CRITERIA) errors.rubric = RUBRIC_WORDS.too_many_criteria;
      // Where the first point with each key is, so that a later one that repeats it says which.
      const firstWith = new Map<string, number>();
      for (const row of rows) {
        const at = form.rubric.indexOf(row);
        const point = row.criterion.trim();
        const key = criterionKey(point);
        const first = firstWith.get(key);
        if (key !== "" && first === undefined) firstWith.set(key, at);
        // One problem to a point, the one the Judge names first.
        const problem = pointProblem(point);
        if (problem !== null) {
          errors[`rubric-${at}-criterion`] =
            problem === "criterion_too_long"
              ? `${RUBRIC_WORDS[problem]} This has ${Array.from(point).length}.`
              : RUBRIC_WORDS[problem];
        } else if (first !== undefined) {
          errors[`rubric-${at}-criterion`] = `This says the same as point ${first + 1}.`;
        }
        const weight = row.weight.trim();
        if (!/^[0-9]{1,2}$/.test(weight) || Number(weight) < 1 || Number(weight) > 10) {
          errors[`rubric-${at}-weight`] = "Use a whole number from 1 to 10.";
        }
      }
      break;
    }
  }

  // What the schemas would turn down once each field reads well: the documents the upload will be,
  // made here, so that a problem (a document over the API's 256 KiB, text that cannot be saved)
  // shows on the page and not after a sign-in. The public checks belong to no one field. The
  // held-out checks are spread over several, and are measured and never quoted.
  if (Object.keys(errors).length === 0) {
    let criteria: PublicCriteria | null = null;
    try {
      criteria = checkedCriteria(form).data;
    } catch (error) {
      errors.form = documentWords(error);
    }
    if (criteria !== null) {
      try {
        checkedHeldout(form, criteria);
      } catch (error) {
        errors.heldout = documentWords(error);
      }
    }
  }
  return errors;
}

// ---- The reward ---------------------------------------------------------------------------------

/** One token Tender takes rewards in, and the least and the most of it for a task. */
export interface TokenLimit {
  token: string;
  minReward: bigint;
  maxReward: bigint;
}

/** What the contract allows for a task now, from `get_config`. */
export interface PostLimits {
  paused: boolean;
  feeBps: number;
  minWindowSecs: number;
  /** The contract's own maximum, or `MAX_WINDOW_SECS` if that is lower. */
  maxWindowSecs: number;
  /** The tokens that are taking rewards now. */
  tokens: TokenLimit[];
}

/**
 * Reads the limits from the contract through the browser's RPC node. Throws an `RpcError` for an
 * answer that is not a configuration, or the request's own failure.
 */
export async function readPostLimits(): Promise<PostLimits> {
  const parsed = ConfigViewSchema.safeParse(await view<unknown>(config.contractId, "get_config"));
  if (!parsed.success) {
    throw new RpcError("get_config returned something other than what the contract promises");
  }
  const { paused, fee_bps, min_window_secs, max_window_secs, tokens } = parsed.data;
  return {
    paused,
    feeBps: fee_bps,
    minWindowSecs: min_window_secs,
    maxWindowSecs: Math.min(max_window_secs, MAX_WINDOW_SECS),
    tokens: tokens
      .filter(({ enabled }) => enabled)
      .map(({ token, min_reward, max_reward }) => ({
        token,
        minReward: BigInt(min_reward),
        maxReward: BigInt(max_reward),
      })),
  };
}

/**
 * The token a form is for: the one chosen if Tender takes it, else the default: the test USDC
 * where Tender takes it (it is free to get, on testnet), else the first token Tender takes.
 */
export function tokenOf(form: PostForm, limits: PostLimits): TokenLimit | undefined {
  return (
    limits.tokens.find(({ token }) => token === form.token) ??
    limits.tokens.find(({ token }) => tokenMeta(token, config.network).symbol === "tUSDC") ??
    limits.tokens[0]
  );
}

/**
 * What the winner of a task with this reward receives, as the contract splits it: the reward less
 * the fee, `reward * feeBps / 10_000` rounded down (`splitReward`, one winner).
 */
export function winnerReceives(reward: bigint, feeBps: number): bigint {
  return splitReward(reward, feeBps, [10_000]).amounts[0] ?? 0n;
}

/** The reward a form asks for in the token's smallest unit, or null if what is typed is no amount. */
export function rewardOf(form: PostForm, token: string): bigint | null {
  const reading = readAmount(form.amount, token, null, "vault");
  return reading.ok ? reading.amount : null;
}

/** A window as typed, in seconds, or null if it is not a whole number of a unit or is too long. */
export function durationSecs(duration: Duration): number | null {
  const amount = duration.amount.trim();
  if (!/^[0-9]{1,9}$/.test(amount)) return null;
  const secs = Number(amount) * UNIT_SECS[duration.unit];
  return Number.isSafeInteger(secs) && secs > 0 && secs <= 0xffff_ffff ? secs : null;
}

/**
 * The four windows of a form in seconds, or null if they are not durations: a custom one that is
 * none, or a deadline that is no time or is not after `nowMs` (now unless said). From a deadline,
 * the commit window runs from `nowMs` to it, in whole seconds, and the rest follow from it
 * (`windowsForDeadline`).
 */
export function windowsOf(form: PostForm, nowMs: number = Date.now()): Windows | null {
  if (form.timing === "deadline") {
    const at = deadlineMs(form.deadline);
    if (at === null) return null;
    const secs = Math.floor((at - nowMs) / 1000);
    return secs > 0 && secs <= 0xffff_ffff ? windowsForDeadline(secs) : null;
  }
  const commit = durationSecs(form.custom.commit);
  const reveal = durationSecs(form.custom.reveal);
  const pick = durationSecs(form.custom.pick);
  const fallback = durationSecs(form.custom.fallback);
  if (commit === null || reveal === null || pick === null || fallback === null) return null;
  return { commit, reveal, pick, fallback };
}

/** The four windows added up, in seconds. */
export function totalSecs(windows: Windows): number {
  return WINDOW_NAMES.reduce((sum, name) => sum + windows[name], 0);
}

/** `Answer 10m · Open 5m · Pick 10m · Fallback 10m`. */
export function windowsText(windows: Windows): string {
  return WINDOW_NAMES.map((name) => `${WINDOW_TEXT[name].label} ${spanText(windows[name])}`).join(
    " · ",
  );
}

/**
 * What a poster who picks, or names another account to pick, should know: where the pick is made.
 * The verifier picks on the task's page here, or with Tender's MCP tools (`pick_winners`), which
 * can also publish the held-out checks with the scorecard; the task page does not publish them.
 */
export const VERIFIER_PICKS_WITH_MCP =
  "The checker picks on the task page, or with Tender's MCP tools (pick_winners).";

/**
 * The note on the rubric and the Judge: how the Judge scores a rubric task (plan 05, task 5), and
 * the one thing a poster should weigh about it.
 */
export const RUBRIC_JUDGE_NOTE =
  "The Tender Judge scores rubric tasks with an AI model. Scores are subjective.";

/**
 * The line under the note: what happens to the entries after the first ones. The Judge scores the
 * first `RUBRIC_MAX_ENTRIES` entries of a rubric task in the order they were committed (P05-R21).
 * An open task has no entry limit of its own (`max_entries` 0 and no invites); an invite-only one
 * takes at most as many as are invited, 20 at the most. `rubricEntriesProblem` accepts both.
 */
export const RUBRIC_JUDGE_LIMIT = `The Judge scores the first ${RUBRIC_MAX_ENTRIES} entries.`;

export function checkReward(
  form: PostForm,
  options: {
    limits: PostLimits;
    judgeAccount: string | null;
    /** The account that will post, when a wallet is connected: it can't invite itself. */
    poster?: string | null;
    /** Now, in ms, for the deadline; now unless said. */
    nowMs?: number;
  },
): Errors {
  const { limits, judgeAccount } = options;
  const nowMs = options.nowMs ?? Date.now();
  const errors: Errors = {};

  if (limits.paused) errors.form = "Tender isn't taking new tasks right now.";

  const chosen = tokenOf(form, limits);
  if (chosen === undefined) {
    errors.token = "Tender takes no rewards right now.";
  } else {
    const typed = readAmount(form.amount, chosen.token, null, "vault");
    if (!typed.ok) {
      errors.amount = typed.message;
    } else if (typed.amount < chosen.minReward) {
      errors.amount = `The least for this token is ${describeAmount(chosen.minReward, chosen.token)}.`;
    } else if (typed.amount > chosen.maxReward) {
      errors.amount = `The most for this token is ${describeAmount(chosen.maxReward, chosen.token)}.`;
    }
  }

  if (form.timing === "deadline") {
    const at = deadlineMs(form.deadline);
    const secs = at === null ? null : Math.floor((at - nowMs) / 1000);
    const windows = secs === null || secs <= 0 ? null : windowsForDeadline(secs);
    if (at === null) {
      errors.deadline = "Pick a date and a time.";
    } else if (secs === null || secs < limits.minWindowSecs) {
      errors.deadline = `Pick a time at least ${spanText(limits.minWindowSecs)} from now.`;
    } else if (secs > limits.maxWindowSecs) {
      errors.deadline = `Pick a time within ${spanText(limits.maxWindowSecs)} from now.`;
    } else if (
      windows !== null &&
      WINDOW_NAMES.some(
        (name) => windows[name] < limits.minWindowSecs || windows[name] > limits.maxWindowSecs,
      )
    ) {
      errors.deadline = `The windows after this deadline are outside what the network takes, from ${spanText(limits.minWindowSecs)} to ${spanText(limits.maxWindowSecs)}. Set each one under More options.`;
    }
  }

  if (form.verifier === "judge" && judgeAccount === null) {
    errors.verifier = "The Tender Judge isn't set up for this site. Pick another checker.";
  }
  if (form.verifier === "other" && !AccountIdSchema.safeParse(form.otherVerifier.trim()).success) {
    errors.otherVerifier = "Enter a NEAR account, like name.near.";
  }

  // Who can enter, by the contract's rules (`check_invited`, `E_LIMIT`): at most `MAX_INVITED`
  // accounts, each once, and never the poster or the checker, who cannot enter their own task.
  const invited = invitedOf(form);
  const checker =
    form.verifier === "judge"
      ? judgeAccount
      : form.verifier === "other"
        ? form.otherVerifier.trim()
        : (options.poster ?? null);
  const bad = invited.find((account) => !AccountIdSchema.safeParse(account).success);
  const twice = invited.find((account, at) => invited.indexOf(account) !== at);
  if (bad !== undefined) {
    errors.invited = `"${bad}" is not a NEAR account. Write one account to a line, like name.near.`;
  } else if (invited.length > MAX_INVITED) {
    errors.invited = `Invite ${MAX_INVITED} agents at most.`;
  } else if (twice !== undefined) {
    errors.invited = `${twice} is listed twice.`;
  } else if (options.poster != null && invited.includes(options.poster)) {
    errors.invited = "You can't invite yourself: a poster can't enter their own task.";
  } else if (checker !== null && invited.includes(checker)) {
    errors.invited = `${checker} checks the work, so it can't be invited.`;
  }
  const most = maxEntriesOf(form);
  if (invited.length > 0 && (!Number.isSafeInteger(most) || most < 1 || most > 0xffff_ffff)) {
    errors.maxEntries = "Use a whole number above 0, or leave it empty.";
  } else if (form.kind === "rubric" && most > RUBRIC_MAX_ENTRIES) {
    errors.maxEntries = RUBRIC_WORDS.entries;
  }
  if (form.timing === "custom") {
    for (const name of WINDOW_NAMES) {
      const secs = durationSecs(form.custom[name]);
      const key = `window-${name}`;
      if (secs === null) errors[key] = "Use a whole number above 0.";
      else if (secs < limits.minWindowSecs)
        errors[key] = `At least ${spanText(limits.minWindowSecs)}.`;
      else if (secs > limits.maxWindowSecs)
        errors[key] = `At most ${spanText(limits.maxWindowSecs)}.`;
    }
  }
  return errors;
}

/** The field to take the person to: the first one with a problem, in the order of the page. */
export function firstError(errors: Errors): string | undefined {
  return Object.keys(errors)[0];
}

// ---- The documents ------------------------------------------------------------------------------

/**
 * A document could not be made from the form. The message is for the person and never holds the
 * text of the held-out checks.
 */
export class DocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentError";
  }
}

export interface PostDocuments {
  brief: Uint8Array;
  criteria: Uint8Array;
  /** Null when the task has no held-out checks. */
  heldout: Uint8Array | null;
  briefHash: string;
  criteriaHash: string;
  /** The SHA-256 of `heldout`: what the task commits to on chain. */
  heldoutCommitment: string | null;
}

function briefDocument(form: PostForm): unknown {
  return {
    version: 1,
    title: form.title.trim(),
    summary: form.summary.trim(),
    instructions: form.instructions.trim(),
    category: form.category,
    tags: parseTags(form.tags),
    output: { format: form.outputFormat, max_bytes: Number(form.maxBytes.trim()) },
  };
}

function criteriaDocument(form: PostForm): unknown {
  const common = {
    version: 1,
    min_score: Number(form.minScore.trim()),
    split: "winner_take_all",
    has_heldout: heldoutDocument(form) !== null,
  };
  switch (form.kind) {
    case "exact":
      return {
        ...common,
        kind: "exact",
        normalize: [
          ...(form.trim ? ["trim"] : []),
          ...(form.lowercase ? ["lowercase"] : []),
          ...(form.collapseWs ? ["collapse_ws"] : []),
        ],
      };
    case "json_schema": {
      const schema = parseJson(form.schema.trim());
      return { ...common, kind: "json_schema", schema: schema.ok ? schema.value : null };
    }
    case "regex_cases":
      return {
        ...common,
        kind: "regex_cases",
        examples: { match: linesOf(form.examplesMatch), no_match: linesOf(form.examplesNoMatch) },
      };
    case "rubric":
      return {
        ...common,
        kind: "rubric",
        rubric: filledRubric(form).map((row) => ({
          criterion: row.criterion.trim(),
          weight: Number(row.weight.trim()),
        })),
      };
  }
}

/** The held-out document of the form, its salt included, or null if the form has none. */
function heldoutDocument(form: PostForm): unknown {
  const checks = heldoutChecks(form);
  return checks === null ? null : { ...checks, salt: form.heldoutSalt };
}

/** The held-out checks of the form, or null if the form has none. */
function heldoutChecks(form: PostForm): object | null {
  switch (form.kind) {
    case "exact":
      return { exact: { expected: linesOf(form.expected) } };
    case "json_schema":
      return {
        json_schema: {
          assertions: filledAssertions(form).map((row) => {
            const equals = parseJson(row.equals.trim());
            return { path: row.path.trim(), equals: equals.ok ? equals.value : null };
          }),
        },
      };
    case "regex_cases": {
      const match = linesOf(form.heldoutMatch);
      const noMatch = linesOf(form.heldoutNoMatch);
      return match.length + noMatch.length === 0
        ? null
        : { regex_cases: { match, no_match: noMatch } };
    }
    case "rubric":
      return null;
  }
}

/**
 * The first thing wrong with a document, as `where: what`. Only for documents that are public. The
 * web app does not depend on zod itself, so the error is typed by the part of it that is read.
 */
function fault(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  const issue = error.issues[0];
  if (issue === undefined) return "it does not fit";
  const where = issue.path.map(String).join(".");
  return where === "" ? issue.message : `${where}: ${issue.message}`;
}

/** The words about a document that can't be made, one pair for each of the three. */
const DOCUMENT_WORDS = {
  brief: {
    cannotSave: "A character in the brief can't be saved.",
    tooLong: "The brief is too long.",
  },
  criteria: {
    cannotSave: "A character in the public checks can't be saved.",
    tooLong: "The public checks are too long.",
  },
  heldout: {
    cannotSave: "A character in the held-out checks can't be saved.",
    tooLong: "The held-out checks are too long.",
  },
} as const;

/**
 * The canonical bytes of `document`. A `DocumentError` for text that cannot be written, and for a
 * document over what the API keeps (`MAX_RESULT_BYTES`, 256 KiB), which it would turn down with a
 * 413 after the sign-in.
 */
function bytesOf(document: unknown, name: keyof typeof DOCUMENT_WORDS): Uint8Array {
  const words = DOCUMENT_WORDS[name];
  let bytes: Uint8Array;
  try {
    bytes = canonicalJson(document);
  } catch {
    // The reason names a place in the document, and a place in the held-out can be the person's own
    // key: it is left out.
    throw new DocumentError(words.cannotSave);
  }
  if (bytes.length > MAX_RESULT_BYTES) {
    throw new DocumentError(`${words.tooLong} The limit is ${MAX_RESULT_BYTES / 1024} KiB.`);
  }
  return bytes;
}

/** A document of the form, as the schema reads it and as the bytes that are uploaded. */
interface Checked<T> {
  data: T;
  bytes: Uint8Array;
}

/** The brief, as it will be uploaded. Throws a `DocumentError` if it cannot be. */
function checkedBrief(form: PostForm): Checked<Brief> {
  const parsed = BriefSchema.safeParse(briefDocument(form));
  if (!parsed.success) throw new DocumentError(`The brief does not fit: ${fault(parsed.error)}.`);
  return { data: parsed.data, bytes: bytesOf(parsed.data, "brief") };
}

/** The public criteria, as they will be uploaded. Throws a `DocumentError` if they cannot be. */
function checkedCriteria(form: PostForm): Checked<PublicCriteria> {
  const parsed = PublicCriteriaSchema.safeParse(criteriaDocument(form));
  if (!parsed.success) {
    throw new DocumentError(`The public checks do not fit: ${fault(parsed.error)}.`);
  }
  // The last check, by the rules the Judge turns a rubric task down by at intake, so that a form
  // that drifts from them cannot send what the Judge will refuse once the reward is in.
  if (parsed.data.kind === "rubric") {
    const problem = rubricCriteriaProblem(parsed.data);
    if (problem !== null) throw new DocumentError(RUBRIC_WORDS[problem]);
  }
  return { data: parsed.data, bytes: bytesOf(parsed.data, "criteria") };
}

/**
 * The held-out checks, as they will be uploaded, or null if the form has none. Checked against the
 * `criteria` they go with. Throws a `DocumentError` that says nothing of their text.
 */
function checkedHeldout(form: PostForm, criteria: PublicCriteria): Uint8Array | null {
  const raw = heldoutDocument(form);
  if (raw === null) return null;
  const parsed = HeldoutSchema.safeParse(raw);
  // Said without the text of the document or of the schema's complaint.
  if (!parsed.success || !heldoutMatchesCriteria(criteria, parsed.data)) {
    throw new DocumentError("The held-out checks do not fit the kind of check.");
  }
  return bytesOf(parsed.data, "heldout");
}

/** The words of a `DocumentError`. Anything else is not a problem with the form, and goes on. */
function documentWords(error: unknown): string {
  if (error instanceof DocumentError) return error.message;
  throw error;
}

/**
 * The three documents of a task, as the canonical bytes that are uploaded, and the hashes that go
 * on chain: the brief, the public criteria, and the held-out checks if there are any. Each is
 * checked against the shared schema, and the held-out against the criteria, so that what is
 * uploaded is what the API and the Judge accept. Throws a `DocumentError` if the form cannot be
 * made into them. The form's checks make the same documents (without the hashes) to say what
 * is wrong with their own part of the form, so this is the last check and not the first.
 */
export function buildDocuments(form: PostForm): PostDocuments {
  const brief = checkedBrief(form);
  const criteria = checkedCriteria(form);
  const heldout = checkedHeldout(form, criteria.data);
  if (criteria.data.has_heldout !== (heldout !== null)) {
    throw new DocumentError("The public checks and the held-out checks do not agree.");
  }
  return {
    brief: brief.bytes,
    criteria: criteria.bytes,
    heldout,
    briefHash: sha256Hex(brief.bytes),
    criteriaHash: sha256Hex(criteria.bytes),
    heldoutCommitment: heldout === null ? null : sha256Hex(heldout),
  };
}

// ---- The calls ----------------------------------------------------------------------------------

const HASH = /^[0-9a-f]{64}$/;

/**
 * Whether the Judge is the one who will pick the winner of the task `form` makes, if `poster`
 * (null: not known yet) posts it: the verifier is the Judge's account (chosen as the Judge, or
 * typed in as another account). Only then does the Judge need the held-out checks, so only then
 * are they sent to the API; for any other verifier they stay on the poster's page and in the file
 * Review offers.
 */
export function judgeVerifies(
  form: PostForm,
  judgeAccount: string | null,
  poster: string | null,
): boolean {
  if (judgeAccount === null) return false;
  const verifier = form.verifier === "me" ? poster : verifierAccountOf(form, judgeAccount);
  return verifier === judgeAccount;
}

/** The verifier's account as the form names it, or null if it names none yet. */
function verifierAccountOf(form: PostForm, judgeAccount: string | null): string | null {
  try {
    return verifierOf(form, judgeAccount) ?? null;
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/**
 * The held-out checks of the form as the file they are committed as: the same canonical JSON bytes
 * whose SHA-256 is the commitment on chain, which a verifier can publish with the scorecard so that
 * anyone can recompute it (`pick_winners` can; the task page's pick does not). Null if the form has none, or its documents cannot be made yet.
 */
export function heldoutFile(form: PostForm): Uint8Array | null {
  try {
    return buildDocuments(form).heldout;
  } catch (error) {
    if (error instanceof DocumentError) return null;
    throw error;
  }
}

/** The account that verifies, or undefined when the poster does. Throws for one that can't be. */
function verifierOf(form: PostForm, judgeAccount: string | null): string | undefined {
  if (form.verifier === "me") return undefined;
  const account = form.verifier === "judge" ? judgeAccount : form.otherVerifier.trim();
  if (account === null || !AccountIdSchema.safeParse(account).success) {
    throw new RangeError("the verifier is not an account");
  }
  return account;
}

/**
 * The NEAR, in yoctoNEAR, that a `storage_deposit` has to add so that `storage` pays for a post, and
 * for the vault slot of the token as well if the post `opensSlot`, and for its invite list; 0 if it
 * already does. Only the `available` of the view is read by `storageShortfall`.
 *
 * `storage` is null for an account that has never deposited. Its first `storage_deposit` registers
 * it, which costs bytes of its own, so the answer is the price of both (`storageShortfall` works it
 * out, with the 0.01 NEAR a first deposit has to be at least), and the account is set up in the
 * same approval as the post.
 */
export function storageTopUpFor(
  storage: StorageBalance | null,
  opensSlot: boolean,
  /** The bytes of an invite list, beyond the task the figure is for (`inviteBytes`). */
  extraBytes = 0n,
): bigint {
  const bytes = (opensSlot ? POST_TASK_BYTES + VAULT_SLOT_BYTES : POST_TASK_BYTES) + extraBytes;
  if (storage === null) return storageShortfall(null, bytes);
  return storageShortfall(
    { total: storage.total.toString(), available: storage.available.toString(), used_bytes: "0" },
    bytes,
  );
}

/**
 * Whether the deposit of a post opens the vault slot of its token. A vault that holds none of the
 * token has no slot, or an emptied one, and a read cannot tell the two apart (`balances_of` lists a
 * slot at 0): it counts as opening one, which sets aside up to 0.002 NEAR more than it may need and
 * is never too little. A vault that holds some has its slot.
 */
const opensVaultSlot = (vaultBalance: bigint): boolean => vaultBalance === 0n;

/**
 * The calls that post the task: `post_task`, and in front of it a deposit that tops the vault up to
 * the reward if it holds less, and in front of that a `storage_deposit` if `storage` cannot pay for
 * the post (and for the vault slot, if the deposit opens one). The wallet sends them in this order,
 * so the storage and the vault hold what the task needs when it is posted. `uris.brief` is where
 * the brief was uploaded, and `hashes` are those of `buildDocuments`. The form was checked before;
 * this checks again what a mistake would cost, and throws a `RangeError` for a reward that is no
 * amount, windows that are no durations (a deadline that has passed), a verifier that is no
 * account, an invite list the contract would refuse by its length or its accounts, a hash or an
 * address that is no good, or a negative vault balance.
 */
export function planPostCalls(o: {
  form: PostForm;
  uris: { brief: string };
  hashes: { briefHash: string; criteriaHash: string; heldoutCommitment: string | null };
  vaultBalance: bigint;
  /**
   * The poster's storage balance with Tender, from the read that gave `vaultBalance`: null for an
   * account that has never deposited, whose first `storage_deposit` registers it as well (the
   * batch sets the account up). Left out (undefined), no top-up is planned: for a check that only
   * wants to know the form can be made into calls.
   */
  storage?: StorageBalance | null;
  contractId: string;
  tokenId: string;
  /** The Judge's account, for a form that picks the Judge as verifier. */
  judgeAccount?: string | null;
  /** Now, in ms, which a deadline's commit window runs from; now unless said. */
  nowMs?: number;
}): TenderCall[] {
  const { form, uris, hashes, vaultBalance, contractId, tokenId } = o;
  const reward = rewardOf(form, tokenId);
  if (reward === null) throw new RangeError("the reward is not an amount");
  if (vaultBalance < 0n) throw new RangeError("the vault balance is negative");
  // From a deadline, the commit window runs from now: the time the calls are made.
  const windows = windowsOf(form, o.nowMs);
  if (windows === null) throw new RangeError("the windows are not durations");
  const verifier = verifierOf(form, o.judgeAccount ?? null);
  const uriBytes = new TextEncoder().encode(uris.brief).length;
  if (uriBytes < 1 || uriBytes > MAX_URI_BYTES) {
    throw new RangeError(`the brief address must be 1 to ${MAX_URI_BYTES} bytes`);
  }
  for (const hash of [hashes.briefHash, hashes.criteriaHash, hashes.heldoutCommitment]) {
    if (hash !== null && !HASH.test(hash)) throw new RangeError("a hash is not a SHA-256");
  }

  const invited = invitedOf(form);
  const maxEntries = maxEntriesOf(form);
  if (
    invited.length > MAX_INVITED ||
    invited.some((account) => !AccountIdSchema.safeParse(account).success) ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 0 ||
    maxEntries > 0xffff_ffff
  ) {
    throw new RangeError("the invite list or the entry limit is not one the contract takes");
  }

  const post = postTaskCall(contractId, {
    token: tokenId,
    reward,
    briefUri: uris.brief,
    briefHash: hashes.briefHash,
    criteriaHash: hashes.criteriaHash,
    heldoutCommitment: hashes.heldoutCommitment ?? undefined,
    verifier,
    commitSecs: windows.commit,
    revealSecs: windows.reveal,
    pickSecs: windows.pick,
    fallbackSecs: windows.fallback,
    maxEntries,
    invited,
  });
  const topUp =
    o.storage === undefined
      ? 0n
      : storageTopUpFor(o.storage, opensVaultSlot(vaultBalance), inviteBytes(form));
  return [
    ...(topUp > 0n ? [storageDepositCall(contractId, topUp)] : []),
    ...(vaultBalance < reward ? [depositCall(tokenId, contractId, reward - vaultBalance)] : []),
    post,
  ];
}

// ---- Paying for it ------------------------------------------------------------------------------

/** How a task's reward is to be paid, from what the account holds. */
export interface Funding {
  /** What the vault holds of the token now. */
  inVault: bigint;
  /** What has to be deposited first: nothing if the vault holds the whole reward. */
  toDeposit: bigint;
  /** What the wallet holds of the token; null if the token would not say. */
  inWallet: bigint | null;
  /** The NEAR, in yoctoNEAR, to add to the storage balance first so that it pays for the post. */
  storageTopUp: bigint;
  /** Why the task can't be posted now, in words, or null. */
  problem: string | null;
}

/**
 * Where the `reward` of `token` comes from, given what `data` says the account holds, and whether
 * it can be posted: the token has to be taking deposits, and the wallet has to hold what the vault
 * lacks (when the token says what it holds). The storage a post needs beyond the account's balance
 * is topped up in the same batch (`planPostCalls`), and `storageTopUp` says how much; an account
 * that has never set up its storage is set up there too, so it is not turned away.
 */
export function fundingOf(
  data: VaultData,
  token: string,
  reward: bigint,
  /** The bytes of the task's invite list (`inviteBytes`); none unless said. */
  extraBytes = 0n,
): Funding {
  const row = data.rows.find((candidate) => candidate.token === token);
  const inVault = row?.vault ?? 0n;
  const toDeposit = reward > inVault ? reward - inVault : 0n;
  const inWallet = row?.wallet ?? null;
  const storageTopUp = storageTopUpFor(data.storage, opensVaultSlot(inVault), extraBytes);

  let problem: string | null = null;
  if (toDeposit > 0n && row?.enabled !== true) {
    problem = "Tender isn't taking deposits of this token right now.";
  } else if (inWallet !== null && toDeposit > inWallet) {
    problem = `You need ${describeAmount(toDeposit - inWallet, token)} more in your wallet to fund this reward.`;
  }
  return { inVault, toDeposit, inWallet, storageTopUp, problem };
}
