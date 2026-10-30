import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BriefSchema } from "@tender/shared";
import { expect, test } from "vitest";
import {
  AGENT_NAMES,
  AGENTS,
  agentVariables,
  analyst,
  coder,
  extractor,
  isAgentName,
} from "../src/agents";

// The three reference agents are only a name and the tags they look for: what each does with a task
// is the solver's business. These tests pin what plan 05 task 8 says of them, and that the names
// agree with the rest of the repository (the deploy's accounts, the seeds' tags).

const SEEDS = join(import.meta.dirname, "../../../seeds");

test("the_three_agents_carry_the_tags_of_the_plan", () => {
  expect(analyst).toEqual({ name: "analyst", tags: ["research", "writing", "data"] });
  expect(coder).toEqual({ name: "coder", tags: ["coding", "regex"] });
  expect(extractor).toEqual({ name: "extractor", tags: ["extraction", "json", "data"] });

  expect(AGENT_NAMES).toEqual(["analyst", "coder", "extractor"]);
  expect(Object.keys(AGENTS).sort()).toEqual([...AGENT_NAMES].sort());
  for (const name of AGENT_NAMES) expect(AGENTS[name].name).toBe(name);
});

test("an_agents_name_is_the_label_of_its_sub_account_and_the_stem_of_its_variables", () => {
  for (const name of AGENT_NAMES) {
    // A label of a NEAR account id, which the deploy puts under the parent account.
    expect(name).toMatch(/^[a-z][a-z0-9]*$/);
    const stem = `AGENT_${name.toUpperCase()}`;
    expect(agentVariables(name)).toEqual({
      account: `${stem}_ACCOUNT`,
      fullAccessKey: `${stem}_FULL_ACCESS_KEY`,
      privateKey: `${stem}_PRIVATE_KEY`,
    });
  }
  // The names the deploy writes, spelled out: the deploy writes the first two and never the third.
  expect(agentVariables("analyst")).toEqual({
    account: "AGENT_ANALYST_ACCOUNT",
    fullAccessKey: "AGENT_ANALYST_FULL_ACCESS_KEY",
    privateKey: "AGENT_ANALYST_PRIVATE_KEY",
  });
});

test("only_the_reference_agents_are_agent_names", () => {
  for (const name of AGENT_NAMES) expect(isAgentName(name)).toBe(true);
  // `lead` is an account the deploy makes, but not an agent that has a config. And the names that
  // every object has are not agents.
  const others = ["", "lead", "Analyst", "analyst ", "constructor", "toString", "__proto__"];
  for (const other of others) expect(isAgentName(other), JSON.stringify(other)).toBe(false);
});

test("every_seed_task_is_in_reach_of_a_reference_agent", () => {
  // The runner lists the open tasks of each of its tags, so a task is an agent's when its brief
  // carries one of the agent's tags. A seed that no agent can find would never be answered.
  const tags = new Set(AGENT_NAMES.flatMap((name) => AGENTS[name].tags));
  const slugs = readdirSync(SEEDS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(SEEDS, entry.name, "brief.json")))
    .map((entry) => entry.name);
  expect(slugs.length).toBeGreaterThan(0);

  for (const slug of slugs) {
    const brief = BriefSchema.parse(
      JSON.parse(readFileSync(join(SEEDS, slug, "brief.json"), "utf8")),
    );
    expect(
      brief.tags.some((tag) => tags.has(tag)),
      slug,
    ).toBe(true);
  }
});
