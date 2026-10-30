import { setTimeout as sleep } from "node:timers/promises";
import { parentPort } from "node:worker_threads";
import { serveWorker } from "../../src/isolate";

// The Judge's own score worker, slow to load: 3 s more, as a busy machine can make it. It is a
// worker's entry: tests start it, and never import it.
await sleep(3_000);
if (parentPort === null) throw new Error("slow-start-worker.ts runs only as a worker");
serveWorker(parentPort);
