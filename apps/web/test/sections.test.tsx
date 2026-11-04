import { canonicalJson, type PublicCriteria, sha256Hex, type TaskOutcome } from "@tender/shared";
import { render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { BriefSection } from "../components/BriefSection";
import { CriteriaSection } from "../components/CriteriaSection";
import { JudgeNote } from "../components/JudgeNote";
import { Payouts } from "../components/Payouts";
import { PHASE_LABELS, PhaseChip } from "../components/PhaseChip";
import { Scorecard } from "../components/Scorecard";
import { formatBps } from "../lib/bps";
import { detail, HASH_A, HASH_B, HASH_C, POSTER, scorecard, TOKEN, VERIFIER } from "./tasks";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- Basis points -----------------------------------------------------------------------------

test("format_bps_writes_a_share_as_a_percentage", () => {
  expect(formatBps(10_000)).toBe("100%");
  expect(formatBps(5000)).toBe("50%");
  expect(formatBps(3333)).toBe("33.33%");
  expect(formatBps(250)).toBe("2.5%");
  expect(formatBps(1)).toBe("0.01%");
});

// ---- Phase chip -------------------------------------------------------------------------------

test("phase_chip_names_every_phase", () => {
  for (const phase of ["open", "revealing", "judging", "fallback", "expired", "settled"] as const) {
    const { unmount } = render(<PhaseChip phase={phase} />);

    const chip = screen.getByTestId("phase-chip");
    expect(chip.textContent, phase).toBe(PHASE_LABELS[phase]);
    expect(chip.getAttribute("data-phase"), phase).toBe(phase);
    unmount();
  }
  expect(Object.values(PHASE_LABELS)).toEqual([
    "Open",
    "Revealing",
    "Judging",
    "Fallback",
    "Expired",
    "Settled",
  ]);
});

// ---- Who settled, and what was paid ----------------------------------------------------------

type Picked = Extract<TaskOutcome, { kind: "picked" }>;
type Voided = Extract<TaskOutcome, { kind: "voided" }>;

const picked = (overrides: Partial<Picked> = {}): Picked => ({
  kind: "picked",
  task_id: "7",
  by: VERIFIER,
  winners: [{ account: "alice.testnet", bps: 10_000, amount: "1425000" }],
  fee: "75000",
  scorecard_hash: HASH_B,
  scorecard_uri: `http://api.test/v1/blobs/${HASH_B}`,
  ...overrides,
});

const voided = (overrides: Partial<Voided> = {}): Voided => ({
  kind: "voided",
  task_id: "7",
  reason: "no_award",
  by: VERIFIER,
  refunds: [{ account: POSTER, amount: "1500000" }],
  scorecard_hash: HASH_B,
  scorecard_uri: `http://api.test/v1/blobs/${HASH_B}`,
  ...overrides,
});

function renderPayouts(outcome: TaskOutcome, parties: { poster?: string; verifier?: string } = {}) {
  return render(
    <Payouts
      outcome={outcome}
      token={TOKEN}
      poster={parties.poster ?? POSTER}
      verifier={parties.verifier ?? VERIFIER}
    />,
  );
}

test("payout_shows_who_settled", () => {
  const OTHER = "carol.testnet";
  const cases: Array<{
    label: string;
    outcome: TaskOutcome;
    parties?: { poster?: string; verifier?: string };
    by: string;
    why: string | null;
  }> = [
    {
      label: "a pick by the verifier",
      outcome: picked({ by: VERIFIER }),
      by: `Picked by ${VERIFIER} (verifier)`,
      why: null,
    },
    {
      label: "a pick by the poster, in the fallback window",
      outcome: picked({ by: POSTER }),
      by: `Picked by ${POSTER} (poster, fallback window)`,
      why: null,
    },
    {
      // The contract gives a poster who is also the verifier both windows. The outcome does not say
      // which one it was, and the account is the verifier either way.
      label: "a pick by an account that is both the poster and the verifier",
      outcome: picked({ by: POSTER }),
      parties: { verifier: POSTER },
      by: `Picked by ${POSTER} (verifier)`,
      why: null,
    },
    {
      label: "a pick by an account that is neither",
      outcome: picked({ by: OTHER }),
      by: `Picked by ${OTHER}`,
      why: null,
    },
    {
      label: "a pick the index took from the chain (reconcile): no name",
      outcome: picked({ by: null, by_source: "reconcile" }),
      by: "Picked",
      why: null,
    },
    {
      label: "a void by the verifier",
      outcome: voided({ by: VERIFIER, reason: "no_award" }),
      by: `Refunded · voided by ${VERIFIER} (verifier)`,
      why: "The pick named no winner.",
    },
    {
      label: "a void by the poster, in the fallback window",
      outcome: voided({ by: POSTER, reason: "no_award" }),
      by: `Refunded · voided by ${POSTER} (poster, fallback window)`,
      why: "The pick named no winner.",
    },
    {
      label: "a void that anyone called, with nothing revealed",
      outcome: voided({
        by: null,
        reason: "no_reveals",
        scorecard_hash: null,
        scorecard_uri: null,
      }),
      by: "Refunded",
      why: "Nobody revealed an entry.",
    },
    {
      label: "a void that anyone called, after the fallback window",
      outcome: voided({ by: null, reason: "expired", scorecard_hash: null, scorecard_uri: null }),
      by: "Refunded",
      why: "Nobody picked before the fallback window closed.",
    },
    {
      label: "a void the index took from the chain (reconcile): no name, no refunds",
      outcome: {
        kind: "voided",
        task_id: "7",
        reason: "expired",
        by: null,
        by_source: "reconcile",
        scorecard_hash: null,
        scorecard_uri: null,
      },
      by: "Refunded",
      why: "Nobody picked before the fallback window closed.",
    },
  ];

  for (const { label, outcome, parties, by, why } of cases) {
    const { unmount } = renderPayouts(outcome, parties);

    expect(screen.getByTestId("settled-by").textContent, label).toBe(by);
    if (why === null) {
      expect(screen.queryByTestId("settled-why"), label).toBeNull();
    } else {
      expect(screen.getByTestId("settled-why").textContent, label).toBe(why);
    }
    // No stand-in for a name that is not there.
    expect(document.body.textContent, label).not.toMatch(/null|undefined/);
    unmount();
  }
});

test("payouts_list_the_winners_with_their_share_and_what_they_were_paid", () => {
  renderPayouts(
    picked({
      winners: [
        { account: "alice.testnet", bps: 7000, amount: "997500" },
        { account: "bob.testnet", bps: 3000, amount: "427500" },
      ],
    }),
  );

  const rows = screen.getAllByTestId("winner-row");
  expect(rows).toHaveLength(2);
  expect(within(rows[0] as HTMLElement).getByText("alice.testnet")).toBeTruthy();
  expect(rows[0]?.textContent).toContain("70%");
  expect(within(rows[0] as HTMLElement).getByTestId("amount").textContent).toBe("0.9975 tUSDC");
  expect(rows[1]?.textContent).toContain("30%");
  expect(within(rows[1] as HTMLElement).getByTestId("amount").textContent).toBe("0.4275 tUSDC");
});

test("payouts_show_the_fee", () => {
  renderPayouts(picked({ fee: "75000" }));

  const fee = screen.getByTestId("fee");
  expect(fee.textContent).toContain("Fee");
  expect(within(fee).getByTestId("amount").textContent).toBe("0.075 tUSDC");
});

test("payouts_list_the_refunds_of_a_void_when_the_index_has_them", () => {
  renderPayouts(
    voided({
      refunds: [
        { account: POSTER, amount: "1000000" },
        { account: "dave.testnet", amount: "500000" },
      ],
    }),
  );

  const rows = screen.getAllByTestId("refund-row");
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain(POSTER);
  expect(within(rows[1] as HTMLElement).getByTestId("amount").textContent).toBe("0.50 tUSDC");
  expect(screen.queryByTestId("winner-row")).toBeNull();
  expect(screen.queryByTestId("fee")).toBeNull();
});

test("payouts_show_no_refund_list_when_the_index_has_none", () => {
  renderPayouts({ ...voided(), refunds: undefined });

  expect(screen.queryByTestId("refund-row")).toBeNull();
  expect(screen.getByTestId("settled-by").textContent).toContain("Refunded");
});

// ---- The scorecard ----------------------------------------------------------------------------

// ---- Who scored it --------------------------------------------------------------------------

test.each([
  ["tender-judge/1", "Scored by the Tender Judge."],
  ["Tender_Judge-x", "Scored by the Tender Judge."],
  ["my-judge/2", "Scored by my-judge/2."],
  ["tender-agent", "Scored by tender-agent."],
])("scorecard_says_who_scored_it_%s", (software, line) => {
  render(<Scorecard scorecard={scorecard({ judge: { software, model: null } })} />);

  expect(screen.getByTestId("scored-by").textContent).toBe(line);
});

test("scorecard_of_a_pick_by_hand_says_a_person_chose_and_nothing_scored", () => {
  render(
    <Scorecard
      scorecard={scorecard({
        verifier: "poster.testnet",
        judge: { software: "tender-web/1", model: null },
      })}
    />,
  );

  expect(screen.getByTestId("scored-by").textContent).toBe(
    "The scorecard says poster.testnet picked by hand, with no software scoring the entries: each winner is listed at 100, every other entry at 0.",
  );
});

test("scorecard_of_a_rubric_is_labelled_subjective_and_names_the_model", () => {
  render(
    <Scorecard
      scorecard={scorecard({
        kind: "rubric",
        heldout: null,
        heldout_commitment: null,
        judge: { software: "tender-judge/1", model: "deepseek-v3.1" },
      })}
      commitment={null}
    />,
  );

  expect(screen.getByTestId("scored-by").textContent).toBe(
    "Scored by the Tender Judge with deepseek-v3.1. Subjective: a model's judgement.",
  );
});

test("scorecard_of_another_verifiers_rubric_is_subjective_under_its_own_name", () => {
  render(
    <Scorecard
      scorecard={scorecard({
        kind: "rubric",
        judge: { software: "acme-grader/3", model: null },
      })}
    />,
  );

  expect(screen.getByTestId("scored-by").textContent).toBe(
    "Scored by acme-grader/3. Subjective: a model's judgement.",
  );
});

test("scorecard_of_a_check_is_not_called_subjective", () => {
  render(<Scorecard scorecard={scorecard({ kind: "exact" })} />);

  expect(screen.getByTestId("scored-by").textContent).not.toMatch(/subjective/i);
});

test("scorecard_does_not_take_the_judges_name_from_another_account_when_the_build_knows_the_judge", () => {
  // The API refuses such a card from any account but the Judge's; a build that knows the Judge holds
  // the card to it as well, and names what the card says.
  const card = scorecard({ judge: { software: "tender-judge/1", model: null } });

  const { rerender } = render(<Scorecard scorecard={card} judgeAccount={VERIFIER} />);
  expect(screen.getByTestId("scored-by").textContent).toBe("Scored by the Tender Judge.");

  rerender(<Scorecard scorecard={card} judgeAccount="someone-else.testnet" />);
  expect(screen.getByTestId("scored-by").textContent).toBe("Scored by tender-judge/1.");
});

test("scorecard_shows_a_row_per_entry_with_its_score_whether_it_passed_and_why", () => {
  render(<Scorecard scorecard={scorecard()} />);

  const rows = screen.getAllByTestId("score-row");
  expect(rows).toHaveLength(2);
  const [alice, bob] = rows.map((row) => within(row));
  expect(alice?.getByText("alice.testnet")).toBeTruthy();
  expect(alice?.getByTestId("score").textContent).toBe("90");
  expect(alice?.getByTestId("passed").textContent).toBe("Yes");
  expect(alice?.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    "matches 9 of 10 cases",
    "rejects every bad id",
  ]);
  expect(bob?.getByTestId("score").textContent).toBe("40");
  expect(bob?.getByTestId("passed").textContent).toBe("No");
  expect(bob?.getByText("accepts `-bad`")).toBeTruthy();
  // The columns are named.
  for (const name of ["Entry", "Score", "Passed", "Reasons"]) {
    expect(screen.getByRole("columnheader", { name })).toBeTruthy();
  }
});

test("scorecard_names_the_winners_and_their_shares", () => {
  render(
    <Scorecard
      scorecard={scorecard({
        winners: [
          { account: "alice.testnet", bps: 6000 },
          { account: "bob.testnet", bps: 4000 },
        ],
      })}
    />,
  );

  const winners = screen.getAllByTestId("scorecard-winner");
  expect(winners.map((winner) => winner.textContent)).toEqual([
    "alice.testnet · 60%",
    "bob.testnet · 40%",
  ]);
});

test("scorecard_says_when_nothing_was_awarded", () => {
  render(<Scorecard scorecard={scorecard({ winners: [] })} />);

  expect(screen.queryByTestId("scorecard-winner")).toBeNull();
  expect(screen.getByText(/no winner/i)).toBeTruthy();
});

test("scorecard_shows_the_recompute_line", () => {
  render(<Scorecard scorecard={scorecard({ heldout_commitment: HASH_A })} />);

  // One element, one text: a reader can select it, and a test can match it whole.
  expect(screen.getByText(`Recompute: sha256(held-out) must equal ${HASH_A}`)).toBeTruthy();
  expect(screen.getByTestId("recompute").textContent).toBe(
    `Recompute: sha256(held-out) must equal ${HASH_A}`,
  );
});

test("scorecard_links_the_held_out_checks_as_the_bytes_that_were_hashed", () => {
  // A commitment that really is the hash of the document, as an honest verifier publishes.
  const heldout = { regex_cases: { no_match: ["-bad"], match: ["alice.near"] } };
  const commitment = sha256Hex(canonicalJson(heldout));
  render(<Scorecard scorecard={scorecard({ heldout, heldout_commitment: commitment })} />);

  const link = screen.getByRole("link", { name: /held-out checks/i });
  expect(link.getAttribute("download")).toBe("heldout.json");
  const href = link.getAttribute("href") ?? "";
  const prefix = "data:application/json;charset=utf-8,";
  expect(href.startsWith(prefix)).toBe(true);
  const bytes = decodeURIComponent(href.slice(prefix.length));
  // Keys in order and no spaces: the canonical form, which is what the commitment is the hash of.
  expect(bytes).toBe('{"regex_cases":{"match":["alice.near"],"no_match":["-bad"]}}');
  expect(sha256Hex(bytes)).toBe(commitment);
});

test("scorecard_shows_the_rest_and_no_link_when_the_held_out_checks_cannot_be_written_out", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  // JSON can escape a lone surrogate, and the canonical form refuses to write one.
  const heldout = { note: `x${String.fromCharCode(0xd800)}y` };

  render(<Scorecard scorecard={scorecard({ heldout })} />);

  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.getByText("The held-out checks cannot be written out as a file.")).toBeTruthy();
  // The scorecard is still there, and so is the line to recompute the commitment by.
  expect(screen.getAllByTestId("score-row")).toHaveLength(2);
  expect(screen.getByTestId("recompute")).toBeTruthy();
  // The original error goes to the console, where a developer looks.
  expect(log).toHaveBeenCalledTimes(1);
});

test("scorecard_writes_the_held_out_checks_once_however_often_the_page_draws", () => {
  const decode = vi.spyOn(TextDecoder.prototype, "decode");
  const card = scorecard();
  const { rerender } = render(<Scorecard scorecard={card} commitment={HASH_A} />);
  const written = decode.mock.calls.length;
  expect(written).toBeGreaterThan(0);

  // The page draws again every second for its countdowns: the same document each time.
  rerender(<Scorecard scorecard={card} commitment={HASH_A} />);
  rerender(<Scorecard scorecard={{ ...card }} commitment={HASH_A} />);
  expect(decode.mock.calls.length).toBe(written);

  // Another document is written again.
  rerender(<Scorecard scorecard={{ ...card, heldout: { other: true } }} commitment={HASH_A} />);
  expect(decode.mock.calls.length).toBeGreaterThan(written);
});

test("scorecard_lists_two_rows_that_name_the_same_account", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const [alice] = scorecard().entries;
  if (!alice) throw new Error("the builder has an entry");
  const share = { account: alice.account, bps: 5000 };

  // The verifier writes the document, and the schema does not make accounts unique.
  render(<Scorecard scorecard={scorecard({ entries: [alice, alice], winners: [share, share] })} />);

  expect(screen.getAllByTestId("score-row")).toHaveLength(2);
  expect(screen.getAllByTestId("scorecard-winner")).toHaveLength(2);
  // React logs two children with one key when there is a clash.
  expect(log).not.toHaveBeenCalled();
});

test("scorecard_asks_for_the_hash_the_task_has_on_chain_and_flags_a_scorecard_that_differs", () => {
  render(<Scorecard scorecard={scorecard({ heldout_commitment: HASH_A })} commitment={HASH_C} />);

  // The line is about the task's own commitment, the one a verifier cannot choose.
  expect(screen.getByTestId("recompute").textContent).toBe(
    `Recompute: sha256(held-out) must equal ${HASH_C}`,
  );
  const notice = screen.getByTestId("commitment-mismatch");
  expect(notice.textContent).toContain(HASH_A);
  expect(notice.textContent).toContain(HASH_C);
});

test("scorecard_flags_nothing_when_both_commitments_agree", () => {
  render(<Scorecard scorecard={scorecard({ heldout_commitment: HASH_A })} commitment={HASH_A} />);

  expect(screen.queryByTestId("commitment-mismatch")).toBeNull();
});

test("scorecard_for_a_task_with_no_held_out_part_has_no_recompute_line", () => {
  render(<Scorecard scorecard={scorecard({ heldout: null, heldout_commitment: null })} />);

  expect(screen.queryByTestId("recompute")).toBeNull();
  expect(screen.queryByRole("link", { name: /held-out/i })).toBeNull();
  expect(screen.getByText(/no held-out checks/i)).toBeTruthy();
});

test("scorecard_says_when_the_held_out_checks_were_not_published", () => {
  render(<Scorecard scorecard={scorecard({ heldout: null, heldout_commitment: HASH_A })} />);

  // The task commits to a document, and the scorecard does not carry it.
  expect(screen.getByTestId("recompute").textContent).toContain(HASH_A);
  expect(screen.queryByRole("link", { name: /held-out/i })).toBeNull();
  expect(screen.getByText(/not published/i)).toBeTruthy();
});

test("scorecard_shows_reasons_and_accounts_as_text_never_as_html", () => {
  const markup = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const base = scorecard();
  render(
    <Scorecard
      scorecard={scorecard({
        entries: [{ ...(base.entries[0] as (typeof base.entries)[number]), reasons: [markup] }],
      })}
    />,
  );

  expect(screen.getByText(markup)).toBeTruthy();
  expect(document.querySelector("img")).toBeNull();
  expect(document.querySelector("script")).toBeNull();
});

test("scorecard_table_keeps_to_the_width_of_a_phone", () => {
  render(<Scorecard scorecard={scorecard()} />);

  // Fixed column widths, and words that wrap anywhere: an account of 64 hex characters has no
  // place to break otherwise (the e2e spec measures the page at 375 px).
  expect(screen.getByRole("table").className).toContain("table-fixed");
  expect(
    within(screen.getAllByTestId("score-row")[0] as HTMLElement).getByText("alice.testnet")
      .className,
  ).toContain("wrap-anywhere");
});

// ---- The brief --------------------------------------------------------------------------------

test("brief_shows_the_summary_the_instructions_and_what_an_answer_must_look_like", () => {
  const { brief } = detail();
  render(<BriefSection brief={brief} />);

  expect(screen.getByText("Pull the total from each invoice.")).toBeTruthy();
  const instructions = screen.getByTestId("brief-instructions");
  // Both lines, as the poster wrote them, with the break between them kept.
  expect(instructions.textContent).toBe("Return the total as a number.\nIgnore tax lines.");
  expect(instructions.className).toContain("whitespace-pre-wrap");
  expect(screen.getByTestId("brief-output").textContent).toBe("Answer: JSON, up to 4096 bytes");
});

test("brief_shows_the_category_and_tags", () => {
  render(<BriefSection brief={detail().brief} />);

  expect(screen.getByTestId("brief-category").textContent).toBe("extraction");
  expect(screen.getAllByTestId("brief-tag").map((tag) => tag.textContent)).toEqual([
    "extraction",
    "json",
  ]);
});

test("brief_says_when_the_index_has_none", () => {
  render(<BriefSection brief={null} />);

  expect(screen.getByText("The brief isn't available yet.")).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/index/i);
});

test("brief_renders_the_poster_s_words_as_text_never_as_html", () => {
  const markup = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const { brief } = detail();
  render(
    <BriefSection
      brief={
        brief && {
          ...brief,
          summary: markup,
          instructions: markup,
          attachments: [{ name: markup, uri: "javascript:alert(3)", sha256: HASH_A }],
        }
      }
    />,
  );

  expect(document.querySelector("img")).toBeNull();
  expect(document.querySelector("script")).toBeNull();
  expect(screen.getByTestId("brief-instructions").textContent).toBe(markup);
  // The attachment's address is text the poster wrote, and `javascript:` is no link.
  expect(document.querySelector("a")).toBeNull();
});

test("brief_links_an_attachment_only_when_its_address_is_a_web_address", () => {
  const { brief } = detail();
  render(
    <BriefSection
      brief={
        brief && {
          ...brief,
          attachments: [
            { name: "invoices.zip", uri: "https://files.test/invoices.zip", sha256: HASH_A },
            { name: "notes.txt", uri: "ipfs://bafy", sha256: HASH_B },
          ],
        }
      }
    />,
  );

  const rows = screen.getAllByTestId("attachment");
  expect(rows).toHaveLength(2);
  const link = within(rows[0] as HTMLElement).getByRole("link", { name: "invoices.zip" });
  expect(link.getAttribute("href")).toBe("https://files.test/invoices.zip");
  expect(rows[0]?.textContent).toContain(`sha256 ${HASH_A}`);
  expect(within(rows[1] as HTMLElement).queryByRole("link")).toBeNull();
  expect(rows[1]?.textContent).toContain("notes.txt");
  expect(rows[1]?.textContent).toContain("ipfs://bafy");
});

// ---- The public criteria ----------------------------------------------------------------------

const criteria = (overrides: Record<string, unknown> = {}): PublicCriteria =>
  ({ ...detail().criteria, ...overrides }) as PublicCriteria;

test("criteria_show_how_entries_are_scored_the_pass_mark_and_the_split", () => {
  render(<CriteriaSection criteria={criteria()} />);

  expect(screen.getByTestId("criteria-kind").textContent).toBe("Regex cases");
  expect(screen.getByTestId("criteria-pass-mark").textContent).toBe("80 of 100");
  expect(screen.getByTestId("criteria-split").textContent).toBe("Winner takes all");
  expect(screen.getByTestId("criteria-heldout").textContent).toBe(
    "Held-out checks stand behind these criteria. Their hash is on the task.",
  );
});

// The task page calls a kind and a format what the wizard called them, and shows one the wizard does
// not offer as it came.
test.each([
  ["exact", "Exact answer", { normalize: [] }],
  ["json_schema", "JSON shape", { schema: {} }],
  ["regex_cases", "Regex cases", {}],
  ["rubric", "Rubric", { rubric: [{ criterion: "Is it clear", weight: 1 }] }],
  ["tests", "tests", { language: "js", entry: "total", examples: [] }],
])("criteria_call_the_%s_kind_%s", (kind, label, more) => {
  render(<CriteriaSection criteria={criteria({ kind, ...more })} />);

  expect(screen.getByTestId("criteria-kind").textContent).toBe(label);
});

test.each([
  ["text", "Plain text"],
  ["json", "JSON"],
  ["regex_json", "A regex, as JSON"],
  ["code_js", "code_js"],
])("brief_calls_the_%s_format_%s", (format, label) => {
  const brief = detail().brief;
  if (brief === null) throw new Error("the fixture has a brief");
  render(
    <BriefSection brief={{ ...brief, output: { ...brief.output, format: format as "text" } }} />,
  );

  expect(screen.getByTestId("brief-output").textContent).toBe(`Answer: ${label}, up to 4096 bytes`);
});

test("brief_shows_a_repeated_tag_each_time_without_a_key_clash", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const brief = detail().brief;
  if (brief === null) throw new Error("the fixture has a brief");
  render(<BriefSection brief={{ ...brief, tags: ["json", "json"] }} />);

  expect(screen.getAllByTestId("brief-tag")).toHaveLength(2);
  expect(log.mock.calls.flat().join("\n")).not.toContain("same key");
});

// ---- What the Judge made of a task ------------------------------------------------------------

test.each([
  ["pending", "Judge: not decided yet"],
  ["accepted", "Judge: accepted"],
  ["rejected", "Judge: turned this task down"],
  ["failed_closed", "Judge: could not check this task"],
  // A status this page has no words for is shown as it came, and not hidden.
  ["something_new", "Judge: something_new"],
])("judge_note_says_the_status_%s_in_words", (status, words) => {
  render(<JudgeNote status={status} reason={null} />);

  expect(screen.getByTestId("judge-note").textContent).toBe(words);
  expect(screen.getByTestId("judge-note").textContent).not.toContain("failed_closed");
});

test("judge_note_gives_the_reason_after_the_words", () => {
  render(<JudgeNote status="failed_closed" reason="the model server could not be reached" />);

  expect(screen.getByTestId("judge-note").textContent).toBe(
    "Judge: could not check this task · the model server could not be reached",
  );
});

test("criteria_write_each_kind_of_split", () => {
  const splitOf = (split: unknown) => {
    const { unmount } = render(<CriteriaSection criteria={criteria({ split })} />);
    const text = screen.getByTestId("criteria-split").textContent;
    unmount();
    return text;
  };

  expect(splitOf("winner_take_all")).toBe("Winner takes all");
  expect(splitOf("equal")).toBe("Equal shares");
  expect(splitOf([7000, 3000])).toBe("70% / 30%");
});

test("criteria_say_when_there_is_no_held_out_part", () => {
  render(<CriteriaSection criteria={criteria({ has_heldout: false })} />);

  expect(screen.getByTestId("criteria-heldout").textContent).toBe("No held-out checks.");
});

test("criteria_list_the_examples_of_a_regex_task", () => {
  render(<CriteriaSection criteria={criteria()} />);

  expect(screen.getAllByTestId("example-match").map((item) => item.textContent)).toEqual([
    "alice.near",
  ]);
  expect(screen.getAllByTestId("example-no-match").map((item) => item.textContent)).toEqual([
    "-bad",
  ]);
});

test("criteria_list_the_rubric_with_its_weights", () => {
  render(
    <CriteriaSection
      criteria={{
        kind: "rubric",
        version: 1,
        min_score: 60,
        split: "equal",
        has_heldout: false,
        rubric: [
          { criterion: "Covers every severity level", weight: 5 },
          { criterion: "Fits in five bullets", weight: 2 },
        ],
      }}
    />,
  );

  const rows = screen.getAllByTestId("rubric-row");
  expect(rows.map((row) => row.textContent)).toEqual([
    "Covers every severity level · weight 5",
    "Fits in five bullets · weight 2",
  ]);
  // It says nothing of who scores: the scorecard does, and a verifier other than the Judge may use
  // a rubric too.
  expect(screen.getByTestId("rubric-subjective").textContent).toBe(
    "Scored against these points. Subjective.",
  );
  expect(document.body.textContent).not.toMatch(/LLM/);
});

test("criteria_show_the_other_kinds_as_text", () => {
  const kinds: Array<[PublicCriteria, string]> = [
    [
      {
        kind: "exact",
        version: 1,
        min_score: 100,
        split: "winner_take_all",
        has_heldout: true,
        normalize: ["trim", "lowercase"],
      },
      "Normalised before comparing: trim, lowercase",
    ],
    [
      {
        kind: "json_schema",
        version: 1,
        min_score: 100,
        split: "winner_take_all",
        has_heldout: true,
        schema: { type: "object", required: ["total"] },
      },
      '"required": [',
    ],
    [
      {
        kind: "tests",
        version: 1,
        min_score: 100,
        split: "winner_take_all",
        has_heldout: true,
        language: "js",
        entry: "solve",
        examples: [{ input: [1, 2], output: 3 }],
      },
      "The answer is a js function named solve.",
    ],
  ];

  for (const [criteriaOfKind, expected] of kinds) {
    const { unmount } = render(<CriteriaSection criteria={criteriaOfKind} />);

    expect(screen.getByTestId("criteria-detail").textContent, criteriaOfKind.kind).toContain(
      expected,
    );
    unmount();
  }
});

test("criteria_render_the_poster_s_words_as_text_never_as_html", () => {
  const markup = '<img src=x onerror="alert(1)">';
  render(
    <CriteriaSection criteria={criteria({ examples: { match: [markup], no_match: [markup] } })} />,
  );

  expect(document.querySelector("img")).toBeNull();
  expect(screen.getByTestId("example-match").textContent).toBe(markup);
});

test("criteria_say_when_the_index_has_none", () => {
  render(<CriteriaSection criteria={null} />);

  expect(screen.getByText("The criteria aren't available yet.")).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/index/i);
});
