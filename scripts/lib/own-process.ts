import { spawn } from "node:child_process";
import { constants } from "node:os";

/**
 * Runs a demo away from tsx's signal relay. `pnpm demo:local` is `tsx scripts/demo-local.ts`, and
 * the tsx command line passes a Ctrl-C on to the script it runs: if the script has not told it, within
 * 30 ms, that it got the signal, it sends it again, and after 30 ms more it kills the script with
 * SIGKILL. A demo whose event loop is busy with its services misses that, and a SIGKILL skips every
 * stop: the temp dir with the local node's home stays behind, and `DEMO OK` never comes (with
 * `--keep`, whose only end is a Ctrl-C, every time). So under the tsx command line the script runs
 * itself once more, as a child of its own, which the relay does not reach. This process is then
 * idle, answers the relay at once, passes each stop signal on to the child, and ends with the
 * child's exit code. The child stops as on a closed terminal if this process goes first.
 */

/** The signals a demo stops on, which this process passes on. */
const STOP_SIGNALS = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"] as const;

/** Set in the child's environment: the child runs the demo itself. */
const IN_OWN_PROCESS = "TENDER_DEMO_OWN_PROCESS";

/** Whether this process is the one the tsx command line started, which its relay reaches. */
const underTsxCommandLine = () =>
  process.execArgv.some((arg) => /[\\/]tsx[\\/]dist[\\/]preflight\.cjs$/.test(arg));

/**
 * Under the tsx command line, runs `script` (this file's path) with the same arguments as a child
 * process, with tsx's loader and no relay, and resolves with its exit code. Anywhere else, and in
 * that child, resolves with undefined at once: the caller runs the demo itself.
 */
export async function inOwnProcess(script: string): Promise<number | undefined> {
  if (process.env[IN_OWN_PROCESS] === "1") {
    // The child of the process below: it stops when that one is gone, as on a closed terminal.
    process.once("disconnect", () => process.kill(process.pid, "SIGHUP"));
    process.channel?.unref();
    return undefined;
  }
  if (!underTsxCommandLine()) return undefined;
  const child = spawn(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), script, ...process.argv.slice(2)],
    {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: { ...process.env, [IN_OWN_PROCESS]: "1" },
    },
  );
  for (const name of STOP_SIGNALS) process.on(name, () => child.kill(name));
  return new Promise((resolve) => {
    child.once("error", () => resolve(1));
    child.once("exit", (code, signal) =>
      resolve(code ?? 128 + (signal === null ? 0 : constants.signals[signal])),
    );
  });
}
