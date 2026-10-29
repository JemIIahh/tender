import { readdirSync, readFileSync } from "node:fs";
import { expect, expectTypeOf, test } from "vitest";
import {
  extractEvents,
  parseEventLog,
  type ReceiptOutcome,
  type TenderEvent,
  TenderEventSchema,
} from "../src/index";

// Fixtures: test/fixtures/events/<event>.log holds one NEP-297 log line per event.
//
// - CAPTURED: the ten events the contract emits today were captured from the real wasm on a
//   sandbox. They are used unmodified.
// - HAND_WRITTEN: the other four were written by hand from the plan 01 task text, because the
//   contract does not emit them yet: task_topped_up (Task 13), delegate_added and delegate_removed
//   (Task 15), and attested_pick (Task 17). When a task lands, replace its file with a captured
//   line, and fix the schema if the real shape differs.
// - DERIVED: a case the captured run did not produce (a null field, a flag the other way round, a
//   maximum value) is a copy of a real fixture with only the listed fields changed. Nothing is
//   written from scratch.
const CAPTURED = [
  "agent_registered",
  "committed",
  "deposit",
  "picked",
  "revealed",
  "storage_deposit",
  "task_created",
  "voided",
  "withdraw",
  "withdraw_failed",
];
const HAND_WRITTEN = ["attested_pick", "delegate_added", "delegate_removed", "task_topped_up"];
const EVENT_NAMES = [...CAPTURED, ...HAND_WRITTEN].sort();

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Path = Array<string | number>;

const PREFIX = "EVENT_JSON:";
const FIXTURES = new URL("./fixtures/events/", import.meta.url);
const CONTRACT = "tender.test.near";
const U64_MAX = "18446744073709551615";
const U128_MAX = "340282366920938463463374607431768211455";

function fixtureNames(): string[] {
  return readdirSync(FIXTURES)
    .filter((file) => file.endsWith(".log"))
    .map((file) => file.slice(0, -".log".length))
    .sort();
}

function fixtureLine(name: string): string {
  return readFileSync(new URL(`${name}.log`, FIXTURES), "utf8");
}

/** The single `data` element of a fixture. */
function dataOf(name: string): Record<string, Json> {
  const envelope = JSON.parse(fixtureLine(name).slice(PREFIX.length)) as {
    data: [Record<string, Json>];
  };
  return envelope.data[0];
}

/**
 * A log line as the contract writes it. `over` replaces envelope keys, and an `undefined` value
 * leaves its key out.
 */
function logLine(event: string, data: Json, over: Record<string, Json | undefined> = {}): string {
  const envelope = { standard: "tender", version: "1.0.0", event, data: [data], ...over };
  return PREFIX + JSON.stringify(envelope);
}

function receipt(
  receiptId: string,
  logs: string[],
  over: Partial<ReceiptOutcome> = {},
): ReceiptOutcome {
  return { receiptId, executorId: CONTRACT, status: "success", logs, ...over };
}

// ---- The fixtures -----------------------------------------------------------------------------

test("parses_each_event_fixture", () => {
  // Exactly one fixture per event: none missing, none left over.
  expect(fixtureNames()).toEqual(EVENT_NAMES);
  for (const name of fixtureNames()) {
    const event = parseEventLog(fixtureLine(name));
    expect(event?.event, name).toBe(name);
    // Lossless: the schema strips, coerces and drops nothing. A field the contract writes that
    // the schema does not know would be stripped, and fail here.
    expect(event, name).toEqual({ event: name, data: dataOf(name) });
  }
});

test("schema_covers_exactly_the_fourteen_events", () => {
  const names = TenderEventSchema.options.map((option) => option.shape.event.value);
  expect(names.sort()).toEqual(EVENT_NAMES);
});

test("schema_validates_event_and_data_without_the_envelope", () => {
  const ok = TenderEventSchema.safeParse({ event: "deposit", data: dataOf("deposit") });
  expect(ok.success).toBe(true);
  // the data of one event under the name of another
  const mixed = TenderEventSchema.safeParse({ event: "withdraw", data: dataOf("task_created") });
  expect(mixed.success).toBe(false);
});

interface Derived {
  label: string;
  from: string;
  patch: Record<string, Json>;
}

const DERIVED: Derived[] = [
  {
    label: "derived_voided_by_void_task_has_null_by_and_scorecard",
    from: "voided",
    patch: { reason: "no_reveals", by: null, scorecard_hash: null, scorecard_uri: null },
  },
  {
    label: "derived_voided_expired_with_two_refunds",
    from: "voided",
    patch: {
      reason: "expired",
      by: null,
      refunds: [
        { account: "poster.test.near", amount: "600000" },
        { account: "carol.test.near", amount: "400000" },
      ],
      scorecard_hash: null,
      scorecard_uri: null,
    },
  },
  {
    label: "derived_agent_registered_without_asp",
    from: "agent_registered",
    patch: { asp: null },
  },
  {
    label: "derived_agent_registered_update",
    from: "agent_registered",
    patch: { updated: true },
  },
  {
    label: "derived_committed_replacing_an_earlier_commitment",
    from: "committed",
    patch: { replaced: true },
  },
  {
    label: "derived_task_created_without_heldout_commitment",
    from: "task_created",
    patch: { heldout_commitment: null },
  },
  {
    label: "derived_task_created_open_with_a_parent",
    from: "task_created",
    patch: { max_entries: 0, invited: [], parent: "7" },
  },
  {
    label: "derived_task_created_with_every_u64_at_its_maximum",
    from: "task_created",
    patch: {
      id: U64_MAX,
      created_at: U64_MAX,
      commit_deadline: U64_MAX,
      reveal_deadline: U64_MAX,
      pick_deadline: U64_MAX,
      fallback_deadline: U64_MAX,
      parent: U64_MAX,
    },
  },
  {
    label: "derived_deposit_of_the_largest_u128",
    from: "deposit",
    patch: { amount: U128_MAX },
  },
  {
    label: "derived_picked_with_one_winner",
    from: "picked",
    patch: { winners: [{ account: "alice.test.near", bps: 10000, amount: "950003" }] },
  },
];

test("line_builder_reproduces_every_fixture_byte_for_byte", () => {
  // So a derived line differs from its real fixture in the patched fields only.
  for (const name of fixtureNames()) {
    expect(logLine(name, dataOf(name)), name).toBe(fixtureLine(name));
  }
});

for (const { label, from, patch } of DERIVED) {
  test(label, () => {
    const data = { ...dataOf(from), ...patch };
    expect(parseEventLog(logLine(from, data))).toEqual({ event: from, data });
  });
}

test("void_reason_is_one_of_the_contracts_three", () => {
  const voided = dataOf("voided");
  for (const reason of ["no_reveals", "no_award", "expired"]) {
    expect(parseEventLog(logLine("voided", { ...voided, reason })), reason).not.toBeNull();
  }
  for (const reason of ["refunded", "NoAward", "no-award", ""]) {
    expect(parseEventLog(logLine("voided", { ...voided, reason })), reason).toBeNull();
  }
});

// ---- Field types ------------------------------------------------------------------------------
//
// Every sample is a fixture or a derived variant. Each test below changes one leaf of one sample at
// a time, so a whole class of field is checked in every event that has one.

interface Sample {
  label: string;
  event: string;
  data: Json;
}

const samples: Sample[] = [
  ...fixtureNames().map((name) => ({ label: name, event: name, data: dataOf(name) })),
  ...DERIVED.map(({ label, from, patch }) => ({
    label,
    event: from,
    data: { ...dataOf(from), ...patch },
  })),
];

function leaves(node: Json, path: Path = []): Array<{ path: Path; value: Json }> {
  if (Array.isArray(node)) return node.flatMap((item, i) => leaves(item, [...path, i]));
  if (node !== null && typeof node === "object") {
    return Object.entries(node).flatMap(([key, value]) => leaves(value, [...path, key]));
  }
  return [{ path, value: node }];
}

/** The path of every key of every object in `node`, nested ones included. */
function keyPaths(node: Json, path: Path = []): Path[] {
  if (Array.isArray(node)) return node.flatMap((item, i) => keyPaths(item, [...path, i]));
  if (node !== null && typeof node === "object") {
    return Object.entries(node).flatMap(([key, value]) => [
      [...path, key],
      ...keyPaths(value, [...path, key]),
    ]);
  }
  return [];
}

/** A copy of `node` with the value at `path` replaced, or the key removed if `replacement` is undefined. */
function edited(node: Json, path: Path, replacement: Json | undefined): Json {
  const [head, ...rest] = path;
  if (head === undefined) return replacement ?? null;
  if (Array.isArray(node)) {
    return node.map((item, i) => (i === head ? edited(item, rest, replacement) : item));
  }
  if (node !== null && typeof node === "object") {
    const copy: { [key: string]: Json } = {};
    for (const [key, value] of Object.entries(node)) {
      if (key !== head) copy[key] = value;
      else if (rest.length > 0 || replacement !== undefined)
        copy[key] = edited(value, rest, replacement);
    }
    return copy;
  }
  return node;
}

/**
 * Replaces one leaf of one sample at a time with each value `replacements` gives for it, and
 * expects `parseEventLog` to return null for every such line. Returns how many it checked.
 */
function expectEveryVariantRejected(replacements: (leaf: Json) => Json[]): number {
  let checked = 0;
  for (const sample of samples) {
    // control: the unmodified sample is accepted, so a null below is the change's doing
    expect(parseEventLog(logLine(sample.event, sample.data)), sample.label).not.toBeNull();
    for (const { path, value } of leaves(sample.data)) {
      for (const replacement of replacements(value)) {
        const line = logLine(sample.event, edited(sample.data, path, replacement));
        const what = `${sample.label} ${path.join(".")} -> ${JSON.stringify(replacement)}`;
        expect(parseEventLog(line), what).toBeNull();
        checked += 1;
      }
    }
  }
  return checked;
}

const isDecimal = (leaf: Json): leaf is string => typeof leaf === "string" && /^\d+$/.test(leaf);
const isHash = (leaf: Json): leaf is string =>
  typeof leaf === "string" && /^[0-9a-f]{64}$/.test(leaf);

test("numbers_as_json_numbers_rejected", () => {
  const line = fixtureLine("task_created");
  expect(parseEventLog(line)).not.toBeNull();
  for (const reward of ["1000", "1000003"]) {
    const asNumber = line.replace('"reward":"1000003"', `"reward":${reward}`);
    expect(asNumber).not.toBe(line);
    expect(parseEventLog(asNumber), reward).toBeNull();
  }
  // The same for every u64 and u128 field of every event: a JSON number would lose digits above
  // 2^53, so only a decimal string is accepted.
  expect(
    expectEveryVariantRejected((leaf) => (isDecimal(leaf) ? [Number(leaf)] : [])),
  ).toBeGreaterThan(0);
});

test("u64_and_u128_must_be_decimal_digits", () => {
  // The escapes are two Arabic-Indic digits: \d in JavaScript matches 0 to 9 only.
  const notDecimal = ["", "-1", "1.5", "1e3", "0x10", " 1", "1 ", "\u0661\u0662", "NaN"];
  const checked = expectEveryVariantRejected((leaf) => (isDecimal(leaf) ? notDecimal : []));
  expect(checked).toBeGreaterThan(0);
});

test("small_integers_must_be_json_numbers", () => {
  // fee_bps, bps, max_entries and max_winners are u16, u16, u32 and u8: JSON integers in the
  // contract's views and events, unlike u64 and u128.
  const isNumber = (leaf: Json): leaf is number => typeof leaf === "number";
  expect(
    expectEveryVariantRejected((leaf) => (isNumber(leaf) ? [String(leaf)] : [])),
  ).toBeGreaterThan(0);
  // and they are whole and not negative
  expect(
    expectEveryVariantRejected((leaf) => (isNumber(leaf) ? [-1, leaf + 0.5] : [])),
  ).toBeGreaterThan(0);
});

test("hashes_must_be_64_lowercase_hex", () => {
  const damaged = (leaf: Json): Json[] =>
    isHash(leaf) ? [leaf.toUpperCase(), leaf.slice(1), `${leaf}0`, `g${leaf.slice(1)}`] : [];
  expect(expectEveryVariantRejected(damaged)).toBeGreaterThan(0);
});

test("other_fields_reject_the_wrong_json_type", () => {
  // Strings that are not amounts or ids (accounts, URIs, tags, hashes, the void reason), booleans
  // and nulls. A null is replaced only by values that no nullable field accepts.
  const wrongType = (leaf: Json): Json[] => {
    if (typeof leaf === "string" && !isDecimal(leaf)) return [5, true, ["x"], {}];
    if (typeof leaf === "boolean") return ["true", 1, null];
    if (leaf === null) return [5, true, [], {}];
    return [];
  };
  expect(expectEveryVariantRejected(wrongType)).toBeGreaterThan(0);
});

test("every_field_is_required", () => {
  // An Option<T> is written as null and never left out, so a missing key is not a null.
  let checked = 0;
  for (const sample of samples) {
    for (const path of keyPaths(sample.data)) {
      const line = logLine(sample.event, edited(sample.data, path, undefined));
      expect(parseEventLog(line), `${sample.label} without ${path.join(".")}`).toBeNull();
      checked += 1;
    }
  }
  expect(checked).toBeGreaterThan(0);
});

test("unknown_keys_are_ignored", () => {
  // A reader ignores what it does not know, so a field the contract adds later cannot make the
  // indexer drop events. parses_each_event_fixture is what flags that drift.
  const line = logLine("deposit", { ...dataOf("deposit"), added_later: "x" }, { note: "x" });
  expect(parseEventLog(line)).toEqual({ event: "deposit", data: dataOf("deposit") });
});

// ---- The envelope -----------------------------------------------------------------------------

test("malformed_json_returns_null", () => {
  const good = fixtureLine("deposit");
  const lines = [
    PREFIX,
    `${PREFIX}{`,
    `${PREFIX}not json`,
    `${PREFIX}{'standard':'tender'}`,
    good.slice(0, -1), // cut before the final brace
    good.slice(0, good.length / 2),
    `${good}}`, // junk after the JSON
    // valid JSON that is not an object
    `${PREFIX}null`,
    `${PREFIX}[]`,
    `${PREFIX}"tender"`,
    `${PREFIX}42`,
  ];
  for (const line of lines) expect(parseEventLog(line), line).toBeNull();
  expect(parseEventLog(good)).not.toBeNull();
});

test("lines_without_the_event_prefix_return_null", () => {
  const good = fixtureLine("deposit");
  const json = good.slice(PREFIX.length);
  for (const line of [json, ` ${good}`, `event_json:${json}`, "EVENT_JSON", "", "deposit"]) {
    expect(parseEventLog(line), line).toBeNull();
  }
});

test("version_mismatch_returns_null", () => {
  const data = dataOf("deposit");
  for (const version of ["1.0.1", "1.1.0", "2.0.0", "0.9.0", "1.0", "1", "v1.0.0", "", 1, null]) {
    expect(parseEventLog(logLine("deposit", data, { version })), String(version)).toBeNull();
  }
  // a missing version
  expect(parseEventLog(logLine("deposit", data, { version: undefined }))).toBeNull();
  expect(parseEventLog(logLine("deposit", data, { version: "1.0.0" }))).not.toBeNull();
});

test("data_must_be_a_one_element_array", () => {
  // NEP-297 allows any `data`, but the contract always writes exactly one element.
  const data = dataOf("deposit");
  const bad: Array<Record<string, Json | undefined>> = [
    { data: [] },
    { data: [data, data] },
    { data },
    { data: null },
    { data: undefined },
    { data: [null] },
    { data: ["x"] },
  ];
  for (const over of bad) {
    expect(parseEventLog(logLine("deposit", data, over)), JSON.stringify(over)).toBeNull();
  }
});

test("unknown_events_return_null", () => {
  const data = dataOf("deposit");
  for (const event of ["ft_transfer", "mt_transfer", "Deposit", "deposit ", "", undefined]) {
    expect(parseEventLog(logLine("deposit", data, { event })), String(event)).toBeNull();
  }
});

// ---- Extraction -------------------------------------------------------------------------------

test("ignores_failed_receipts", () => {
  // A failed receipt keeps its logs (seen on mainnet), so a valid-looking line in one is no event.
  const failed = receipt("rF", [fixtureLine("deposit")], { status: "failure" });
  expect(extractEvents([failed], CONTRACT)).toEqual([]);
  // control: the same receipt, successful, yields the event
  expect(extractEvents([{ ...failed, status: "success" }], CONTRACT)).toHaveLength(1);
  // The status decides per receipt: a successful one beside the failed one still counts.
  const ok = receipt("rS", [fixtureLine("withdraw_failed")]);
  expect(extractEvents([failed, ok], CONTRACT)).toEqual([
    { event: "withdraw_failed", data: dataOf("withdraw_failed"), receiptId: "rS", logIndex: 0 },
  ]);
});

test("ignores_other_contracts_and_standards", () => {
  const line = fixtureLine("deposit");
  // The same valid line, logged by another account: anyone can log a line that looks like ours.
  const others = [
    "intents.near",
    "tender.test.near.evil",
    "evil.tender.test.near",
    "Tender.test.near",
    "",
  ];
  for (const executorId of others) {
    const found = extractEvents([receipt("r1", [line], { executorId })], CONTRACT);
    expect(found, executorId).toEqual([]);
  }
  // Another standard, logged by the contract itself.
  for (const standard of ["nep141", "nep245", "Tender", ""]) {
    const other = logLine("deposit", dataOf("deposit"), { standard });
    expect(parseEventLog(other), standard).toBeNull();
    expect(extractEvents([receipt("r2", [other])], CONTRACT), standard).toEqual([]);
  }
  // control: the right contract and the right standard yield the event
  expect(extractEvents([receipt("r3", [line])], CONTRACT)).toHaveLength(1);
});

test("log_index_counts_every_log_of_the_receipt", () => {
  const logs = [
    "Transfer 1 from a.near to b.near",
    fixtureLine("deposit"),
    `${PREFIX}{"truncated`,
    fixtureLine("task_created"),
    "",
  ];
  const found = extractEvents([receipt("rA", logs)], CONTRACT);
  expect(found.map((e) => [e.event, e.receiptId, e.logIndex])).toEqual([
    ["deposit", "rA", 1],
    ["task_created", "rA", 3],
  ]);
});

test("extraction_keeps_receipt_and_log_order", () => {
  const receipts = [
    receipt("r1", [fixtureLine("committed"), fixtureLine("revealed")]),
    receipt("r2", [], { executorId: "usdc.test.near" }),
    receipt("r3", [fixtureLine("picked")]),
  ];
  const found = extractEvents(receipts, CONTRACT);
  expect(found.map((e) => [e.receiptId, e.logIndex, e.event])).toEqual([
    ["r1", 0, "committed"],
    ["r1", 1, "revealed"],
    ["r3", 0, "picked"],
  ]);
  expect(extractEvents([], CONTRACT)).toEqual([]);
});

test("events_are_discriminated_by_event", () => {
  expectTypeOf<TenderEvent["event"]>().toEqualTypeOf<
    | "agent_registered"
    | "attested_pick"
    | "committed"
    | "delegate_added"
    | "delegate_removed"
    | "deposit"
    | "picked"
    | "revealed"
    | "storage_deposit"
    | "task_created"
    | "task_topped_up"
    | "voided"
    | "withdraw"
    | "withdraw_failed"
  >();

  const [first] = extractEvents([receipt("r1", [fixtureLine("picked")])], CONTRACT);
  if (first?.event !== "picked") throw new Error("expected a picked event");
  // Checking `event` types `data` as that event's data.
  expectTypeOf(first.data.fee).toEqualTypeOf<string>();
  expectTypeOf(first.data.winners).toEqualTypeOf<
    Array<{ account: string; bps: number; amount: string }>
  >();
  expectTypeOf(first.data).not.toHaveProperty("reason");
  expectTypeOf(first.receiptId).toEqualTypeOf<string>();
  expectTypeOf(first.logIndex).toEqualTypeOf<number>();
  expect(first.data.winners.map((winner) => winner.bps)).toEqual([7000, 3000]);
});
