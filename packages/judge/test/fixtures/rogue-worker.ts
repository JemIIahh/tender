import { appendFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { parentPort } from "node:worker_threads";
import { serveWorker } from "../../src/isolate";
import { checkJsonSchemaUsable } from "../../src/kinds/json_schema";
import { runInSandbox } from "../../src/sandbox";
import { prepareScorer, ScorerUnavailableError } from "../../src/score";
import type { EntryScore } from "../../src/types";
import { MALFORMED } from "./malformed";

// A score worker for the isolation tests that misbehaves on cue. An entry whose content is one of
// the cues below, or a json_schema schema whose `title` is one, makes it do what the cue says;
// anything else is scored, compiled and checked as the Judge's own worker does it. It is a worker's
// entry: tests start it, and never import it.

// What the loops count, without end.
const counter = { spins: 0 };
/** How many entries this worker has been asked to score. */
let seen = 0;

/** Keeps the thread busy for `ms` milliseconds, as a slow compile does. */
function busyFor(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) counter.spins++;
}

/** The `title` of a json_schema schema, where the compile and check cues go. */
function titleOf(schema: Record<string, unknown>): string {
  return typeof schema.title === "string" ? schema.title : "";
}

function roguePrepare(...task: Parameters<typeof prepareScorer>): ReturnType<typeof prepareScorer> {
  const [criteria] = task;
  const title = criteria.kind === "json_schema" ? titleOf(criteria.schema) : "";
  // A compile that takes this many milliseconds, and one that crashes.
  if (title.startsWith("rogue:slow:")) busyFor(Number(title.slice("rogue:slow:".length)));
  // `rogue:slow-again:{ms}:{path}`: a compile that takes this long from the second time on, in
  // any worker. The first one leaves a file at the path to say it has been.
  if (title.startsWith("rogue:slow-again:")) {
    const [ms, ...path] = title.slice("rogue:slow-again:".length).split(":");
    const mark = path.join(":");
    if (existsSync(mark)) busyFor(Number(ms));
    else writeFileSync(mark, "");
  }
  // `rogue:slow-nth:{n}:{ms}:{path}`: the n-th compile, in any worker, takes this long, and the
  // others do not. Each compile adds a byte to the file at the path, which counts them.
  if (title.startsWith("rogue:slow-nth:")) {
    const [n, ms, ...path] = title.slice("rogue:slow-nth:".length).split(":");
    const mark = path.join(":");
    appendFileSync(mark, "x");
    if (statSync(mark).size === Number(n)) busyFor(Number(ms));
  }
  if (title === "rogue:compile-throws") throw new RangeError("thrown by the compile");
  const prepared = prepareScorer(...task);
  return { problem: prepared.problem, score: (content) => rogueScore(content, prepared.score) };
}

async function rogueScore(
  content: Uint8Array,
  score: (content: Uint8Array) => Promise<EntryScore>,
): Promise<EntryScore> {
  seen++;
  const cue = new TextDecoder().decode(content);
  if (cue.startsWith("rogue:malformed:")) {
    return MALFORMED[Number(cue.slice("rogue:malformed:".length))] as never;
  }
  switch (cue) {
    case "rogue:loop":
      for (;;) counter.spins++;
    case "rogue:alloc": {
      const kept: number[][] = [];
      for (;;) kept.push(new Array(100_000).fill(kept.length));
    }
    case "rogue:recurse": {
      const down = (depth: number): number => down(depth + 1) + 1;
      return { score: down(0), passed: false, reasons: [] };
    }
    case "rogue:sandbox-recursion": {
      // Which stack runs out first: the engine's own check, or the thread's.
      const ran = await runInSandbox("function f() { f() } f()", {
        timeoutMs: 2_000,
        memoryBytes: 32 * 1024 * 1024,
      });
      return { score: 0, passed: false, reasons: [ran.ok ? "it ran" : ran.message] };
    }
    case "rogue:throw":
      throw new TypeError("thrown by the scorer");
    case "rogue:unavailable":
      throw new ScorerUnavailableError("the scorer cannot run");
    case "rogue:exit":
      return process.exit(0);
    case "rogue:wrong-id":
      // An answer to a request that was never sent, before the answer to this one.
      parentPort?.postMessage({ id: 1e9, answer: { score: 100, passed: true, reasons: [] } });
      return score(content);
    case "rogue:twice":
      // The answer, and then one more message that answers nothing.
      setTimeout(() => parentPort?.postMessage({ id: 1e9, answer: null }), 10);
      return score(content);
    case "rogue:seen":
      return { score: 0, passed: false, reasons: [`${seen} seen`] };
    case "rogue:env":
      return { score: 0, passed: false, reasons: Object.keys(process.env) };
    default:
      return score(content);
  }
}

function rogueCheck(schema: Record<string, unknown>): ReturnType<typeof checkJsonSchemaUsable> {
  const title = titleOf(schema);
  if (title.startsWith("rogue:slow:")) busyFor(Number(title.slice("rogue:slow:".length)));
  switch (title) {
    case "rogue:loop":
      for (;;) counter.spins++;
    case "rogue:throw":
      throw new RangeError("thrown by the check");
    case "rogue:malformed":
      return { ok: "yes" } as never;
    default:
      return checkJsonSchemaUsable(schema);
  }
}

if (parentPort === null) throw new Error("rogue-worker.ts runs only as a worker");
serveWorker(parentPort, {
  prepareScorer: roguePrepare,
  checkJsonSchemaUsable: rogueCheck,
});
