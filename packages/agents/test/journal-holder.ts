import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// A process of its own that takes the lead's journal lock (`lockJournal`) and holds it, for the tests
// that need a second process: one that is refused, one that dies by a signal, one that is killed and
// leaves its lock behind. It prints `ready` once it holds the lock, and each line of the lock's log.
//
// - `wait`: holds the lock until it is killed. It has no handler of its own for any signal, as a
//   process that is not told what to do on SIGTERM has none.
// - `handled`: the same, but its host handles SIGTERM (it says `stopping` and goes on) and ends on
//   SIGINT with `process.exit(0)`, as a host with an orderly stop does.
// - `end`: lets the event loop run dry once it holds the lock, a normal end.
// - `exit`: ends with `process.exit(0)` once it holds the lock.

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const LOCK_MODULE = pathToFileURL(
  join(ROOT, "packages", "agents", "src", "agents", "lead-lock.ts"),
);

export type HoldMode = "wait" | "handled" | "end" | "exit";

export interface Holder {
  child: ChildProcess;
  /** The holder's process id. */
  pid: number;
  /** Resolves once it holds the lock; rejects if it ends first. */
  ready: Promise<void>;
  /** How it ended. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** What it has printed so far, on stdout and on stderr. */
  stdout(): string;
  stderr(): string;
}

const children: ChildProcess[] = [];

const SCRIPT = `
  import { lockJournal } from ${JSON.stringify(LOCK_MODULE.href)};
  const mode = process.env.HOLD_MODE;
  if (mode === "handled") {
    process.on("SIGTERM", () => process.stdout.write("stopping\\n"));
    process.on("SIGINT", () => process.exit(0));
  }
  lockJournal(process.env.HOLD_DIR, (line) => process.stdout.write(line + "\\n"));
  process.stdout.write("ready\\n", () => {
    if (mode === "exit") process.exit(0);
    if (mode === "wait" || mode === "handled") setInterval(() => {}, 1000);
  });
`;

/** Starts a process that takes the lock of the journal `dir`, as `mode` says. */
export function holdJournal(dir: string, mode: HoldMode = "wait"): Holder {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", SCRIPT], {
    cwd: ROOT,
    env: { ...process.env, HOLD_DIR: dir, HOLD_MODE: mode },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => {
    out += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    err += String(chunk);
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", () => {
      if (out.includes("ready\n")) resolve();
    });
    void exited.then(() => reject(new Error(`the holder ended before it held the lock: ${err}`)));
    // Only a guard against a hang: a process starting under load takes however long it takes.
    setTimeout(
      () => reject(new Error("the holder did not take the lock in time")),
      120_000,
    ).unref();
  });
  // Seen even if the test ends before it is awaited.
  ready.catch(() => undefined);
  const pid = child.pid;
  if (pid === undefined) throw new Error("the holder did not start");
  return { child, pid, ready, exited, stdout: () => out, stderr: () => err };
}

/** Kills every holder a test left running. Only the processes these tests started. */
export function killHolders(): void {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

/** The id of a process that has ended: one that ran `node -e ""` and was reaped. */
export async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (pid === undefined) throw new Error("the process did not start");
  return pid;
}
