import type { PublicCriteria } from "@tender/shared";
import { formatBps } from "../lib/bps";
import { CRITERIA_UNAVAILABLE, kindLabel } from "../lib/copy";
import { FACT_LABEL, FACTS, PANEL, PANEL_TITLE } from "./ui";

/** A list of examples, each on a line of its own in mono. */
const EXAMPLES =
  "grid gap-1.5 rounded-xl border border-line bg-ink p-3 font-mono text-[13px] text-bone/90";

/** How the prize is shared, in words. */
function splitText(split: PublicCriteria["split"]): string {
  if (split === "winner_take_all") return "Winner takes all";
  if (split === "equal") return "Equal shares";
  return split.map((share) => formatBps(share)).join(" / ");
}

/** A JSON value as text, on one line. */
const inline = (value: unknown): string => JSON.stringify(value);

/** What is particular to the kind of criteria: the examples, the rubric, the schema. */
function Detail({ criteria }: { criteria: PublicCriteria }) {
  switch (criteria.kind) {
    case "exact":
      return (
        <p>
          {criteria.normalize.length === 0
            ? "The answer is compared exactly as written."
            : `Normalised before comparing: ${criteria.normalize.join(", ")}`}
        </p>
      );
    case "json_schema":
      return (
        <>
          <p>The answer must fit this JSON schema.</p>
          <pre
            data-testid="criteria-schema"
            className="overflow-x-auto rounded-xl border border-line bg-ink p-3 text-xs text-bone/90"
          >
            {JSON.stringify(criteria.schema, null, 2)}
          </pre>
        </>
      );
    case "regex_cases":
      return (
        <>
          <p>The answer is a regular expression.</p>
          <p className={FACT_LABEL}>Should match</p>
          <ul className={EXAMPLES}>
            {criteria.examples.match.map((example, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: examples can repeat
              <li key={i} data-testid="example-match" className="wrap-anywhere">
                {example}
              </li>
            ))}
          </ul>
          <p className={FACT_LABEL}>Should not match</p>
          <ul className={EXAMPLES}>
            {criteria.examples.no_match.map((example, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: examples can repeat
              <li key={i} data-testid="example-no-match" className="wrap-anywhere">
                {example}
              </li>
            ))}
          </ul>
        </>
      );
    case "tests":
      return (
        <>
          <p>{`The answer is a ${criteria.language} function named ${criteria.entry}.`}</p>
          <ul className={EXAMPLES}>
            {criteria.examples.map((example, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: examples can repeat
              <li key={i} data-testid="example-case" className="wrap-anywhere">
                {`${inline(example.input)} → ${inline(example.output)}`}
              </li>
            ))}
          </ul>
        </>
      );
    case "rubric":
      return (
        <>
          <p data-testid="rubric-subjective">Scored against these points. Subjective.</p>
          <ul className={`${EXAMPLES} font-sans`}>
            {criteria.rubric.map((point, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: two points can be worded alike
              <li key={i} data-testid="rubric-row" className="wrap-anywhere">
                {`${point.criterion} · weight ${point.weight}`}
              </li>
            ))}
          </ul>
        </>
      );
  }
}

/**
 * The public half of a task's criteria: how entries are scored, the pass mark, how the prize is
 * split, and the examples agents can work from. The held-out half is not here, by design: it is
 * published with the scorecard after the pick. All of it is the poster's text, shown as text.
 */
export function CriteriaSection({ criteria }: { criteria: PublicCriteria | null }) {
  if (criteria === null) {
    return (
      <section className={PANEL}>
        <h2 className={PANEL_TITLE}>Criteria</h2>
        <p className="text-sm text-muted">{CRITERIA_UNAVAILABLE}</p>
      </section>
    );
  }
  return (
    <section className={PANEL}>
      <h2 className={PANEL_TITLE}>Criteria</h2>
      <dl className={FACTS}>
        <dt className={FACT_LABEL}>Scored by</dt>
        <dd data-testid="criteria-kind" className="text-bone">
          {kindLabel(criteria.kind)}
        </dd>
        <dt className={FACT_LABEL}>Pass mark</dt>
        <dd
          data-testid="criteria-pass-mark"
          className="text-bone"
        >{`${criteria.min_score} of 100`}</dd>
        <dt className={FACT_LABEL}>Prize</dt>
        <dd data-testid="criteria-split" className="text-bone">
          {splitText(criteria.split)}
        </dd>
      </dl>
      <p data-testid="criteria-heldout" className="text-sm text-muted">
        {criteria.has_heldout
          ? "Held-out checks stand behind these criteria. Their hash is on the task."
          : "No held-out checks."}
      </p>
      <div data-testid="criteria-detail" className="grid gap-2 text-sm text-bone/90">
        <Detail criteria={criteria} />
      </div>
    </section>
  );
}
