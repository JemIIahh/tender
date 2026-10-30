import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { AgentViewSchema, EntryViewSchema, TaskViewSchema } from "../src/index";

const FIXTURES = new URL("./fixtures/", import.meta.url);

/** A view sample captured from the contract's wasm: `test/fixtures/<name>.json`. */
function sample(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8"));
}

test("view_uris_may_hold_a_nul_or_control_characters", () => {
  // The contract checks a uri for its length alone (`check_uri`: 1 to 256 bytes), so any text can
  // be in one, and the view schemas take it as it comes: a refused uri would fail the whole view
  // over a field that anyone can fill. A consumer that stores a uri cleans it (see `views.ts`).
  const uris = [
    "ipfs://x\u0000y",
    "\u0000",
    "a\u0001b\u001f\u007f\u0085",
    "line\nbreak\r\ttab",
    "not a url at all ✓",
  ];
  for (const uri of uris) {
    const label = JSON.stringify(uri);

    // The brief's uri, and the scorecard's in a pick and in a void that has one.
    const task = sample("task_view");
    const picked = task.outcome as Record<string, unknown>;
    const voided = {
      kind: "voided",
      reason: "no_award",
      scorecard_hash: picked.scorecard_hash,
      scorecard_uri: uri,
    };
    for (const outcome of [{ ...picked, scorecard_uri: uri }, voided]) {
      const view = { ...task, brief_uri: uri, outcome };
      expect(TaskViewSchema.parse(view), label).toEqual(view);
    }

    const entry = { ...sample("entry_view"), uri };
    expect(EntryViewSchema.parse(entry), label).toEqual(entry);

    const agent = { ...sample("agent_view"), profile_uri: uri };
    expect(AgentViewSchema.parse(agent), label).toEqual(agent);
  }
});
