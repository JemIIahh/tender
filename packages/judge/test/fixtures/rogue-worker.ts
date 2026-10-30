import { parentPort, workerData } from "node:worker_threads";
import { serveWorker } from "../../src/isolate";
import { checkJsonSchemaUsable } from "../../src/kinds/json_schema";
import { runInSandbox } from "../../src/sandbox";
import { ScorerUnavailableError, scorerFor } from "../../src/score";
import { MALFORMED } from "./malformed";

// A score worker for the isolation tests that misbehaves on cue. An entry whose content is one of
// the cues below, or a schema whose `title` is one, makes it do what the cue says; anything else
// is scored and checked as the Judge's own worker does it. It is a worker's entry: tests start it,
// and never import it.

// What the loops count, without end.
const counter = { spins: 0 };

function rogueScorerFor(...task: Parameters<typeof scorerFor>): ReturnType<typeof scorerFor> {
  const score = scorerFor(...task);
  return async (content) => {
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
      default:
        return score(content);
    }
  };
}

function rogueCheck(schema: Record<string, unknown>): ReturnType<typeof checkJsonSchemaUsable> {
  switch (schema.title) {
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
serveWorker(parentPort, workerData, {
  scorerFor: rogueScorerFor,
  checkJsonSchemaUsable: rogueCheck,
});
