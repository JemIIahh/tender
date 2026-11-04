import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Runs a demo in a child process of its own, which a supervisor (this process, idle) starts, passes
 * the stop signals to, and cleans up after.
 *
 * Why: `pnpm demo:local` is `tsx scripts/demo-local.ts`, and the tsx command line passes a Ctrl-C on
 * to the script it runs. If the script has not told it, within 30 ms, that it got the signal, tsx
 * sends it again, and after 30 ms more it kills the script with SIGKILL. A demo whose event loop is
 * busy with its services misses that, and a SIGKILL skips every stop: the temp dir with the local
 * node's home stays behind, and the last line never comes. The supervisor has nothing to do but wait,
 * so it answers at once, and it does not depend on how the script was started: it always runs the
 * demo as a child, under the tsx command line or not.
 *
 * The child runs in a process group of its own, so a Ctrl-C reaches it once, through the
 * supervisor, and its stops run in order. The supervisor makes the run's temp dir and hands it to
 * the child (`demoDir`). Once the child has exited, however it exited, the supervisor kills what is
 * left of the child's process group (only processes the demo started are in it) and removes the
 * temp dir. The child stops as on a closed terminal if the supervisor goes first.
 */

/** The signals a demo stops on, which the supervisor passes on. */
const STOP_SIGNALS = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"] as const;

/** Set in the child's environment to the temp dir the supervisor made for the run. */
const CHILD_DIR = "TENDER_DEMO_CHILD_DIR";

/** What a supervisor needs to know of its demo. */
export interface OwnProcessOptions {
  /** The demo's script, this file's path of the caller: what the child runs. */
  script: string;
  /** The start of the temp dir's name: `tender-demo-`. */
  prefix: string;
  /** The prefix of the supervisor's own lines on stderr: `demo`. */
  name: string;
}

/**
 * In the supervisor: runs `script` with the same arguments as a child, with tsx's loader, and
 * resolves with its exit code once it has exited and been cleaned up after. In the child: watches
 * for the supervisor to go, and resolves with undefined at once, for the caller to run the demo.
 */
export async function inOwnProcess(options: OwnProcessOptions): Promise<number | undefined> {
  if (process.env[CHILD_DIR] !== undefined) {
    // The supervisor holds the other end of the IPC channel: when it goes, this stops as on SIGHUP.
    process.once("disconnect", () => process.kill(process.pid, "SIGHUP"));
    process.channel?.unref();
    return undefined;
  }
  // Absolute and settled (a temp dir can be under a link, as /var is on macOS), so that the removal
  // below and the child's own agree on what it is.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), options.prefix)));
  const child = spawn(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), options.script, ...process.argv.slice(2)],
    {
      // Its own group, which nothing but the supervisor signals; no stdin, which a process in a
      // group in the background of a terminal must not read.
      detached: true,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: { ...process.env, [CHILD_DIR]: dir },
    },
  );
  for (const name of STOP_SIGNALS) {
    process.on(name, () => {
      if (child.exitCode === null && child.signalCode === null) child.kill(name);
    });
  }
  const code = await new Promise<number>((resolve) => {
    child.once("error", (error) => {
      process.stderr.write(
        `${options.name}: could not start the demo's process: ${error.message}\n`,
      );
      resolve(1);
    });
    child.once("exit", (exitCode, signal) =>
      resolve(exitCode ?? 128 + (signal === null ? 0 : constants.signals[signal])),
    );
  });
  // What the demo left, if it was killed past its stops: the processes of its group, and its files.
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group is empty: the demo stopped everything it started.
    }
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return code;
}

/**
 * The run's temp dir: the one the supervisor made (`inOwnProcess`), or, in a process that has none,
 * a new one named `<prefix>...` in the OS temp dir. Absolute either way.
 */
export async function demoDir(prefix: string): Promise<string> {
  const given = process.env[CHILD_DIR];
  return given !== undefined && given !== ""
    ? given
    : realpathSync(await mkdtemp(join(tmpdir(), prefix)));
}
