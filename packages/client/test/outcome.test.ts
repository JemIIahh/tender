import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { receiptsFromTx } from "../src/outcome";

const outcomeWith = (status: unknown) => ({
  receipts_outcome: [
    { id: "R1", outcome: { executor_id: "tender.sandbox", status, logs: ["EVENT_JSON:{}"] } },
  ],
});

describe("receiptsFromTx", () => {
  test("maps_every_receipt_outcome_in_order", () => {
    const resp = {
      receipts_outcome: [
        {
          id: "R1",
          outcome: {
            executor_id: "tender.sandbox",
            status: { SuccessReceiptId: "R2" },
            logs: ["a", "b"],
          },
        },
        {
          id: "R2",
          outcome: { executor_id: "usdc.sandbox", status: { SuccessValue: "" }, logs: [] },
        },
      ],
    };
    expect(receiptsFromTx(resp)).toEqual([
      { receiptId: "R1", executorId: "tender.sandbox", status: "success", logs: ["a", "b"] },
      { receiptId: "R2", executorId: "usdc.sandbox", status: "success", logs: [] },
    ]);
  });

  test("copies_the_logs", () => {
    const resp = outcomeWith({ SuccessValue: "" });
    const [receipt] = receiptsFromTx(resp);
    receipt?.logs.push("added");
    expect(resp.receipts_outcome[0]?.outcome.logs).toEqual(["EVENT_JSON:{}"]);
  });

  // Ruling P02-R17: only the two success shapes are a success.
  test.each([
    [{ SuccessValue: "" }],
    [{ SuccessValue: "dHJ1ZQ==" }],
    [{ SuccessReceiptId: "8EMcZ3FFnsCVhtGJfM5yPWxRxwzTvrGsDb2zXg1Ug9vY" }],
  ])("status %j is a success", (status) => {
    expect(receiptsFromTx(outcomeWith(status))[0]?.status).toBe("success");
  });

  // Everything else is a failure. `"Failure" in status` would throw on the bare string "Unknown",
  // and would count every shape it did not expect as a success.
  test.each([
    [{ Failure: { ActionError: { index: 0, kind: { FunctionCallError: {} } } } }],
    ["Unknown"],
    ["SuccessValue"],
    [null],
    [undefined],
    [42],
    [[]],
    [{}],
    [{ successValue: "" }],
    [{ SuccessValue: 1 }],
    [{ SuccessReceiptId: null }],
    [{ SuccessValue: "", Failure: {} }],
  ])("status %j is a failure", (status) => {
    expect(receiptsFromTx(outcomeWith(status))[0]?.status).toBe("failure");
  });

  test("an_inherited_success_key_does_not_count", () => {
    const status = Object.create({ SuccessValue: "" });
    expect(receiptsFromTx(outcomeWith(status))[0]?.status).toBe("failure");
  });

  // The browser imports @tender/client/outcome, so the module loads nothing at run time: no RPC
  // stack, no Node API.
  test("imports_types_only", () => {
    const source = readFileSync(new URL("../src/outcome.ts", import.meta.url), "utf8");
    const lines = source.split("\n");
    for (const line of lines.filter((l) => /^\s*import\b/.test(l))) {
      expect(line).toMatch(/^import type /);
    }
    for (const line of lines.filter((l) => /^\s*export\b.*\bfrom\s+["']/.test(l))) {
      expect(line).toMatch(/^export type /);
    }
    for (const line of lines.filter((l) => /\bfrom\s+["']/.test(l))) {
      expect(line).not.toContain("near-api-js");
    }
    expect(source).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
  });
});
