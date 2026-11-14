import { describe, expect, test } from "vitest";
import {
  auditCsv,
  csvRecords,
  DataInputError,
  findDuplicateRecords,
  importReadiness,
} from "../src/services/data-quality";

describe("data quality services", () => {
  test("audit identifies import blockers and logical records across quoted newlines", () => {
    const report = auditCsv({
      csv: '\uFEFFsku,note,quantity\r\nA,"two, words",3\r\nB,"two\nlines",\r\nC,short\r\n',
      required_columns: ["sku", "quantity", "price"],
    });
    expect(report.record_count).toBe(3);
    expect(report.missing_required_columns).toEqual(["price"]);
    expect(report.wrong_width_examples).toEqual([{ record: 4, actual_columns: 2 }]);
    expect(report.blank_required_cell_examples).toEqual([
      { record: 3, column: "quantity" },
      { record: 4, column: "quantity" },
    ]);
    expect(report.passes_requested_checks).toBe(false);
  });
  test.each(["a,a\n1,2", "a,\n1,2", 'a\n"unfinished', 'a\n"closed"extra', 'a\nquo"te', "a\rb"])(
    "rejects ambiguous CSV %s",
    (csv) => {
      expect(() => auditCsv({ csv })).toThrow(DataInputError);
    },
  );
  test("escaped quotes and final empty fields are preserved", () => {
    expect(csvRecords('sku,note\nA,"a ""quote"""\nB,')).toEqual([
      { sku: "A", note: 'a "quote"' },
      { sku: "B", note: "" },
    ]);
    expect(auditCsv({ csv: "sku\n" }).record_count).toBe(0);
  });
  test("typed composite keys avoid delimiter collisions; incomplete keys are never merged", () => {
    const result = findDuplicateRecords({
      records: [
        { a: "x|y", b: "z" },
        { a: "x", b: "y|z" },
        { a: "x|y", b: "z" },
        { a: 1, b: false },
        { a: "1", b: false },
        { a: null, b: "z" },
        { b: "z" },
      ],
      key_columns: ["a", "b"],
    });
    expect(result.duplicate_groups).toEqual([{ record_count: 2, records: [1, 3] }]);
    expect(result.redundant_record_count).toBe(1);
    expect(result.incomplete_key_examples).toEqual([6, 7]);
    expect(JSON.stringify(result)).not.toContain("x|y");
  });
  test("case comparison is explicit, and inherited keys do not identify a record", () => {
    const records = [{ id: "ALPHA" }, { id: "alpha" }];
    expect(findDuplicateRecords({ records, key_columns: ["id"] }).duplicate_group_count).toBe(0);
    expect(
      findDuplicateRecords({ records, key_columns: ["id"], case_sensitive: false })
        .duplicate_group_count,
    ).toBe(1);
    expect(
      findDuplicateRecords({ records: [{}], key_columns: ["toString"] })
        .incomplete_key_record_count,
    ).toBe(1);
  });
  test("bounded inputs and diagnostic examples", () => {
    expect(() => auditCsv({ csv: `a\n${"x".repeat(65_536)}` })).toThrow(DataInputError);
    expect(() => findDuplicateRecords({ records: [{ id: {} }], key_columns: ["id"] })).toThrow(
      DataInputError,
    );
    const report = auditCsv({ csv: `id\n${"\n".repeat(30)}`, required_columns: ["id"] });
    expect(report.blank_required_cell_count).toBe(30);
    expect(report.blank_required_cell_examples).toHaveLength(20);
  });
  test("readiness requires both structure and complete unique keys", () => {
    expect(importReadiness("id,qty\nA,2\nB,3", ["id", "qty"], ["id"]).decision).toBe(
      "passes_requested_import_checks",
    );
    expect(importReadiness("id,qty\nA,2\nA,3", ["id"], ["id"]).decision).toBe("review_required");
    expect(importReadiness("id,qty\nA", ["id"], ["id"]).duplicates).toBeNull();
  });
});
