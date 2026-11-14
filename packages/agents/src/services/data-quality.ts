/** Deterministic, team-run data services. Input is data; no model or remote URL is used. */
export const DATA_LIMIT_BYTES = 65_536;
const MAX_RECORDS = 2_000;
const MAX_COLUMNS = 50;
const MAX_EXAMPLES = 20;

export class DataInputError extends Error {}

function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new DataInputError("Expected a JSON object.");
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key)))
    throw new DataInputError("Unexpected input field.");
  return record;
}

function names(input: unknown, required = false): string[] {
  if (input === undefined && !required) return [];
  if (
    !Array.isArray(input) ||
    input.length > MAX_COLUMNS ||
    (required && input.length === 0) ||
    input.some((name) => typeof name !== "string" || !name.trim() || name.length > 80) ||
    new Set(input).size !== input.length
  )
    throw new DataInputError("Column names must be distinct nonempty strings, at most 50.");
  return input as string[];
}

/** Comma-separated CSV: quoted commas, escaped quotes, embedded newlines, LF and CRLF. */
function parseCsv(text: string): string[][] {
  if (!text || Buffer.byteLength(text) > DATA_LIMIT_BYTES)
    throw new DataInputError("CSV must contain a header and fit 64 KiB of UTF-8.");
  const source = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let state: "plain" | "quoted" | "closed" = "plain";
  const field = () => {
    row.push(value);
    value = "";
    state = "plain";
    if (row.length > MAX_COLUMNS) throw new DataInputError("CSV has more than 50 columns.");
  };
  const record = () => {
    field();
    rows.push(row);
    row = [];
    if (rows.length > MAX_RECORDS + 1)
      throw new DataInputError("CSV has more than 2,000 data records.");
  };
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (state === "quoted") {
      if (char === '"') {
        if (source[index + 1] === '"') {
          value += '"';
          index++;
        } else state = "closed";
      } else value += char;
    } else if (char === ",") field();
    else if (char === "\n" || char === "\r") {
      if (char === "\r") {
        if (source[index + 1] !== "\n")
          throw new DataInputError("Use LF or CRLF record separators.");
        index++;
      }
      record();
    } else if (char === '"' && state === "plain" && value === "") state = "quoted";
    else if (char === '"' || state === "closed") throw new DataInputError("Malformed CSV quoting.");
    else value += char;
  }
  if (state === "quoted") throw new DataInputError("Unclosed CSV quote.");
  if (row.length || value || state === "closed" || source.endsWith(",")) record();
  const header = rows[0];
  if (
    !header ||
    header.some((name) => !name.trim() || name.length > 80) ||
    new Set(header).size !== header.length
  )
    throw new DataInputError(
      "CSV header names must be distinct, nonempty and at most 80 characters.",
    );
  return rows;
}

export function auditCsv(input: unknown) {
  const request = object(input, ["csv", "required_columns"]);
  if (typeof request.csv !== "string") throw new DataInputError("csv must be a string.");
  const required = names(request.required_columns);
  const [header = [], ...rows] = parseCsv(request.csv);
  const missingColumns = required.filter((name) => !header.includes(name));
  const ragged: { record: number; actual_columns: number }[] = [];
  const blanks: { record: number; column: string }[] = [];
  let raggedCount = 0;
  let blankCount = 0;
  const emptyCounts = header.map(() => 0);
  for (const [index, row] of rows.entries()) {
    if (row.length !== header.length) {
      raggedCount++;
      if (ragged.length < MAX_EXAMPLES)
        ragged.push({ record: index + 2, actual_columns: row.length });
    }
    header.forEach((column, columnIndex) => {
      if ((row[columnIndex] ?? "").trim() !== "") return;
      emptyCounts[columnIndex] = (emptyCounts[columnIndex] ?? 0) + 1;
      if (required.includes(column)) {
        blankCount++;
        if (blanks.length < MAX_EXAMPLES) blanks.push({ record: index + 2, column });
      }
    });
  }
  return {
    service: "csv-audit",
    version: 1,
    passes_requested_checks: !missingColumns.length && !raggedCount && !blankCount,
    record_count: rows.length,
    columns: header.map((name, index) => ({ name, empty_cells: emptyCounts[index] ?? 0 })),
    missing_required_columns: missingColumns,
    wrong_width_count: raggedCount,
    wrong_width_examples: ragged,
    blank_required_cell_count: blankCount,
    blank_required_cell_examples: blanks,
    examples_limit: MAX_EXAMPLES,
    record_numbering: "Header is record 1; quoted newlines do not start a new record.",
  };
}

type Cell = string | number | boolean | null;

export function findDuplicateRecords(input: unknown) {
  const request = object(input, ["records", "key_columns", "case_sensitive"]);
  const keys = names(request.key_columns, true);
  const caseSensitive = request.case_sensitive ?? true;
  if (typeof caseSensitive !== "boolean")
    throw new DataInputError("case_sensitive must be a boolean.");
  if (!Array.isArray(request.records) || request.records.length > MAX_RECORDS)
    throw new DataInputError("records must be an array of at most 2,000 flat objects.");
  if (Buffer.byteLength(JSON.stringify(request)) > DATA_LIMIT_BYTES)
    throw new DataInputError("Input must fit 64 KiB of UTF-8 JSON.");
  const groups = new Map<string, number[]>();
  const incomplete: number[] = [];
  for (const [index, value] of request.records.entries()) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length > MAX_COLUMNS
    )
      throw new DataInputError("Each record must be a flat object of at most 50 fields.");
    const row = value as Record<string, Cell>;
    if (
      Object.values(row).some(
        (cell) =>
          cell !== null &&
          typeof cell !== "string" &&
          typeof cell !== "boolean" &&
          (typeof cell !== "number" || !Number.isFinite(cell)),
      )
    )
      throw new DataInputError("Record values must be strings, finite numbers, booleans or null.");
    const values = keys.map((key) => (Object.hasOwn(row, key) ? row[key] : undefined));
    if (values.some((cell) => cell === undefined || cell === null || cell === "")) {
      incomplete.push(index + 1);
      continue;
    }
    const key = JSON.stringify(
      values.map((cell) =>
        typeof cell === "string" && !caseSensitive ? cell.toLowerCase() : cell,
      ),
    );
    const group = groups.get(key) ?? [];
    group.push(index + 1);
    groups.set(key, group);
  }
  const duplicates = [...groups.values()].filter((group) => group.length > 1);
  return {
    service: "duplicate-records",
    version: 1,
    record_count: request.records.length,
    key_columns: keys,
    case_sensitive: caseSensitive,
    duplicate_group_count: duplicates.length,
    duplicate_record_count: duplicates.reduce((sum, group) => sum + group.length, 0),
    redundant_record_count: duplicates.reduce((sum, group) => sum + group.length - 1, 0),
    duplicate_groups: duplicates
      .slice(0, MAX_EXAMPLES)
      .map((group) => ({ record_count: group.length, records: group.slice(0, MAX_EXAMPLES) })),
    incomplete_key_record_count: incomplete.length,
    incomplete_key_examples: incomplete.slice(0, MAX_EXAMPLES),
    examples_limit: MAX_EXAMPLES,
    record_numbering:
      "Input array starts at record 1. Incomplete keys are excluded from duplicate groups.",
  };
}

export const DATA_QUALITY_SERVICES = [
  {
    slug: "csv-audit",
    title: "CSV import audit",
    description:
      "Checks CSV headers, record widths and required fields before an import. Returns counts and up to 20 locations per issue; does not return cell values. Deterministic service run by the Tender team. No semantic or business-rule validation.",
    tags: ["data-quality", "csv"],
    input: { csv: "sku,quantity\nPEN,12\nBOOK,\n", required_columns: ["sku", "quantity"] },
    run: auditCsv,
  },
  {
    slug: "duplicate-records",
    title: "Duplicate record check",
    description:
      "Finds repeated customer, invoice or catalog keys in JSON records. Returns group counts and record positions without returning values. Exact typed comparison; optional case-insensitive strings. Deterministic service run by the Tender team. No fuzzy identity matching.",
    tags: ["data-quality", "deduplication"],
    input: {
      records: [{ invoice: "INV-1" }, { invoice: "INV-2" }, { invoice: "INV-1" }],
      key_columns: ["invoice"],
    },
    run: findDuplicateRecords,
  },
] as const;

/** Converts a CSV export for exact key comparison; refuses ambiguous, wrong-width rows. */
export function csvRecords(csv: string): Record<string, string>[] {
  const [header = [], ...rows] = parseCsv(csv);
  if (rows.some((row) => row.length !== header.length))
    throw new DataInputError("Fix wrong-width CSV records before comparing keys.");
  return rows.map((row) =>
    Object.fromEntries(header.map((name, index) => [name, row[index] ?? ""])),
  );
}

export function importReadiness(csv: string, requiredColumns: string[], keyColumns: string[]) {
  const audit = auditCsv({ csv, required_columns: requiredColumns });
  const duplicates =
    audit.wrong_width_count === 0
      ? findDuplicateRecords({ records: csvRecords(csv), key_columns: keyColumns })
      : null;
  return {
    audit,
    duplicates,
    decision:
      audit.passes_requested_checks &&
      duplicates !== null &&
      duplicates.duplicate_group_count === 0 &&
      duplicates.incomplete_key_record_count === 0
        ? "passes_requested_import_checks"
        : "review_required",
    scope:
      "Structure, required fields and exact keys only; not scientific accuracy or completeness of source coverage.",
  };
}
