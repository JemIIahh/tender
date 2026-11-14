import { csvRecords, DataInputError } from "./data-quality";

type Cell = string | number | boolean | null;
type Row = Record<string, Cell>;
const LIMIT = 65_536;
const EXAMPLES = 20;

function inputObject(value: unknown, allowed: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DataInputError("Expected an input object.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new DataInputError("Unexpected input field.");
  return input;
}
function columnNames(value: unknown, nonempty = true): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 50 ||
    (nonempty && !value.length) ||
    value.some(
      (name) =>
        typeof name !== "string" ||
        !name.trim() ||
        name.length > 80 ||
        ["__proto__", "constructor", "prototype"].includes(name),
    ) ||
    new Set(value).size !== value.length
  )
    throw new DataInputError(
      "Use distinct column names, at most 50, with no reserved object keys.",
    );
  return value as string[];
}
function records(value: unknown): Row[] {
  if (!Array.isArray(value) || value.length > 2_000)
    throw new DataInputError("Use at most 2,000 flat records.");
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length > 50)
      throw new DataInputError("Each record must be a flat object of at most 50 fields.");
    columnNames(Object.keys(row), false);
    if (
      Object.values(row).some(
        (cell) =>
          cell !== null &&
          typeof cell !== "string" &&
          typeof cell !== "boolean" &&
          (typeof cell !== "number" || !Number.isFinite(cell)),
      )
    )
      throw new DataInputError(
        "Record cells must be JSON strings, finite numbers, booleans or null.",
      );
  }
  if (Buffer.byteLength(JSON.stringify(value)) > LIMIT)
    throw new DataInputError("Records must fit 64 KiB of JSON.");
  return value as Row[];
}
const has = (row: Row, name: string) => Object.hasOwn(row, name);
const empty = (value: Cell | undefined) =>
  value === undefined || value === null || (typeof value === "string" && !value.trim());

export function csvToJson(value: unknown) {
  const input = inputObject(value, ["csv"]);
  if (typeof input.csv !== "string") throw new DataInputError("csv must be a string.");
  const rows = csvRecords(input.csv);
  return {
    service: "csv-to-json",
    version: 1,
    record_count: rows.length,
    records: rows,
    value_types: "CSV values are preserved as strings; no type guessing.",
  };
}

export function jsonToCsv(value: unknown) {
  const input = inputObject(value, ["records", "columns"]);
  const rows = records(input.records);
  const columns =
    input.columns === undefined
      ? [...new Set(rows.flatMap((row) => Object.keys(row)))]
      : columnNames(input.columns);
  columnNames(columns);
  let sanitized = 0;
  const quote = (cell: Cell | undefined) => {
    let text = cell === null || cell === undefined ? "" : String(cell);
    if (text.includes("\0")) throw new DataInputError("CSV cells cannot contain NUL characters.");
    const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
    if (
      typeof cell === "string" &&
      (/^[\t\r\n]/.test(text) || (/^\s*[=+@-]/.test(text) && !numeric.test(text.trim())))
    ) {
      text = `'${text}`;
      sanitized++;
    }
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  // Headers are untrusted too. Formula-looking strings are prefixed rather than executed by a sheet.
  const csv = [
    columns.map(quote).join(","),
    ...rows.map((row) => columns.map((name) => quote(has(row, name) ? row[name] : null)).join(",")),
  ]
    .join("\n")
    .concat("\n");
  if (Buffer.byteLength(csv) > LIMIT) throw new DataInputError("CSV output exceeds 64 KiB.");
  return {
    service: "json-to-csv",
    version: 1,
    record_count: rows.length,
    columns,
    csv,
    formula_safe_cells: sanitized,
    null_values: "Absent and null cells are exported as empty fields.",
  };
}

export function mapColumns(value: unknown) {
  const input = inputObject(value, ["records", "mapping"]);
  const rows = records(input.records);
  if (!input.mapping || typeof input.mapping !== "object" || Array.isArray(input.mapping))
    throw new DataInputError("mapping must map source column names to target names.");
  const mapping = input.mapping as Record<string, unknown>;
  const sources = columnNames(Object.keys(mapping));
  const targets = columnNames(Object.values(mapping));
  const all = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (sources.some((name) => !all.includes(name)))
    throw new DataInputError("A mapped source column is absent from the dataset.");
  const destination = (name: string) =>
    Object.hasOwn(mapping, name) ? (targets[sources.indexOf(name)] ?? name) : name;
  if (new Set(all.map(destination)).size !== all.length)
    throw new DataInputError("Mapping would overwrite an existing column.");
  return {
    service: "column-mapping",
    version: 1,
    record_count: rows.length,
    records: rows.map((row) =>
      Object.fromEntries(Object.entries(row).map(([name, cell]) => [destination(name), cell])),
    ),
    unmapped_columns: all.filter((name) => !sources.includes(name)),
  };
}

export function checkJsonFields(value: unknown) {
  const input = inputObject(value, ["records", "required_columns", "types"]);
  const rows = records(input.records);
  const required = columnNames(input.required_columns ?? [], false);
  const types = input.types ?? {};
  if (!types || typeof types !== "object" || Array.isArray(types))
    throw new DataInputError("types must be a column-to-type object.");
  columnNames(Object.keys(types), false);
  const declared = types as Record<string, unknown>;
  if (
    Object.values(declared).some(
      (type) => !["string", "number", "integer", "boolean"].includes(String(type)),
    )
  )
    throw new DataInputError("Supported field types: string, number, integer, boolean.");
  let issues = 0;
  const examples: { record: number; column: string; issue: string }[] = [];
  const fail = (record: number, column: string, issue: string) => {
    issues++;
    if (examples.length < EXAMPLES) examples.push({ record, column, issue });
  };
  rows.forEach((row, index) => {
    for (const column of required)
      if (!has(row, column) || empty(row[column]))
        fail(index + 1, column, "required_value_missing");
    for (const [column, type] of Object.entries(declared)) {
      if (!has(row, column) || row[column] === null) continue;
      const cell = row[column];
      if (type === "integer" ? !Number.isSafeInteger(cell) : typeof cell !== type)
        fail(index + 1, column, "type_mismatch");
    }
  });
  return {
    service: "json-field-check",
    version: 1,
    record_count: rows.length,
    passes_requested_checks: issues === 0,
    issue_count: issues,
    examples,
    examples_limit: EXAMPLES,
    scope: "Required fields and primitive types only; not a general JSON Schema validator.",
  };
}

export function numericSummary(value: unknown) {
  const input = inputObject(value, ["records", "columns", "coerce_numeric_strings"]);
  const rows = records(input.records);
  const columns = columnNames(input.columns);
  const coerce = input.coerce_numeric_strings ?? false;
  if (typeof coerce !== "boolean")
    throw new DataInputError("coerce_numeric_strings must be boolean.");
  const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  const summaries = columns.map((name) => {
    let missing = 0;
    let nonnumeric = 0;
    let sum = 0;
    let compensation = 0;
    const numbers: number[] = [];
    for (const row of rows) {
      let cell = has(row, name) ? row[name] : undefined;
      if (empty(cell)) {
        missing++;
        continue;
      }
      if (coerce && typeof cell === "string" && numeric.test(cell.trim())) cell = Number(cell);
      if (typeof cell !== "number" || !Number.isFinite(cell)) {
        nonnumeric++;
        continue;
      }
      numbers.push(cell);
      const adjusted = cell - compensation;
      const total = sum + adjusted;
      compensation = total - sum - adjusted;
      sum = total;
    }
    if (!Number.isFinite(sum))
      throw new DataInputError("Numeric total is outside the finite range.");
    return {
      column: name,
      numeric_count: numbers.length,
      missing_count: missing,
      nonnumeric_count: nonnumeric,
      min: numbers.length ? Math.min(...numbers) : null,
      max: numbers.length ? Math.max(...numbers) : null,
      sum: numbers.length ? sum : null,
      mean: numbers.length ? sum / numbers.length : null,
    };
  });
  return {
    service: "numeric-summary",
    version: 1,
    record_count: rows.length,
    columns: summaries,
    arithmetic:
      "Floating-point descriptive statistics in the supplied units; no financial rounding or unit conversion.",
  };
}

export function reconcileDatasets(value: unknown) {
  const input = inputObject(value, ["left", "right", "key_columns"]);
  const left = records(input.left);
  const right = records(input.right);
  const keys = columnNames(input.key_columns);
  const index = (rows: Row[]) => {
    const result = new Map<string, { row: Row; position: number }>();
    for (const [position, row] of rows.entries()) {
      if (keys.some((name) => !has(row, name) || empty(row[name])))
        throw new DataInputError("Reconciliation requires complete keys in both datasets.");
      const key = JSON.stringify(keys.map((name) => row[name]));
      if (result.has(key))
        throw new DataInputError(
          "Reconciliation requires unique keys; run Duplicate Record Check first.",
        );
      result.set(key, { row, position: position + 1 });
    }
    return result;
  };
  const a = index(left);
  const b = index(right);
  const leftOnly: number[] = [];
  const rightOnly: number[] = [];
  const changed: { left_record: number; right_record: number; columns: string[] }[] = [];
  let equal = 0;
  for (const [key, item] of a) {
    const other = b.get(key);
    if (!other) {
      leftOnly.push(item.position);
      continue;
    }
    const columns = [...new Set([...Object.keys(item.row), ...Object.keys(other.row)])].filter(
      (name) => has(item.row, name) !== has(other.row, name) || item.row[name] !== other.row[name],
    );
    if (columns.length)
      changed.push({ left_record: item.position, right_record: other.position, columns });
    else equal++;
  }
  for (const [key, item] of b) if (!a.has(key)) rightOnly.push(item.position);
  return {
    service: "dataset-reconciliation",
    version: 1,
    left_count: left.length,
    right_count: right.length,
    equal_count: equal,
    changed_count: changed.length,
    left_only_count: leftOnly.length,
    right_only_count: rightOnly.length,
    left_only_examples: leftOnly.slice(0, EXAMPLES),
    right_only_examples: rightOnly.slice(0, EXAMPLES),
    changed_examples: changed.slice(0, EXAMPLES),
    examples_limit: EXAMPLES,
    scope:
      "Exact typed comparison by complete unique keys. Differences do not imply records should be deleted.",
  };
}

export function normalizeDates(value: unknown) {
  const input = inputObject(value, ["values"]);
  if (
    !Array.isArray(input.values) ||
    input.values.length > 2_000 ||
    input.values.some((item) => typeof item !== "string" || item.length > 80)
  )
    throw new DataInputError(
      "values must be at most 2,000 date strings, each up to 80 characters.",
    );
  let valid = 0;
  const result = input.values.map((value: string, index) => {
    const match =
      /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2}))?$/.exec(
        value,
      );
    let normalized: string | null = null;
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const zone = match[8];
      const offset = zone && zone !== "Z" ? zone.slice(1).split(":").map(Number) : [0, 0];
      const dateValid =
        year >= 1900 &&
        month >= 1 &&
        month <= 12 &&
        day >= 1 &&
        day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
      const timeValid =
        match[4] === undefined ||
        (Number(match[4]) <= 23 &&
          Number(match[5]) <= 59 &&
          Number(match[6]) <= 59 &&
          (offset[0] ?? 0) <= 14 &&
          (offset[1] ?? 0) <= 59 &&
          ((offset[0] ?? 0) < 14 || offset[1] === 0));
      if (dateValid && timeValid)
        normalized = match[4] === undefined ? value : new Date(value).toISOString();
    }
    if (normalized !== null) valid++;
    return { record: index + 1, normalized, valid: normalized !== null };
  });
  return {
    service: "date-normalization",
    version: 1,
    record_count: input.values.length,
    valid_count: valid,
    invalid_count: input.values.length - valid,
    results: result,
    scope:
      "ISO calendar dates (1900–9999) or timestamps with explicit Z/offset and at most millisecond precision. Date-only inputs remain dates; ambiguous local formats are rejected.",
  };
}

export const EXTENDED_UTILITY_SERVICES = [
  {
    operation: "json-field-check",
    role: "data-check",
    title: "JSON Field Check",
    price: "100000",
    tags: ["data-quality", "json"],
    run: checkJsonFields,
    description:
      'Validate flat JSON records before an API or database import. Checks required values and caller-specified string, number, integer or boolean types. Request JSON: {"operation":"json-field-check","input":{"records":[{"id":"A","quantity":2}],"required_columns":["id"],"types":{"quantity":"integer"}}}. Returns issue counts and up to 20 record/column locations. Not a general JSON Schema validator.',
  },
  {
    operation: "dataset-reconciliation",
    role: "data-check",
    title: "Dataset Reconciliation",
    price: "150000",
    tags: ["data-quality", "reconciliation"],
    run: reconcileDatasets,
    description:
      'Compare two exports by complete unique keys before a sync. Reports matching records, changed columns, and records present on only one side. Request JSON: {"operation":"dataset-reconciliation","input":{"left":[{"id":"A","qty":2}],"right":[{"id":"A","qty":3}],"key_columns":["id"]}}. Exact typed comparison; up to 20 diagnostic examples. Refuses missing or duplicate keys and never changes or deletes data.',
  },
  {
    operation: "numeric-summary",
    role: "data-check",
    title: "Numeric Column Summary",
    price: "100000",
    tags: ["data-quality", "statistics"],
    run: numericSummary,
    description:
      'Summarize numeric columns for a dashboard or analysis: count, minimum, maximum, sum, mean, missing and nonnumeric counts. Request JSON: {"operation":"numeric-summary","input":{"records":[{"depth":2},{"depth":4}],"columns":["depth"],"coerce_numeric_strings":false}}. Optional explicit string-to-number conversion. Floating-point descriptive statistics in supplied units; no financial rounding or unit conversion.',
  },
  {
    operation: "csv-to-json",
    role: "import-planner",
    title: "CSV to JSON",
    price: "100000",
    tags: ["data-conversion", "csv"],
    run: csvToJson,
    description:
      'Convert a header-based CSV export into JSON records for an integration. Handles quoted commas, escaped quotes and embedded newlines. Request JSON: {"operation":"csv-to-json","input":{"csv":"id,qty\\nA,2\\n"}}. Preserves cell strings rather than guessing types. Rejects ambiguous headers and wrong-width rows. Returns records and record count.',
  },
  {
    operation: "json-to-csv",
    role: "import-planner",
    title: "JSON to CSV",
    price: "100000",
    tags: ["data-conversion", "csv"],
    run: jsonToCsv,
    description:
      'Export flat JSON records to a CSV string for reporting. Request JSON: {"operation":"json-to-csv","input":{"records":[{"id":"A","qty":2}],"columns":["id","qty"]}}. Columns are explicit or collected in first-seen order. Quotes special characters, emits empty fields for null/absent values, and prefixes formula-looking text cells for spreadsheet safety. Returns CSV text, record count and sanitization count.',
  },
  {
    operation: "column-mapping",
    role: "import-planner",
    title: "Column Mapping",
    price: "100000",
    tags: ["data-conversion", "normalization"],
    run: mapColumns,
    description:
      'Rename export fields to the target integration names without overwriting columns. Request JSON: {"operation":"column-mapping","input":{"records":[{"sku":"A","qty":2}],"mapping":{"sku":"product_id","qty":"quantity"}}}. Keeps unmapped fields and preserves values. Rejects absent source columns, duplicate targets and collisions. Returns mapped records and unchanged column names.',
  },
  {
    operation: "date-normalization",
    role: "import-planner",
    title: "Date Normalization",
    price: "100000",
    tags: ["data-conversion", "dates"],
    run: normalizeDates,
    description:
      'Normalize explicit ISO timestamps to UTC before joining feeds. Request JSON: {"operation":"date-normalization","input":{"values":["2025-01-01T09:00:00+01:00","2025-01-01"]}}. Validates calendar dates, offset and time fields. ISO years 1900–9999, at most millisecond precision. Date-only values stay dates. Rejects ambiguous local formats and reports invalid positions instead of guessing a timezone.',
  },
] as const;
