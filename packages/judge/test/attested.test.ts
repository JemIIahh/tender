import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { type Db, getBlob, putBlob } from "@tender/db";
import {
  type Brief,
  canonicalJson,
  type EntryView,
  ScorecardSchema,
  sha256Hex,
  type TaskView,
} from "@tender/shared";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { attestationProblem } from "../src/attest";
import { judgeTask } from "../src/index";
import { ATTESTED_MAX_ENTRIES, type RubricCriteria } from "../src/kinds/rubric";
import type { JudgeChain } from "../src/types";
import { gradeJson, type LlmRequest } from "./fake-llm";
import {
  blobUri,
  entry,
  fakeChain,
  insertTask,
  judgeDeps,
  judgeRow,
  putCriteria,
  putResult,
  resetDb,
  TEAM_POSTER,
  taskView,
  testDb,
} from "./helpers";

// The attested Judge (`JudgeDeps.attested`): every rubric request goes through `attestedComplete`
// to a fake NEAR AI Cloud that signs each completion with a test key, as the TEE does
// (text = model:sha256(request):sha256(response), EIP-191). No test reaches a real model.

const KEY = "key-for-tests";
const MODEL = "Qwen/Qwen3.8-27B";
const BASE = "https://cloud-api.near.ai/v1";
const SIGNER_ID = "nearai-qwen3.8";
/** The fake TEE's key, and its address. */
const TEE_KEY = sha256(utf8ToBytes("the fake TEE's key"));
const TEE_ADDRESS = `0x${bytesToHex(keccak_256(secp256k1.getPublicKey(TEE_KEY, false).slice(1)).slice(12))}`;

const BRIEF: Brief = {
  version: 1,
  title: "Describe a lighthouse",
  summary: "One paragraph about a lighthouse.",
  instructions: "Write one paragraph of at most 80 words that describes a lighthouse at night.",
  category: "writing",
  tags: ["writing"],
  output: { format: "text", max_bytes: 2000 },
};

const RUBRIC: RubricCriteria = {
  version: 1,
  kind: "rubric",
  min_score: 50,
  split: [7000, 3000],
  has_heldout: false,
  rubric: [
    { criterion: "clear", weight: 3 },
    { criterion: "accurate", weight: 2 },
    { criterion: "short", weight: 5 },
  ],
};

/** EIP-191 personal_sign of `text` with `key`: r, s and v (27 or 28), as `0x` hex. */
function personalSign(text: string, key: Uint8Array): string {
  const message = utf8ToBytes(text);
  const digest = keccak_256(
    new Uint8Array([...utf8ToBytes(`\x19Ethereum Signed Message:\n${message.length}`), ...message]),
  );
  const signature = secp256k1.sign(digest, key);
  return `0x${signature.toCompactHex()}${(27 + (signature.recovery ?? 0)).toString(16)}`;
}

interface FakeTee {
  fetchImpl: typeof fetch;
  /** The bodies of the completion requests, in order. */
  requests: string[];
  /** The headers each completion request was sent with. */
  headers: Record<string, string>[];
}

/**
 * A fake NEAR AI Cloud: it grades each entry by `scoreOf` its text, answers with a completion whose
 * id is `chat-{n}`, and signs `model:sha256(request):sha256(response)` with `TEE_KEY`, or as
 * `tamper` says.
 */
function fakeTee(
  scoreOf: (text: string) => number,
  tamper: { claimAddress?: string } = {},
): FakeTee {
  const signed = new Map<string, { request: string; response: string }>();
  const requests: string[] = [];
  const headers: Record<string, string>[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === `${BASE}/chat/completions`) {
      const request = String(init?.body);
      requests.push(request);
      headers.push(Object.fromEntries(new Headers(init?.headers).entries()));
      const body = JSON.parse(request) as { messages: { role: string; content: string }[] };
      const user = body.messages.find((message) => message.role === "user")?.content ?? "";
      const asked = { user } as LlmRequest;
      const id = `chat-${requests.length}`;
      const response = JSON.stringify({
        id,
        object: "chat.completion",
        model: MODEL,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: gradeJson(asked, (_criterion, text) => scoreOf(text)),
            },
            finish_reason: "stop",
          },
        ],
      });
      signed.set(id, { request, response });
      return new Response(response, { status: 200 });
    }
    const match = /\/signature\/([^?]+)\?/.exec(url);
    const bodies = signed.get(match?.[1] ?? "");
    if (bodies === undefined) return new Response("{}", { status: 404 });
    const hash = (text: string) => bytesToHex(sha256(utf8ToBytes(text)));
    const text = `${MODEL}:${hash(bodies.request)}:${hash(bodies.response)}`;
    return new Response(
      JSON.stringify({
        text,
        signature: personalSign(text, TEE_KEY),
        signing_address: tamper.claimAddress ?? TEE_ADDRESS,
        signing_algo: "ecdsa",
      }),
    );
  }) as typeof fetch;
  return { fetchImpl, requests, headers };
}

const llm = { baseUrl: BASE, apiKey: KEY, model: MODEL };

/** `fakeChain` with `pickAttested` as well. */
function attestedChain(view: TaskView, entries: EntryView[]) {
  const chain = fakeChain(view, entries);
  return {
    ...chain,
    pickAttested: vi.fn(
      async (
        _taskId: bigint,
        _winners: readonly { account: string; bps: number }[],
        _scorecardHash: string,
        _scorecardUri: string,
        _attestations: readonly { signer_id: string; text: string; signature: string }[],
      ): Promise<unknown> => ({}),
    ),
  } satisfies JudgeChain;
}

let db: Db;

beforeAll(async () => {
  db = await testDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  vi.restoreAllMocks();
});

/** Task 7, an open team rubric task in its judging window, with `answers` as our own blobs. */
async function postRubric(answers: [account: string, text: string, block: bigint][]) {
  const view = taskView({
    poster: TEAM_POSTER,
    criteria_hash: await putCriteria(db, RUBRIC),
    brief_hash: await putBlob(db, {
      kind: "brief",
      contentType: "application/json",
      bytes: canonicalJson(BRIEF),
      uploader: TEAM_POSTER,
      isPublic: true,
    }),
    max_entries: 0,
    invited: [],
  });
  await insertTask(db, view, "accepted");
  const entries: EntryView[] = [];
  for (const [account, text, block] of answers) {
    const sha = await putResult(db, text, account);
    entries.push(entry(account, sha, blobUri(sha), block));
  }
  return { view, chain: attestedChain(view, entries) };
}

async function scorecardOf(sha: string | undefined) {
  const blob = await getBlob(db, sha ?? "");
  if (blob === null) throw new Error("the scorecard is not stored");
  const text = new TextDecoder().decode(blob.bytes);
  return { text, scorecard: ScorecardSchema.parse(JSON.parse(text)) };
}

const byText = (text: string) => (text.startsWith("good") ? 9 : text.startsWith("okay") ? 7 : 4);

test("an_attested_rubric_task_carries_its_signatures_and_is_settled_with_pick_attested", async () => {
  const { chain } = await postRubric([
    ["alice.test.near", "good answer", 12n],
    ["bob.test.near", "weak answer", 10n],
    ["eve.test.near", "okay answer", 13n],
  ]);
  const tee = fakeTee(byText);
  const deps = judgeDeps(db, chain, {
    llm,
    attested: { signerId: SIGNER_ID, fetchImpl: tee.fetchImpl },
    resultUploaded: async () => true,
  });

  expect(await judgeTask(deps, 7n)).toBe("picked");

  // One request for each entry, each with the header that pins the model, and no plain pick.
  expect(tee.requests).toHaveLength(3);
  for (const headers of tee.headers) expect(headers["x-no-aliasing"]).toBe("true");
  expect(chain.pick).not.toHaveBeenCalled();
  expect(chain.pickAttested).toHaveBeenCalledTimes(1);
  const [taskId, winners, sha, , sent] = chain.pickAttested.mock.calls[0] ?? [];
  expect(taskId).toBe(7n);
  expect(winners).toEqual([
    { account: "alice.test.near", bps: 7000 },
    { account: "eve.test.near", bps: 3000 },
  ]);

  // The scorecard holds every completion, its exact bodies, and a signature that checks.
  const { text, scorecard } = await scorecardOf(sha);
  expect(scorecard.judge.model).toBe(MODEL);
  expect(scorecard.attestations).toHaveLength(3);
  for (const [i, attestation] of (scorecard.attestations ?? []).entries()) {
    expect(attestation.signer_id).toBe(SIGNER_ID);
    expect(attestation.signing_address).toBe(TEE_ADDRESS);
    expect(attestation.request).toBe(tee.requests[i]);
    expect(attestationProblem(attestation)).toBeNull();
  }
  // `pick_attested` is sent the signer, the text and the signature of each, in the same order.
  expect(sent).toEqual(
    scorecard.attestations?.map(({ signer_id, text, signature }) => ({
      signer_id,
      text,
      signature,
    })),
  );
  expect(sha).toBe(sha256Hex(new TextEncoder().encode(text)));
  expect(text).not.toContain(KEY);
  expect(await judgeRow(db, 7)).toEqual({ judge_status: "accepted", judge_reason: null });
});

test(`an_attested_judge_grades_the_first_${ATTESTED_MAX_ENTRIES}_entries_so_the_signatures_fit_one_pick`, async () => {
  const answers = Array.from(
    { length: ATTESTED_MAX_ENTRIES + 2 },
    (_, i) =>
      [`agent${i}.test.near`, `good answer ${i}`, BigInt(10 + i)] as [string, string, bigint],
  );
  const { chain } = await postRubric(answers);
  const tee = fakeTee(byText);
  const deps = judgeDeps(db, chain, {
    llm,
    attested: { signerId: SIGNER_ID, fetchImpl: tee.fetchImpl },
  });

  expect(await judgeTask(deps, 7n)).toBe("picked");

  expect(tee.requests).toHaveLength(ATTESTED_MAX_ENTRIES);
  const sha = chain.pickAttested.mock.calls[0]?.[2];
  const { scorecard } = await scorecardOf(sha);
  expect(scorecard.attestations).toHaveLength(ATTESTED_MAX_ENTRIES);
  expect(scorecard.entries.slice(-2).map((e) => [e.account, e.score, e.passed, e.reasons])).toEqual(
    [6, 7].map((i) => [
      `agent${i}.test.near`,
      0,
      false,
      ["not scored: the attested Judge scores the first 6 entries of a rubric task"],
    ]),
  );
});

test("a_reply_whose_signature_does_not_hold_fails_the_task_closed_and_nothing_is_picked", async () => {
  const { chain } = await postRubric([["alice.test.near", "good answer", 12n]]);
  // The signature is good, but by another key than the one the server names.
  const tee = fakeTee(byText, { claimAddress: "0x0000000000000000000000000000000000000001" });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const deps = judgeDeps(db, chain, {
    llm,
    attested: { signerId: SIGNER_ID, fetchImpl: tee.fetchImpl },
  });

  expect(await judgeTask(deps, 7n)).toBe("failed_closed");

  expect(chain.pick).not.toHaveBeenCalled();
  expect(chain.pickAttested).not.toHaveBeenCalled();
  const row = await judgeRow(db, 7);
  expect(row?.judge_status).toBe("failed_closed");
  expect(row?.judge_reason).toMatch(/^the model server's reply could not be attested \(content /);
});

test("an_attested_task_that_asked_the_model_nothing_is_settled_with_plain_pick", async () => {
  // No entries: no completion to attest, and `pick_attested` takes at least one.
  const { chain } = await postRubric([]);
  const tee = fakeTee(byText);
  const deps = judgeDeps(db, chain, {
    llm,
    attested: { signerId: SIGNER_ID, fetchImpl: tee.fetchImpl },
  });

  expect(await judgeTask(deps, 7n)).toBe("no_award");

  expect(tee.requests).toHaveLength(0);
  expect(chain.pickAttested).not.toHaveBeenCalled();
  expect(chain.pick).toHaveBeenCalledTimes(1);
  const { text } = await scorecardOf(chain.pick.mock.calls[0]?.[2]);
  expect(text).not.toContain("attestations");
});

test("extra_body_fields_reach_the_request_but_cannot_replace_the_model_or_messages", async () => {
  const { chain } = await postRubric([["alice.test.near", "good answer", 12n]]);
  const tee = fakeTee(byText);
  const deps = judgeDeps(db, chain, {
    llm,
    attested: {
      signerId: SIGNER_ID,
      fetchImpl: tee.fetchImpl,
      extraBody: {
        chat_template_kwargs: { enable_thinking: false },
        max_tokens: 8000,
        model: "other/model",
        stream: true,
        messages: [],
      },
    },
  });

  expect(await judgeTask(deps, 7n)).toBe("picked");

  const body = JSON.parse(tee.requests[0] ?? "{}");
  expect(body).toMatchObject({
    model: MODEL,
    stream: false,
    max_tokens: 8000,
    chat_template_kwargs: { enable_thinking: false },
  });
  expect(body.messages).toHaveLength(2);
});

test("a_pick_attested_that_fails_is_tried_again_with_the_same_signatures_and_no_new_request", async () => {
  const { chain } = await postRubric([["alice.test.near", "good answer", 12n]]);
  chain.pickAttested.mockRejectedValueOnce(new Error("the node did not answer"));
  const tee = fakeTee(byText);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const deps = judgeDeps(db, chain, {
    llm,
    attested: { signerId: SIGNER_ID, fetchImpl: tee.fetchImpl },
    memory: {
      checks: new Map(),
      progress: new Map(),
      overruns: new Map(),
      intakeFrom: null,
    },
  });

  expect(await judgeTask(deps, 7n)).toBe("skipped");
  expect(await judgeTask(deps, 7n)).toBe("picked");

  expect(tee.requests).toHaveLength(1);
  const [first, second] = chain.pickAttested.mock.calls;
  expect(second?.[4]).toEqual(first?.[4]);
  expect(second?.[4]).toHaveLength(1);
});
