import { parentPort, workerData } from "node:worker_threads";
import { serveWorker } from "./isolate";

// The entry of the Judge's score workers, which `isolate.ts` starts: the job is the worker's
// `workerData`, and the requests come on its parent port. It is never imported.
if (parentPort === null) throw new Error("score-worker.ts runs only as a worker");
serveWorker(parentPort, workerData);
