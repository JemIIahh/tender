"use client";

import { RUBRIC_MIN_SCORE } from "@tender/shared";
import { type ReactNode, useEffect, useRef } from "react";
import { type CheckKind, FORMAT_PHRASE, kindsFor, regexCaution } from "../../lib/post";
import {
  AreaField,
  bindText,
  CheckField,
  FieldError,
  RadioGroup,
  SECONDARY,
  type StepProps,
  TextField,
} from "./ui";

// Step 2: how entries are checked. The page is split in two, because the task is: the left side is
// published with the task, so agents work from it, and the right side is kept secret and shown to
// no one until the winner is paid. Every kind fills both sides in its own way. Who keeps it is the
// verifier, chosen on the next step: the Judge, or the poster or another account, whose checks these
// are just the same. So the side is worded for no one verifier.

/** What the right side says, for every kind that has one. Its heading says agents can't read it. */
const KEPT_NOTE =
  "The Judge publishes these with the scorecard; another verifier can, with pick_winners. Use new ones for each task.";

function Split({ seen, kept }: { seen: ReactNode; kept: ReactNode }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section
        data-testid="split-public"
        aria-labelledby="post-split-public"
        className="grid min-w-0 content-start gap-4 rounded-xl border border-line bg-ink p-4 sm:p-5"
      >
        <h3 id="post-split-public" className="text-lg font-semibold tracking-tight text-bone">
          What agents see
        </h3>
        {seen}
      </section>
      <section
        data-testid="split-heldout"
        aria-labelledby="post-split-heldout"
        className="grid min-w-0 content-start gap-4 rounded-xl border border-seal/45 bg-seal/[0.04] p-4 sm:p-5"
      >
        <h3
          id="post-split-heldout"
          className="flex items-center gap-2 text-lg font-semibold tracking-tight text-bone"
        >
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-seal" />
          Kept secret until payout
        </h3>
        {kept}
      </section>
    </div>
  );
}

const Note = ({ children }: { children: ReactNode }) => (
  <p className="text-sm text-muted">{children}</p>
);

export function CriteriaStep(
  props: StepProps & { canRubric: boolean; onKind(kind: CheckKind): void },
) {
  const { form, update, errors, touch, canRubric, onKind } = props;

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

  const sides = (() => {
    switch (form.kind) {
      case "exact":
        return (
          <Split
            seen={
              <>
                <Note>Before comparing:</Note>
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
              </>
            }
            kept={
              <>
                <AreaField
                  label="Accepted answers"
                  help="One per line."
                  rows={5}
                  mono
                  {...bindText(props, "expected")}
                />
                <Note>{KEPT_NOTE}</Note>
              </>
            }
          />
        );

      case "json_schema":
        return (
          <Split
            seen={<AreaField label="JSON schema" rows={9} mono {...bindText(props, "schema")} />}
            kept={
              <>
                <div id="post-assertions" tabIndex={-1} className="grid gap-3">
                  <p className="font-medium text-bone">Values the Judge checks</p>
                  {form.assertions.map((row, i) => (
                    <fieldset
                      // biome-ignore lint/suspicious/noArrayIndexKey: a row has no identity but its place
                      key={i}
                      className="grid min-w-0 gap-3 rounded-xl border border-line p-3.5"
                    >
                      <legend className="px-1 font-mono text-[10.5px] tracking-[0.14em] text-muted uppercase">{`Value ${i + 1}`}</legend>
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
                        className={SECONDARY}
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
                <Note>{KEPT_NOTE}</Note>
              </>
            }
          />
        );

      case "regex_cases": {
        const caution = regexCaution(form);
        return (
          <Split
            seen={
              <>
                <AreaField
                  label="Should match"
                  help="One per line."
                  rows={4}
                  mono
                  {...bindText(props, "examplesMatch")}
                />
                <AreaField
                  label="Should not match"
                  rows={4}
                  mono
                  {...bindText(props, "examplesNoMatch")}
                />
              </>
            }
            kept={
              <>
                <Note>Optional. If set, the Judge scores on these only.</Note>
                <AreaField
                  label="Held-out: should match"
                  help="One per line."
                  rows={4}
                  mono
                  {...bindText(props, "heldoutMatch")}
                />
                <AreaField
                  label="Held-out: should not match"
                  rows={4}
                  mono
                  {...bindText(props, "heldoutNoMatch")}
                />
                {caution === null ? null : (
                  <p data-testid="regex-caution" className="text-sm font-medium text-seal">
                    {caution}
                  </p>
                )}
                <Note>{KEPT_NOTE}</Note>
              </>
            }
          />
        );
      }

      case "rubric":
        return (
          <Split
            seen={
              <div id="post-rubric" tabIndex={-1} className="grid gap-3">
                <Note>Points an answer is scored on.</Note>
                {form.rubric.map((row, i) => (
                  <fieldset
                    // biome-ignore lint/suspicious/noArrayIndexKey: a row has no identity but its place
                    key={i}
                    className="grid min-w-0 gap-3 rounded-xl border border-line p-3.5"
                  >
                    <legend className="px-1 font-mono text-[10.5px] tracking-[0.14em] text-muted uppercase">{`Point ${i + 1}`}</legend>
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
                      className="sm:max-w-32"
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
                      className={SECONDARY}
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
            }
            kept={<Note>Nothing.</Note>}
          />
        );
    }
  })();

  return (
    <div className="grid gap-4">
      <RadioGroup
        name="kind"
        legend="How are entries checked?"
        value={form.kind}
        options={kindsFor(canRubric).map(({ kind, label, blurb }) => ({
          value: kind,
          label,
          detail: blurb,
        }))}
        onChange={onKind}
        error={errors.kind}
      />
      <p data-testid="answer-format" className="text-sm text-muted">
        {`Answers: ${FORMAT_PHRASE[form.outputFormat]} (set on Brief).`}
      </p>

      <TextField
        label="Pass mark"
        help={
          form.kind === "rubric"
            ? `Out of 100, and at least ${RUBRIC_MIN_SCORE}. Below it, no payout.`
            : "Out of 100. Below it, no payout."
        }
        inputMode="numeric"
        className="sm:max-w-32"
        {...bindText(props, "minScore")}
      />

      {sides}

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
