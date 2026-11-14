import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { TenderClient, TenderError } from "@tender/client";
import { addressOfPublicKey } from "@tender/judge";
import { AccountIdSchema, type AttestedSignerView, NETWORKS } from "@tender/shared";
import { readDeployment, UsageError } from "./deploy";
import { loadEnv } from "./lib/env";

/**
 * Registers a NEAR AI Cloud TEE model's signing key as a signer the contract's `pick_attested`
 * accepts. It fetches the model's attestation report, finds the model's entry, prints the evidence,
 * and then, as the contract's owner, calls
 *
 *   set_attested_signer(signer_id, "ecdsa", <signing address>, model, true)
 *
 * and reads the signer back with `get_attested_signer`.
 *
 *   pnpm exec tsx scripts/register-signer.ts --network testnet --signer-id nearai-qwen3.8 \
 *     --model Qwen/Qwen3.8-27B [--report <saved report.json>] [--dry-run]
 *
 * The report is `GET {LLM_BASE_URL or https://cloud-api.near.ai/v1}/attestation/report?model=
 * {model}&signing_algo=ecdsa&nonce={32 fresh random bytes}`, with `LLM_API_KEY` as the bearer when
 * it is set; `--report` reads a saved one instead. What is checked here, and printed:
 *
 * - the model's entry is in `model_attestations`, with `signing_algo` ecdsa, a `signing_address`
 *   and the `signing_public_key` it comes from (keccak256 of the 64-byte key, last 20 bytes): a
 *   mismatch is refused;
 * - `intel_quote` and `nvidia_payload` are present: missing either is refused;
 * - the quote's report_data (bytes 568 to 632 of the TDX quote) holds the signing address and the
 *   report's `request_nonce`, and the NVIDIA payload names the same nonce, and whether that nonce is
 *   the one sent (a fresh report) or one the server chose.
 *
 * What is NOT checked here: the quote's signature chain to Intel, the TDX measurements against a
 * known build, and the NVIDIA payload's signature, which need Intel's and NVIDIA's verifiers (or
 * NEAR AI's verifier). Run those off chain before you trust the key; this script says so every time.
 *
 * The owner's key is `DEPLOY_PARENT_ACCOUNT` and `DEPLOY_PARENT_PRIVATE_KEY` from `.env` or
 * `.env.deploy.<network>`, the deploy's, and the contract is `deployments/testnet.json`'s (or
 * `TENDER_CONTRACT`). On the sandbox, `NEAR_RPC_URL` and `TENDER_CONTRACT` name the node and the
 * contract. Mainnet is refused by name, and when the node says its chain id is `mainnet`.
 * `--dry-run` prints the evidence and calls nothing. The key is never printed.
 */

const USAGE =
  "usage: pnpm exec tsx scripts/register-signer.ts --network testnet|sandbox --signer-id <id> " +
  "--model <model> [--report <file>] [--dry-run]";
const MAINNET_REFUSED =
  "mainnet is not handled by this script: registering a mainnet signer needs the owner's approval";
const DEFAULT_BASE_URL = "https://cloud-api.near.ai/v1";
/** Where report_data sits in a TDX quote (v4): 64 bytes, after the 48-byte header and the TD report's first 520. */
const REPORT_DATA_OFFSET = 568;
const SIGNER_ID = /^[a-z0-9._-]{1,64}$/;

/** What the report says about the model, and what was checked of it. */
export interface Evidence {
  model: string;
  signingAddress: string;
  /** The address is the one the report's public key gives. Always true: a mismatch throws. */
  addressFromPublicKey: true;
  intelQuoteBytes: number;
  nvidiaPayloadBytes: number;
  requestNonce: string;
  /** Whether `request_nonce` is the nonce sent with the request: a report made for this run. */
  nonceIsOurs: boolean;
  /** Whether the quote's report_data holds the signing address, and the nonce. */
  quoteBindsAddress: boolean;
  quoteBindsNonce: boolean;
  /** Whether the NVIDIA payload's `nonce` is `request_nonce`. */
  nvidiaNonceMatches: boolean;
}

/**
 * The evidence for `model` in `report`, or throws: no entry for the model, an algorithm other than
 * ecdsa, no address or public key, an address that is not the public key's, or no quote or NVIDIA
 * payload. `sentNonce` is the nonce the request carried, if any.
 */
export function examineReport(report: unknown, model: string, sentNonce?: string): Evidence {
  const entries: unknown = isRecord(report) ? report.model_attestations : undefined;
  if (!Array.isArray(entries)) throw new Error("the report has no model_attestations");
  const entry: unknown = entries.find((item) => isRecord(item) && item.model_name === model);
  if (!isRecord(entry)) throw new Error(`the report has no attestation for model ${model}`);
  if (entry.signing_algo !== undefined && entry.signing_algo !== "ecdsa") {
    throw new Error(`the report's key for ${model} is not ecdsa`);
  }
  const address =
    typeof entry.signing_address === "string" ? entry.signing_address.toLowerCase() : "";
  const publicKey = typeof entry.signing_public_key === "string" ? entry.signing_public_key : "";
  if (!/^0x[0-9a-f]{40}$/.test(address))
    throw new Error("the report's signing_address is no address");
  const derived = addressOfPublicKey(publicKey);
  if (derived === null) {
    throw new Error("the report's signing_public_key is not a 64-byte secp256k1 key");
  }
  if (derived !== address) {
    throw new Error("the report's signing_address is not the address of its signing_public_key");
  }
  const quote = typeof entry.intel_quote === "string" ? entry.intel_quote : "";
  const payload = typeof entry.nvidia_payload === "string" ? entry.nvidia_payload : "";
  if (quote === "") throw new Error(`the report has no intel_quote for ${model}`);
  if (payload === "") throw new Error(`the report has no nvidia_payload for ${model}`);
  const nonce = typeof entry.request_nonce === "string" ? entry.request_nonce.toLowerCase() : "";

  let reportData = "";
  if (/^[0-9a-fA-F]+$/.test(quote) && quote.length >= 2 * (REPORT_DATA_OFFSET + 64)) {
    reportData = quote.slice(2 * REPORT_DATA_OFFSET, 2 * (REPORT_DATA_OFFSET + 64)).toLowerCase();
  }
  let nvidiaNonce: unknown;
  try {
    const parsed: unknown = JSON.parse(payload);
    nvidiaNonce = isRecord(parsed) ? parsed.nonce : undefined;
  } catch {
    nvidiaNonce = undefined;
  }
  return {
    model,
    signingAddress: address,
    addressFromPublicKey: true,
    intelQuoteBytes: quote.length / 2,
    nvidiaPayloadBytes: payload.length,
    requestNonce: nonce,
    nonceIsOurs: sentNonce !== undefined && nonce === sentNonce.toLowerCase(),
    quoteBindsAddress: reportData.startsWith(address.slice(2)),
    quoteBindsNonce: nonce !== "" && reportData.endsWith(nonce),
    nvidiaNonceMatches: typeof nvidiaNonce === "string" && nvidiaNonce.toLowerCase() === nonce,
  };
}

/** The lines that print `evidence`, with what is and is not verified here. */
export function describeEvidence(evidence: Evidence): string[] {
  const yesNo = (value: boolean) => (value ? "yes" : "NO");
  return [
    `model                        ${evidence.model}`,
    `signing address              ${evidence.signingAddress}`,
    "address from the public key  yes (keccak256 of signing_public_key)",
    `intel_quote                  present, ${evidence.intelQuoteBytes} bytes`,
    `nvidia_payload               present, ${evidence.nvidiaPayloadBytes} characters`,
    `request nonce                ${evidence.requestNonce}${evidence.nonceIsOurs ? " (the one sent: a fresh report)" : " (not the one sent: chosen by the server)"}`,
    `quote report_data binds      address ${yesNo(evidence.quoteBindsAddress)}, nonce ${yesNo(evidence.quoteBindsNonce)}`,
    `nvidia payload nonce         ${evidence.nvidiaNonceMatches ? "matches" : "DIFFERENT"}`,
    "verified here: the model's entry, the address from its key, and that the quote's report_data",
    "  and the NVIDIA payload name this address and nonce.",
    "NOT verified here: the TDX quote's signature chain to Intel, its measurements against a known",
    "  build, and the NVIDIA payload's signature. Check those with Intel's and NVIDIA's verifiers",
    "  (or NEAR AI's) before you trust this key.",
  ];
}

/** The attestation report for `model`, with `nonce`, as JSON. Throws on any failure. */
export async function fetchReport(input: {
  baseUrl: string;
  apiKey?: string;
  model: string;
  nonce: string;
  fetchImpl?: typeof fetch;
}): Promise<unknown> {
  const query = new URLSearchParams({
    model: input.model,
    signing_algo: "ecdsa",
    nonce: input.nonce,
  });
  const url = `${input.baseUrl.replace(/\/+$/, "")}/attestation/report?${query.toString()}`;
  const response = await (input.fetchImpl ?? fetch)(url, {
    headers: input.apiKey === undefined ? {} : { authorization: `Bearer ${input.apiKey}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`the attestation report was refused (HTTP ${response.status})`);
  return response.json();
}

/** What the script needs of the chain. `TenderClient` is it, with the owner as signer. */
export interface SignerChain {
  chainId(): Promise<string>;
  setAttestedSigner(input: {
    signerId: string;
    address: string;
    model: string;
    enabled: boolean;
  }): Promise<{ txHash: string }>;
  getAttestedSigner(signerId: string): Promise<AttestedSignerView | null>;
}

/**
 * Checks the evidence, then (unless `dryRun`) registers the signer and reads it back. Throws when
 * the chain is mainnet, or the signer read back is not what was set.
 */
export async function registerSigner(input: {
  signerId: string;
  model: string;
  report: unknown;
  sentNonce?: string;
  chain: SignerChain;
  dryRun?: boolean;
  out: (line: string) => void;
}): Promise<Evidence> {
  const evidence = examineReport(input.report, input.model, input.sentNonce);
  for (const line of describeEvidence(evidence)) input.out(line);
  if (input.dryRun === true) {
    input.out("dry run: set_attested_signer was not called");
    return evidence;
  }
  if ((await input.chain.chainId()) === "mainnet") throw new UsageError(MAINNET_REFUSED);
  const { txHash } = await input.chain.setAttestedSigner({
    signerId: input.signerId,
    address: evidence.signingAddress,
    model: input.model,
    enabled: true,
  });
  input.out(
    `OK set_attested_signer ${input.signerId} ecdsa ${evidence.signingAddress} ${input.model} (transaction ${txHash})`,
  );
  const stored = await input.chain.getAttestedSigner(input.signerId);
  if (
    stored === null ||
    stored.address !== evidence.signingAddress ||
    stored.model !== input.model ||
    !stored.enabled
  ) {
    throw new Error("get_attested_signer does not read back what was set");
  }
  input.out(
    `OK get_attested_signer ${input.signerId}: enabled, ${stored.address}, ${stored.model}`,
  );
  return evidence;
}

export interface CliOptions {
  /** Where the env files and `deployments/` are. */
  dir?: string;
  out?: (line: string) => void;
  err?: (text: string) => void;
  /** The `fetch` for the report: tests pass a fake. */
  fetchImpl?: typeof fetch;
  /** The chain, made from the target: tests pass a fake. */
  makeChain?: (target: {
    network: string;
    rpcUrl: string;
    contractId: string;
    owner: { accountId: string; privateKey: string };
  }) => SignerChain;
  /** Reads a saved report: tests pass a fake. */
  readReport?: (path: string) => Promise<unknown>;
}

/** Runs the command line and returns the exit code: 0 when the signer is registered, else 1. */
export async function main(args: readonly string[], options: CliOptions = {}): Promise<number> {
  const out = options.out ?? console.log;
  const err = options.err ?? console.error;
  try {
    let values: {
      network?: string;
      "signer-id"?: string;
      model?: string;
      report?: string;
      "dry-run"?: boolean;
    };
    try {
      values = parseArgs({
        args: [...args],
        options: {
          network: { type: "string" },
          "signer-id": { type: "string" },
          model: { type: "string" },
          report: { type: "string" },
          "dry-run": { type: "boolean" },
        },
      }).values;
    } catch (error) {
      throw new UsageError(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    }
    const { network, model } = values;
    const signerId = values["signer-id"];
    if (network === "mainnet") throw new UsageError(MAINNET_REFUSED);
    if (network !== "testnet" && network !== "sandbox") throw new UsageError(USAGE);
    if (signerId === undefined || !SIGNER_ID.test(signerId)) {
      throw new UsageError(`--signer-id must be 1 to 64 of a-z, 0-9, '.', '_' and '-'\n${USAGE}`);
    }
    if (model === undefined || model === "" || model.includes(":") || model.length > 128) {
      throw new UsageError(`--model must be the model's id, 1 to 128 characters, no ':'\n${USAGE}`);
    }

    const env = loadEnv(network, { dir: options.dir });
    const sentNonce = randomBytes(32).toString("hex");
    const report =
      values.report === undefined
        ? await fetchReport({
            baseUrl: env.LLM_BASE_URL?.trim() || DEFAULT_BASE_URL,
            apiKey: env.LLM_API_KEY?.trim() || undefined,
            model,
            nonce: sentNonce,
            fetchImpl: options.fetchImpl,
          })
        : await (options.readReport ?? readJson)(values.report);

    const chain = values["dry-run"] === true ? undefined : await chainFor(network, env, options);
    await registerSigner({
      signerId,
      model,
      report,
      sentNonce: values.report === undefined ? sentNonce : undefined,
      chain: chain ?? NO_CHAIN,
      dryRun: values["dry-run"],
      out,
    });
    return 0;
  } catch (error) {
    if (error instanceof UsageError) err(error.message);
    else if (error instanceof TenderError) {
      const tx = error.txHash === undefined ? "" : `\ntransaction ${error.txHash}`;
      err(`register-signer failed with ${error.code}\n${error.message}${tx}`);
    } else err(`register-signer failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** A chain for a dry run, which calls none of it. */
const NO_CHAIN: SignerChain = {
  chainId: async () => {
    throw new Error("a dry run asks the chain nothing");
  },
  setAttestedSigner: async () => {
    throw new Error("a dry run calls nothing");
  },
  getAttestedSigner: async () => null,
};

/** The chain of `network`, signing as the owner. */
async function chainFor(
  network: "testnet" | "sandbox",
  env: Record<string, string>,
  options: CliOptions,
): Promise<SignerChain> {
  const accountId = env.DEPLOY_PARENT_ACCOUNT?.trim() ?? "";
  const privateKey = env.DEPLOY_PARENT_PRIVATE_KEY?.trim() ?? "";
  if (!AccountIdSchema.safeParse(accountId).success || privateKey === "") {
    throw new UsageError(
      `DEPLOY_PARENT_ACCOUNT and DEPLOY_PARENT_PRIVATE_KEY, the contract owner's, must be set in .env or .env.deploy.${network}`,
    );
  }
  let rpcUrl: string;
  let contractId: string;
  if (network === "testnet") {
    rpcUrl = env.NEAR_RPC_URL?.trim() || NETWORKS.testnet.rpcUrl;
    contractId =
      env.TENDER_CONTRACT?.trim() ||
      ((await readDeployment("testnet", options.dir))?.contract ?? "");
  } else {
    rpcUrl = env.NEAR_RPC_URL?.trim() ?? "";
    contractId = env.TENDER_CONTRACT?.trim() ?? "";
    if (rpcUrl === "") throw new UsageError("NEAR_RPC_URL must name the sandbox node");
  }
  if (!AccountIdSchema.safeParse(contractId).success) {
    throw new UsageError("no contract: set TENDER_CONTRACT, or deploy so deployments/ names it");
  }
  const target = { network, rpcUrl, contractId, owner: { accountId, privateKey } };
  if (options.makeChain !== undefined) return options.makeChain(target);
  const client = new TenderClient({ network, contractId, rpcUrl, signer: target.owner });
  return {
    chainId: async () => {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: [] }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await response.json()) as { result?: { chain_id?: unknown } };
      return String(body.result?.chain_id ?? "");
    },
    setAttestedSigner: (input) => client.setAttestedSigner(input),
    getAttestedSigner: (id) => client.getAttestedSigner(id),
  };
}

async function readJson(path: string): Promise<unknown> {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(path, "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Only when run as the script, never when a test imports from here.
if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
