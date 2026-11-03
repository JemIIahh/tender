"use client";

import type { ReactNode } from "react";
import type { Errors, PostForm } from "../../lib/post";

// The small pieces the steps of the post wizard are made of: a labelled control with its help and
// its problem wired to it, and the choices that are radios. A field's id is `post-<name>`, which is
// also the key of its problem in `Errors`, so that the wizard can take the person to it.

export const PRIMARY =
  "min-h-11 w-fit rounded border border-neutral-900 bg-neutral-900 px-4 text-white aria-disabled:opacity-60";
export const SECONDARY =
  "min-h-11 w-fit rounded border border-neutral-900 px-4 aria-disabled:opacity-60";

const CONTROL =
  "min-h-11 w-full rounded border border-neutral-900 bg-white px-2 aria-invalid:border-2";

/** What every step is given. */
export interface StepProps {
  form: PostForm;
  update(patch: Partial<PostForm>): void;
  /** The problems to show now, by the key of the field. */
  errors: Errors;
  /** Notes that the person has been in a field, so that its problem shows. */
  touch(key: string): void;
}

/** The keys of the form that hold text. */
export type TextKey = {
  [K in keyof PostForm]: PostForm[K] extends string ? K : never;
}[keyof PostForm];

/** The props of a text control for the field `name` of the form. */
export function bindText(props: StepProps, name: TextKey) {
  return {
    name,
    value: props.form[name] as string,
    error: props.errors[name],
    onChange: (value: string) => {
      props.update({ [name]: value } as Partial<PostForm>);
      props.touch(name);
    },
    onBlur: () => props.touch(name),
  };
}

function describedBy(id: string, help: boolean, error: boolean): string | undefined {
  const ids = [help ? `${id}-help` : "", error ? `${id}-error` : ""].filter((part) => part !== "");
  return ids.length === 0 ? undefined : ids.join(" ");
}

export function FieldError({ name, error }: { name: string; error: string | undefined }) {
  if (error === undefined) return null;
  return (
    <p id={`post-${name}-error`} data-testid={`error-${name}`} className="text-sm font-medium">
      {error}
    </p>
  );
}

interface ControlProps {
  /** The id of the control is `post-<name>`. */
  name: string;
  label: ReactNode;
  help?: ReactNode;
  value: string;
  error: string | undefined;
  onChange(value: string): void;
  onBlur(): void;
  mono?: boolean;
  /** Set for text that is prose, which a spell checker should look at. */
  prose?: boolean;
  /** Class for the control, such as a width. */
  className?: string;
}

function Labelled({
  name,
  label,
  help,
  error,
  children,
}: {
  name: string;
  label: ReactNode;
  help: ReactNode;
  error: string | undefined;
  children: ReactNode;
}) {
  const id = `post-${name}`;
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      {help === undefined ? null : (
        <p id={`${id}-help`} className="text-sm text-neutral-700">
          {help}
        </p>
      )}
      {children}
      <FieldError name={name} error={error} />
    </div>
  );
}

export function TextField(
  props: ControlProps & { inputMode?: "numeric" | "decimal" | "text" | "url" },
) {
  const id = `post-${props.name}`;
  return (
    <Labelled name={props.name} label={props.label} help={props.help} error={props.error}>
      <input
        id={id}
        name={props.name}
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        onBlur={props.onBlur}
        inputMode={props.inputMode}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={props.prose === true}
        aria-invalid={props.error !== undefined}
        aria-describedby={describedBy(id, props.help !== undefined, props.error !== undefined)}
        className={`${CONTROL} ${props.mono ? "font-mono" : ""} ${props.className ?? ""}`}
      />
    </Labelled>
  );
}

export function AreaField(props: ControlProps & { rows?: number }) {
  const id = `post-${props.name}`;
  return (
    <Labelled name={props.name} label={props.label} help={props.help} error={props.error}>
      <textarea
        id={id}
        name={props.name}
        value={props.value}
        rows={props.rows ?? 4}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        onBlur={props.onBlur}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={props.prose === true}
        aria-invalid={props.error !== undefined}
        aria-describedby={describedBy(id, props.help !== undefined, props.error !== undefined)}
        className={`${CONTROL} py-2 ${props.mono ? "font-mono" : ""} ${props.className ?? ""}`}
      />
    </Labelled>
  );
}

export function SelectField<T extends string>({
  name,
  label,
  help,
  value,
  options,
  error,
  onChange,
  className,
}: {
  name: string;
  label: ReactNode;
  help?: ReactNode;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  error?: string;
  onChange(value: T): void;
  className?: string;
}) {
  const id = `post-${name}`;
  return (
    <Labelled name={name} label={label} help={help} error={error}>
      <select
        id={id}
        name={name}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value as T)}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy(id, help !== undefined, error !== undefined)}
        className={`${CONTROL} ${className ?? ""}`}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Labelled>
  );
}

/** A choice of one: radios in a fieldset, each in a box that is the whole target. */
export function RadioGroup<T extends string>({
  name,
  legend,
  value,
  options,
  onChange,
  error,
  children,
}: {
  name: string;
  legend: ReactNode;
  value: T;
  options: ReadonlyArray<{ value: T; label: ReactNode; detail?: ReactNode }>;
  onChange(value: T): void;
  error?: string;
  /** Shown under the choices, such as the fields the chosen one asks for. */
  children?: ReactNode;
}) {
  const id = `post-${name}`;
  return (
    // The fieldset takes the focus when there is a problem with the choice, and says it.
    <fieldset
      id={id}
      tabIndex={-1}
      aria-describedby={error === undefined ? undefined : `${id}-error`}
      className="grid min-w-0 gap-2"
    >
      <legend className="mb-1 font-medium">{legend}</legend>
      {options.map((option) => (
        <label
          key={option.value}
          className="flex min-h-11 items-start gap-3 rounded border border-neutral-300 p-3 has-checked:border-neutral-900 has-checked:bg-neutral-100"
        >
          <input
            type="radio"
            name={id}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            className="mt-0.5 size-5 shrink-0"
          />
          <span className="grid min-w-0 gap-0.5">
            <span className="font-medium">{option.label}</span>
            {option.detail === undefined ? null : (
              <span className="text-sm text-neutral-700">{option.detail}</span>
            )}
          </span>
        </label>
      ))}
      {children}
      <FieldError name={name} error={error} />
    </fieldset>
  );
}

export function CheckField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <label className="flex min-h-11 items-center gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className="size-5 shrink-0"
      />
      <span>{label}</span>
    </label>
  );
}
