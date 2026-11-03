import {
  BriefSchema,
  canonicalJson,
  HeldoutSchema,
  heldoutMatchesCriteria,
  PublicCriteriaSchema,
  RUBRIC_MAX_CRITERIA,
  RUBRIC_MAX_CRITERION_CHARS,
  RUBRIC_MAX_ENTRIES,
  RUBRIC_MIN_SCORE,
  type RubricProblem,
  rubricCriteriaProblem,
  rubricEntriesProblem,
  sha256Hex,
} from "@tender/shared";
import { expect, test } from "vitest";
import {
  buildDocuments,
  checkBrief,
  checkChecks,
  checkReward,
  DocumentError,
  firstError,
  formatForKind,
  fundingOf,
  KINDS,
  kindsFor,
  linesOf,
  POST_TASK_BYTES,
  type PostForm,
  PRESET_WINDOWS,
  parseTags,
  planPostCalls,
  RUBRIC_JUDGE_LIMIT,
  RUBRIC_WORDS,
  regexCaution,
  VAULT_SLOT_BYTES,
  windowsOf,
} from "../lib/post";
import {
  exactForm,
  JUDGE,
  jsonForm,
  LIMITS,
  regexForm,
  rubricForm,
  SECRET,
  TOKEN,
} from "./postForms";

// The rules of the post wizard, without a page: what a form is checked for, the documents it is
// turned into and the calls that post them. vitest.config.ts gives the config the network testnet,
// in which `tusdc.*` is the test USDC with six decimals.

const CONTRACT = "tender.testnet";

const decode = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes));
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

// ---- The documents ------------------------------------------------------------------------------

test("wizard_builds_valid_documents", () => {
  for (const form of [regexForm(), exactForm(), jsonForm(), rubricForm()]) {
    const docs = buildDocuments(form);

    // Each document is the canonical bytes of a JSON value the shared schemas accept.
    const brief = BriefSchema.parse(decode(docs.brief));
    const criteria = PublicCriteriaSchema.parse(decode(docs.criteria));
    expect(docs.brief, form.kind).toEqual(canonicalJson(decode(docs.brief)));
    expect(docs.criteria, form.kind).toEqual(canonicalJson(decode(docs.criteria)));
    expect(criteria.kind).toBe(form.kind);
    expect(brief.output.format).toBe(form.outputFormat);

    // The hashes are those of the bytes, and the commitment is that of the held-out bytes.
    expect(docs.briefHash).toBe(sha256Hex(docs.brief));
    expect(docs.criteriaHash).toBe(sha256Hex(docs.criteria));
    if (docs.heldout === null) {
      expect(docs.heldoutCommitment).toBeNull();
      expect(criteria.has_heldout).toBe(false);
    } else {
      expect(docs.heldoutCommitment).toBe(sha256Hex(docs.heldout));
      expect(docs.heldout).toEqual(canonicalJson(decode(docs.heldout)));
      const heldout = HeldoutSchema.parse(decode(docs.heldout));
      expect(heldoutMatchesCriteria(criteria, heldout)).toBe(true);
      expect(criteria.has_heldout).toBe(true);
    }
  }
});

test("documents_hold_what_was_typed", () => {
  const regex = buildDocuments(regexForm());
  expect(decode(regex.brief)).toEqual({
    version: 1,
    title: "Regex for NEAR account ids",
    summary: "Write one regex that tells valid account ids from invalid ones.",
    instructions: "Return the pattern and its flags.\nAnchor it at both ends.",
    category: "coding",
    tags: ["regex", "near", "validation"],
    output: { format: "regex_json", max_bytes: 4096 },
  });
  expect(decode(regex.criteria)).toEqual({
    version: 1,
    kind: "regex_cases",
    min_score: 100,
    split: "winner_take_all",
    has_heldout: true,
    examples: { match: ["alice.near", "bob.testnet"], no_match: ["-bad", "UPPER"] },
  });
  expect(decode(regex.heldout as Uint8Array)).toEqual({
    regex_cases: {
      match: [`${SECRET}.near`, "carol.near"],
      no_match: ["dave..near", "_eve.near"],
    },
  });

  const exact = buildDocuments(exactForm());
  expect(decode(exact.criteria)).toMatchObject({ kind: "exact", normalize: ["trim", "lowercase"] });
  expect(decode(exact.heldout as Uint8Array)).toEqual({
    exact: { expected: ["Canberra", "Canberra, ACT"] },
  });

  const json = buildDocuments(jsonForm());
  expect(decode(json.criteria)).toMatchObject({ kind: "json_schema", schema: { type: "object" } });
  expect(decode(json.heldout as Uint8Array)).toEqual({
    json_schema: {
      assertions: [
        { path: "$.total", equals: 1250.5 },
        { path: "$.lines[0].sku", equals: "A-1" },
      ],
    },
  });

  // A rubric has no held-out part.
  const rubric = buildDocuments(rubricForm());
  expect(rubric.heldout).toBeNull();
  expect(decode(rubric.criteria)).toMatchObject({
    kind: "rubric",
    min_score: 70,
    rubric: [
      { criterion: "Clear about what changed", weight: 8 },
      { criterion: "Short", weight: 3 },
    ],
  });
});

test("a_regex_task_without_heldout_cases_is_scored_on_its_public_examples", () => {
  const docs = buildDocuments(regexForm({ heldoutMatch: "", heldoutNoMatch: "" }));

  expect(docs.heldout).toBeNull();
  expect(docs.heldoutCommitment).toBeNull();
  expect(decode(docs.criteria)).toMatchObject({ has_heldout: false });
});

test("the_same_form_gives_the_same_bytes_whatever_the_order_it_was_typed_in", () => {
  const first = buildDocuments(jsonForm({ schema: '{"type":"object","title":"t"}' }));
  const second = buildDocuments(jsonForm({ schema: '{ "title": "t",\n "type": "object" }' }));

  expect(second.criteria).toEqual(first.criteria);
  expect(second.criteriaHash).toBe(first.criteriaHash);
  expect(text(first.criteria)).toContain('"schema":{"title":"t","type":"object"}');
});

test("tags_are_read_from_commas_and_spaces_and_each_is_kept_once", () => {
  expect(parseTags("Regex, near  #validation,regex")).toEqual(["regex", "near", "validation"]);
  expect(parseTags("")).toEqual([]);
  expect(parseTags(" , ")).toEqual([]);
});

test("cases_are_read_one_to_a_line_and_spaces_are_kept", () => {
  expect(linesOf("a\n\n b \r\nc\n  \n")).toEqual(["a", " b ", "c"]);
  expect(linesOf("")).toEqual([]);
});

test("a_form_that_does_not_fit_the_schemas_is_a_document_error_and_never_quotes_the_heldout", () => {
  // The steps of the wizard stop all of these earlier; this is the last check before an upload.
  const cases: PostForm[] = [
    regexForm({ title: "" }),
    regexForm({ maxBytes: "0" }),
    exactForm({ expected: "" }),
    jsonForm({ schema: "[1]" }),
    // A key that would set the prototype is something the schemas refuse to carry.
    jsonForm({ schema: '{"__proto__": {"type": "object"}}' }),
  ];
  for (const form of cases) {
    expect(() => buildDocuments(form), form.title).toThrow(DocumentError);
  }

  // A lone surrogate in the held-out is text that cannot be written; the message says nothing of it.
  let message = "";
  try {
    buildDocuments(exactForm({ expected: `${SECRET}\ud800` }));
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentError);
    message = (error as Error).message;
  }
  expect(message).not.toBe("");
  expect(message).not.toContain(SECRET);
});

// ---- The calls ----------------------------------------------------------------------------------

function planFor(form: PostForm, vaultBalance: bigint, judgeAccount: string | null = JUDGE) {
  const docs = buildDocuments(form);
  return planPostCalls({
    form,
    uris: { brief: `http://api.test/v1/blobs/${docs.briefHash}` },
    hashes: docs,
    vaultBalance,
    contractId: CONTRACT,
    tokenId: TOKEN,
    judgeAccount,
  });
}

test("deposit_prepended_when_vault_short", () => {
  const form = regexForm({ amount: "5" });

  // An empty vault: the whole reward is deposited first.
  const empty = planFor(form, 0n);
  expect(empty.map((call) => [call.receiverId, call.methodName])).toEqual([
    [TOKEN, "ft_transfer_call"],
    [CONTRACT, "post_task"],
  ]);
  expect(empty[0]?.args).toEqual({ receiver_id: CONTRACT, amount: "5000000", msg: "" });

  // A vault that holds part of it: the difference.
  const partial = planFor(form, 2_000_000n);
  expect(partial).toHaveLength(2);
  expect(partial[0]?.args).toEqual({ receiver_id: CONTRACT, amount: "3000000", msg: "" });
  expect(partial[0]?.deposit).toBe(1n);

  // The reward is in the vault already, to the last unit or beyond: only the post.
  for (const vault of [5_000_000n, 9_000_000n]) {
    const enough = planFor(form, vault);
    expect(enough.map((call) => call.methodName)).toEqual(["post_task"]);
  }
  // One unit short is still a deposit, of one unit.
  const oneShort = planFor(form, 4_999_999n);
  expect(oneShort[0]?.args).toMatchObject({ amount: "1" });
});

test("post_task_carries_the_terms_of_the_form", () => {
  const form = regexForm({ amount: "5" });
  const docs = buildDocuments(form);
  const [post] = planFor(form, 5_000_000n);

  expect(post?.receiverId).toBe(CONTRACT);
  expect(post?.deposit).toBe(1n);
  expect(post?.args).toEqual({
    task: {
      token: TOKEN,
      reward: "5000000",
      brief_uri: `http://api.test/v1/blobs/${docs.briefHash}`,
      brief_hash: docs.briefHash,
      criteria_hash: docs.criteriaHash,
      heldout_commitment: docs.heldoutCommitment,
      // The Judge is this form's verifier.
      verifier: JUDGE,
      commit_secs: 600,
      reveal_secs: 300,
      pick_secs: 600,
      fallback_secs: 600,
      max_entries: 0,
      max_winners: 1,
      invited: [],
      parent: null,
    },
  });
});

test("the_verifier_on_chain_is_null_when_the_poster_verifies", () => {
  const task = (form: PostForm) =>
    (planFor(form, 9_000_000n).at(-1)?.args.task as { verifier: unknown } | undefined)?.verifier;

  expect(task(regexForm({ verifier: "me" }))).toBeNull();
  expect(task(regexForm({ verifier: "judge" }))).toBe(JUDGE);
  expect(task(regexForm({ verifier: "other", otherVerifier: " bob.testnet " }))).toBe(
    "bob.testnet",
  );
});

test("a_task_without_heldout_checks_commits_to_none", () => {
  const form = regexForm({ heldoutMatch: "", heldoutNoMatch: "" });
  const [post] = planFor(form, 9_000_000n);

  expect(post?.args.task).toMatchObject({ heldout_commitment: null });
});

test("the_calls_are_refused_for_what_would_cost_money_to_get_wrong", () => {
  const form = regexForm();
  const docs = buildDocuments(form);
  const base = {
    form,
    uris: { brief: "http://api.test/v1/blobs/x" },
    hashes: docs,
    vaultBalance: 0n,
    contractId: CONTRACT,
    tokenId: TOKEN,
    judgeAccount: JUDGE,
  };
  expect(planPostCalls(base)).toHaveLength(2);

  for (const amount of ["", "0", "-1", "1e3", "1.2345678", "abc"]) {
    expect(() => planPostCalls({ ...base, form: { ...form, amount } }), amount).toThrow(RangeError);
  }
  expect(() => planPostCalls({ ...base, vaultBalance: -1n })).toThrow(RangeError);
  expect(() =>
    planPostCalls({ ...base, form: { ...form, preset: "custom", custom: bad() } }),
  ).toThrow(RangeError);
  // The Judge chosen with no Judge account to name, and a verifier that is no account.
  expect(() => planPostCalls({ ...base, judgeAccount: null })).toThrow(RangeError);
  expect(() =>
    planPostCalls({ ...base, form: { ...form, verifier: "other", otherVerifier: "No Account" } }),
  ).toThrow(RangeError);
  // An address the chain would refuse (E_URI), and a hash that is not a SHA-256 (E_HASH).
  expect(() => planPostCalls({ ...base, uris: { brief: "" } })).toThrow(RangeError);
  expect(() => planPostCalls({ ...base, uris: { brief: "u".repeat(257) } })).toThrow(RangeError);
  expect(() =>
    planPostCalls({ ...base, hashes: { ...docs, briefHash: docs.briefHash.toUpperCase() } }),
  ).toThrow(RangeError);

  function bad() {
    return { ...form.custom, commit: { amount: "ten", unit: "minutes" as const } };
  }
});

// ---- The storage a post needs -------------------------------------------------------------------

/** What one byte of Tender storage costs, in yoctoNEAR. */
const BYTE = 10n ** 19n;

/** The plan for `form` when the vault holds `vaultBalance` and `free` yoctoNEAR of storage is free. */
function planWithStorage(form: PostForm, vaultBalance: bigint, free: bigint) {
  const docs = buildDocuments(form);
  return planPostCalls({
    form,
    uris: { brief: `http://api.test/v1/blobs/${docs.briefHash}` },
    hashes: docs,
    vaultBalance,
    storage: { total: 10n ** 24n, available: free },
    contractId: CONTRACT,
    tokenId: TOKEN,
    judgeAccount: JUDGE,
  });
}

const methods = (calls: ReturnType<typeof planFor>) => calls.map((call) => call.methodName);

test("the_bytes_a_post_sets_aside_cover_what_the_contract_charges_for_the_biggest_one_it_writes", () => {
  // The record is 40 + 1 + 8 + Borsh(Task) bytes, and 800 are held back for the outcome. A task
  // from the wizard has a Borsh(Task) of 738 bytes at most (the review of 06-T4 derived it from
  // contract/tender/src/tasks.rs and types.rs). The slot of a first deposit is 200 at most.
  expect(POST_TASK_BYTES).toBeGreaterThanOrEqual(40n + 1n + 8n + 738n + 800n);
  expect(VAULT_SLOT_BYTES).toBe(200n);
});

test("storage_is_topped_up_first_when_it_cannot_pay_for_the_post", () => {
  const form = regexForm({ amount: "5" });

  // The vault holds the reward, so the post is all there is: 1,600 bytes, and 1,000 are free.
  const short = planWithStorage(form, 5_000_000n, 1_000n * BYTE);
  expect(short.map((call) => [call.receiverId, call.methodName])).toEqual([
    [CONTRACT, "storage_deposit"],
    [CONTRACT, "post_task"],
  ]);
  // The 600 bytes that are missing, paid by whoever signs: no account is named.
  expect(short[0]?.args).toEqual({});
  expect(short[0]?.deposit).toBe(600n * BYTE);

  // With a deposit too, the top-up comes first, then the deposit, then the post.
  const both = planWithStorage(regexForm({ amount: "5" }), 2_000_000n, 1_000n * BYTE);
  expect(both.map((call) => [call.receiverId, call.methodName])).toEqual([
    [CONTRACT, "storage_deposit"],
    [TOKEN, "ft_transfer_call"],
    [CONTRACT, "post_task"],
  ]);
  expect(both[1]?.args).toEqual({ receiver_id: CONTRACT, amount: "3000000", msg: "" });
});

test("storage_that_pays_for_the_post_is_not_topped_up", () => {
  const form = regexForm({ amount: "5" });

  // Exactly what a post needs is enough; one byte less is a byte's price short.
  expect(methods(planWithStorage(form, 5_000_000n, POST_TASK_BYTES * BYTE))).toEqual(["post_task"]);
  const oneShort = planWithStorage(form, 5_000_000n, (POST_TASK_BYTES - 1n) * BYTE);
  expect(methods(oneShort)).toEqual(["storage_deposit", "post_task"]);
  expect(oneShort[0]?.deposit).toBe(BYTE);

  // Plenty is no top-up either, and a plan made without a storage balance has none.
  expect(methods(planWithStorage(form, 5_000_000n, 50_000n * BYTE))).toEqual(["post_task"]);
  expect(methods(planFor(form, 0n))).toEqual(["ft_transfer_call", "post_task"]);
});

test("the_slot_of_a_first_deposit_is_paid_for_too_and_only_for_a_first_deposit", () => {
  const form = regexForm({ amount: "5" });
  const need = POST_TASK_BYTES + VAULT_SLOT_BYTES;

  // The vault holds none of the token, so the deposit opens its slot: the post and the slot.
  const first = planWithStorage(form, 0n, POST_TASK_BYTES * BYTE);
  expect(methods(first)).toEqual(["storage_deposit", "ft_transfer_call", "post_task"]);
  expect(first[0]?.deposit).toBe(VAULT_SLOT_BYTES * BYTE);
  expect(methods(planWithStorage(form, 0n, need * BYTE))).toEqual([
    "ft_transfer_call",
    "post_task",
  ]);

  // The vault holds part of the reward, so the slot is there and the deposit adds none.
  expect(methods(planWithStorage(form, 2_000_000n, POST_TASK_BYTES * BYTE))).toEqual([
    "ft_transfer_call",
    "post_task",
  ]);
  const short = planWithStorage(form, 2_000_000n, (POST_TASK_BYTES - 1n) * BYTE);
  expect(short[0]?.deposit).toBe(BYTE);
});

test("funding_says_the_storage_the_post_will_add_by_the_same_rule", () => {
  const data = (vault: bigint, free: bigint) => ({
    storage: { total: 10n ** 24n, available: free },
    rows: [{ token: TOKEN, enabled: true, vault, wallet: 100_000_000n as bigint | null }],
  });

  expect(fundingOf(data(0n, 1_000n * BYTE), TOKEN, 5_000_000n).storageTopUp).toBe(800n * BYTE);
  expect(fundingOf(data(5_000_000n, 1_000n * BYTE), TOKEN, 5_000_000n).storageTopUp).toBe(
    600n * BYTE,
  );
  expect(fundingOf(data(5_000_000n, 5_000n * BYTE), TOKEN, 5_000_000n).storageTopUp).toBe(0n);
  // An account that is not set up is turned away, and no top-up is made up for it.
  expect(fundingOf({ storage: null, rows: [] }, TOKEN, 5_000_000n)).toMatchObject({
    storageTopUp: 0n,
    problem: "Your account isn't set up with Tender yet. Set it up on the Wallet page first.",
  });
});

// ---- Checks, step by step -----------------------------------------------------------------------

test("amount_inputs_reject_invalid", () => {
  const form = regexForm();
  const errorFor = (amount: string) =>
    checkReward({ ...form, amount }, { limits: LIMITS, judgeAccount: JUDGE }).amount;

  // Six decimals at most; zero; negative; an exponent; text; nothing; and the ends of the range.
  expect(errorFor("1.2345678")).toBe("This token has 6 decimal places at most.");
  expect(errorFor("0")).toBe("Enter more than 0.");
  expect(errorFor("-1")).toBe("An amount can't be negative.");
  expect(errorFor("1e3")).toBe("Use digits and one point, like 12.5.");
  expect(errorFor("")).toBe("Enter an amount.");
  for (const typed of ["abc", "1,5", ".5", "1.", "0x10", "٣"]) {
    expect(errorFor(typed), typed).toBe("Use digits and one point, like 12.5.");
  }
  // Below the least and above the cap (get_config's token limits), by one unit each.
  expect(errorFor("0.999999")).toBe("The least for this token is 1.00 tUSDC.");
  expect(errorFor("1000.000001")).toBe("The most for this token is 1000.00 tUSDC.");

  // And the ones that are fine: the least, the cap and something between.
  for (const typed of ["1", "1.000000", "5", "12.5", "1000", " 7 "]) {
    expect(errorFor(typed), typed).toBeUndefined();
  }
});

test("rubric_hidden_for_non_team", () => {
  expect(kindsFor(false).map(({ kind }) => kind)).toEqual(["exact", "json_schema", "regex_cases"]);
  expect(kindsFor(true).map(({ kind }) => kind)).toEqual([
    "exact",
    "json_schema",
    "regex_cases",
    "rubric",
  ]);
  expect(KINDS.map(({ kind }) => kind)).toContain("rubric");

  // A form that holds the rubric is turned down for an account that is not the team's.
  expect(checkChecks(rubricForm(), { canRubric: false }).kind).toBe(
    "Rubric checks are for team accounts.",
  );
  expect(checkChecks(rubricForm(), { canRubric: true })).toEqual({});
});

// ---- What the Judge takes of a rubric -----------------------------------------------------------

// The Judge turns a rubric task down at intake for these (packages/judge/src/kinds/rubric.ts,
// `rubricProblem`), after the reward is in, so the Checks step says them first. The cases are the
// Judge's own (its test of `rubricProblem`), as the step has to agree with it.

const rubricOf = (...points: string[]): PostForm =>
  rubricForm({ rubric: points.map((criterion) => ({ criterion, weight: "5" })) });
const numbered = (count: number): string[] => Array.from({ length: count }, (_, i) => `point ${i}`);
const rubricChecks = (form: PostForm) => checkChecks(form, { canRubric: true });

// The limits are the shared module's, and the cases are written from them: the step has no number
// of its own to agree with.
const MAX_POINTS = RUBRIC_MAX_CRITERIA;
const MAX_CHARS = RUBRIC_MAX_CRITERION_CHARS;
const TOO_MANY = `Use at most ${MAX_POINTS} points.`;
const BLANK = "Say what to look for.";
const BRACKET = "Leave out angle brackets, like < and >.";
const tooLong = (count: number) => `Use ${MAX_CHARS} characters or fewer. This has ${count}.`;
const sameAs = (place: number) => `This says the same as point ${place}.`;

test.each([
  ["all_the_points_allowed", rubricOf(...numbered(MAX_POINTS)), {}],
  ["one_point_too_many", rubricOf(...numbered(MAX_POINTS + 1)), { rubric: TOO_MANY }],
  ["all_the_characters_allowed", rubricOf("x".repeat(MAX_CHARS)), {}],
  [
    "one_character_too_many",
    rubricOf("x".repeat(MAX_CHARS + 1)),
    { "rubric-0-criterion": tooLong(MAX_CHARS + 1) },
  ],
  // Characters are counted as code points, as the Judge counts them: 200 emoji are 400 UTF-16 units.
  ["all_the_emoji_allowed", rubricOf("\u{1F600}".repeat(MAX_CHARS)), {}],
  [
    "one_emoji_too_many",
    rubricOf("\u{1F600}".repeat(MAX_CHARS + 1)),
    { "rubric-0-criterion": tooLong(MAX_CHARS + 1) },
  ],
  // The point is counted as it is posted, trimmed.
  ["all_the_characters_and_spaces", rubricOf(`  ${"x".repeat(MAX_CHARS)}  `), {}],
  ["spaces_and_a_weight", rubricOf("clear", "  \t "), { "rubric-1-criterion": BLANK }],
  ["an_ideographic_space", rubricOf("clear", "\u{3000}"), { "rubric-1-criterion": BLANK }],
  // A prefix, letters that only look alike and a word that is only close are other points.
  ["a_prefix", rubricOf("clear", "clearer"), {}],
  ["look_alike_letters", rubricOf("clear", "cl\u{0435}ar"), {}],
  ["a_close_word", rubricOf("accurate", "accurate!"), {}],
  // The single angle quotes that the Judge turns brackets into are not brackets themselves.
  ["single_angle_quotes", rubricOf("a \u{2039}b\u{203A} c"), {}],
] as const)("rubric_points_follow_the_judges_rules_%s", (_name, form, expected) => {
  expect(rubricChecks(form)).toEqual(expected);
});

test.each([
  ["less_than", "a<b"],
  ["greater_than", "a>b"],
  ["fullwidth_less_than", "a\u{FF1C}b"],
  ["fullwidth_greater_than", "a\u{FF1E}b"],
  ["small_less_than", "a\u{FE64}b"],
  ["small_greater_than", "a\u{FE65}b"],
  ["not_less_than", "a\u{226E}b"],
  ["not_greater_than", "a\u{226F}b"],
  ["tag_less_than", "a\u{E003C}b"],
  ["tag_greater_than", "a\u{E003E}b"],
  ["a_frame_tag", "</entry>"],
  ["a_control_token", "<|im_start|>"],
] as const)("a_point_with_an_angle_bracket_is_a_problem_%s", (_name, point) => {
  expect(rubricChecks(rubricOf("fine", point))).toEqual({ "rubric-1-criterion": BRACKET });
});

test.each([
  ["the_same_text", ["clear", "clear"]],
  ["another_case", ["clear", "CLEAR"]],
  ["other_spacing", ["very clear", " very \t clear "]],
  ["fullwidth_letters", ["clear", "\u{FF43}lear"]],
  ["a_ligature", ["fine", "\u{FB01}ne"]],
] as const)("two_points_that_read_the_same_are_a_problem_%s", (_name, points) => {
  expect(rubricChecks(rubricOf(...points))).toEqual({ "rubric-1-criterion": sameAs(1) });
});

test("a_repeat_says_which_point_it_repeats_by_its_place_in_the_list", () => {
  // The empty row is left out of the rubric, but it has its place among the points on the page.
  const form = rubricForm({
    rubric: [
      { criterion: "Clear", weight: "5" },
      { criterion: "", weight: "" },
      { criterion: " clear ", weight: "5" },
      { criterion: "Short", weight: "5" },
      { criterion: "SHORT", weight: "5" },
      { criterion: "clear", weight: "5" },
    ],
  });

  expect(rubricChecks(form)).toEqual({
    "rubric-2-criterion": sameAs(1),
    "rubric-4-criterion": sameAs(4),
    "rubric-5-criterion": sameAs(1),
  });
});

test("a_point_with_several_problems_names_one_in_the_order_the_judge_does", () => {
  // A blank point, then a long one, then a bracket, then a repeat: the first that is broken.
  const long = "x".repeat(MAX_CHARS + 1);
  expect(rubricChecks(rubricOf(long, long))).toEqual({
    "rubric-0-criterion": tooLong(MAX_CHARS + 1),
    "rubric-1-criterion": tooLong(MAX_CHARS + 1),
  });
  expect(rubricChecks(rubricOf("a<b", "a<b"))).toEqual({
    "rubric-0-criterion": BRACKET,
    "rubric-1-criterion": BRACKET,
  });
  // The count is named as well as the points that have a problem.
  expect(rubricChecks(rubricOf(...numbered(MAX_POINTS), "POINT 0"))).toEqual({
    rubric: TOO_MANY,
    "rubric-20-criterion": sameAs(1),
  });
  // A weight that is wrong is its own problem.
  const both = rubricForm({ rubric: [{ criterion: "a<b", weight: "11" }] });
  expect(rubricChecks(both)).toEqual({
    "rubric-0-criterion": BRACKET,
    "rubric-0-weight": "Use a whole number from 1 to 10.",
  });
});

test("a_rubric_needs_a_pass_mark_of_at_least_the_shared_minimum", () => {
  const MIN = String(RUBRIC_MIN_SCORE);

  // Below it, the Judge turns the task down at intake, after the reward is in (P05-R20).
  expect(rubricChecks(rubricForm({ minScore: "0" })).minScore).toBe(RUBRIC_WORDS.min_score);
  expect(RUBRIC_WORDS.min_score).toBe(`A rubric needs a pass mark of ${MIN} or more.`);
  expect(rubricChecks(rubricForm({ minScore: MIN }))).toEqual({});
  expect(rubricChecks(rubricForm({ minScore: "100" }))).toEqual({});
  // A mark that is no mark at all says where the range begins for this kind.
  for (const mark of ["", "101", "-1", "x"]) {
    expect(rubricChecks(rubricForm({ minScore: mark })).minScore, mark).toBe(
      `Use a whole number from ${MIN} to 100.`,
    );
  }
  // Another kind may have 0: the Judge scores it by checks, not by a model.
  expect(checkChecks(exactForm({ minScore: "0" }), { canRubric: true })).toEqual({});
});

test("a_rubric_form_that_breaks_a_shared_rule_cannot_be_made_into_documents", () => {
  // The step's own checks are the first line; the documents are checked once more by the rules of
  // `@tender/shared` themselves, so that a step that drifts from them sends nothing the Judge turns
  // away after the reward is in.
  const broken: Array<[string, PostForm, RubricProblem]> = [
    ["a pass mark of 0", rubricForm({ minScore: "0" }), "min_score"],
    ["an angle bracket", rubricOf("a<b"), "criterion_bracket"],
    ["two alike", rubricOf("Clear", "clear"), "criteria_collide"],
    ["too many", rubricOf(...numbered(MAX_POINTS + 1)), "too_many_criteria"],
    ["too long", rubricOf("x".repeat(MAX_CHARS + 1)), "criterion_too_long"],
  ];
  for (const [name, form, problem] of broken) {
    expect(() => buildDocuments(form), name).toThrow(DocumentError);
    expect(() => buildDocuments(form), name).toThrow(RUBRIC_WORDS[problem]);
  }

  // And what the step lets through, the rules let through.
  const docs = buildDocuments(rubricForm());
  const criteria = PublicCriteriaSchema.parse(decode(docs.criteria));
  expect(criteria.kind === "rubric" && rubricCriteriaProblem(criteria)).toBeNull();
});

test("every_rule_a_rubric_can_break_has_words", () => {
  for (const [problem, words] of Object.entries(RUBRIC_WORDS)) {
    expect(words, problem).not.toBe("");
  }
});

test("the_wizard_posts_a_rubric_task_the_way_the_shared_rules_allow", () => {
  // An open task: no entry limit and no invites, which is all the contract allows an open task.
  const post = planPostCalls({
    form: rubricForm(),
    uris: { brief: "http://api.test/v1/blobs/x" },
    hashes: { briefHash: "a".repeat(64), criteriaHash: "b".repeat(64), heldoutCommitment: null },
    vaultBalance: 20_000_000n,
    contractId: CONTRACT,
    tokenId: TOKEN,
    judgeAccount: JUDGE,
  }).at(-1);
  const task = post?.args.task as { max_entries: number; invited: string[] };

  expect(post?.methodName).toBe("post_task");
  expect(rubricEntriesProblem({ max_entries: task.max_entries, invited: task.invited })).toBeNull();
  expect(task).toMatchObject({ max_entries: 0, invited: [] });
});

test("the_judge_is_said_to_score_the_first_entries_of_a_rubric_task_as_many_as_the_shared_rule_says", () => {
  expect(RUBRIC_JUDGE_LIMIT).toBe(`The Judge scores the first ${RUBRIC_MAX_ENTRIES} entries.`);
});

test("a_brief_is_checked_against_what_the_schema_allows", () => {
  expect(checkBrief(regexForm())).toEqual({});

  const errors = checkBrief(
    regexForm({
      title: "  ",
      summary: "s".repeat(281),
      instructions: "",
      tags: "ok, Bad_Tag, a",
      maxBytes: "262145",
    }),
  );
  expect(Object.keys(errors)).toEqual(["title", "summary", "instructions", "tags", "maxBytes"]);
  expect(errors.title).toBe("Give the task a title.");
  expect(errors.tags).toContain("bad_tag");
  expect(errors.maxBytes).toBe("Use a whole number from 1 to 262,144.");

  // Characters are counted as the schema counts them: a pair of UTF-16 units is one.
  expect(checkBrief(regexForm({ title: "😀".repeat(120) })).title).toBeUndefined();
  expect(checkBrief(regexForm({ title: "😀".repeat(121) })).title).toBe(
    "Use 120 characters or fewer.",
  );
  expect(checkBrief(regexForm({ tags: "a b c d e f g h i" })).tags).toBe("Use 8 tags or fewer.");
  expect(checkBrief(regexForm({ tags: "x".repeat(25) })).tags).toContain("up to 24");
  expect(checkBrief(regexForm({ summary: "" }))).toEqual({});
});

test("checks_are_validated_for_each_kind", () => {
  const opts = { canRubric: true };

  // exact
  expect(checkChecks(exactForm({ expected: " \n\n" }), opts).expected).toBe(
    "Write at least one answer the Judge will accept, one to a line.",
  );
  // json_schema
  expect(checkChecks(jsonForm({ schema: "" }), opts).schema).toBe(
    "Paste the JSON schema that answers have to fit.",
  );
  expect(checkChecks(jsonForm({ schema: "{type:" }), opts).schema).toBe("That isn't valid JSON.");
  expect(checkChecks(jsonForm({ schema: "[]" }), opts).schema).toBe(
    'A schema is a JSON object, like {"type": "object"}.',
  );
  expect(checkChecks(jsonForm({ assertions: [{ path: "", equals: "" }] }), opts).assertions).toBe(
    "Add at least one value for the Judge to check.",
  );
  const rows = checkChecks(
    jsonForm({
      assertions: [
        { path: "total", equals: "1" },
        { path: "$.a[01]", equals: "1" },
        { path: "$.ok", equals: "abc" },
        { path: "$.ok", equals: "" },
        { path: "", equals: "" },
      ],
    }),
    opts,
  );
  expect(Object.keys(rows)).toEqual([
    "assertion-0-path",
    "assertion-1-path",
    "assertion-2-equals",
    "assertion-3-equals",
  ]);
  // regex_cases
  expect(
    checkChecks(
      regexForm({ examplesMatch: "", examplesNoMatch: "", heldoutMatch: "", heldoutNoMatch: "" }),
      opts,
    ).examplesMatch,
  ).toContain("Add at least one case");
  // rubric
  expect(checkChecks(rubricForm({ rubric: [{ criterion: "", weight: "5" }] }), opts)).toEqual({
    "rubric-0-criterion": "Say what to look for.",
  });
  expect(
    checkChecks(rubricForm({ rubric: [{ criterion: "Short", weight: "11" }] }), opts)[
      "rubric-0-weight"
    ],
  ).toBe("Use a whole number from 1 to 10.");
  // the pass mark
  for (const mark of ["", "101", "-1", "9.5", "x"]) {
    expect(checkChecks(exactForm({ minScore: mark }), opts).minScore, mark).toBe(
      "Use a whole number from 0 to 100.",
    );
  }
  expect(checkChecks(exactForm({ minScore: "0" }), opts)).toEqual({});
});

test("the_answer_format_has_to_suit_the_kind_of_check", () => {
  const opts = { canRubric: true };

  expect(formatForKind("regex_cases", "text")).toBe("regex_json");
  expect(formatForKind("json_schema", "text")).toBe("json");
  expect(formatForKind("exact", "json")).toBe("json");
  expect(formatForKind("exact", "regex_json")).toBe("text");
  expect(formatForKind("rubric", "regex_json")).toBe("text");

  expect(checkChecks(regexForm({ outputFormat: "text" }), opts).kind).toBe(
    'Regex cases needs the answer format "A regex, as JSON". Change it on the Brief step.',
  );
  expect(checkChecks(jsonForm({ outputFormat: "text" }), opts).kind).toContain('"JSON"');
});

test("a_regex_task_scored_on_one_side_only_is_cautioned_not_refused", () => {
  const onlyMatches = regexForm({ examplesNoMatch: "", heldoutMatch: "", heldoutNoMatch: "" });
  expect(checkChecks(onlyMatches, { canRubric: false })).toEqual({});
  expect(regexCaution(onlyMatches)).toContain("matches everything");

  const onlyRejects = regexForm({ examplesMatch: "", heldoutMatch: "", heldoutNoMatch: "x" });
  expect(regexCaution(onlyRejects)).toContain("matches nothing");

  expect(regexCaution(regexForm())).toBeNull();
  expect(
    regexCaution(
      regexForm({ examplesMatch: "", examplesNoMatch: "", heldoutMatch: "", heldoutNoMatch: "" }),
    ),
  ).toBeNull();
});

test("heldout_checks_that_are_too_long_are_refused_without_being_quoted", () => {
  const big = exactForm({ expected: Array.from({ length: 30_000 }, () => SECRET).join("\n") });
  const errors = checkChecks(big, { canRubric: false });

  expect(Object.keys(errors)).toEqual(["heldout"]);
  expect(errors.heldout).toContain("256 KiB");
  expect(errors.heldout).not.toContain(SECRET);
});

test("a_public_document_the_api_would_refuse_is_a_problem_on_its_own_step", () => {
  // A schema over the 256 KiB the API keeps: the Checks step says so, and not a 413 after the sign-in.
  const schema = JSON.stringify({ type: "object", description: "x".repeat(300_000) });
  const errors = checkChecks(jsonForm({ schema }), { canRubric: false });
  expect(Object.keys(errors)).toEqual(["form"]);
  expect(errors.form).toBe("The public checks are too long. The limit is 256 KiB.");

  // So are the examples of a regex task, which are public.
  const examples = Array.from({ length: 30_000 }, () => "alice.near").join("\n");
  expect(checkChecks(regexForm({ examplesMatch: examples }), { canRubric: false }).form).toBe(
    "The public checks are too long. The limit is 256 KiB.",
  );

  // The build refuses the same documents, in the same words.
  expect(() => buildDocuments(jsonForm({ schema }))).toThrow(
    "The public checks are too long. The limit is 256 KiB.",
  );

  // A schema that the shared schema turns down is said on the step too.
  const proto = checkChecks(jsonForm({ schema: '{"__proto__": {"type": "object"}}' }), {
    canRubric: false,
  });
  expect(proto.form).toContain("The public checks do not fit");
});

test("text_that_cannot_be_saved_is_a_problem_on_the_step_that_holds_it", () => {
  // A lone surrogate is not text the documents can hold. Which field has it is not said, since a
  // place in a document can be the person's own key: the step says whose document it is.
  expect(checkBrief(regexForm({ title: "Tit\ud800le" }))).toEqual({
    form: "A character in the brief can't be saved.",
  });
  expect(checkChecks(regexForm({ examplesMatch: "a\ud800" }), { canRubric: false })).toEqual({
    form: "A character in the public checks can't be saved.",
  });

  // The held-out checks are named and never quoted.
  const held = checkChecks(regexForm({ heldoutMatch: `${SECRET}\ud800` }), { canRubric: false });
  expect(held).toEqual({ heldout: "A character in the held-out checks can't be saved." });
  expect(JSON.stringify(held)).not.toContain(SECRET);
});

// ---- The reward and the windows -----------------------------------------------------------------

test("the_presets_are_the_windows_the_task_page_expects", () => {
  expect(PRESET_WINDOWS.quick).toEqual({ commit: 600, reveal: 300, pick: 600, fallback: 600 });
  expect(PRESET_WINDOWS.day).toEqual({
    commit: 86_400,
    reveal: 7_200,
    pick: 14_400,
    fallback: 86_400,
  });
  expect(windowsOf(regexForm({ preset: "quick" }))).toEqual(PRESET_WINDOWS.quick);
  expect(windowsOf(regexForm({ preset: "day" }))).toEqual(PRESET_WINDOWS.day);
});

test("custom_windows_are_read_in_their_units_and_each_is_held_to_the_chain_limits", () => {
  const custom = (commit: string, unit: "seconds" | "minutes" | "hours" | "days") =>
    regexForm({
      preset: "custom",
      custom: {
        commit: { amount: commit, unit },
        reveal: { amount: "5", unit: "minutes" },
        pick: { amount: "1", unit: "hours" },
        fallback: { amount: "2", unit: "days" },
      },
    });
  const check = (form: PostForm) => checkReward(form, { limits: LIMITS, judgeAccount: JUDGE });

  expect(windowsOf(custom("90", "seconds"))).toEqual({
    commit: 90,
    reveal: 300,
    pick: 3_600,
    fallback: 172_800,
  });
  expect(check(custom("90", "seconds"))).toEqual({});

  // The least the chain takes is `min_window_secs`; the most is 14 days.
  expect(check(custom("59", "seconds"))["window-commit"]).toBe("At least 1m.");
  expect(check(custom("60", "seconds"))["window-commit"]).toBeUndefined();
  expect(check(custom("14", "days"))["window-commit"]).toBeUndefined();
  expect(check(custom("15", "days"))["window-commit"]).toBe("At most 14d.");
  expect(check(custom("1209601", "seconds"))["window-commit"]).toBe("At most 14d.");
  // Not a whole number, nothing, zero, and more than a u32 can count.
  for (const bad of ["", "0", "1.5", "-3", "1e2", "ten", "99999999999"]) {
    const found = check(custom(bad, "minutes"));
    expect(found["window-commit"], bad).toBe("Use a whole number above 0.");
    expect(windowsOf(custom(bad, "minutes")), bad).toBeNull();
  }
  // A chain that wants longer windows than a preset has says so, and where to go.
  const strict = { ...LIMITS, minWindowSecs: 3_600 };
  expect(
    checkReward(regexForm({ preset: "quick" }), { limits: strict, judgeAccount: JUDGE }).preset,
  ).toContain("Use Custom");
  expect(
    checkReward(regexForm({ preset: "day" }), { limits: strict, judgeAccount: JUDGE }).preset,
  ).toBeUndefined();
});

test("the_verifier_has_to_be_an_account_this_build_can_name", () => {
  const form = regexForm();
  const check = (patch: Partial<PostForm>, judgeAccount: string | null = JUDGE) =>
    checkReward({ ...form, ...patch }, { limits: LIMITS, judgeAccount });

  expect(check({ verifier: "judge" })).toEqual({});
  expect(check({ verifier: "judge" }, null).verifier).toContain("isn't set up");
  expect(check({ verifier: "me" }, null)).toEqual({});
  expect(check({ verifier: "other", otherVerifier: "" }).otherVerifier).toBe(
    "Enter a NEAR account, like name.near.",
  );
  expect(check({ verifier: "other", otherVerifier: "Bob Smith" }).otherVerifier).toBeDefined();
  expect(check({ verifier: "other", otherVerifier: "bob.testnet" })).toEqual({});
  // The account is not looked at when it is not the verifier.
  expect(check({ verifier: "me", otherVerifier: "Bob Smith" })).toEqual({});
});

test("the_first_token_tender_takes_is_the_default_and_no_token_is_a_reason_to_stop", () => {
  const form = regexForm({ token: "" });

  expect(checkReward(form, { limits: LIMITS, judgeAccount: JUDGE })).toEqual({});
  expect(checkReward(form, { limits: { ...LIMITS, tokens: [] }, judgeAccount: JUDGE }).token).toBe(
    "Tender takes no rewards right now.",
  );
  // A token that is no longer taken is the first one that is, not a reward in a token that fails.
  expect(
    checkReward(regexForm({ token: "gone.testnet" }), { limits: LIMITS, judgeAccount: JUDGE }),
  ).toEqual({});
});

test("a_paused_contract_stops_the_reward_step", () => {
  const paused = { ...LIMITS, paused: true };

  expect(checkReward(regexForm(), { limits: paused, judgeAccount: JUDGE })).toEqual({
    form: "Tender isn't taking new tasks right now.",
  });
});

test("the_field_to_go_to_is_the_first_in_the_order_of_the_page", () => {
  const errors = checkBrief(regexForm({ title: "", instructions: "", maxBytes: "x" }));

  expect(firstError(errors)).toBe("title");
  expect(firstError({})).toBeUndefined();
});
