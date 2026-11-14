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
// task with no held-out part says so. So does a scorecard that publishes no held-out checks for a
// task that committed to some: its verifier chose not to publish them (a pick made by hand on the
// web app's task page publishes none), and the pick cannot be re-run against them.
//
// A held-out document carries a `salt` of random bytes beside its checks, and the hash is of the
// whole document, salt included. Without one, the commitment of a short answer could have been
// found by hashing likely answers while the task was open; the script says when the published
// document has none. That is a note, not a mismatch: the hashes are what they are.
//
// It prints one verdict, and exits with its code:
//   0  VERIFIED       everything that exists matches;
//   1  MISMATCH       a hash does not: the scorecard served, or the held-out checks it publishes,
//                     are not what the chain committed to, or an attestation does not hold;
//   2                 it could not look (a usage error, a node or an API that did not answer);
//   3  NOT PUBLISHED  the scorecard is the one the chain pinned, but it publishes no held-out
//                     checks for a task that committed to some.
//
// Canonical JSON is RFC 8785 for the data JSON holds: keys sorted by UTF-16 code unit, no
// whitespace, numbers and strings as `JSON.stringify` writes them. The function below is the
// whole of it, so the check does not depend on this repository's own code.
//
// A scorecard from the attested Judge carries `attestations`: the exact request and response
// bodies of every model completion the scores rest on, each signed in NEAR AI Cloud's TEE. For each
// one the script re-hashes both bodies, checks that `text` is "model:sha256(request):sha256(
// response)", recovers the EIP-191 signer of `text` (secp256k1 and keccak-256, written out below so
// nothing else is needed), and asks the contract (`get_attested_signer`) that the signer is
// registered, enabled, for that model and that address. Each that holds prints ATTESTED; one that
// does not is a MISMATCH. This proves which registered key signed these bytes. It does not prove the
// TEE is genuine (the owner checks its attestation report before registering the key), nor that the
// score is right.
//
// Defaults come from the environment: TENDER_CONTRACT, TENDER_API_URL, TENDER_NETWORK and
// NEAR_RPC_URL. No key is needed or read. `--help` prints the usage and the exit codes. The first
// line it prints names the network, or, for a node given with --rpc, that node's host.

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

// Keccak-256 (the Ethereum one: Keccak padding 0x01, not SHA-3's 0x06), on 64-bit lanes as bigints.
const MASK64 = (1n << 64n) - 1n;
const KECCAK_RC = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];
// The rotation of lane x + 5y.
const KECCAK_ROT = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
].map(BigInt);
const rotl = (v, n) => (n === 0n ? v : ((v << n) | (v >> (64n - n))) & MASK64);

function keccakF(s) {
  for (const rc of KECCAK_RC) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1n);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    const b = new Array(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++)
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], KECCAK_ROT[x + 5 * y]);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 25; y += 5)
        s[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & MASK64 & b[((x + 2) % 5) + y]);
    }
    s[0] ^= rc;
  }
}

const keccak256 = (bytes) => {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let at = 0; at < padded.length; at += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[at + 8 * i + k]);
      s[i] ^= lane;
    }
    keccakF(s);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++)
    for (let k = 0; k < 8; k++) out[8 * i + k] = Number((s[i] >> BigInt(8 * k)) & 0xffn);
  return out;
};

// secp256k1 public key recovery, as Ethereum's ecrecover: affine points, bigints.
const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [
  0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
];
const mod = (a, m) => ((a % m) + m) % m;
const inverse = (a, m) => {
  let [old, r, olds, s] = [mod(a, m), m, 1n, 0n];
  while (r !== 0n) {
    const q = old / r;
    [old, r] = [r, old - q * r];
    [olds, s] = [s, olds - q * s];
  }
  return mod(olds, m);
};
const power = (b, e, m) => {
  let result = 1n;
  for (b = mod(b, m); e > 0n; e >>= 1n, b = (b * b) % m) if (e & 1n) result = (result * b) % m;
  return result;
};
const add = (a, b) => {
  if (a === null) return b;
  if (b === null) return a;
  if (a[0] === b[0] && mod(a[1] + b[1], P) === 0n) return null;
  const l =
    a[0] === b[0]
      ? mod(3n * a[0] * a[0] * inverse(2n * a[1], P), P)
      : mod((b[1] - a[1]) * inverse(b[0] - a[0], P), P);
  const x = mod(l * l - a[0] - b[0], P);
  return [x, mod(l * (a[0] - x) - a[1], P)];
};
const times = (k, point) => {
  let result = null;
  for (let at = point; k > 0n; k >>= 1n, at = add(at, at)) if (k & 1n) result = add(result, at);
  return result;
};
const hexToBytes = (hex) => Uint8Array.from(Buffer.from(hex, "hex"));
const toBig = (bytes) => BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);

/** The address that signed `text` with EIP-191 personal_sign, or null. */
function recoverAddress(text, signature) {
  if (typeof signature !== "string" || !/^(0x)?[0-9a-fA-F]{130}$/.test(signature)) return null;
  const sig = hexToBytes(signature.replace(/^0x/, ""));
  const v = sig[64] >= 27 ? sig[64] - 27 : sig[64];
  const r = toBig(sig.slice(0, 32));
  const s = toBig(sig.slice(32, 64));
  if ((v !== 0 && v !== 1) || r === 0n || r >= N || s === 0n || s >= N) return null;
  const message = new TextEncoder().encode(text);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${message.length}`);
  const e = mod(toBig(keccak256(new Uint8Array([...prefix, ...message]))), N);
  const y2 = mod(r ** 3n + 7n, P);
  let y = power(y2, (P + 1n) / 4n, P);
  if ((y * y) % P !== y2) return null;
  if (Number(y & 1n) !== v) y = P - y;
  const rInv = inverse(r, N);
  const q = add(times(mod(-e * rInv, N), G), times(mod(s * rInv, N), [r, y]));
  if (q === null) return null;
  const key = hexToBytes(q[0].toString(16).padStart(64, "0") + q[1].toString(16).padStart(64, "0"));
  return `0x${Buffer.from(keccak256(key).slice(12)).toString("hex")}`;
}

const USAGE =
  "usage: node scripts/verify-scorecard.mjs --task <id> --contract <account> --api <url> " +
  "[--network testnet|mainnet] [--rpc <url>]";

const usage = (problem) => {
  if (problem) console.error(problem);
  console.error(USAGE);
  process.exit(2);
};

// What --help prints, on stdout, and then it exits with 0.
const HELP = `${USAGE}

Checks a settled task's scorecard against the chain: the held-out checks it publishes against the
task's heldout_commitment, and the scorecard's bytes against the outcome's scorecard_hash. A
scorecard from the attested Judge has each TEE attestation checked too (the bodies re-hashed, the
signature recovered, the signer read from the contract): ATTESTED, or NOT ATTESTED and MISMATCH.
--contract, --api, --network and --rpc default to TENDER_CONTRACT, TENDER_API_URL, TENDER_NETWORK
(else testnet, unless --rpc names a node) and NEAR_RPC_URL. No key is needed or read.

exit codes: 0 VERIFIED, 1 MISMATCH, 2 could not check (a usage error, a node or an API that did
not answer), 3 NOT PUBLISHED (the scorecard is the pinned one, but publishes no held-out checks).`;

// An unknown flag, or a flag with no value, is a usage error (exit 2): exit 1 means MISMATCH, and 3
// NOT PUBLISHED.
let values;
try {
  ({ values } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" },
      task: { type: "string" },
      contract: { type: "string", default: process.env.TENDER_CONTRACT },
      api: { type: "string", default: process.env.TENDER_API_URL },
      network: { type: "string", default: process.env.TENDER_NETWORK || undefined },
      rpc: { type: "string", default: process.env.NEAR_RPC_URL },
    },
  }));
} catch (error) {
  usage(error instanceof Error ? error.message : String(error));
}

if (values.help) {
  console.log(HELP);
  process.exit(0);
}
if (!/^[0-9]+$/.test(values.task ?? "") || !values.contract || !values.api) usage();
const rpc = values.rpc || RPC[values.network ?? "testnet"];
if (!rpc) {
  console.error(`no RPC url for network "${values.network}": pass --rpc`);
  process.exit(2);
}

// What the first line says the check ran against. The network flag only picks a public node, so a
// node of one's own (--rpc, or NEAR_RPC_URL) is named by its host, which holds no credentials, and
// is not called testnet when no network was named: a check on a local chain would say so.
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return "an RPC url that does not parse";
  }
};
const ranOn = values.rpc
  ? [values.network, `node ${hostOf(values.rpc)}`].filter(Boolean).join(", ")
  : (values.network ?? "testnet");

const timeout = () => AbortSignal.timeout(20_000);

/** The result of view `method` of the contract with `args`, parsed. */
async function chainView(method, args) {
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
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const body = await response.json();
  if (body.error || !body.result?.result) {
    throw new Error(`the node could not run ${method}: ${JSON.stringify(body.error ?? body)}`);
  }
  return JSON.parse(Buffer.from(body.result.result).toString("utf8"));
}

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
  console.log(`task ${values.task} on ${values.contract} (${ranOn})`);
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

  // A held-out part the chain committed to, which the scorecard does not publish: no documents that
  // differ, but nothing to compare either, as long as the scorecard itself is the one pinned.
  let unpublished = false;
  if (task.heldout_commitment === null) {
    console.log("this task has no held-out part (heldout_commitment is null on chain)");
    if (card.heldout !== null) {
      console.log("the scorecard shows one all the same");
      ok = false;
    }
  } else if (card.heldout === null) {
    show("chain  heldout_commitment", task.heldout_commitment);
    show("card   heldout", "null (not published)");
    unpublished = true;
  } else {
    show("chain  heldout_commitment", task.heldout_commitment);
    show("card   sha256(heldout)", sha256(canonical(card.heldout)), task.heldout_commitment);
    const salted =
      typeof card.heldout === "object" &&
      !Array.isArray(card.heldout) &&
      Object.hasOwn(card.heldout, "salt");
    show(
      "card   heldout salt",
      salted
        ? "present"
        : "none: while the task was open, a short answer could be found from the commitment",
    );
  }
  show("chain  scorecard_hash", task.outcome.scorecard_hash);
  show("api    sha256(scorecard)", sha256(bytes), task.outcome.scorecard_hash);

  // The attested Judge's signatures, each checked here and against the signer the contract holds.
  if (Array.isArray(card.attestations)) {
    const signers = new Map();
    for (const [i, a] of card.attestations.entries()) {
      const problems = [];
      const requestHash = sha256(new TextEncoder().encode(String(a.request)));
      const responseHash = sha256(new TextEncoder().encode(String(a.response)));
      if (requestHash !== a.request_sha256) problems.push("request_sha256 is not of request");
      if (responseHash !== a.response_sha256) problems.push("response_sha256 is not of response");
      if (a.text !== `${a.model}:${requestHash}:${responseHash}`) {
        problems.push("text is not model:sha256(request):sha256(response)");
      }
      const recovered = recoverAddress(String(a.text), a.signature);
      if (recovered === null || recovered !== String(a.signing_address).toLowerCase()) {
        problems.push("the signature does not recover to signing_address");
      }
      if (!signers.has(a.signer_id)) {
        signers.set(
          a.signer_id,
          await chainView("get_attested_signer", { signer_id: a.signer_id }),
        );
      }
      const signer = signers.get(a.signer_id);
      if (signer === null) problems.push(`no signer ${a.signer_id} is registered on chain`);
      else {
        if (!signer.enabled) problems.push(`signer ${a.signer_id} is disabled on chain`);
        if (signer.address !== recovered) problems.push("the signer on chain has another address");
        if (signer.model !== a.model) problems.push("the signer on chain is for another model");
      }
      const label = `attestation ${i + 1}`.padEnd(28);
      if (problems.length === 0) {
        console.log(`${label}ATTESTED  ${a.model} by ${a.signer_id} (${recovered})`);
      } else {
        ok = false;
        console.log(`${label}NOT ATTESTED: ${problems.join("; ")}`);
      }
    }
  }
  if (!ok) {
    console.log("MISMATCH");
    process.exit(1);
  }
  if (unpublished) {
    console.log("the verifier did not publish the held-out checks; this pick can't be re-run");
    console.log("NOT PUBLISHED");
    process.exit(3);
  }
  console.log("VERIFIED");
  process.exit(0);
} catch (error) {
  console.error(`could not check: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
