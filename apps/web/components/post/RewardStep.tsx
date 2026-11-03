"use client";

import { tokenMeta } from "@tender/shared";
import { formatBps } from "../../lib/bps";
import { config } from "../../lib/config";
import {
  DURATION_UNITS,
  type DurationUnit,
  durationsOf,
  type PostLimits,
  PRESET_WINDOWS,
  type Preset,
  RUBRIC_JUDGE_LIMIT,
  RUBRIC_JUDGE_NOTE,
  spanText,
  tokenOf,
  totalSecs,
  VERIFIER_PICKS_WITH_MCP,
  type Verifier,
  WINDOW_NAMES,
  WINDOW_TEXT,
  type WindowName,
  type Windows,
  windowsOf,
  windowsText,
} from "../../lib/post";
import { describeAmount } from "../../lib/vault";
import { bindText, FieldError, RadioGroup, SelectField, type StepProps, TextField } from "./ui";

/** An amount this large is the contract's "no limit", which nobody means to say in a sentence. */
const NO_REAL_LIMIT = 10n ** 30n;

const UNIT_LABEL: Record<DurationUnit, string> = {
  seconds: "seconds",
  minutes: "minutes",
  hours: "hours",
  days: "days",
};

/** A legend that is the group's one heading: the group has no other. */
const headingLegend = (text: string) => <span className="text-lg font-semibold">{text}</span>;

function tokenLabel(token: string): string {
  const { symbol } = tokenMeta(token, config.network);
  return symbol === token ? token : `${symbol} (${token})`;
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
    <div className="grid gap-1">
      <label htmlFor={`post-${key}`} className="font-medium">
        {`${WINDOW_TEXT[name].label} window`}
      </label>
      <p id={`post-${key}-help`} className="text-sm text-neutral-700">
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
          className="min-h-11 w-28 rounded border border-neutral-900 bg-white px-2 aria-invalid:border-2"
        />
        <select
          id={`post-${key}-unit`}
          aria-label={`${WINDOW_TEXT[name].label} window unit`}
          value={duration.unit}
          onChange={(event) => set({ unit: event.currentTarget.value as DurationUnit })}
          className="min-h-11 rounded border border-neutral-900 bg-white px-2"
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

/** Step 3: what the task pays, how long each stage lasts, and who picks the winner. */
export function RewardStep(props: StepProps & { limits: PostLimits; judgeAccount: string | null }) {
  const { form, update, errors, limits, judgeAccount } = props;
  const chosen = tokenOf(form, limits);
  const symbol = chosen === undefined ? "" : tokenMeta(chosen.token, config.network).symbol;

  const onPreset = (preset: Preset) => {
    // `Custom` starts from the choice it replaces, so that nothing has to be typed from nothing.
    update(
      preset === "custom" && form.preset !== "custom"
        ? { preset, custom: durationsOf(PRESET_WINDOWS[form.preset]) }
        : { preset },
    );
  };

  const presetDetail = (windows: Windows) =>
    `${windowsText(windows)}. ${spanText(totalSecs(windows))} in all.`;

  const custom = windowsOf(form.preset === "custom" ? form : { ...form, preset: "custom" });
  const windowOptions: Array<{ value: Preset; label: string; detail: string }> = [
    { value: "quick", label: "Quick", detail: presetDetail(PRESET_WINDOWS.quick) },
    { value: "day", label: "Day", detail: presetDetail(PRESET_WINDOWS.day) },
    {
      value: "custom",
      label: "Custom",
      detail:
        form.preset === "custom" && custom !== null
          ? `${spanText(totalSecs(custom))} in all.`
          : "Set each window yourself.",
    },
  ];

  const verifiers: Array<{ value: Verifier; label: string; detail?: string }> = [
    ...(judgeAccount === null
      ? []
      : [
          {
            value: "judge" as const,
            label: "Tender Judge (run by the Tender team)",
            detail: "Scores entries against your checks.",
          },
        ]),
    { value: "me", label: "Me" },
    { value: "other", label: "Another account" },
  ];

  return (
    <div className="grid gap-6">
      <section className="grid gap-3">
        {limits.tokens.length > 1 ? (
          <SelectField
            name="token"
            label="Token"
            value={chosen?.token ?? ""}
            options={limits.tokens.map(({ token }) => ({ value: token, label: tokenLabel(token) }))}
            error={errors.token}
            onChange={(token) => update({ token })}
          />
        ) : chosen === undefined ? (
          <p id="post-token" tabIndex={-1} data-testid="error-token" className="font-medium">
            {errors.token ?? "Tender takes no rewards right now."}
          </p>
        ) : null}
        {chosen === undefined ? null : (
          <TextField
            label={`Amount (${symbol})`}
            help={
              <>
                {limits.tokens.length > 1 ? "" : `Paid in ${chosen.token}. `}
                {`At least ${describeAmount(chosen.minReward, chosen.token)}`}
                {chosen.maxReward < NO_REAL_LIMIT
                  ? `, at most ${describeAmount(chosen.maxReward, chosen.token)}`
                  : ""}
                {`. Tender keeps ${formatBps(limits.feeBps)} of it when it is paid out.`}
              </>
            }
            inputMode="decimal"
            className="sm:max-w-48"
            {...bindText(props, "amount")}
          />
        )}
      </section>

      <section className="grid gap-3">
        <RadioGroup
          name="preset"
          legend={headingLegend("Time")}
          value={form.preset}
          options={windowOptions}
          onChange={onPreset}
          error={errors.preset}
        >
          {form.preset === "custom" ? (
            <div
              className="grid gap-4 rounded border border-neutral-300 p-3"
              data-testid="custom-windows"
            >
              {WINDOW_NAMES.map((name) => (
                <WindowRow
                  key={name}
                  name={name}
                  form={form}
                  update={update}
                  errors={errors}
                  touch={props.touch}
                />
              ))}
              <p className="text-sm text-neutral-700">
                {`Each window is ${spanText(limits.minWindowSecs)} to ${spanText(limits.maxWindowSecs)}.`}
              </p>
            </div>
          ) : null}
        </RadioGroup>
      </section>

      <section className="grid gap-3">
        <RadioGroup
          name="verifier"
          legend={headingLegend("Who picks the winner")}
          value={form.verifier}
          options={verifiers}
          onChange={(verifier) => update({ verifier })}
          error={errors.verifier}
        >
          {form.verifier === "other" ? (
            <TextField label="Their NEAR account" mono {...bindText(props, "otherVerifier")} />
          ) : null}
        </RadioGroup>
        {form.verifier === "judge" ? null : (
          <p data-testid="verifier-picks-with-mcp" className="text-sm">
            {VERIFIER_PICKS_WITH_MCP}
          </p>
        )}
        {form.kind === "rubric" && form.verifier === "judge" ? (
          <div className="grid gap-1 text-sm font-medium">
            <p data-testid="rubric-judge-note">{RUBRIC_JUDGE_NOTE}</p>
            <p data-testid="rubric-judge-limit">{RUBRIC_JUDGE_LIMIT}</p>
          </div>
        ) : null}
      </section>
    </div>
  );
}
