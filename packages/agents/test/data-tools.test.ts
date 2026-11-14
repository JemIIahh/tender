import { expect, test } from "vitest";
import {
  checkJsonFields,
  csvToJson,
  jsonToCsv,
  mapColumns,
  normalizeDates,
  numericSummary,
  reconcileDatasets,
} from "../src/services/data-tools";
import { UTILITY_ESCROW_CATALOG } from "../src/services/escrow";

test("CSV conversion preserves quoted values and CSV export quotes and protects formula text", () => {
  const input = 'id,note,qty\nA,"two, words",2\nB,"a ""quote""",3\n';
  const json = csvToJson({ csv: input });
  expect(json.records[0]).toEqual({ id: "A", note: "two, words", qty: "2" });
  expect(csvToJson({ csv: jsonToCsv({ records: json.records }).csv }).records).toEqual(
    json.records,
  );
  const protectedExport = jsonToCsv({
    records: [
      {
        text: '=HYPERLINK("https://example.com")',
        longitude: "-123.45",
        number: -2,
        missing: null,
      },
      { text: "\t+cmd", longitude: "+3", number: 0 },
    ],
  });
  expect(protectedExport.formula_safe_cells).toBe(2);
  expect(protectedExport.csv).toContain("-123.45");
  expect(protectedExport.csv).toContain("-2");
  expect(protectedExport.csv).toContain("'=HYPERLINK");
  expect(() => jsonToCsv({ records: [{ text: "a\0b" }] })).toThrow("NUL");
});

test("mapping preserves unknown fields and refuses destructive collisions", () => {
  expect(
    mapColumns({
      records: [{ sku: "A", qty: 2, extra: false }],
      mapping: { sku: "id", qty: "quantity" },
    }).records,
  ).toEqual([{ id: "A", quantity: 2, extra: false }]);
  expect(() => mapColumns({ records: [{ id: "A", sku: "B" }], mapping: { sku: "id" } })).toThrow(
    "overwrite",
  );
  expect(() => mapColumns({ records: [{ id: "A" }], mapping: { absent: "new" } })).toThrow(
    "absent",
  );
  expect(() =>
    mapColumns({ records: [{ id: "A" }], mapping: JSON.parse('{"id":"__proto__"}') }),
  ).toThrow("reserved");
});

test("field checks separate required values from declared type problems", () => {
  const report = checkJsonFields({
    records: [{ id: "A", qty: 2 }, { id: "", qty: "3" }, { qty: null }],
    required_columns: ["id"],
    types: { qty: "integer" },
  });
  expect(report.issue_count).toBe(3);
  expect(report.examples).toEqual([
    { record: 2, column: "id", issue: "required_value_missing" },
    { record: 2, column: "qty", issue: "type_mismatch" },
    { record: 3, column: "id", issue: "required_value_missing" },
  ]);
  expect(checkJsonFields({ records: [], required_columns: ["id"] }).passes_requested_checks).toBe(
    true,
  );
  expect(() => checkJsonFields({ records: [], types: { id: "object" } })).toThrow("Supported");
});

test("numeric summaries make coercion explicit and count absent and invalid observations", () => {
  const rows = [{ value: 2 }, { value: "4" }, { value: null }, { other: "x" }, { value: "bad" }];
  const strict = numericSummary({ records: rows, columns: ["value"] }).columns[0];
  expect(strict).toMatchObject({
    numeric_count: 1,
    missing_count: 2,
    nonnumeric_count: 2,
    sum: 2,
    mean: 2,
  });
  const converted = numericSummary({
    records: rows,
    columns: ["value"],
    coerce_numeric_strings: true,
  }).columns[0];
  expect(converted).toMatchObject({
    numeric_count: 2,
    missing_count: 2,
    nonnumeric_count: 1,
    min: 2,
    max: 4,
    sum: 6,
    mean: 3,
  });
  expect(numericSummary({ records: [], columns: ["value"] }).columns[0]?.mean).toBeNull();
  expect(() =>
    numericSummary({ records: [{ value: 1e308 }, { value: 1e308 }], columns: ["value"] }),
  ).toThrow("finite range");
});

test("reconciliation distinguishes additions, omissions, exact changes and null versus absent", () => {
  const report = reconcileDatasets({
    left: [{ id: "A", qty: 2 }, { id: "B" }, { id: "C", qty: 3 }],
    right: [
      { id: "A", qty: 2 },
      { id: "B", qty: null },
      { id: "D", qty: 4 },
    ],
    key_columns: ["id"],
  });
  expect(report).toMatchObject({
    equal_count: 1,
    changed_count: 1,
    left_only_count: 1,
    right_only_count: 1,
    left_only_examples: [3],
    right_only_examples: [3],
  });
  expect(report.changed_examples).toEqual([{ left_record: 2, right_record: 2, columns: ["qty"] }]);
  expect(() =>
    reconcileDatasets({ left: [{ id: "A" }, { id: "A" }], right: [], key_columns: ["id"] }),
  ).toThrow("unique keys");
  expect(() => reconcileDatasets({ left: [{}], right: [], key_columns: ["id"] })).toThrow(
    "complete keys",
  );
});

test("date normalization validates calendars and explicit offsets without locale guesses", () => {
  const report = normalizeDates({
    values: [
      "2024-02-29",
      "2025-02-29",
      "2025-01-01T09:30:00+01:00",
      "2025-01-01T00:00:00.123Z",
      "01/02/2025",
      "2025-01-01T24:00:00Z",
      "2025-01-01T00:00:00+14:30",
      "2025-01-01T00:00:00.1234Z",
    ],
  });
  expect(report.valid_count).toBe(3);
  expect(report.results.map((item) => item.normalized)).toEqual([
    "2024-02-29",
    null,
    "2025-01-01T08:30:00.000Z",
    "2025-01-01T00:00:00.123Z",
    null,
    null,
    null,
    null,
  ]);
});

test("expanded catalog contains ten distinct services, five per worker", () => {
  expect(UTILITY_ESCROW_CATALOG).toHaveLength(10);
  expect(new Set(UTILITY_ESCROW_CATALOG.map((service) => service.title)).size).toBe(10);
  expect(UTILITY_ESCROW_CATALOG.filter((service) => service.role === "data-check")).toHaveLength(5);
  expect(
    UTILITY_ESCROW_CATALOG.filter((service) => service.role === "import-planner"),
  ).toHaveLength(5);
});
