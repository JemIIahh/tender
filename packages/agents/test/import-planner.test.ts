import type { Brief } from "@tender/shared";
import { expect, test, vi } from "vitest";
import { auditCsv, findDuplicateRecords } from "../src/services/data-quality";
import { createImportPlannerSolver } from "../src/services/import-planner";
import type { TaskContext } from "../src/types";

const context = (request: unknown): TaskContext => ({
  brief: { instructions: JSON.stringify(request), output: { format: "json" } } as Brief,
  task: { id: "17" } as TaskContext["task"],
  criteria: {} as TaskContext["criteria"],
});

test("planner buys real computations and reports repeated IDs for review", async () => {
  const purchase = vi.fn(async (slug, input) =>
    slug === "csv-audit" ? auditCsv(input) : findDuplicateRecords(input),
  );
  const solver = createImportPlannerSolver(purchase);
  const answer = await solver.solve(
    context({
      operation: "import-readiness",
      csv: "id,qty\nA,2\nA,3",
      required_columns: ["id", "qty"],
      key_columns: ["id"],
    }),
  );
  expect(answer).not.toBeNull();
  const report = JSON.parse(new TextDecoder().decode(answer ?? undefined));
  expect(report.decision).toBe("review_required");
  expect(report.duplicates.duplicate_groups).toEqual([{ record_count: 2, records: [1, 2] }]);
  expect(purchase.mock.calls.map((call) => call[0])).toEqual(["csv-audit", "duplicate-records"]);
});

test("unsupported tasks and invalid key policies cannot cause a purchase", async () => {
  const purchase = vi.fn();
  const solver = createImportPlannerSolver(purchase);
  expect(
    await solver.solve(context({ operation: "fetch-url", url: "https://example.com" })),
  ).toBeNull();
  expect(
    await solver.solve(context({ operation: "import-readiness", csv: "id\nA", key_columns: [] })),
  ).toBeNull();
  expect(purchase).not.toHaveBeenCalled();
});

test("a response for a different dataset cannot become a task answer", async () => {
  const solver = createImportPlannerSolver(async () => ({
    service: "csv-audit",
    version: 1,
    record_count: 100,
  }));
  await expect(
    solver.solve(context({ operation: "import-readiness", csv: "id\nA", key_columns: ["id"] })),
  ).rejects.toThrow("does not match");
});
