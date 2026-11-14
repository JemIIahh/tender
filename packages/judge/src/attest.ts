import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";

// The attested model request. NEAR AI Cloud runs some models in a TEE (Intel TDX with NVIDIA
// confidential GPUs) and signs each completion with a key that the TEE's attestation report names.
// For a request sent with `x-no-aliasing: true` and no streaming, it answers
// `GET /v1/signature/{chat_id}?model={model}&signing_algo=ecdsa` with
//
//   text       "{model}:{sha256 of the exact request body}:{sha256 of the exact response body}"
//   signature  EIP-191 personal_sign over `text`, 65 bytes, by `signing_address`
//
// so whoever holds the two bodies can hash them again, rebuild `text` and recover the signer. That
// is what this file does for each request the Judge sends in attested mode, and what the contract's
// `pick_attested` does again on chain against the signer the owner registered. What it proves: the
// key that the attestation report names signed these bytes. What it does not: that the TEE is
// genuine (that is the attestation report, checked off chain before the signer is registered), or
// that the score the model gave is right.

/** One completion's attestation, as it goes on the scorecard and (in part) to `pick_attested`. */
export interface Attestation {
  /** The model id the request named and the signature's `text` starts with. */
  model: string;
  /** `"{model}:{request_sha256}:{response_sha256}"`. */
  text: string;
  /** EIP-191 signature over `text`: `0x` and 130 lowercase hex characters (r, s, v). */
  signature: string;
  /** The address the signature recovers to: `0x` and 40 lowercase hex characters. */
  signing_address: string;
  /** SHA-256 of `request`'s UTF-8 bytes, 64 lowercase hex characters. */
  request_sha256: string;
  /** SHA-256 of `response`'s UTF-8 bytes, 64 lowercase hex characters. */
  response_sha256: string;
  /** The exact request body sent. */
  request: string;
  /** The exact response body received. */
  response: string;
}

/** What `attestedComplete` is given. */
export interface AttestedCompleteInput {
  /** The OpenAI-compatible base URL, `https://cloud-api.near.ai/v1`. */
  baseUrl: string;
  apiKey: string;
  /** The model's canonical id: the signature's `text` must start with it. */
  model: string;
  /**
   * The chat completion request. `model` and `stream: false` are set over whatever it holds, and
   * `JSON.stringify` of the result is the exact request body.
   */
  body: Record<string, unknown>;
  /** The `fetch` to use: tests pass a fake. The global one by default. */
  fetchImpl?: typeof fetch;
  /** How long the completion may take, and the signature after it: 60 s each by default. */
  timeoutMs?: number;
  /** Cancels the request, the caller's stop line say. */
  signal?: AbortSignal;
  /** The most bytes of a completion that are read: 64 KiB by default. */
  maxReplyBytes?: number;
  /** How many times a signature that is not there yet (HTTP 404) is asked for again: 5. */
  signatureRetries?: number;
  /** How long to wait before asking again: 500 ms. */
  signatureRetryDelayMs?: number;
}

/** What went wrong with an attested request. `reason` holds nothing the server sent. */
export type AttestedFailure =
  /** The completion request was answered with this HTTP status. */
  | { kind: "http"; status: number }
  /** The completion is larger than the Judge reads. */
  | { kind: "too_large" }
  /** The completion or the signature did not come in time, or the caller cancelled. */
  | { kind: "timeout" }
  | { kind: "aborted" }
  /** The server could not be reached. */
  | { kind: "unreachable" }
  /** The completion is not UTF-8 JSON with a chat id. */
  | { kind: "not_completion" }
  /** The signature could not be had, or does not hold for these bytes: never the entry's doing. */
  | { kind: "attestation"; reason: string };

/** Thrown by `attestedComplete`. */
export class AttestedCompletionError extends Error {
  override name = "AttestedCompletionError";
  readonly failure: AttestedFailure;

  constructor(failure: AttestedFailure) {
    super(describeFailure(failure));
    this.failure = failure;
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_REPLY_BYTES = 65_536;
/** The most bytes of a signature answer that are read: it is a few hundred. */
const MAX_SIGNATURE_BYTES = 16_384;
const DEFAULT_SIGNATURE_RETRIES = 5;
const DEFAULT_SIGNATURE_RETRY_DELAY_MS = 500;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const SIGNATURE = /^(0x)?[0-9a-fA-F]{130}$/;

/**
 * Sends one chat completion to a NEAR AI Cloud TEE model and returns it with its checked
 * attestation. The request body is `JSON.stringify(body)` with `model` and `stream: false` set,
 * sent with `x-no-aliasing: true` (so the model that answers is the one named), and the response
 * body is kept as the exact text received (at most `maxReplyBytes`). Then the signature is fetched
 * for the completion's `id` (asked for again on HTTP 404, as it can lag the completion), and it is
 * checked here before anything is returned: `text` must be `"{model}:{sha256(request)}:{sha256(
 * response)}"` for these exact bytes, and the EIP-191 signature over it must recover to the
 * `signing_address` the server gave. `completion` is the parsed response.
 *
 * Throws `AttestedCompletionError`: `http` for a non-2xx completion, `too_large`, `timeout`,
 * `aborted`, `unreachable`, `not_completion`, or `attestation` when the signature cannot be had or
 * does not hold. No message quotes the server or the key.
 */
export async function attestedComplete(
  input: AttestedCompleteInput,
): Promise<{ completion: unknown; attestation: Attestation }> {
  const doFetch = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = input.baseUrl.replace(/\/+$/, "");
  const request = JSON.stringify({ ...input.body, model: input.model, stream: false });
  const headers = {
    authorization: `Bearer ${input.apiKey}`,
    "content-type": "application/json",
    "x-no-aliasing": "true",
  };

  const completionBytes = await send(input.signal, timeoutMs, async (signal) => {
    const response = await doFetch(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: request,
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new AttestedCompletionError({ kind: "http", status: response.status });
    }
    return readCapped(response, input.maxReplyBytes ?? DEFAULT_MAX_REPLY_BYTES);
  });
  const responseText = utf8(completionBytes);
  let completion: unknown;
  try {
    completion = JSON.parse(responseText ?? "");
  } catch {
    throw new AttestedCompletionError({ kind: "not_completion" });
  }
  const chatId: unknown =
    typeof completion === "object" && completion !== null
      ? Reflect.get(completion, "id")
      : undefined;
  if (responseText === null || typeof chatId !== "string" || chatId === "") {
    throw new AttestedCompletionError({ kind: "not_completion" });
  }

  const requestSha256 = bytesToHex(sha256(utf8ToBytes(request)));
  const responseSha256 = bytesToHex(sha256(completionBytes));
  const query = new URLSearchParams({ model: input.model, signing_algo: "ecdsa" });
  const signatureUrl = `${base}/signature/${encodeURIComponent(chatId)}?${query.toString()}`;
  const retries = input.signatureRetries ?? DEFAULT_SIGNATURE_RETRIES;
  const delayMs = input.signatureRetryDelayMs ?? DEFAULT_SIGNATURE_RETRY_DELAY_MS;

  const signed = await send(input.signal, timeoutMs, async (signal) => {
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(signatureUrl, { method: "GET", headers, signal });
      if (response.status === 404 && attempt < retries) {
        await response.body?.cancel().catch(() => undefined);
        await sleep(delayMs, signal);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw attestationFailure(`the signature was refused (HTTP ${response.status})`);
      }
      const text = utf8(await readCapped(response, MAX_SIGNATURE_BYTES));
      try {
        return JSON.parse(text ?? "") as unknown;
      } catch {
        throw attestationFailure("the signature answer is not JSON");
      }
    }
  });

  const attestation = checkSignatureAnswer(signed, {
    model: input.model,
    request,
    response: responseText,
    requestSha256,
    responseSha256,
  });
  return { completion, attestation };
}

/**
 * The attestation in a signature answer for these exact bodies, or throws (`attestation`): the
 * answer must be `{ text, signature, signing_address }` (and `signing_algo` `ecdsa` when given),
 * `text` must be exactly `"{model}:{requestSha256}:{responseSha256}"`, and the signature must
 * recover to `signing_address`.
 */
function checkSignatureAnswer(
  answer: unknown,
  bodies: {
    model: string;
    request: string;
    response: string;
    requestSha256: string;
    responseSha256: string;
  },
): Attestation {
  if (typeof answer !== "object" || answer === null) {
    throw attestationFailure("the signature answer is not an object");
  }
  const text: unknown = Reflect.get(answer, "text");
  const signature: unknown = Reflect.get(answer, "signature");
  const address: unknown = Reflect.get(answer, "signing_address");
  const algo: unknown = Reflect.get(answer, "signing_algo");
  if (typeof text !== "string" || typeof signature !== "string" || typeof address !== "string") {
    throw attestationFailure("the signature answer lacks text, signature or signing_address");
  }
  if (algo !== undefined && algo !== "ecdsa") {
    throw attestationFailure("the signature is not ecdsa");
  }
  const expected = `${bodies.model}:${bodies.requestSha256}:${bodies.responseSha256}`;
  if (text !== expected) {
    throw attestationFailure("the signed text is not the model and the hashes of these bodies");
  }
  const signingAddress = address.toLowerCase();
  if (!ADDRESS.test(signingAddress)) throw attestationFailure("signing_address is no address");
  const recovered = recoverAddress(text, signature);
  if (recovered === null || recovered !== signingAddress) {
    throw attestationFailure("the signature does not recover to signing_address");
  }
  return {
    model: bodies.model,
    text,
    signature: normaliseSignature(signature),
    signing_address: signingAddress,
    request_sha256: bodies.requestSha256,
    response_sha256: bodies.responseSha256,
    request: bodies.request,
    response: bodies.response,
  };
}

/**
 * What is wrong with `attestation` as a record of a completion, or `null`: its hashes are not those
 * of its `request` and `response`, its `text` is not `"{model}:{request_sha256}:{response_sha256}"`,
 * or its signature does not recover to `signing_address`. Anyone holding a scorecard can run the
 * same checks (`scripts/verify-scorecard.mjs` does, with Node alone).
 */
export function attestationProblem(attestation: Attestation): string | null {
  const requestSha256 = bytesToHex(sha256(utf8ToBytes(attestation.request)));
  const responseSha256 = bytesToHex(sha256(utf8ToBytes(attestation.response)));
  if (requestSha256 !== attestation.request_sha256) return "request_sha256 is not of request";
  if (responseSha256 !== attestation.response_sha256) return "response_sha256 is not of response";
  if (attestation.text !== `${attestation.model}:${requestSha256}:${responseSha256}`) {
    return "text is not model:request_sha256:response_sha256";
  }
  const recovered = recoverAddress(attestation.text, attestation.signature);
  if (recovered === null || recovered !== attestation.signing_address.toLowerCase()) {
    return "the signature does not recover to signing_address";
  }
  return null;
}

/**
 * The address (`0x` and 40 lowercase hex) that signed `text` with EIP-191 personal_sign, or `null`
 * when `signature` is not 65 bytes of hex (`0x` optional) with v of 27, 28, 0 or 1, or recovers no
 * key. The digest is keccak256("\x19Ethereum Signed Message:\n" + the byte length of `text` in
 * decimal + `text`), and the address is the last 20 bytes of keccak256 of the 64-byte public key:
 * what the contract does with `env::ecrecover`.
 */
export function recoverAddress(text: string, signature: string): string | null {
  if (!SIGNATURE.test(signature)) return null;
  const bytes = hexToBytes(signature.replace(/^0x/, ""));
  const v = bytes[64] ?? -1;
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) return null;
  const message = utf8ToBytes(text);
  const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${message.length}`);
  const prefixed = new Uint8Array(prefix.length + message.length);
  prefixed.set(prefix);
  prefixed.set(message, prefix.length);
  try {
    const key = secp256k1.Signature.fromCompact(bytes.slice(0, 64))
      .addRecoveryBit(recovery)
      .recoverPublicKey(keccak_256(prefixed))
      .toRawBytes(false);
    return `0x${bytesToHex(keccak_256(key.slice(1)).slice(12))}`;
  } catch {
    return null;
  }
}

/**
 * The address (`0x` and 40 lowercase hex) of a secp256k1 public key given as 64 bytes of hex (`x`
 * then `y`, with `0x` or a leading `04` allowed): the last 20 bytes of its keccak256. `null` when
 * it is not such a key.
 */
export function addressOfPublicKey(publicKey: string): string | null {
  const key = publicKey.replace(/^0x/, "").replace(/^04(?=[0-9a-fA-F]{128}$)/, "");
  if (!/^[0-9a-fA-F]{128}$/.test(key)) return null;
  return `0x${bytesToHex(keccak_256(hexToBytes(key)).slice(12))}`;
}

/** `signature` as `0x` and lowercase hex. */
function normaliseSignature(signature: string): string {
  return `0x${signature.replace(/^0x/, "").toLowerCase()}`;
}

function attestationFailure(reason: string): AttestedCompletionError {
  return new AttestedCompletionError({ kind: "attestation", reason });
}

function describeFailure(failure: AttestedFailure): string {
  switch (failure.kind) {
    case "http":
      return `the model server answered HTTP ${failure.status}`;
    case "too_large":
      return "the model server's reply is larger than the Judge reads";
    case "timeout":
      return "the model server did not answer in time";
    case "aborted":
      return "the request was cancelled";
    case "unreachable":
      return "the model server could not be reached";
    case "not_completion":
      return "the model server's reply is not a chat completion";
    case "attestation":
      return `the reply could not be attested: ${failure.reason}`;
  }
}

/**
 * Runs `work` with a signal that aborts after `timeoutMs` or when `outer` does, and turns what a
 * `fetch` throws into an `AttestedCompletionError`.
 */
async function send<T>(
  outer: AbortSignal | undefined,
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timer = AbortSignal.timeout(timeoutMs);
  const signal = outer === undefined ? timer : AbortSignal.any([outer, timer]);
  try {
    return await work(signal);
  } catch (error) {
    if (error instanceof AttestedCompletionError) throw error;
    if (outer?.aborted === true) throw new AttestedCompletionError({ kind: "aborted" });
    if (timer.aborted) throw new AttestedCompletionError({ kind: "timeout" });
    throw new AttestedCompletionError({ kind: "unreachable" });
  }
}

/** The body of `response`, failing (`too_large`) once it passes `limit` bytes. */
async function readCapped(response: Response, limit: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new AttestedCompletionError({ kind: "too_large" });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** `bytes` as text, or `null` when they are not UTF-8. A byte order mark is kept, not dropped. */
function utf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
