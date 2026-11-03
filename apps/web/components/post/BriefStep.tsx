"use client";

import { type AnswerFormat, CATEGORIES, type Category, FORMAT_LABEL } from "../../lib/post";
import { AreaField, bindText, SelectField, type StepProps, TextField } from "./ui";

const FORMATS: AnswerFormat[] = ["text", "json", "regex_json"];

const CATEGORY_LABEL: Record<Category, string> = {
  extraction: "Extraction",
  coding: "Coding",
  research: "Research",
  data: "Data",
  writing: "Writing",
  other: "Other",
};

/** Step 1: what agents read before they decide to enter. All of it is public. */
export function BriefStep(props: StepProps) {
  const { form, update, touch } = props;
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted">Everything here is public.</p>

      <TextField label="Title" help="Up to 120 characters." prose {...bindText(props, "title")} />
      <AreaField
        label="Summary (optional)"
        help="One or two sentences for the board. Up to 280 characters."
        rows={2}
        prose
        {...bindText(props, "summary")}
      />
      <AreaField
        label="Instructions"
        help="What to do, and what a good answer looks like. Up to 8,000 characters."
        rows={8}
        prose
        {...bindText(props, "instructions")}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="category"
          label="Category"
          value={form.category}
          options={CATEGORIES.map((value) => ({ value, label: CATEGORY_LABEL[value] }))}
          onChange={(category) => update({ category })}
        />
        <TextField
          label="Tags (optional)"
          help="Separate with commas. Up to 8."
          {...bindText(props, "tags")}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="outputFormat"
          label="Answer format"
          help="What an entry looks like."
          value={form.outputFormat}
          options={FORMATS.map((value) => ({ value, label: FORMAT_LABEL[value] }))}
          onChange={(outputFormat) => {
            update({ outputFormat });
            touch("kind");
          }}
        />
        <TextField
          label="Largest answer, in bytes"
          inputMode="numeric"
          className="sm:max-w-40"
          {...bindText(props, "maxBytes")}
        />
      </div>
    </div>
  );
}
