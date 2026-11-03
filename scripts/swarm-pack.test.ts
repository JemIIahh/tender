import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkJsonSchemaUsable, scoreJsonSchema } from "@tender/judge";
import {
  BriefSchema,
  type Heldout,
  HeldoutSchema,
  heldoutMatchesCriteria,
  type PublicCriteria,
  PublicCriteriaSchema,
  parseTokenAmount,
  sha256Hex,
} from "@tender/shared";
import { describe, expect, test } from "vitest";

// The pack of the swarm demo: one parent task and the three sub-tasks its lead hires for. It is in
// the seed format (a folder of task.json, brief.json, criteria.json, heldout.json, solution.txt
// and weak.txt for each task), and it sits outside `seeds/` on purpose: the 30 seeds, the 25 of
// them with held-out checks and the 22.50 tUSDC they cost are counted by folder, and this pack is
// the demo's own. Every task is scored here with the Judge's own scorer, so a pack that pays
// nobody, or pays a flawed answer, fails before it is posted.

const PACK = join(import.meta.dirname, "swarm-research-pack");
const PARENT = join(PACK, "parent");
const CHILDREN = join(PACK, "children");
const SEEDS = join(import.meta.dirname, "..", "seeds");

/** The three sub-tasks, in the order the lead hires for them and the parent lists their parts. */
const CHILD_SLUGS = ["01-gas-ledger", "02-key-audit", "03-event-tally"];
/** The platform fee, in basis points, as the contract's `new` sets it on a local chain. */
const FEE_BPS = 500n;

const text = (dir: string, name: string): string => readFileSync(join(dir, name), "utf8");
const json = (dir: string, name: string): unknown => JSON.parse(text(dir, name));
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

type JsonSchemaCriteria = Extract<PublicCriteria, { kind: "json_schema" }>;
type JsonSchemaHeldout = Extract<Heldout, { json_schema: unknown }>["json_schema"];

/** A task of the pack, read and parsed. */
interface Task {
  dir: string;
  terms: Record<string, unknown>;
  brief: ReturnType<typeof BriefSchema.parse>;
  criteria: JsonSchemaCriteria;
  heldout: JsonSchemaHeldout;
  heldoutText: string;
  solution: string;
  weak: string | null;
}

function load(dir: string): Task {
  const criteria = PublicCriteriaSchema.parse(json(dir, "criteria.json"));
  if (criteria.kind !== "json_schema") throw new Error(`${dir} is not a json_schema task`);
  const heldout = HeldoutSchema.parse(json(dir, "heldout.json"));
  if (!heldoutMatchesCriteria(criteria, heldout) || !("json_schema" in heldout)) {
    throw new Error(`${dir}/heldout.json is not a json_schema held-out document`);
  }
  return {
    dir,
    terms: json(dir, "task.json") as Record<string, unknown>,
    brief: BriefSchema.parse(json(dir, "brief.json")),
    criteria,
    heldout: heldout.json_schema as JsonSchemaHeldout,
    heldoutText: text(dir, "heldout.json"),
    solution: text(dir, "solution.txt"),
    weak: existsSync(join(dir, "weak.txt")) ? text(dir, "weak.txt") : null,
  };
}

const children = (): Task[] => CHILD_SLUGS.map((slug) => load(join(CHILDREN, slug)));
const parent = (): Task => load(PARENT);

const scoreOf = (task: Task, answer: string) =>
  scoreJsonSchema(task.criteria, task.heldout, bytes(answer));

/** `{"parts":[...]}` over the given answers, each as the JSON it is. */
const assemble = (answers: string[]): string =>
  JSON.stringify({ parts: answers.map((one) => JSON.parse(one)) });

test("the_pack_is_a_parent_and_three_children_in_hiring_order", () => {
  expect(
    readdirSync(CHILDREN, { withFileTypes: true })
      .map((e) => e.name)
      .sort(),
  ).toEqual(CHILD_SLUGS);
  for (const dir of [PARENT, ...CHILD_SLUGS.map((slug) => join(CHILDREN, slug))]) {
    for (const name of [
      "task.json",
      "brief.json",
      "criteria.json",
      "heldout.json",
      "solution.txt",
    ]) {
      expect(existsSync(join(dir, name)), `${dir}/${name}`).toBe(true);
    }
  }
});

test("the_pack_stays_out_of_the_seed_listing", () => {
  // The seeds' scripts and tests read every folder of seeds/ as a seed.
  expect(existsSync(join(SEEDS, "swarm-research-pack"))).toBe(false);
});

describe("each task of the pack", () => {
  for (const [name, load_] of [
    ["parent", parent],
    ...CHILD_SLUGS.map((slug, index) => [slug, () => children()[index] as Task] as const),
  ] as const) {
    test(`${name}_fits_its_schemas_and_can_be_judged`, () => {
      const task = load_();
      expect(task.criteria.min_score).toBe(100);
      expect(task.criteria.split).toBe("winner_take_all");
      expect(task.criteria.has_heldout).toBe(true);
      expect(checkJsonSchemaUsable(task.criteria.schema)).toEqual({ ok: true });
      expect(task.brief.output.format).toBe("json");
      expect(task.terms.verifier).toBe("judge");
      expect(task.terms.max_winners).toBe(1);
    });
  }
});

describe("the sub-tasks", () => {
  test("a_solution_scores_100_and_a_weak_answer_fits_the_schema_and_still_fails", () => {
    for (const task of children()) {
      const right = scoreOf(task, task.solution);
      expect(right.score, `${task.dir}: ${right.reasons.join("; ")}`).toBe(100);
      expect(task.weak, `${task.dir}/weak.txt`).not.toBeNull();
      const weak = scoreOf(task, task.weak ?? "");
      // Above 0 means the weak answer fits the public schema: it is plausible, and wrong.
      expect(weak.score, `${task.dir}: ${weak.reasons.join("; ")}`).toBeGreaterThan(0);
      expect(weak.score).toBeLessThan(100);
    }
  });

  test("no_child_carries_the_swarm_tag_and_each_names_its_part", () => {
    children().forEach((task, index) => {
      expect(task.brief.tags).not.toContain("swarm");
      expect(task.brief.tags).toContain(`part-${index + 1}`);
    });
  });

  test("the_answers_are_not_in_the_public_criteria", () => {
    for (const task of [parent(), ...children()]) {
      const publicText = JSON.stringify(task.criteria);
      for (const { equals } of task.heldout.assertions) {
        for (const value of JSON.stringify(equals).match(/"[^"]{3,}"/g) ?? []) {
          expect(publicText, `${task.dir} gives away ${value}`).not.toContain(value);
        }
      }
    }
  });
});

describe("the parent", () => {
  test("the_children_s_solutions_assembled_score_100_and_the_stored_solution_is_that_document", () => {
    const task = parent();
    const assembled = assemble(children().map((child) => child.solution));
    const scored = scoreOf(task, assembled);
    expect(scored.score, scored.reasons.join("; ")).toBe(100);
    expect(JSON.parse(task.solution)).toEqual(JSON.parse(assembled));
  });

  test("one_weak_part_anywhere_keeps_the_assembled_document_from_passing", () => {
    const task = parent();
    const all = children();
    for (const [index, child] of all.entries()) {
      const answers = all.map((one) => one.solution);
      answers[index] = child.weak ?? "";
      const scored = scoreOf(task, assemble(answers));
      expect(scored.score, `part ${index + 1} weak`).toBeGreaterThan(0);
      expect(scored.score, `part ${index + 1} weak`).toBeLessThan(100);
    }
  });

  test("a_document_with_a_part_missing_or_extra_is_turned_down_by_the_schema", () => {
    const task = parent();
    const answers = children().map((child) => child.solution);
    expect(scoreOf(task, assemble(answers.slice(0, 2))).score).toBe(0);
    expect(scoreOf(task, assemble([...answers, answers[0] ?? ""])).score).toBe(0);
    expect(scoreOf(task, "placeholder").score).toBe(0);
  });

  test("it_is_the_only_task_tagged_swarm", () => {
    expect(parent().brief.tags).toContain("swarm");
  });
});

describe("the money", () => {
  const token = { decimals: 6 };
  const units = (task: Task) => parseTokenAmount(String(task.terms.reward), token.decimals);

  test("the_parent_pays_more_after_its_fee_than_the_children_cost", () => {
    const payout = units(parent()) - (units(parent()) * FEE_BPS) / 10_000n;
    const cost = children().reduce((sum, child) => sum + units(child), 0n);
    expect(payout).toBe(9_500_000n);
    expect(cost).toBe(6_000_000n);
    expect(payout - cost).toBe(3_500_000n);
  });

  test("every_child_fits_the_per_task_cap_of_the_demo_key_and_the_three_fill_its_total_cap", () => {
    const rewards = children().map(units);
    expect(Math.max(...rewards.map(Number))).toBe(2_000_000);
    expect(rewards.reduce((sum, one) => sum + one, 0n)).toBe(6_000_000n);
  });
});

describe("the held-out checks", () => {
  test("are_single_use_so_all_four_documents_differ", () => {
    const hashes = [parent(), ...children()].map((task) => sha256Hex(bytes(task.heldoutText)));
    expect(new Set(hashes).size).toBe(4);
  });
});

describe("the windows", () => {
  test("a_child_posted_early_in_the_parents_commit_window_settles_before_its_deadline_less_a_minute", () => {
    const parentCommit = Number(parent().terms.commit_secs);
    for (const child of children()) {
      const {
        commit_secs: c,
        reveal_secs: r,
        pick_secs: p,
      } = child.terms as Record<string, number>;
      // The lead hires within its first ten minutes of the window, and keeps a minute in hand.
      expect(600 + (c ?? 0) + (r ?? 0) + (p ?? 0)).toBeLessThanOrEqual(parentCommit - 60);
    }
  });
});
