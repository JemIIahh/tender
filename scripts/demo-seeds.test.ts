import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createOfflineSolver, createWeakSolver } from "@tender/agents";
import {
  checkJsonSchemaUsable,
  type EntryScore,
  scoreExact,
  scoreJsonSchema,
  scoreRegexCases,
  scoreTests,
  testsCriteriaProblem,
} from "@tender/judge";
import {
  BriefSchema,
  canonicalJson,
  type Heldout,
  HeldoutSchema,
  heldoutMatchesCriteria,
  type PublicCriteria,
  PublicCriteriaSchema,
  sha256Hex,
} from "@tender/shared";
import { describe, expect, test } from "vitest";
import {
  heldoutFileOf,
  missingPrivateFiles,
  PRIVATE_DIR_VARIABLE,
  privateDirOf,
  solutionFileOf,
} from "./lib/private-dir";

// The demo task set (scripts/demo-seeds/): a few small tasks that `pnpm demo:local`, the CI demo
// job and the end-to-end stack post to a local chain, so that a clean checkout can run the whole
// demo with nothing set up. They are demo-only, so their held-out checks and their solutions are
// in the open, in the same folders as the rest. The 30 real seeds (seeds/) are the opposite: their
// checks and solutions are private (seeds/README.md), and a demo that copied one of them would
// give it away. So the second half of this file shows that the two sets share no content.

const DEMO = join(import.meta.dirname, "demo-seeds");
const REAL = join(import.meta.dirname, "..", "seeds");

/** The demo tasks, and the kind of check each one has: the four the Judge scores without a model. */
const DEMO_TASKS: Record<string, PublicCriteria["kind"]> = {
  "demo-dispatch-note-extract": "json_schema",
  "demo-divisor-counts": "exact",
  "demo-room-code-regex": "regex_cases",
  "demo-run-length-code": "tests",
};
const DEMO_SLUGS = Object.keys(DEMO_TASKS);

const text = (dir: string, slug: string, name: string): string =>
  readFileSync(join(dir, slug, name), "utf8");
const json = (dir: string, slug: string, name: string): unknown =>
  JSON.parse(text(dir, slug, name));
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
/** The canonical JSON of `value` as text, which is what two values are compared by. */
const canon = (value: unknown): string => new TextDecoder().decode(canonicalJson(value));

const slugsOf = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

/** A demo task, read and parsed. */
function load(slug: string) {
  const criteria = PublicCriteriaSchema.parse(json(DEMO, slug, "criteria.json"));
  const heldout = HeldoutSchema.parse(json(DEMO, slug, "heldout.json"));
  return {
    slug,
    terms: json(DEMO, slug, "task.json") as Record<string, unknown>,
    brief: BriefSchema.parse(json(DEMO, slug, "brief.json")),
    criteria,
    heldout,
    solution: text(DEMO, slug, "solution.txt"),
    weak: text(DEMO, slug, "weak.txt"),
  };
}

/** `answer` scored as the Judge scores a revealed entry, on the task's own held-out document. */
async function scoreAnswer(slug: string, answer: string): Promise<EntryScore> {
  const { criteria, heldout } = load(slug);
  if (criteria.kind === "exact" && "exact" in heldout) {
    return scoreExact(criteria, heldout.exact, bytes(answer));
  }
  if (criteria.kind === "json_schema" && "json_schema" in heldout) {
    return scoreJsonSchema(criteria, heldout.json_schema, bytes(answer));
  }
  if (criteria.kind === "regex_cases" && "regex_cases" in heldout) {
    return scoreRegexCases(criteria, heldout.regex_cases, bytes(answer));
  }
  if (criteria.kind === "tests" && "tests" in heldout) {
    return scoreTests(criteria, heldout.tests, bytes(answer));
  }
  throw new Error(`${slug}: no scorer for a "${criteria.kind}" task with this held-out document`);
}

describe("the demo set", () => {
  test("is_four_tasks_of_four_kinds_and_a_readme", () => {
    expect(slugsOf(DEMO)).toEqual(DEMO_SLUGS);
    const kinds = Object.fromEntries(DEMO_SLUGS.map((slug) => [slug, load(slug).criteria.kind]));
    expect(kinds).toEqual(DEMO_TASKS);
    expect(new Set(Object.values(kinds)).size).toBe(4);
    expect(existsSync(join(DEMO, "README.md"))).toBe(true);
  });

  test("readme_says_demo_only_and_local_chain_and_names_every_task", () => {
    const readme = readFileSync(join(DEMO, "README.md"), "utf8").toLowerCase();
    expect(readme).toContain("demo-only");
    expect(readme).toContain("local chain");
    for (const slug of DEMO_SLUGS) expect(readme, `the README names ${slug}`).toContain(slug);
  });

  test("every_file_of_a_task_is_there_and_nothing_else", () => {
    for (const slug of DEMO_SLUGS) {
      expect(readdirSync(join(DEMO, slug)).sort(), slug).toEqual([
        "brief.json",
        "criteria.json",
        "heldout.json",
        "solution.txt",
        "task.json",
        "weak.txt",
      ]);
    }
  });

  describe.each(DEMO_SLUGS)("task %s", (slug) => {
    test("fits_its_schemas_and_says_it_is_demo_only", () => {
      const { terms, brief, criteria, heldout } = load(slug);
      expect(terms.verifier).toBe("judge");
      expect(terms.max_winners).toBe(1);
      expect(criteria.min_score).toBe(100);
      expect(criteria.split).toBe("winner_take_all");
      expect(criteria.has_heldout).toBe(true);
      expect(heldoutMatchesCriteria(criteria, heldout), "held-out document fits the criteria").toBe(
        true,
      );
      if (criteria.kind === "json_schema") {
        expect(checkJsonSchemaUsable(criteria.schema)).toEqual({ ok: true });
      }
      if (criteria.kind === "tests") expect(testsCriteriaProblem(criteria)).toBeNull();
      // Labelled where a reader of the task, and a listing of tasks, sees it.
      expect(brief.title).toMatch(/^Demo: /);
      expect(brief.tags).toContain("demo-only");
      expect(brief.summary.toLowerCase()).toContain("demo-only");
      expect(brief.instructions).toContain("Demo-only: this task is part of the tracked demo set");
    });

    test("answers_fit_the_briefs_output_rules", () => {
      const { brief, solution, weak } = load(slug);
      expect(bytes(solution).byteLength, "solution.txt bytes").toBeLessThanOrEqual(
        brief.output.max_bytes,
      );
      expect(bytes(weak).byteLength, "weak.txt bytes").toBeLessThanOrEqual(brief.output.max_bytes);
    });

    test("the_solution_scores_100_and_the_weak_answer_does_not", async () => {
      const { solution, weak } = load(slug);
      const right = await scoreAnswer(slug, solution);
      expect(right.score, `solution: ${right.reasons.join("; ")}`).toBe(100);
      const wrong = await scoreAnswer(slug, weak);
      expect(wrong.score, `weak answer: ${wrong.reasons.join("; ")}`).toBeLessThan(100);
    });

    test("a_public_example_is_not_a_held_out_case", () => {
      const { criteria, heldout } = load(slug);
      if (criteria.kind === "regex_cases" && "regex_cases" in heldout) {
        const held = new Set([...heldout.regex_cases.match, ...heldout.regex_cases.no_match]);
        const shown = [...criteria.examples.match, ...criteria.examples.no_match];
        expect(shown.filter((one) => held.has(one))).toEqual([]);
      }
      if (criteria.kind === "tests" && "tests" in heldout) {
        const held = new Set(heldout.tests.cases.map((one) => canon(one.input)));
        const shown = criteria.examples.map((one) => canon(one.input));
        expect(shown.filter((one) => held.has(one))).toEqual([]);
      }
    });
  });

  test("a_scripted_solver_answers_every_task_from_its_own_folder_with_no_private_directory", async () => {
    // The zero-setup path: `pnpm demo:local` on a clean checkout, where there is no private
    // directory (or none that holds these slugs), and the solutions are read from the folders.
    const nowhere = join(import.meta.dirname, "no-such-private-directory");
    const offline = createOfflineSolver(DEMO, nowhere);
    const weak = createWeakSolver(DEMO);
    for (const [index, slug] of DEMO_SLUGS.entries()) {
      const brief = json(DEMO, slug, "brief.json");
      // The solvers look a task up by the brief hash the chain holds for it, and use nothing else.
      const ctx = {
        task: { id: index + 1, brief_hash: sha256Hex(canonicalJson(brief)) },
      } as unknown as Parameters<typeof offline.solve>[0];
      const answer = await offline.solve(ctx);
      expect(answer && new TextDecoder().decode(answer), `${slug}: solution`).toBe(
        text(DEMO, slug, "solution.txt"),
      );
      const poor = await weak.solve(ctx);
      expect(poor && new TextDecoder().decode(poor), `${slug}: weak`).toBe(
        text(DEMO, slug, "weak.txt"),
      );
    }
  });
});

// ---- The demo set and the real seeds share nothing --------------------------------------------

/**
 * What a held-out document or a solution gives away if it is copied: its strings of four or more
 * characters (a regex case, an expected answer, an asserted value, a test input or output), and
 * each whole test case. Short values are left out: `true`, `3` and `null` are in every set.
 */
function contentOf(value: unknown): Set<string> {
  const found = new Set<string>();
  const visit = (one: unknown): void => {
    if (typeof one === "string") {
      if (one.length >= 4) found.add(one);
    } else if (Array.isArray(one)) {
      for (const inner of one) visit(inner);
    } else if (typeof one === "object" && one !== null) {
      for (const inner of Object.values(one)) visit(inner);
    }
  };
  visit(value);
  if (typeof value === "object" && value !== null && "tests" in value) {
    const cases = (value as { tests: { cases: Array<{ input: unknown }> } }).tests.cases;
    for (const one of cases) {
      // An edge case whose input is a bare null, number or boolean is in every set of tests.
      const content =
        typeof one.input === "string" || (typeof one.input === "object" && one.input !== null);
      const whole = canon(one);
      if (content && whole.length >= 8) found.add(whole);
    }
  }
  return found;
}

/** The words of `text` that are 4 or more characters, each a piece of an answer that can be copied. */
const wordsOf = (answer: string): Set<string> =>
  new Set(answer.match(/[^\s{}()[\],:;"'=<>]{4,}/g) ?? []);

const intersection = (a: Set<string>, b: Set<string>): string[] => [...a].filter((x) => b.has(x));

/** `answer` parsed as JSON, or null if it is not (a solution may be code or plain text). */
function jsonOrNull(answer: string): unknown {
  try {
    return JSON.parse(answer);
  } catch {
    return null;
  }
}

const REAL_SLUGS = slugsOf(REAL).filter((slug) => existsSync(join(REAL, slug, "criteria.json")));
const PRIVATE_DIR = privateDirOf();
const MISSING_PRIVATE = missingPrivateFiles(REAL, PRIVATE_DIR, REAL_SLUGS);
const PRIVATE_NOTE = `solutions and held-out checks not found in ${PRIVATE_DIR}; set ${PRIVATE_DIR_VARIABLE}`;

describe("the demo set and the 30 real seeds share no content", () => {
  test("no_slug_no_brief_no_title_no_weak_answer_and_no_public_example_is_shared", () => {
    expect(REAL_SLUGS.length).toBe(30);
    expect(intersection(new Set(DEMO_SLUGS), new Set(REAL_SLUGS))).toEqual([]);

    const demoBriefs = DEMO_SLUGS.map(
      (slug) => json(DEMO, slug, "brief.json") as { title: string },
    );
    const realBriefs = REAL_SLUGS.map(
      (slug) => json(REAL, slug, "brief.json") as { title: string },
    );
    expect(
      intersection(
        new Set(demoBriefs.map((one) => sha256Hex(canonicalJson(one)))),
        new Set(realBriefs.map((one) => sha256Hex(canonicalJson(one)))),
      ),
    ).toEqual([]);
    expect(
      intersection(
        new Set(demoBriefs.map((one) => one.title)),
        new Set(realBriefs.map((one) => one.title)),
      ),
    ).toEqual([]);

    // The weak answers and the public examples of the real seeds are in the open, so they are
    // compared too: a demo solution, or a demo held-out string, must not be one of them.
    const openReal = new Set<string>();
    for (const slug of REAL_SLUGS) {
      openReal.add(text(REAL, slug, "weak.txt").trim());
      for (const one of contentOf(json(REAL, slug, "criteria.json"))) openReal.add(one);
    }
    for (const slug of DEMO_SLUGS) {
      expect(openReal.has(text(DEMO, slug, "solution.txt").trim()), `${slug} solution`).toBe(false);
      expect(openReal.has(text(DEMO, slug, "weak.txt").trim()), `${slug} weak answer`).toBe(false);
      const shared = intersection(contentOf(json(DEMO, slug, "heldout.json")), openReal);
      expect(shared, `${slug}: held-out content found in a real seed's public files`).toEqual([]);
    }
  });

  test("no_solution_and_no_held_out_content_is_shared", ({ skip }) => {
    if (MISSING_PRIVATE.length > 0) skip(PRIVATE_NOTE);

    const realSolutions = REAL_SLUGS.map((slug) =>
      readFileSync(solutionFileOf(PRIVATE_DIR, slug), "utf8"),
    );
    const realHeldoutContent = new Set<string>();
    for (const slug of REAL_SLUGS) {
      if (!existsSync(heldoutFileOf(PRIVATE_DIR, slug))) continue; // a rubric seed
      const document: Heldout = HeldoutSchema.parse(
        JSON.parse(readFileSync(heldoutFileOf(PRIVATE_DIR, slug), "utf8")),
      );
      for (const one of contentOf(document)) realHeldoutContent.add(one);
    }
    const realWords = new Set(realSolutions.flatMap((one) => [...wordsOf(one)]));
    const realJsonContent = new Set(
      realSolutions.flatMap((one) => [...contentOf(jsonOrNull(one))]),
    );

    for (const slug of DEMO_SLUGS) {
      const solution = text(DEMO, slug, "solution.txt");
      // The whole answer, as written and with the white space gone.
      const squeezed = (one: string) => one.replace(/\s+/g, "");
      expect(
        realSolutions.some((one) => squeezed(one) === squeezed(solution)),
        `${slug}: solution`,
      ).toBe(false);

      const heldout = contentOf(json(DEMO, slug, "heldout.json"));
      expect(
        intersection(heldout, realHeldoutContent),
        `${slug}: held-out content shared with a real seed`,
      ).toEqual([]);
      // A real solution gives away real held-out values, so a demo held-out value that a real
      // solution contains is a demo that quotes a real answer.
      expect(
        intersection(heldout, realWords),
        `${slug}: held-out content found in a real solution`,
      ).toEqual([]);
      // And a demo solution that is JSON has none of the values of a real held-out document or of
      // a real JSON solution. (Code is compared as a whole above: two functions share keywords.)
      const parsed = jsonOrNull(solution);
      if (parsed !== null) {
        expect(
          intersection(contentOf(parsed), new Set([...realHeldoutContent, ...realJsonContent])),
          `${slug}: solution values shared with a real seed`,
        ).toEqual([]);
      }
    }
  });
});
