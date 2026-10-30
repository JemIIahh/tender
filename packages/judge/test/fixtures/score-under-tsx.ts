import type { P0Criteria } from "../../src/intake";
import { checkJsonSchemaIsolated, openTaskScorer } from "../../src/isolate";

// Run by isolate.test.ts with the tsx CLI, the way `pnpm serve` runs the Judge, so that the
// workers load TypeScript through the loader they inherit. It scores a few entries with the
// Judge's own worker and with the rogue one, closes both, prints what came of it with the
// workers and timers still running, and is expected to exit by itself.

const criteria: P0Criteria = {
  version: 1,
  kind: "exact",
  min_score: 100,
  split: "winner_take_all",
  has_heldout: true,
  normalize: ["trim"],
};
const task = { criteria, heldout: { exact: { expected: ["42"] } } };
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const judges = openTaskScorer(task);
const rogue = openTaskScorer(task, {
  workerUrl: new URL("./rogue-worker.ts", import.meta.url),
  entryTimeoutMs: 500,
  onCrash: () => undefined,
});
const scores = [
  await judges.score(bytes("42")),
  await judges.score(bytes("41")),
  await rogue.score(bytes("rogue:loop")),
  await rogue.score(bytes("rogue:recurse")),
  await rogue.score(bytes("42")),
  // The worker's environment, which is empty.
  await rogue.score(bytes("rogue:env")),
];
const check = await checkJsonSchemaIsolated({ type: "object" });
await judges.close();
await rogue.close();

const left = process
  .getActiveResourcesInfo()
  .filter((type) => type === "MessagePort" || type === "Timeout");
process.stdout.write(`${JSON.stringify({ scores, check, left })}\n`);
