import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  type Attestation,
  AttestedCompletionError,
  attestationProblem,
  attestedComplete,
  recoverAddress,
} from "../src/attest";

/** A real NEAR AI Cloud TEE signature over a real completion (see the file's `_about`). */
const FIXTURE = JSON.parse(
  readFileSync(new URL("../../../docs/research/S1-fixture.json", import.meta.url), "utf8"),
) as {
  model: string;
  chat_id: string;
  request: string;
  response: string;
  request_sha256: string;
  response_sha256: string;
  text: string;
  signature: string;
  signing_address: string;
};

const BASE = "https://cloud-api.near.ai/v1";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/**
 * A fake NEAR AI Cloud: the completion answers with `response` (the fixture's exact bytes by
 * default) and the signature endpoint with `signature` (the fixture's), after `notYet` 404s.
 */
function fakeCloud(
  options: {
    response?: string;
    completionStatus?: number;
    signature?: Record<string, unknown>;
    signatureStatus?: number;
    notYet?: number;
  } = {},
) {
  const seen: Seen[] = [];
  let notYet = options.notYet ?? 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    seen.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (url === `${BASE}/chat/completions`) {
      return new Response(options.response ?? FIXTURE.response, {
        status: options.completionStatus ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith(`${BASE}/signature/`)) {
      if (notYet > 0) {
        notYet--;
        return new Response("{}", { status: 404 });
      }
      const answer = options.signature ?? {
        text: FIXTURE.text,
        signature: FIXTURE.signature,
        signing_address: FIXTURE.signing_address,
        signing_algo: "ecdsa",
        signature_kind: "provider_tee",
      };
      return new Response(JSON.stringify(answer), { status: options.signatureStatus ?? 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

/** The fixture's request body, parsed: sent again it is the same bytes. */
const BODY = JSON.parse(FIXTURE.request) as Record<string, unknown>;

const call = (fetchImpl: typeof fetch) =>
  attestedComplete({
    baseUrl: `${BASE}/`,
    apiKey: "test-key",
    model: FIXTURE.model,
    body: BODY,
    fetchImpl,
    signatureRetryDelayMs: 1,
  });

async function failureOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AttestedCompletionError) return error.failure;
    throw error;
  }
  throw new Error("expected AttestedCompletionError");
}

test("the_fixture_is_accepted_and_its_attestation_is_returned", async () => {
  const cloud = fakeCloud();
  const { completion, attestation } = await call(cloud.fetchImpl);

  expect(attestation).toStrictEqual({
    model: FIXTURE.model,
    text: FIXTURE.text,
    signature: FIXTURE.signature,
    signing_address: FIXTURE.signing_address,
    request_sha256: FIXTURE.request_sha256,
    response_sha256: FIXTURE.response_sha256,
    request: FIXTURE.request,
    response: FIXTURE.response,
  } satisfies Attestation);
  expect(completion).toStrictEqual(JSON.parse(FIXTURE.response));
  expect(attestationProblem(attestation)).toBeNull();

  // The exact bytes, with the header that pins the model, and the signature for the chat id.
  const [sent, asked] = cloud.seen;
  expect(sent?.url).toBe(`${BASE}/chat/completions`);
  expect(sent?.method).toBe("POST");
  expect(sent?.body).toBe(FIXTURE.request);
  expect(sent?.headers["x-no-aliasing"]).toBe("true");
  expect(sent?.headers.authorization).toBe("Bearer test-key");
  expect(asked?.url).toBe(
    `${BASE}/signature/${FIXTURE.chat_id}?model=Qwen%2FQwen3.8-27B&signing_algo=ecdsa`,
  );
  expect(asked?.headers["x-no-aliasing"]).toBe("true");
});

test("model_and_stream_false_are_set_over_the_body", async () => {
  const cloud = fakeCloud();
  const body = { ...BODY, model: "something/else", stream: true };
  // The fixture was signed over `stream: false` and the canonical model, in the body's key order.
  await attestedComplete({
    baseUrl: BASE,
    apiKey: "k",
    model: FIXTURE.model,
    body,
    fetchImpl: cloud.fetchImpl,
  });
  expect(cloud.seen[0]?.body).toBe(FIXTURE.request);
});

test("a_signature_that_is_not_there_yet_is_asked_for_again", async () => {
  const cloud = fakeCloud({ notYet: 2 });
  const { attestation } = await call(cloud.fetchImpl);
  expect(attestation.signing_address).toBe(FIXTURE.signing_address);
  expect(cloud.seen.filter((seen) => seen.url.includes("/signature/"))).toHaveLength(3);
});

test("a_signature_that_never_comes_fails_as_an_attestation_failure", async () => {
  const cloud = fakeCloud({ notYet: 100 });
  const failure = await failureOf(call(cloud.fetchImpl));
  expect(failure).toMatchObject({ kind: "attestation" });
});

test("a_tampered_response_is_rejected", async () => {
  // One character of the reply changed: its hash is no longer the one the TEE signed.
  const tampered = FIXTURE.response.replace('"prompt_tokens":59', '"prompt_tokens":58');
  expect(tampered).not.toBe(FIXTURE.response);
  const failure = await failureOf(call(fakeCloud({ response: tampered }).fetchImpl));
  expect(failure).toStrictEqual({
    kind: "attestation",
    reason: "the signed text is not the model and the hashes of these bodies",
  });
});

test("a_tampered_text_or_signature_or_address_is_rejected", async () => {
  const good = {
    text: FIXTURE.text,
    signature: FIXTURE.signature,
    signing_address: FIXTURE.signing_address,
  };
  const flip = (hex: string, at: number) =>
    `${hex.slice(0, at)}${hex[at] === "0" ? "1" : "0"}${hex.slice(at + 1)}`;
  const cases: Record<string, unknown>[] = [
    // The text names another model or other hashes.
    { ...good, text: FIXTURE.text.replace("Qwen3.8", "Qwen3.9") },
    { ...good, text: `${FIXTURE.text}0` },
    // The signature is changed, or another key's.
    { ...good, signature: flip(FIXTURE.signature, 10) },
    { ...good, signature: `${FIXTURE.signature.slice(0, -2)}1d` },
    { ...good, signature: FIXTURE.signature.slice(0, -2) },
    { ...good, signing_address: "0x0000000000000000000000000000000000000001" },
    { ...good, signing_algo: "ed25519" },
    { text: FIXTURE.text },
  ];
  for (const signature of cases) {
    const failure = await failureOf(call(fakeCloud({ signature }).fetchImpl));
    expect(failure.kind, JSON.stringify(signature)).toBe("attestation");
  }
});

test("http_errors_and_non_completions_are_told_apart", async () => {
  expect(await failureOf(call(fakeCloud({ completionStatus: 400 }).fetchImpl))).toStrictEqual({
    kind: "http",
    status: 400,
  });
  expect(await failureOf(call(fakeCloud({ completionStatus: 503 }).fetchImpl))).toStrictEqual({
    kind: "http",
    status: 503,
  });
  expect(await failureOf(call(fakeCloud({ response: "not json" }).fetchImpl))).toStrictEqual({
    kind: "not_completion",
  });
  expect(await failureOf(call(fakeCloud({ response: '{"choices":[]}' }).fetchImpl))).toStrictEqual({
    kind: "not_completion",
  });
  expect(await failureOf(call(fakeCloud({ signatureStatus: 500 }).fetchImpl))).toMatchObject({
    kind: "attestation",
  });
});

test("a_reply_larger_than_the_limit_is_too_large", async () => {
  const cloud = fakeCloud({ response: `{"id":"x","pad":"${"a".repeat(70_000)}"}` });
  expect(await failureOf(call(cloud.fetchImpl))).toStrictEqual({ kind: "too_large" });
});

test("a_server_that_cannot_be_reached_or_hangs_or_is_cancelled_is_told_apart", async () => {
  const unreachable = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  expect(await failureOf(call(unreachable))).toStrictEqual({ kind: "unreachable" });

  const hangs = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as typeof fetch;
  const timedOut = attestedComplete({
    baseUrl: BASE,
    apiKey: "k",
    model: FIXTURE.model,
    body: BODY,
    fetchImpl: hangs,
    timeoutMs: 20,
  });
  expect(await failureOf(timedOut)).toStrictEqual({ kind: "timeout" });

  const controller = new AbortController();
  const cancelled = attestedComplete({
    baseUrl: BASE,
    apiKey: "k",
    model: FIXTURE.model,
    body: BODY,
    fetchImpl: hangs,
    signal: controller.signal,
  });
  controller.abort();
  expect(await failureOf(cancelled)).toStrictEqual({ kind: "aborted" });
});

test("no_failure_message_quotes_the_key", async () => {
  const error = await call(fakeCloud({ completionStatus: 401 }).fetchImpl).catch((e) => e);
  expect(String(error.message)).not.toContain("test-key");
});

test("recover_address_takes_v_as_27_28_0_or_1_and_nothing_else", () => {
  const body = FIXTURE.signature.slice(2, -2);
  const v = FIXTURE.signature.slice(-2); // 1c = 28
  expect(v).toBe("1c");
  expect(recoverAddress(FIXTURE.text, FIXTURE.signature)).toBe(FIXTURE.signing_address);
  expect(recoverAddress(FIXTURE.text, `${body}01`)).toBe(FIXTURE.signing_address);
  expect(recoverAddress(FIXTURE.text, `0x${body}1b`)).not.toBe(FIXTURE.signing_address);
  expect(recoverAddress(FIXTURE.text, `0x${body}02`)).toBeNull();
  expect(recoverAddress(FIXTURE.text, "0x1234")).toBeNull();
});

test("attestation_problem_names_what_does_not_hold", () => {
  const good: Attestation = {
    model: FIXTURE.model,
    text: FIXTURE.text,
    signature: FIXTURE.signature,
    signing_address: FIXTURE.signing_address,
    request_sha256: FIXTURE.request_sha256,
    response_sha256: FIXTURE.response_sha256,
    request: FIXTURE.request,
    response: FIXTURE.response,
  };
  expect(attestationProblem(good)).toBeNull();
  expect(attestationProblem({ ...good, response: `${FIXTURE.response} ` })).toBe(
    "response_sha256 is not of response",
  );
  expect(attestationProblem({ ...good, request: `${FIXTURE.request} ` })).toBe(
    "request_sha256 is not of request",
  );
  expect(attestationProblem({ ...good, model: "other/model" })).toBe(
    "text is not model:request_sha256:response_sha256",
  );
  expect(
    attestationProblem({ ...good, signing_address: "0x0000000000000000000000000000000000000001" }),
  ).toBe("the signature does not recover to signing_address");
});
