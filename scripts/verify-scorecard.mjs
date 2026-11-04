#!/usr/bin/env node
// Checks a settled task's scorecard against the chain, with Node and nothing else installed:
//
//   node scripts/verify-scorecard.mjs --task 12 --contract <tender account> --api <api url> [--network testnet]
//
// It asks the contract (a view call on a NEAR RPC node, not the Tender API) for the task's
// `heldout_commitment` and the `scorecard_hash` of its outcome, fetches the scorecard from the API,
// and prints whether
//
//   sha256(canonical JSON of the scorecard's `heldout`)  ==  the task's heldout_commitment
//   sha256(the scorecard's bytes, as served)             ==  the outcome's scorecard_hash
//
// The first line shows that the held-out checks published in the scorecard are the checks the
// poster committed to on chain before any agent worked. It does not show that the verifier scored
// with them: to see that, run the checks against the revealed entries and compare the scores. A
// task with no held-out part says so. Exit code 0 when everything that exists matches, 1
// when something does not, 2 when it could not look.
//
// Canonical JSON is RFC 8785 for the data JSON holds: keys sorted by UTF-16 code unit, no
// whitespace, numbers and strings as `JSON.stringify` writes them. The function below is the
// whole of it, so the check does not depend on this repository's own code.
//
// Defaults come from the environment: TENDER_CONTRACT, TENDER_API_URL, TENDER_NETWORK and
// NEAR_RPC_URL. No key is needed or read.

import { createHash } from "node:crypto";
import { parseArgs } from "node:util";

const RPC = {
  testnet: "https://rpc.testnet.fastnear.com",
  mainnet: "https://rpc.mainnet.fastnear.com",
};

const canonical = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
  return `{${entries.join(",")}}`;
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const usage = (problem) => {
  if (problem) console.error(problem);
  console.error(
    "usage: node scripts/verify-scorecard.mjs --task <id> --contract <account> --api <url> " +
      "[--network testnet|mainnet] [--rpc <url>]",
  );
  process.exit(2);
};

// An unknown flag, or a flag with no value, is a usage error (exit 2): exit 1 means MISMATCH.
let values;
try {
  ({ values } = parseArgs({
    options: {
      task: { type: "string" },
      contract: { type: "string", default: process.env.TENDER_CONTRACT },
      api: { type: "string", default: process.env.TENDER_API_URL },
      network: { type: "string", default: process.env.TENDER_NETWORK || "testnet" },
      rpc: { type: "string", default: process.env.NEAR_RPC_URL },
    },
  }));
} catch (error) {
  usage(error instanceof Error ? error.message : String(error));
}

if (!/^[0-9]+$/.test(values.task ?? "") || !values.contract || !values.api) usage();
const rpc = values.rpc || RPC[values.network];
if (!rpc) {
  console.error(`no RPC url for network "${values.network}": pass --rpc`);
  process.exit(2);
}

const timeout = () => AbortSignal.timeout(20_000);

async function chainTask() {
  const response = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: timeout(),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: values.contract,
        method_name: "get_task",
        args_base64: Buffer.from(JSON.stringify({ task_id: values.task })).toString("base64"),
      },
    }),
  });
  const body = await response.json();
  if (body.error || !body.result?.result) {
    throw new Error(`the node could not run get_task: ${JSON.stringify(body.error ?? body)}`);
  }
  const task = JSON.parse(Buffer.from(body.result.result).toString("utf8"));
  if (task === null) throw new Error(`${values.contract} has no task ${values.task}`);
  return task;
}

async function servedScorecard() {
  const url = `${values.api.replace(/\/+$/, "")}/v1/scorecards/${values.task}`;
  const response = await fetch(url, { signal: timeout() });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

try {
  const task = await chainTask();
  console.log(`task ${values.task} on ${values.contract} (${values.network})`);
  if (task.outcome === null) {
    console.log("not settled yet: no scorecard to check");
    process.exit(0);
  }
  if (task.outcome.scorecard_hash === null) {
    console.log(
      "the outcome records no scorecard (a void by timeout stores none): nothing to check",
    );
    process.exit(0);
  }
  const bytes = await servedScorecard();
  const card = JSON.parse(new TextDecoder().decode(bytes));

  let ok = true;
  const show = (label, value, expected) => {
    const verdict = expected === undefined ? "" : value === expected ? "  MATCH" : "  DIFFERENT";
    if (verdict === "  DIFFERENT") ok = false;
    console.log(`${label.padEnd(28)}${value}${verdict}`);
  };

  if (task.heldout_commitment === null) {
    console.log("this task has no held-out part (heldout_commitment is null on chain)");
    if (card.heldout !== null) {
      console.log("the scorecard shows one all the same");
      ok = false;
    }
  } else {
    show("chain  heldout_commitment", task.heldout_commitment);
    show("card   sha256(heldout)", sha256(canonical(card.heldout)), task.heldout_commitment);
  }
  show("chain  scorecard_hash", task.outcome.scorecard_hash);
  show("api    sha256(scorecard)", sha256(bytes), task.outcome.scorecard_hash);
  console.log(ok ? "VERIFIED" : "MISMATCH");
  process.exit(ok ? 0 : 1);
} catch (error) {
  console.error(`could not check: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
