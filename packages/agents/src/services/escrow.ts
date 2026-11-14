import { canonicalJson } from "@tender/shared";
import type { Solver } from "../types";
import { auditCsv, findDuplicateRecords, importReadiness } from "./data-quality";
import { EXTENDED_UTILITY_SERVICES } from "./data-tools";

/** The hire builder appends listing metadata after the hirer's JSON request. Treat both as data. */
export function utilityRequest(instructions: string): Record<string, unknown> | null {
  try {
    const words = instructions.split("\n\n---\nThis task hires service ", 1)[0] ?? "";
    const value: unknown = JSON.parse(words);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Escrow service solver. It computes each response; it neither calls a model nor buys APIs. */
export function createUtilityEscrowSolver(role: "data-check" | "import-planner"): Solver {
  return {
    name: role === "data-check" ? "Tender team Data Check" : "Tender team Import Planner",
    scripted: true,
    async solve(ctx) {
      if (ctx.brief.output.format !== "json") return null;
      const request = utilityRequest(ctx.brief.instructions);
      if (!request) return null;
      const offered = UTILITY_ESCROW_CATALOG.find(
        (service) => service.role === role && service.operation === request.operation,
      );
      if (
        !offered ||
        ctx.task?.token !== "tusdc.tender-dev-1104.testnet" ||
        typeof ctx.task.reward !== "string" ||
        !/^\d+$/.test(ctx.task.reward) ||
        BigInt(ctx.task.reward) < BigInt(offered.price)
      )
        return null;
      let result: unknown;
      if (role === "data-check" && request.operation === "csv-audit")
        result = auditCsv(request.input);
      else if (role === "data-check" && request.operation === "duplicate-records")
        result = findDuplicateRecords(request.input);
      else if (
        role === "import-planner" &&
        request.operation === "import-readiness" &&
        typeof request.csv === "string"
      ) {
        const names = (value: unknown): value is string[] =>
          Array.isArray(value) &&
          value.length <= 50 &&
          value.every((name) => typeof name === "string" && !!name.trim() && name.length <= 80) &&
          new Set(value).size === value.length;
        const required = request.required_columns ?? [];
        if (!names(required) || !names(request.key_columns) || !request.key_columns.length)
          return null;
        result = importReadiness(request.csv, required, request.key_columns);
      } else {
        const service = EXTENDED_UTILITY_SERVICES.find(
          (service) => service.role === role && service.operation === request.operation,
        );
        if (!service) return null;
        result = service.run(request.input);
      }
      const bytes = canonicalJson(result);
      return bytes.byteLength <= ctx.brief.output.max_bytes ? bytes : null;
    },
  };
}

export const UTILITY_ESCROW_CATALOG = [
  {
    operation: "csv-audit",
    role: "data-check",
    title: "CSV Import Audit",
    price: "100000",
    tags: ["data-quality", "csv"],
    description:
      'Check a CSV export before importing it into a catalog, dashboard or business system. Receive missing-column, blank-field and wrong-width counts with record positions. Request JSON: {"operation":"csv-audit","input":{"csv":"id,quantity\\nA,2\\n","required_columns":["id","quantity"]}}. Comma-separated CSV with a header; up to 2,000 records and 50 columns. The hire request must fit 4,000 characters. Deterministic service run by the Tender team. No semantic validation or automatic data changes. Delivered through task escrow; the buyer reviews the report.',
  },
  {
    operation: "duplicate-records",
    role: "data-check",
    title: "Duplicate Record Check",
    price: "100000",
    tags: ["data-quality", "deduplication"],
    description:
      'Find repeated invoice IDs, catalog keys or other exact identifiers before merging JSON records. Receive duplicate groups, counts and incomplete-key positions. Request JSON: {"operation":"duplicate-records","input":{"records":[{"invoice":"A"},{"invoice":"A"}],"key_columns":["invoice"]}}. Optional case_sensitive defaults to true. Flat JSON records only; no fuzzy identity matching or automatic deletion. The hire request must fit 4,000 characters. Deterministic service run by the Tender team. Delivered through task escrow; the buyer reviews the report.',
  },
  {
    operation: "import-readiness",
    role: "import-planner",
    title: "Import Readiness Report",
    price: "200000",
    tags: ["import-readiness", "data-quality"],
    description:
      'Check a CSV export for required values and repeated keys, then receive a structured import-readiness report. Request JSON: {"operation":"import-readiness","csv":"id,quantity\\nA,2\\nB,3\\n","required_columns":["id","quantity"],"key_columns":["id"]}. The hire request must fit 4,000 characters. Reports passes_requested_import_checks or review_required with diagnostic counts and locations. It does not check business or scientific accuracy, rewrite files or delete records. Computed directly by a deterministic workflow run by the Tender team; this escrow version does not purchase another service. The buyer reviews the report.',
  },
  ...EXTENDED_UTILITY_SERVICES.map((service) => ({
    operation: service.operation,
    role: service.role,
    title: service.title,
    price: service.price,
    tags: service.tags,
    description: `${service.description} Hire request: at most 4,000 characters. Deterministic service run by the Tender team. Delivered through task escrow; the buyer reviews the report.`,
  })),
] as const;
