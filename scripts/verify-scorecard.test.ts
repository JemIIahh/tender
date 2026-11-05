import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256Hex } from "@tender/shared";
import { afterAll, beforeAll, expect, test } from "vitest";

// scripts/verify-scorecard.mjs against local stand-ins: a node that answers `get_task` and an API
// that serves a scorecard. Each case is one task the stand-ins hold, and the script's verdict and
// exit code are what is checked.

const SCRIPT = fileURLToPath(new URL("./verify-scorecard.mjs", import.meta.url));
const HELDOUT = {
  regex_cases: { match: ["C3-045"], no_match: ["G1-010"] },
  salt: "5a".repeat(32),
};
const COMMITMENT = sha256Hex(canonicalJson(HELDOUT));

/** A scorecard as the API serves it: its canonical bytes. */
function card(heldout: unknown, heldoutCommitment: string | null): Uint8Array {
  return canonicalJson({
    version: 1,
    task_id: "1",
    verifier: "poster.test",
    heldout,
    heldout_commitment: heldoutCommitment,
    winners: [{ account: "alice.test", bps: 10_000 }],
  });
}

interface Case {
  /** The chain's task: its commitment and the scorecard hash its outcome pins. */
  commitment: string | null;
  pinned: string;
  /** What the API serves as the scorecard. */
  served: Uint8Array;
}

/** The tasks the stand-ins hold, by id. */
const cases = new Map<string, Case>();
let node: Server;
let api: Server;

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

let nodeUrl = "";
let apiUrl = "";

beforeAll(async () => {
  node = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => {
      text += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(text) as { params: { args_base64: string } };
      const { task_id: id } = JSON.parse(
        Buffer.from(body.params.args_base64, "base64").toString("utf8"),
      ) as { task_id: string };
      const found = cases.get(id);
      const task =
        found === undefined
          ? null
          : {
              id,
              heldout_commitment: found.commitment,
              outcome: {
                kind: "picked",
                scorecard_hash: found.pinned,
                scorecard_uri: `${apiUrl}/v1/blobs/${found.pinned}`,
              },
            };
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { result: [...Buffer.from(JSON.stringify(task))] },
        }),
      );
    });
  });
  api = createServer((request, response) => {
    const id = /^\/v1\/scorecards\/(\d+)$/.exec(request.url ?? "")?.[1] ?? "";
    const found = cases.get(id);
    if (found === undefined) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(Buffer.from(found.served));
  });
  nodeUrl = await listen(node);
  apiUrl = await listen(api);
});

afterAll(async () => {
  await new Promise((resolve) => node.close(resolve));
  await new Promise((resolve) => api.close(resolve));
});

/** Runs the script for task `id`, and gives its exit code and what it printed. */
function verify(id: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, "--task", id, "--contract", "tender.test", "--api", apiUrl, "--rpc", nodeUrl],
      { timeout: 30_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
        resolve({ code, out: `${stdout}${stderr}` });
      },
    );
  });
}

/** Puts a task in the stand-ins whose outcome pins exactly what the API serves. */
function pinned(id: string, commitment: string | null, served: Uint8Array, pin?: string): void {
  cases.set(id, { commitment, pinned: pin ?? sha256Hex(served), served });
}

test("a_scorecard_that_publishes_the_committed_held_out_checks_is_verified", async () => {
  pinned("1", COMMITMENT, card(HELDOUT, COMMITMENT));
  const { code, out } = await verify("1");
  expect(out).toMatch(/card {3}sha256\(heldout\) +[0-9a-f]{64} {2}MATCH/);
  // The hash is of the whole document, salt included, and the salt is said to be there.
  expect(out).toContain("card   heldout salt         present");
  expect(out.trimEnd().split("\n").at(-1)).toBe("VERIFIED");
  expect(code).toBe(0);
});

test("held_out_checks_published_without_a_salt_are_verified_with_a_note", async () => {
  const { salt: _salt, ...unsalted } = HELDOUT;
  const commitment = sha256Hex(canonicalJson(unsalted));
  pinned("7", commitment, card(unsalted, commitment));
  const { code, out } = await verify("7");
  expect(out).toContain(
    "card   heldout salt         none: while the task was open, a short answer could be found from the commitment",
  );
  expect(out.trimEnd().split("\n").at(-1)).toBe("VERIFIED");
  expect(code).toBe(0);
});

test("held_out_checks_other_than_the_committed_ones_are_a_mismatch", async () => {
  pinned("2", COMMITMENT, card({ regex_cases: { match: ["X"], no_match: [] } }, COMMITMENT));
  const { code, out } = await verify("2");
  expect(out).toContain("DIFFERENT");
  expect(out.trimEnd().split("\n").at(-1)).toBe("MISMATCH");
  expect(code).toBe(1);
});

test("a_scorecard_other_than_the_one_the_chain_pins_is_a_mismatch", async () => {
  pinned("3", COMMITMENT, card(HELDOUT, COMMITMENT), "ab".repeat(32));
  const { code, out } = await verify("3");
  expect(out.trimEnd().split("\n").at(-1)).toBe("MISMATCH");
  expect(code).toBe(1);
});

test("a_pick_that_publishes_no_held_out_checks_is_said_to_and_is_no_mismatch", async () => {
  // A pick made by hand on the task page: the scorecard is the pinned one, with `heldout: null`.
  pinned("4", COMMITMENT, card(null, COMMITMENT));
  const { code, out } = await verify("4");
  expect(out).toContain("card   heldout              null (not published)");
  expect(out).toContain(
    "the verifier did not publish the held-out checks; this pick can't be re-run",
  );
  expect(out).not.toContain("MISMATCH");
  expect(out.trimEnd().split("\n").at(-1)).toBe("NOT PUBLISHED");
  expect(code).toBe(3);
});

test("an_unpublished_held_out_part_does_not_hide_a_scorecard_mismatch", async () => {
  pinned("5", COMMITMENT, card(null, COMMITMENT), "cd".repeat(32));
  const { code, out } = await verify("5");
  expect(out.trimEnd().split("\n").at(-1)).toBe("MISMATCH");
  expect(code).toBe(1);
});

test("a_task_with_no_held_out_part_is_verified_on_its_scorecard_alone", async () => {
  pinned("6", null, card(null, null));
  const { code, out } = await verify("6");
  expect(out).toContain("this task has no held-out part");
  expect(out.trimEnd().split("\n").at(-1)).toBe("VERIFIED");
  expect(code).toBe(0);
});

test("help_prints_the_usage_and_the_exit_codes_and_exits_0", async () => {
  for (const flag of ["--help", "-h"]) {
    const { code, stdout, stderr } = await new Promise<{
      code: number;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      execFile(process.execPath, [SCRIPT, flag], { timeout: 30_000 }, (error, out, err) => {
        const exit = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
        resolve({ code: exit, stdout: out, stderr: err });
      });
    });
    // On stdout, where a reader pipes it to `less`; nothing on stderr.
    expect(stdout, flag).toMatch(/^usage: node scripts\/verify-scorecard\.mjs --task <id>/);
    expect(stdout, flag).toContain("exit codes: 0 VERIFIED, 1 MISMATCH, 2 could not check");
    expect(stderr, flag).toBe("");
    expect(code, flag).toBe(0);
  }
});

test("a_task_the_chain_does_not_have_could_not_be_checked", async () => {
  const { code, out } = await verify("99");
  expect(out).toContain("could not check: tender.test has no task 99");
  expect(code).toBe(2);
});
