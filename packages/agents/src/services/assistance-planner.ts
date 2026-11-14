import { canonicalJson, sha256Hex } from "@tender/shared";
import type { TaskContext } from "../types";
import { auditCsv, csvRecords, findDuplicateRecords } from "./data-quality";
import { utilityRequest } from "./escrow";
import type { AssistancePlan } from "./escrow-assistance";

/**
 * This planner can parse and assemble imports; CSV audits and duplicate checks are capabilities
 * it delegates. The local checker deliberately recomputes the narrow deterministic checks before
 * paying. This proves orchestration, not unique expertise or an LLM discovering its limitations.
 */
export function planAssistedImport(ctx: TaskContext): AssistancePlan | null {
  const request = utilityRequest(ctx.brief.instructions);
  if (request?.operation !== "import-readiness" || typeof request.csv !== "string") return null;
  const names = (value: unknown): value is string[] =>
    Array.isArray(value) &&
    value.length <= 50 &&
    value.every((name) => typeof name === "string" && !!name.trim() && name.length <= 80) &&
    new Set(value).size === value.length;
  const required = request.required_columns ?? [];
  if (!names(required) || !names(request.key_columns) || !request.key_columns.length) return null;
  try {
    const auditInput = { csv: request.csv, required_columns: required };
    const duplicateInput = { records: csvRecords(request.csv), key_columns: request.key_columns };
    const expected = [auditCsv(auditInput), findDuplicateRecords(duplicateInput)];
    return {
      needs: [
        {
          capability: "csv-audit",
          request: JSON.stringify({ operation: "csv-audit", input: auditInput }),
        },
        {
          capability: "duplicate-records",
          request: JSON.stringify({ operation: "duplicate-records", input: duplicateInput }),
        },
      ],
      validate: (index, result) =>
        index < expected.length &&
        sha256Hex(canonicalJson(result)) === sha256Hex(canonicalJson(expected[index])),
      compose(results) {
        const audit = results[0] as ReturnType<typeof auditCsv>;
        const duplicates = results[1] as ReturnType<typeof findDuplicateRecords>;
        return {
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
        };
      },
    };
  } catch {
    return null;
  }
}
