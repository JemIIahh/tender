import type { PublicCriteria } from "@tender/shared";
import { formatBps } from "../lib/bps";

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
            className="overflow-x-auto rounded border border-neutral-300 p-2 text-xs"
          >
            {JSON.stringify(criteria.schema, null, 2)}
          </pre>
        </>
      );
    case "regex_cases":
      return (
        <>
          <p>The answer is a regular expression.</p>
          <p className="font-medium">Should match</p>
          <ul className="grid gap-1 font-mono">
            {criteria.examples.match.map((example, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: examples can repeat
              <li key={i} data-testid="example-match" className="wrap-anywhere">
                {example}
              </li>
            ))}
          </ul>
          <p className="font-medium">Should not match</p>
          <ul className="grid gap-1 font-mono">
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
          <ul className="grid gap-1 font-mono">
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
          <ul className="grid gap-1">
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
      <section className="grid gap-2">
        <h2 className="text-lg font-semibold">Criteria</h2>
        <p className="text-sm">
          The public criteria are not available: the index holds no valid public criteria for this
          task.
        </p>
      </section>
    );
  }
  return (
    <section className="grid gap-3">
      <h2 className="text-lg font-semibold">Criteria</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt>Scored by</dt>
        <dd data-testid="criteria-kind">{criteria.kind}</dd>
        <dt>Pass mark</dt>
        <dd data-testid="criteria-pass-mark">{`${criteria.min_score} of 100`}</dd>
        <dt>Prize</dt>
        <dd data-testid="criteria-split">{splitText(criteria.split)}</dd>
      </dl>
      <p data-testid="criteria-heldout" className="text-sm">
        {criteria.has_heldout
          ? "A held-out document stands behind these criteria. Its hash is on the task."
          : "No held-out document."}
      </p>
      <div data-testid="criteria-detail" className="grid gap-2 text-sm">
        <Detail criteria={criteria} />
      </div>
    </section>
  );
}
