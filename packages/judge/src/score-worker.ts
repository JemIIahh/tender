import { parentPort } from "node:worker_threads";
import { serveWorker } from "./isolate";

// The entry of the Judge's score workers, which `isolate.ts` starts: the requests, the job among
// them, come on its parent port. It is never imported.
if (parentPort === null) throw new Error("score-worker.ts runs only as a worker");
serveWorker(parentPort);
