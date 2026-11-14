import { canonicalJson } from "@tender/shared";
import type { Solver } from "../types";
import { csvRecords } from "./data-quality";

type Purchase = (
  slug: "csv-audit" | "duplicate-records",
  input: unknown,
  taskId: string,
) => Promise<unknown>;

function report(value: unknown, service: string, count: number): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid service report.");
  const body = value as Record<string, unknown>;
  if (body.service !== service || body.version !== 1 || body.record_count !== count)
    throw new Error("Service report does not match the requested work.");
  return body;
}

/** Programmed workflow: buys two owner-configured checks and composes an import decision. */
export function createImportPlannerSolver(purchase: Purchase): Solver {
  return {
    name: "Tender team Import Planner",
    scripted: true,
    async solve(ctx) {
      let request: {
        operation?: unknown;
        csv?: unknown;
        required_columns?: unknown;
        key_columns?: unknown;
      };
      try {
        request = JSON.parse(ctx.brief.instructions);
      } catch {
        return null;
      }
      if (
        request?.operation !== "import-readiness" ||
        typeof request.csv !== "string" ||
        ctx.brief.output.format !== "json"
      )
        return null;
      const rows = csvRecords(request.csv);
      const required = request.required_columns ?? [];
      const keys = request.key_columns;
      const validNames = (value: unknown): value is string[] =>
        Array.isArray(value) &&
        value.length <= 50 &&
        value.every((name) => typeof name === "string" && name.trim() && name.length <= 80) &&
        new Set(value).size === value.length;
      if (!validNames(required) || !validNames(keys) || !keys.length) return null;
      const audit = report(
        await purchase("csv-audit", { csv: request.csv, required_columns: required }, ctx.task.id),
        "csv-audit",
        rows.length,
      );
      const duplicates = report(
        await purchase("duplicate-records", { records: rows, key_columns: keys }, ctx.task.id),
        "duplicate-records",
        rows.length,
      );
      if (
        typeof audit.passes_requested_checks !== "boolean" ||
        !Number.isSafeInteger(duplicates.duplicate_group_count) ||
        !Number.isSafeInteger(duplicates.incomplete_key_record_count) ||
        (duplicates.duplicate_group_count as number) < 0 ||
        (duplicates.incomplete_key_record_count as number) < 0
      )
        throw new Error("Invalid check totals.");
      return canonicalJson({
        audit,
        duplicates,
        decision:
          audit.passes_requested_checks &&
          duplicates.duplicate_group_count === 0 &&
          duplicates.incomplete_key_record_count === 0
            ? "passes_requested_import_checks"
            : "review_required",
        scope:
          "Structure, required fields and exact keys only; not scientific accuracy or completeness of source coverage.",
      });
    },
  };
}
