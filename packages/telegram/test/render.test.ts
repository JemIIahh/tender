import { NETWORKS } from "@tender/shared";
import { expect, test } from "vitest";
import { type Alert, dedupeKey, escapeHtml, type RenderContext, renderAlert } from "../src/index";

const TESTNET_USDC = NETWORKS.testnet.usdc;
if (!TESTNET_USDC) throw new Error("NETWORKS has no USDC account for testnet");

const NOW = new Date("2026-11-05T12:00:00.000Z");
const CTX: RenderContext = { webUrl: "https://tender.example", network: "testnet", now: NOW };
const MIN = 60_000;
const HOUR = 60 * MIN;

/** A time `ms` after NOW, as the contract writes one: nanoseconds, in a decimal string. */
function inMs(ms: number): string {
  return ((BigInt(NOW.getTime()) + BigInt(ms)) * 1_000_000n).toString();
}

type ByKind = { [K in Alert["kind"]]: Extract<Alert, { kind: K }> };

/**
 * One alert of every kind, all on task 7. A new kind in `Alert` does not compile until it has a
 * sample here.
 */
const SAMPLES: ByKind = {
  new_task: {
    kind: "new_task",
    taskId: "7",
    title: "Summarise the Q3 report",
    reward: "5000000",
    token: TESTNET_USDC,
    tags: ["research", "summary"],
    commitDeadline: inMs(2 * HOUR + 5 * MIN + 30_000),
  },
  agent_started: {
    kind: "agent_started",
    taskId: "7",
    title: "Summarise the Q3 report",
    agent: "alice.testnet",
  },
  entry_committed: {
    kind: "entry_committed",
    taskId: "7",
    title: "Summarise the Q3 report",
    count: 3,
  },
  reveal_open: {
    kind: "reveal_open",
    taskId: "7",
    title: "Summarise the Q3 report",
    revealDeadline: inMs(3 * HOUR + 20 * MIN),
  },
  reveal_closing: {
    kind: "reveal_closing",
    taskId: "7",
    title: "Summarise the Q3 report",
    revealDeadline: inMs(9 * MIN + 40_000),
  },
  winner_paid: {
    kind: "winner_paid",
    taskId: "7",
    title: "Summarise the Q3 report",
    token: TESTNET_USDC,
    winners: [
      { account: "alice.testnet", amount: "4000000" },
      { account: "bob.testnet", amount: "750000" },
    ],
    scorecardUri: "https://api.tender.example/v1/blobs/ab12",
  },
  task_voided: {
    kind: "task_voided",
    taskId: "7",
    title: "Summarise the Q3 report",
    reason: "no_reveals",
  },
  deadline_reminder: {
    kind: "deadline_reminder",
    taskId: "7",
    title: "Summarise the Q3 report",
    hoursLeft: 24,
  },
  pool_grew: {
    kind: "pool_grew",
    taskId: "7",
    title: "Summarise the Q3 report",
    token: TESTNET_USDC,
    reward: "12500000",
    funders: 3,
  },
};

// One snapshot per kind. The expected text is written out by hand from the plan's formats.

test("renders_new_task", () => {
  expect(renderAlert(SAMPLES.new_task, CTX)).toMatchInlineSnapshot(`
    "<b>New task</b> · Summarise the Q3 report
    5.00 USDC · research · summary · entries close in 2 h 5 min
    <a href="https://tender.example/tasks/7">Open task</a>"
  `);
});

test("renders_agent_started", () => {
  expect(renderAlert(SAMPLES.agent_started, CTX)).toMatchInlineSnapshot(`
    "<b>Agent working</b> · alice.testnet started “Summarise the Q3 report”
    <a href="https://tender.example/tasks/7">Open task</a>"
  `);
});

test("renders_entry_committed", () => {
  expect(renderAlert(SAMPLES.entry_committed, CTX)).toMatchInlineSnapshot(`
    "<b>Entry received</b> · Summarise the Q3 report now has 3 sealed entries
    <a href="https://tender.example/tasks/7">Open task</a>"
  `);
});

test("renders_reveal_open", () => {
  expect(renderAlert(SAMPLES.reveal_open, CTX)).toMatchInlineSnapshot(`
    "<b>Reveal now</b> · Summarise the Q3 report · reveal window closes in 3 h 20 min
    <a href="https://tender.example/tasks/7">Open task</a>"
  `);
});

test("renders_reveal_closing", () => {
  expect(renderAlert(SAMPLES.reveal_closing, CTX)).toMatchInlineSnapshot(`
    "<b>Reveal closing</b> · Summarise the Q3 report · 9 min left to reveal
    <a href="https://tender.example/tasks/7">Open task</a>"
  `);
});

test("renders_winner_paid", () => {
  expect(renderAlert(SAMPLES.winner_paid, CTX)).toMatchInlineSnapshot(`
    "<b>Paid</b> · Summarise the Q3 report
    alice.testnet won 4.00 USDC
    bob.testnet won 0.75 USDC
    <a href="https://api.tender.example/v1/blobs/ab12">Scorecard</a>
    <a href="https://tender.example/tasks/7">Open task</a>"
  `);
});

test("renders_task_voided", () => {
  expect(renderAlert(SAMPLES.task_voided, CTX)).toMatchInlineSnapshot(`
    "<b>Refunded</b> · Summarise the Q3 report · no entry was revealed
    <a href="https://tender.example/tasks/7">Open task</a>"
  `);
});

test("renders_deadline_reminder", () => {
  expect(renderAlert(SAMPLES.deadline_reminder, CTX)).toMatchInlineSnapshot(`
    "<b>24 h left</b> · entries for Summarise the Q3 report close soon
    <a href="https://tender.example/tasks/7">Open task</a>"
  `);
});

test("renders_pool_grew", () => {
  expect(renderAlert(SAMPLES.pool_grew, CTX)).toMatchInlineSnapshot(`
    "<b>Pool grew</b> · Summarise the Q3 report now pays 12.50 USDC from 3 backers
    <a href="https://tender.example/tasks/7">Open task</a>"
  `);
});

// Wording that depends on the value.

test("void_reasons_read_in_plain_words", () => {
  const reasons = {
    no_reveals: "no entry was revealed",
    no_award: "no entry met the criteria",
    expired: "nobody picked a winner in time",
  } as const;
  for (const [reason, text] of Object.entries(reasons)) {
    const alert = { ...SAMPLES.task_voided, reason: reason as keyof typeof reasons };
    expect(renderAlert(alert, CTX).split("\n")[0]).toBe(
      `<b>Refunded</b> · Summarise the Q3 report · ${text}`,
    );
  }
});

test("counts_read_in_the_singular_when_there_is_one", () => {
  expect(renderAlert({ ...SAMPLES.entry_committed, count: 1 }, CTX)).toContain(
    "now has 1 sealed entry\n",
  );
  expect(renderAlert({ ...SAMPLES.entry_committed, count: 2 }, CTX)).toContain(
    "now has 2 sealed entries\n",
  );
  expect(renderAlert({ ...SAMPLES.pool_grew, funders: 1 }, CTX)).toContain("from 1 backer\n");
  expect(renderAlert({ ...SAMPLES.pool_grew, funders: 2 }, CTX)).toContain("from 2 backers\n");
});

test("one_hour_reminder_reads_1_h_left", () => {
  expect(renderAlert({ ...SAMPLES.deadline_reminder, hoursLeft: 1 }, CTX).split("\n")[0]).toBe(
    "<b>1 h left</b> · entries for Summarise the Q3 report close soon",
  );
});

test("new_task_without_tags_has_no_empty_separator", () => {
  expect(renderAlert({ ...SAMPLES.new_task, tags: [] }, CTX).split("\n")[1]).toBe(
    "5.00 USDC · entries close in 2 h 5 min",
  );
});

test("task_link_ignores_a_trailing_slash_on_the_web_url", () => {
  const html = renderAlert(SAMPLES.agent_started, { ...CTX, webUrl: "https://tender.example/" });
  expect(html.endsWith('<a href="https://tender.example/tasks/7">Open task</a>')).toBe(true);
});

// Times are shown relative to ctx.now, floored to whole minutes.

test.each([
  [-5 * MIN, "under 1 min"],
  [0, "under 1 min"],
  [MIN - 1, "under 1 min"],
  [MIN, "1 min"],
  [9 * MIN + 59_999, "9 min"],
  [59 * MIN, "59 min"],
  [HOUR, "1 h"],
  [HOUR + MIN, "1 h 1 min"],
  [2 * HOUR + 5 * MIN + 59_999, "2 h 5 min"],
  [24 * HOUR - 1, "23 h 59 min"],
  [24 * HOUR, "1 d"],
  [25 * HOUR + 30 * MIN, "1 d 1 h"],
  [14 * 24 * HOUR, "14 d"],
])("a_deadline_%d_ms_away_reads_%s", (ms, text) => {
  const alert = { ...SAMPLES.reveal_closing, revealDeadline: inMs(ms) };
  expect(renderAlert(alert, CTX)).toContain(` · ${text} left to reveal\n`);
});

test("a_deadline_that_is_not_a_u64_string_is_refused", () => {
  for (const revealDeadline of ["", "soon", "-1", "1e9", "0x10", "12.5", " 12 "]) {
    expect(() => renderAlert({ ...SAMPLES.reveal_closing, revealDeadline }, CTX)).toThrow(
      /deadline/,
    );
  }
});

// Escaping: task titles, tags, agents and the like are written by strangers.

test("html_is_escaped", () => {
  expect(escapeHtml("<b>&co")).toBe("&lt;b&gt;&amp;co");
  expect(escapeHtml('say "hi"')).toBe("say &quot;hi&quot;");
  // Text that is already an entity is escaped again, so that it shows as typed.
  expect(escapeHtml("&lt;")).toBe("&amp;lt;");

  const html = renderAlert({ ...SAMPLES.new_task, title: "<b>&co" }, CTX);
  expect(html).toContain("&lt;b&gt;&amp;co");
  expect(html).not.toContain("<b>&co");
});

test("html_is_escaped_in_every_text_field_of_every_kind", () => {
  const evil = '<b>&co "q" <a href="https://evil.example">x</a>';
  const evilUri = 'https://evil.example/?q="><b>&x';
  const hostile: ByKind = {
    new_task: { ...SAMPLES.new_task, title: evil, tags: [evil, "<i>"], token: evil },
    agent_started: { ...SAMPLES.agent_started, title: evil, agent: evil },
    entry_committed: { ...SAMPLES.entry_committed, title: evil },
    reveal_open: { ...SAMPLES.reveal_open, title: evil },
    reveal_closing: { ...SAMPLES.reveal_closing, title: evil },
    winner_paid: {
      ...SAMPLES.winner_paid,
      title: evil,
      token: evil,
      winners: [{ account: evil, amount: "5" }],
      scorecardUri: evilUri,
    },
    task_voided: { ...SAMPLES.task_voided, title: evil },
    deadline_reminder: { ...SAMPLES.deadline_reminder, title: evil },
    pool_grew: { ...SAMPLES.pool_grew, title: evil, token: evil },
  };

  for (const alert of Object.values(hostile)) {
    const html = renderAlert(alert, CTX);
    // The only markup is what the renderer writes itself: <b>…</b>, and one <a>…</a> for the task
    // link plus one for winner_paid's scorecard. Anything leaked from a text would add to these.
    const links = alert.kind === "winner_paid" ? 2 : 1;
    const count = (char: string) => html.split(char).length - 1;
    expect(count("<"), alert.kind).toBe(2 + 2 * links);
    expect(count(">"), alert.kind).toBe(2 + 2 * links);
    expect(count('"'), alert.kind).toBe(2 * links);
    expect(html, alert.kind).not.toMatch(/&(?!(?:amp|lt|gt|quot);)/);
    expect(html, alert.kind).toContain(escapeHtml(evil));
  }
});

test("scorecard_link_is_escaped_and_only_for_web_urls", () => {
  const withUri = (scorecardUri: string) =>
    renderAlert({ ...SAMPLES.winner_paid, scorecardUri }, CTX);

  expect(withUri("https://api.tender.example/v1/blobs/ab12?a=1&b=2")).toContain(
    '<a href="https://api.tender.example/v1/blobs/ab12?a=1&amp;b=2">Scorecard</a>',
  );
  expect(withUri("http://localhost:8787/v1/blobs/ab12")).toContain(
    '<a href="http://localhost:8787/v1/blobs/ab12">Scorecard</a>',
  );
  // The verifier picks this URI. Only web links are linked; the message still goes out without one.
  for (const uri of [
    "javascript:alert(1)",
    "tg://join?invite=abc",
    "ipfs://bafy",
    "",
    "not a url",
  ]) {
    const html = withUri(uri);
    expect(html, uri).not.toContain("Scorecard");
    expect(html, uri).toContain("alice.testnet won 4.00 USDC");
    expect(html, uri).toContain("Open task");
  }
});

// Money: amounts are in the token's smallest unit, and the token decides how to show them.

test("amounts_use_token_decimals", () => {
  const poolOf = (token: string, reward: string, ctx: RenderContext = CTX) =>
    renderAlert({ ...SAMPLES.pool_grew, token, reward }, ctx).split("\n")[0];

  // Circle's USDC on testnet: 6 decimals.
  expect(poolOf(TESTNET_USDC, "1250000")).toContain(" now pays 1.25 USDC from ");
  expect(poolOf(TESTNET_USDC, "1000000")).toContain(" now pays 1.00 USDC from ");
  // A token the tables do not know: raw units, with the account id as the symbol.
  expect(poolOf("wtf.near", "1250000")).toContain(" now pays 1250000 wtf.near from ");

  // The tables belong to the network in ctx: mainnet's USDC is a stranger on testnet.
  const mainnetUsdc = NETWORKS.mainnet.usdc;
  if (!mainnetUsdc) throw new Error("NETWORKS has no USDC account for mainnet");
  expect(poolOf(mainnetUsdc, "1250000")).toContain(` now pays 1250000 ${mainnetUsdc} from `);
  expect(poolOf(mainnetUsdc, "1250000", { ...CTX, network: "mainnet" })).toContain(
    " now pays 1.25 USDC from ",
  );

  // Every amount in every alert goes through the same table, winners' included.
  const paid = (token: string) =>
    renderAlert({ ...SAMPLES.winner_paid, token }, CTX)
      .split("\n")
      .slice(1, 3);
  expect(paid(TESTNET_USDC)).toEqual(["alice.testnet won 4.00 USDC", "bob.testnet won 0.75 USDC"]);
  expect(paid("wtf.near")).toEqual([
    "alice.testnet won 4000000 wtf.near",
    "bob.testnet won 750000 wtf.near",
  ]);
  expect(renderAlert({ ...SAMPLES.new_task, token: "wtf.near" }, CTX).split("\n")[1]).toMatch(
    /^5000000 wtf\.near · /,
  );
});

// Dedupe keys name an alert for the tg_sent table: the same alert must get the same key, and two
// alerts that are not the same must not.

test("dedupe_keys_are_distinct_per_kind", () => {
  const keys = Object.values(SAMPLES).map(dedupeKey);
  expect(new Set(keys).size).toBe(Object.keys(SAMPLES).length);
  for (const alert of Object.values(SAMPLES)) {
    expect(dedupeKey(alert).startsWith(`${alert.kind}:7`)).toBe(true);
  }

  // Two commits on one task are two alerts.
  const first = dedupeKey({ ...SAMPLES.entry_committed, count: 1 });
  const second = dedupeKey({ ...SAMPLES.entry_committed, count: 2 });
  expect(first).not.toBe(second);
  // The same news on another task is another alert.
  expect(dedupeKey({ ...SAMPLES.entry_committed, taskId: "8" })).not.toBe(
    dedupeKey(SAMPLES.entry_committed),
  );
});

test("dedupe_keys_take_the_documented_form", () => {
  expect(Object.values(SAMPLES).map(dedupeKey)).toEqual([
    "new_task:7",
    "agent_started:7:alice.testnet",
    "entry_committed:7:3",
    "reveal_open:7",
    "reveal_closing:7",
    "winner_paid:7",
    "task_voided:7",
    "deadline_reminder:7:24",
    "pool_grew:7:12500000",
  ]);
});

test("alerts_that_repeat_get_a_key_per_value", () => {
  // A restart that builds the same alert again must land on the same key...
  expect(dedupeKey({ ...SAMPLES.pool_grew })).toBe(dedupeKey(SAMPLES.pool_grew));
  expect(dedupeKey({ ...SAMPLES.entry_committed })).toBe(dedupeKey(SAMPLES.entry_committed));
  // ...and a second top-up, another agent or the other reminder must not.
  const distinct = (a: Alert, b: Alert) => expect(dedupeKey(a)).not.toBe(dedupeKey(b));
  distinct(SAMPLES.pool_grew, { ...SAMPLES.pool_grew, reward: "15000000" });
  distinct(SAMPLES.agent_started, { ...SAMPLES.agent_started, agent: "bob.testnet" });
  distinct(SAMPLES.deadline_reminder, { ...SAMPLES.deadline_reminder, hoursLeft: 1 });
});

test("an_alert_of_an_unknown_kind_is_refused", () => {
  const bogus = { kind: "nope", taskId: "7", title: "t" } as unknown as Alert;
  expect(() => dedupeKey(bogus)).toThrow(/unknown alert/);
  expect(() => renderAlert(bogus, CTX)).toThrow(/unknown alert/);
});
