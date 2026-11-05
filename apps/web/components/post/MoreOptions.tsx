"use client";

import { RUBRIC_MIN_SCORE } from "@tender/shared";
import { type ReactNode, useId } from "react";
import {
  type AnswerFormat,
  type CheckKind,
  DURATION_UNITS,
  type DurationUnit,
  durationsOf,
  FORMAT_LABEL,
  invitedOf,
  kindsFor,
  MAX_INVITED,
  type PostLimits,
  spanText,
  type Verifier,
  WINDOW_NAMES,
  WINDOW_TEXT,
  type WindowName,
  windowsForDeadline,
  windowsOf,
} from "../../lib/post";
import { FIELD } from "../ui";
import { HIDDEN_HELP } from "./RuleFields";
import {
  AreaField,
  bindText,
  CheckField,
  FieldError,
  RadioGroup,
  SelectField,
  type StepProps,
  TextField,
} from "./ui";

// More options: everything a task can have that most tasks leave as it is, each with a default
// that works. It starts closed; a problem in it opens it (the page does that), and so does the
// rule's "Other ways to check".

const FORMATS: AnswerFormat[] = ["text", "json", "regex_json"];

const UNIT_LABEL: Record<DurationUnit, string> = {
  seconds: "seconds",
  minutes: "minutes",
  hours: "hours",
  days: "days",
};

/** A group of options under its own small heading. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid min-w-0 gap-4 border-t border-line pt-5 first:border-t-0 first:pt-0">
      <h3 className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

function WindowRow({ name, ...props }: StepProps & { name: WindowName }) {
  const { form, update, errors, touch } = props;
  const key = `window-${name}`;
  const duration = form.custom[name];
  const set = (patch: Partial<typeof duration>) => {
    update({ custom: { ...form.custom, [name]: { ...duration, ...patch } } });
    touch(key);
  };
  const error = errors[key];
  return (
    <div className="grid gap-1.5">
      <label htmlFor={`post-${key}`} className="text-[15px] font-medium text-bone">
        {`${WINDOW_TEXT[name].label} window`}
      </label>
      <p id={`post-${key}-help`} className="text-sm text-muted">
        {WINDOW_TEXT[name].detail}
      </p>
      <div className="flex gap-2">
        <input
          id={`post-${key}`}
          value={duration.amount}
          onChange={(event) => set({ amount: event.currentTarget.value })}
          onBlur={() => touch(key)}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error !== undefined}
          aria-describedby={
            error === undefined ? `post-${key}-help` : `post-${key}-help post-${key}-error`
          }
          className={`${FIELD} w-28`}
        />
        <select
          id={`post-${key}-unit`}
          aria-label={`${WINDOW_TEXT[name].label} window unit`}
          value={duration.unit}
          onChange={(event) => set({ unit: event.currentTarget.value as DurationUnit })}
          className={`${FIELD} w-auto`}
        >
          {DURATION_UNITS.map((unit) => (
            <option key={unit} value={unit}>
              {UNIT_LABEL[unit]}
            </option>
          ))}
        </select>
      </div>
      <FieldError name={key} error={error} />
    </div>
  );
}

export function MoreOptions(
  props: StepProps & {
    open: boolean;
    onToggle(): void;
    canRubric: boolean;
    onKind(kind: CheckKind): void;
    /** The checker of the two choices above, to go back to when another account is unticked. */
    defaultVerifier: Verifier;
    limits: PostLimits | null;
  },
) {
  const { form, update, errors, touch, open, onToggle, canRubric, onKind, limits } = props;
  const panel = useId();
  const invited = invitedOf(form).length;

  const setCustom = (custom: boolean) => {
    if (!custom) {
      update({ timing: "deadline" });
      return;
    }
    // The windows start from those the deadline gives, so that nothing is typed from nothing: the
    // time to answer to the hour (or, under six hours, to the minute), and the rest follow from it.
    const commit = windowsOf(form)?.commit ?? 86_400;
    const rounded =
      commit >= 21_600
        ? Math.round(commit / 3_600) * 3_600
        : Math.max(60, Math.round(commit / 60) * 60);
    update({ timing: "custom", custom: durationsOf(windowsForDeadline(rounded)) });
  };

  return (
    <section className="rounded-2xl border border-line bg-panel">
      <h2>
        <button
          type="button"
          id="post-more"
          aria-expanded={open}
          aria-controls={panel}
          onClick={onToggle}
          className="flex min-h-14 w-full items-center justify-between gap-4 rounded-2xl px-5 text-left text-[15px] font-medium text-bone transition-colors hover:bg-raised motion-reduce:transition-none sm:px-7"
        >
          <span className="grid gap-0.5">
            <span>More options</span>
            {open ? null : (
              <span className="text-[13px] font-normal text-muted">
                Summary and tags, other ways to check, who can enter, each window.
              </span>
            )}
          </span>
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            className={`size-4 shrink-0 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          >
            <path d="M3.5 6l4.5 4.5L12.5 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </h2>
      {open ? (
        <div id={panel} className="grid gap-6 border-t border-line px-5 py-6 sm:px-7">
          <Group title="About the task">
            <AreaField
              label="Summary (optional)"
              help="One or two sentences for the board. Up to 280 characters."
              rows={2}
              prose
              {...bindText(props, "summary")}
            />
            <TextField
              label="Tags (optional)"
              help="Separate with commas. Up to 8."
              {...bindText(props, "tags")}
            />
          </Group>

          <Group title="How answers are checked">
            <RadioGroup
              name="kind"
              legend="Kind of check"
              value={form.kind}
              options={kindsFor(canRubric).map(({ kind, label, blurb }) => ({
                value: kind,
                label,
                detail: blurb,
              }))}
              onChange={onKind}
              error={errors.kind}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Pass mark"
                help={
                  form.kind === "rubric"
                    ? `Out of 100, and at least ${RUBRIC_MIN_SCORE}. Below it, no payout.`
                    : "Out of 100. Below it, no payout."
                }
                inputMode="numeric"
                {...bindText(props, "minScore")}
              />
              <SelectField
                name="outputFormat"
                label="Answer format"
                help="What an answer looks like."
                value={form.outputFormat}
                options={FORMATS.map((value) => ({ value, label: FORMAT_LABEL[value] }))}
                onChange={(outputFormat) => {
                  update({ outputFormat });
                  touch("kind");
                }}
              />
              <TextField
                label="Largest answer, in bytes"
                help="4,096 suits most answers."
                inputMode="numeric"
                {...bindText(props, "maxBytes")}
              />
            </div>
            {form.kind === "regex_cases" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <AreaField
                  label="Hidden: should match"
                  help={`Optional. One per line. If set, the Judge scores on these only. ${HIDDEN_HELP}`}
                  rows={3}
                  mono
                  {...bindText(props, "heldoutMatch")}
                />
                <AreaField
                  label="Hidden: should not match"
                  help={`Optional. One per line. ${HIDDEN_HELP}`}
                  rows={3}
                  mono
                  {...bindText(props, "heldoutNoMatch")}
                />
              </div>
            ) : null}
            <CheckField
              label="Another account checks the work"
              checked={form.verifier === "other"}
              onChange={(checked) =>
                update({ verifier: checked ? "other" : props.defaultVerifier })
              }
            />
            {form.verifier === "other" ? (
              <TextField
                label="Their NEAR account"
                help="They pick the winner instead of you or the Judge."
                mono
                {...bindText(props, "otherVerifier")}
              />
            ) : null}
          </Group>

          <Group title="Who can enter">
            <AreaField
              label="Invited agents (optional)"
              help={`Leave it empty and any agent can enter. Up to ${MAX_INVITED}, one account to a line.`}
              rows={2}
              mono
              {...bindText(props, "invited")}
            />
            {invited === 0 ? null : (
              <TextField
                label="Most entries (optional)"
                help={`Empty: each of the ${invited} invited can enter.`}
                inputMode="numeric"
                className="sm:max-w-40"
                {...bindText(props, "maxEntries")}
              />
            )}
          </Group>

          <Group title="Windows">
            <CheckField
              label="Set each window yourself"
              checked={form.timing === "custom"}
              onChange={setCustom}
            />
            {form.timing === "custom" ? (
              <div
                className="grid gap-5 rounded-xl border border-line bg-ink p-4"
                data-testid="custom-windows"
              >
                {WINDOW_NAMES.map((name) => (
                  <WindowRow
                    key={name}
                    name={name}
                    form={form}
                    update={update}
                    errors={errors}
                    touch={touch}
                  />
                ))}
                {limits === null ? null : (
                  <p className="text-sm text-muted">
                    {`Each window is ${spanText(limits.minWindowSecs)} to ${spanText(limits.maxWindowSecs)}. Each starts when the one before it ends, from the moment the task is posted.`}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted">
                Worked out from the deadline: opening the answers takes a twelfth of the time to
                answer, the pick a sixth, and if the checker doesn&rsquo;t pick, you can for six
                times as long.
              </p>
            )}
          </Group>
        </div>
      ) : null}
    </section>
  );
}
