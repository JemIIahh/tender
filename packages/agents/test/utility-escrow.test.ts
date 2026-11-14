import { hireDocuments, type Service } from "@tender/shared";
import { expect, test } from "vitest";
import { createUtilityEscrowSolver } from "../src/services/escrow";
import type { TaskContext } from "../src/types";

test("a normal escrow hire's wrapped JSON request produces useful CSV diagnostics", async () => {
  const service = {
    id: "1",
    title: "CSV Import Audit",
    agent: "data-check.provider.testnet",
    provider: "provider.testnet",
    description: "CSV audit",
    category: "data",
    tags: ["csv"],
    output_format: "json",
    verification: { kind: "hirer" },
    payment_mode: "escrow",
  } as Service;
  const { brief, criteria } = hireDocuments(
    service,
    JSON.stringify({
      operation: "csv-audit",
      input: { csv: "id,quantity\nA,\n", required_columns: ["id", "quantity"] },
    }),
  );
  const answer = await createUtilityEscrowSolver("data-check").solve({
    brief,
    criteria,
    task: { id: "1", token: "tusdc.tender-dev-1104.testnet", reward: "100000" },
  } as TaskContext);
  const report = JSON.parse(new TextDecoder().decode(answer ?? undefined));
  expect(report.blank_required_cell_count).toBe(1);
  expect(report.passes_requested_checks).toBe(false);
});

test("the planner computes an import report without making paid calls", async () => {
  const context = {
    task: { token: "tusdc.tender-dev-1104.testnet", reward: "200000" },
    brief: {
      instructions: JSON.stringify({
        operation: "import-readiness",
        csv: "id\nA\nA",
        key_columns: ["id"],
      }),
      output: { format: "json", max_bytes: 16_384 },
    },
  } as TaskContext;
  const answer = await createUtilityEscrowSolver("import-planner").solve(context);
  expect(JSON.parse(new TextDecoder().decode(answer ?? undefined)).decision).toBe(
    "review_required",
  );
  expect(await createUtilityEscrowSolver("data-check").solve(context)).toBeNull();
  context.brief.output.max_bytes = 1;
  expect(await createUtilityEscrowSolver("import-planner").solve(context)).toBeNull();
});

test("a cheaper operation or different asset cannot buy the import-readiness report", async () => {
  const context = {
    task: { token: "tusdc.tender-dev-1104.testnet", reward: "100000" },
    brief: {
      instructions: JSON.stringify({
        operation: "import-readiness",
        csv: "id\nA",
        key_columns: ["id"],
      }),
      output: { format: "json", max_bytes: 16_384 },
    },
  } as TaskContext;
  const solver = createUtilityEscrowSolver("import-planner");
  expect(await solver.solve(context)).toBeNull();
  context.task.reward = "200000";
  context.task.token = "other.testnet";
  expect(await solver.solve(context)).toBeNull();
});
