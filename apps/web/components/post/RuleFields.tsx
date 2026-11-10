"use client";

import { type ReactNode, useEffect, useRef } from "react";
import { FORMAT_PHRASE, KINDS, regexCaution } from "../../lib/post";
import { TEXT_LINK } from "../ui";
import {
  AreaField,
  bindText,
  CheckField,
  FieldError,
  SECONDARY,
  type StepProps,
  TextField,
} from "./ui";

// The rule an answer is checked by: the fields of the kind of check the form has. Exact answers are
// the default and the simplest; the other kinds are chosen under More options, and their fields
// show here all the same, since they are what the task needs. A field the agents never see is
// marked as kept secret, in its help, which its control is described by.

/**
 * The help of a field agents don't see (the held-out checks), true whoever checks the work: the
 * Judge gets them through the API, which shows them to no one, and publishes them with its
 * scorecard; for another checker they never leave this page but in the file it offers, and are
 * public only if that checker's pick publishes them (pick_winners can; the task page's pick
 * doesn't). The salt keeps the hash on chain from giving them away.
 */
export const HIDDEN_HELP =
  "Agents don't see these. The Judge publishes them when it picks; another checker only if it chooses to. A random salt keeps their hash from giving them away.";

/** A small mark beside a label: agents don't see the field. The help says it in words. */
function HiddenMark() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex items-center gap-1.5 rounded-full border border-seal/45 px-2 py-0.5 font-mono text-[10px] tracking-[0.12em] text-bone uppercase"
    >
      <span className="size-1.5 rounded-full bg-seal" />
      Hidden
    </span>
  );
}

/** A field agents don't see: its mark above it, at its right. */
function Hidden({ children }: { children: ReactNode }) {
  return (
    <div className="relative grid">
      <span className="absolute top-0 right-0">
        <HiddenMark />
      </span>
      {children}
    </div>
  );
}

const Note = ({ children, testId }: { children: ReactNode; testId?: string }) => (
  <p data-testid={testId} className="text-sm text-muted">
    {children}
  </p>
);

export function RuleFields(props: StepProps & { onMore(): void }) {
  const { form, update, errors, touch, onMore } = props;

  // A row that is added or taken away moves the person's place; this puts it back somewhere sane.
  const focusAfter = useRef<string | null>(null);
  useEffect(() => {
    if (focusAfter.current !== null) {
      document.getElementById(focusAfter.current)?.focus();
      focusAfter.current = null;
    }
  });

  const setAssertion = (i: number, patch: Partial<(typeof form.assertions)[number]>) =>
    update({
      assertions: form.assertions.map((row, at) => (at === i ? { ...row, ...patch } : row)),
    });
  const setPoint = (i: number, patch: Partial<(typeof form.rubric)[number]>) =>
    update({ rubric: form.rubric.map((row, at) => (at === i ? { ...row, ...patch } : row)) });

  const kind = KINDS.find((candidate) => candidate.kind === form.kind);

  const fields = (() => {
    switch (form.kind) {
      case "exact":
        return (
          <>
            <Hidden>
              <AreaField
                label="Accepted answers"
                help={`One per line. An answer must match one of them. ${HIDDEN_HELP}`}
                rows={3}
                mono
                {...bindText(props, "expected")}
              />
            </Hidden>
            <fieldset className="grid min-w-0 gap-0">
              <legend className="sr-only">Before comparing</legend>
              <div className="flex flex-wrap gap-x-6">
                <CheckField
                  label="Ignore spaces at the start and end"
                  checked={form.trim}
                  onChange={(trim) => update({ trim })}
                />
                <CheckField
                  label="Ignore upper and lower case"
                  checked={form.lowercase}
                  onChange={(lowercase) => update({ lowercase })}
                />
                <CheckField
                  label="Treat runs of spaces as one"
                  checked={form.collapseWs}
                  onChange={(collapseWs) => update({ collapseWs })}
                />
              </div>
            </fieldset>
          </>
        );

      case "json_schema":
        return (
          <>
            <AreaField
              label="JSON schema"
              help="Answers have to fit it. Agents see it."
              rows={6}
              mono
              {...bindText(props, "schema")}
            />
            <Hidden>
              <div id="post-assertions" tabIndex={-1} className="grid gap-3">
                <p className="text-[14px] font-medium text-bone">Values that are checked</p>
                <Note>{HIDDEN_HELP}</Note>
                {form.assertions.map((row, i) => (
                  <fieldset
                    // biome-ignore lint/suspicious/noArrayIndexKey: a row has no identity but its place
                    key={i}
                    className="grid min-w-0 gap-3 rounded-xl border border-line p-3.5 sm:grid-cols-2"
                  >
                    <legend className="px-1 text-[13px] text-muted">{`Value ${i + 1}`}</legend>
                    <TextField
                      name={`assertion-${i}-path`}
                      label="Path"
                      help="Like $.total or $.items[0].name"
                      mono
                      value={row.path}
                      error={errors[`assertion-${i}-path`]}
                      onChange={(path) => {
                        setAssertion(i, { path });
                        touch(`assertion-${i}-path`);
                      }}
                      onBlur={() => touch(`assertion-${i}-path`)}
                    />
                    <TextField
                      name={`assertion-${i}-equals`}
                      label="Must equal (JSON)"
                      help={'Like 42, true, or text in quotes: "abc"'}
                      mono
                      value={row.equals}
                      error={errors[`assertion-${i}-equals`]}
                      onChange={(equals) => {
                        setAssertion(i, { equals });
                        touch(`assertion-${i}-equals`);
                      }}
                      onBlur={() => touch(`assertion-${i}-equals`)}
                    />
                    <button
                      type="button"
                      aria-disabled={form.assertions.length === 1}
                      onClick={() => {
                        if (form.assertions.length === 1) return;
                        update({ assertions: form.assertions.filter((_, at) => at !== i) });
                        focusAfter.current = "post-add-assertion";
                      }}
                      className={`${SECONDARY} sm:col-span-2`}
                    >
                      {`Remove value ${i + 1}`}
                    </button>
                  </fieldset>
                ))}
                <FieldError name="assertions" error={errors.assertions} />
                <button
                  id="post-add-assertion"
                  type="button"
                  onClick={() => {
                    update({ assertions: [...form.assertions, { path: "", equals: "" }] });
                    focusAfter.current = `post-assertion-${form.assertions.length}-path`;
                  }}
                  className={SECONDARY}
                >
                  Add another value
                </button>
              </div>
            </Hidden>
          </>
        );

      case "regex_cases": {
        const caution = regexCaution(form);
        return (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <AreaField
                label="Should match"
                help="One per line. Agents see these."
                rows={4}
                mono
                {...bindText(props, "examplesMatch")}
              />
              <AreaField
                label="Should not match"
                help="One per line."
                rows={4}
                mono
                {...bindText(props, "examplesNoMatch")}
              />
            </div>
            <Note>Hidden cases, which agents don&rsquo;t see, are under More options.</Note>
            {caution === null ? null : (
              <p data-testid="regex-caution" className="text-sm font-medium text-seal">
                {caution}
              </p>
            )}
          </>
        );
      }

      case "rubric":
        return (
          <div id="post-rubric" tabIndex={-1} className="grid gap-3">
            <Note>Points an answer is scored on. Agents see them.</Note>
            {form.rubric.map((row, i) => (
              <fieldset
                // biome-ignore lint/suspicious/noArrayIndexKey: a row has no identity but its place
                key={i}
                className="grid min-w-0 gap-3 rounded-xl border border-line p-3.5 sm:grid-cols-[minmax(0,1fr)_8rem]"
              >
                <legend className="px-1 text-[13px] text-muted">{`Point ${i + 1}`}</legend>
                <TextField
                  name={`rubric-${i}-criterion`}
                  label="What to look for"
                  prose
                  value={row.criterion}
                  error={errors[`rubric-${i}-criterion`]}
                  onChange={(criterion) => {
                    setPoint(i, { criterion });
                    touch(`rubric-${i}-criterion`);
                  }}
                  onBlur={() => touch(`rubric-${i}-criterion`)}
                />
                <TextField
                  name={`rubric-${i}-weight`}
                  label="Weight, 1 to 10"
                  inputMode="numeric"
                  value={row.weight}
                  error={errors[`rubric-${i}-weight`]}
                  onChange={(weight) => {
                    setPoint(i, { weight });
                    touch(`rubric-${i}-weight`);
                  }}
                  onBlur={() => touch(`rubric-${i}-weight`)}
                />
                <button
                  type="button"
                  aria-disabled={form.rubric.length === 1}
                  onClick={() => {
                    if (form.rubric.length === 1) return;
                    update({ rubric: form.rubric.filter((_, at) => at !== i) });
                    focusAfter.current = "post-add-point";
                  }}
                  className={`${SECONDARY} sm:col-span-2`}
                >
                  {`Remove point ${i + 1}`}
                </button>
              </fieldset>
            ))}
            <FieldError name="rubric" error={errors.rubric} />
            <button
              id="post-add-point"
              type="button"
              onClick={() => {
                update({ rubric: [...form.rubric, { criterion: "", weight: "5" }] });
                // A point too many is said at once, not after the person has written it.
                touch("rubric");
                focusAfter.current = `post-rubric-${form.rubric.length}-criterion`;
              }}
              className={SECONDARY}
            >
              Add a point
            </button>
          </div>
        );
    }
  })();

  return (
    <div className="grid gap-4 rounded-xl border border-line bg-ink p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-[15px] font-medium text-bone">
          {form.kind === "exact" ? "The answer must match exactly" : kind?.label}
        </p>
        <button type="button" onClick={onMore} className={`${TEXT_LINK} text-sm`}>
          Other ways to check
        </button>
      </div>
      {fields}
      <p data-testid="answer-format" className="text-[13px] text-muted">
        {`Answers: ${FORMAT_PHRASE[form.outputFormat]}. Change it under More options.`}
      </p>
      {errors.heldout === undefined ? null : (
        <p
          id="post-heldout"
          tabIndex={-1}
          data-testid="error-heldout"
          className="font-medium text-seal"
        >
          {errors.heldout}
        </p>
      )}
    </div>
  );
}
