import type { TenderClient } from "@tender/client";
import {
  BriefSchema,
  canonicalJson,
  ScorecardSchema,
  sha256Hex,
  type TaskView,
  type TenderApi,
} from "@tender/shared";
import { expect, test } from "vitest";
import { readPaidEscrowResult } from "../src/services/paid-result";

function fixture() {
  const request = { operation: "csv-audit", input: { csv: "id\nA\n", required_columns: ["id"] } };
  const result = { rows: 1 };
  const blobs = new Map<string, Uint8Array>();
  const put = (value: unknown) => {
    const bytes = canonicalJson(value);
    const hash = sha256Hex(bytes);
    blobs.set(hash, bytes);
    return hash;
  };
  const brief = BriefSchema.parse({
    version: 1,
    title: "Audit an import",
    summary: "Team test.",
    instructions: JSON.stringify(request),
    category: "data",
    tags: [],
    output: { format: "json", max_bytes: 4096 },
  });
  const contentHash = put(result);
  const card = ScorecardSchema.parse({
    version: 1,
    task_id: "2",
    verifier: "buyer.testnet",
    kind: "rubric",
    criteria_hash: "a".repeat(64),
    heldout: null,
    heldout_commitment: null,
    tie_break: "score desc, committed_at_block asc, account asc",
    entries: [
      {
        account: "specialist.testnet",
        content_hash: contentHash,
        uri: "blob:test",
        committed_at_block: "10",
        score: 100,
        passed: true,
        reasons: [],
      },
    ],
    winners: [{ account: "specialist.testnet", bps: 10000 }],
    generated_at: "2026-11-12T00:00:00Z",
    judge: { software: "team-check/1", model: null },
  });
  const task = {
    id: "2",
    parent: "1",
    poster: "buyer.testnet",
    verifier: "buyer.testnet",
    token: "token.testnet",
    reward: "100000",
    invited: ["specialist.testnet"],
    brief_hash: put(brief),
    criteria_hash: card.criteria_hash,
    outcome: {
      kind: "picked",
      winners: [{ account: "specialist.testnet", bps: 10000, amount: "95000" }],
      fee: "5000",
      scorecard_hash: put(card),
    },
  } as unknown as TaskView;
  const options = {
    chain: { getTask: async () => task } as Pick<TenderClient, "getTask">,
    api: { getBlob: async (hash: string) => blobs.get(hash) ?? null } as Pick<TenderApi, "getBlob">,
    taskId: 2n,
    parent: "1",
    poster: "buyer.testnet",
    agent: "specialist.testnet",
    token: "token.testnet",
    price: "100000",
    request,
    validate: (value: unknown) => JSON.stringify(value) === JSON.stringify(result),
  };
  return { options, task, card, blobs, put, contentHash };
}

test("verifies a paid result after contract entry cleanup without calling getEntry", async () => {
  const f = fixture();
  expect(await readPaidEscrowResult(f.options)).toMatchObject({
    taskId: "2",
    contentHash: f.contentHash,
    result: { rows: 1 },
  });
});
test.each(["parent", "poster", "verifier", "token", "reward"] as const)(
  "rejects the wrong purchase %s",
  async (field) => {
    const f = fixture();
    f.task[field] = "wrong.testnet";
    await expect(readPaidEscrowResult(f.options)).rejects.toThrow("approved purchase");
  },
);
test("rejects tampered scorecard bytes", async () => {
  const f = fixture();
  if (f.task.outcome?.kind !== "picked") throw new Error("fixture");
  f.blobs.set(f.task.outcome.scorecard_hash, canonicalJson({ changed: true }));
  await expect(readPaidEscrowResult(f.options)).rejects.toThrow("wrong hash");
});
test("rejects tampered answer bytes", async () => {
  const f = fixture();
  f.blobs.set(f.contentHash, canonicalJson({ rows: 99 }));
  await expect(readPaidEscrowResult(f.options)).rejects.toThrow("wrong hash");
});
test("rejects another input even when the service was paid", async () => {
  const f = fixture();
  f.options.request.input.csv = "id\nB\n";
  await expect(readPaidEscrowResult(f.options)).rejects.toThrow("input differs");
});
test("rejects a scorecard for another task even with a matching on-chain hash", async () => {
  const f = fixture();
  if (f.task.outcome?.kind !== "picked") throw new Error("fixture");
  f.task.outcome.scorecard_hash = f.put({ ...f.card, task_id: "3" });
  await expect(readPaidEscrowResult(f.options)).rejects.toThrow("scorecard does not match");
});
test("rejects a paid response that fails the buyer's content check", async () => {
  const f = fixture();
  f.options.validate = () => false;
  await expect(readPaidEscrowResult(f.options)).rejects.toThrow("content check");
});
test("rejects a missing retained result", async () => {
  const f = fixture();
  f.blobs.delete(f.contentHash);
  await expect(readPaidEscrowResult(f.options)).rejects.toThrow("missing");
});
