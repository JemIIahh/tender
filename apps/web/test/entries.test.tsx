import { render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { EntryList } from "../components/EntryList";
import { VerifierRecord } from "../components/VerifierRecord";
import { entry, HASH_A, HASH_B, revealed } from "./tasks";

// ---- Entries ----------------------------------------------------------------------------------

const rows = () => screen.getAllByTestId("entry-row");

test("entries_are_sealed_with_the_block_they_were_committed_at_while_the_task_is_open", () => {
  render(
    <EntryList
      entries={[
        entry("alice.testnet", { committed_height: "123456" }),
        entry("bob.testnet", { committed_height: "123460", entry_index: 1 }),
      ]}
      phase="open"
    />,
  );

  expect(rows().map((row) => row.textContent)).toEqual([
    "alice.testnetSealed entry · committed at block 123456",
    "bob.testnetSealed entry · committed at block 123460",
  ]);
  // Nothing to open, and nothing to hash yet.
  expect(screen.queryByRole("link")).toBeNull();
});

test("entries_show_a_hash_and_no_link_during_the_reveal_window", () => {
  render(
    <EntryList
      entries={[revealed("alice.testnet", HASH_A), entry("bob.testnet", { entry_index: 1 })]}
      phase="revealing"
    />,
  );

  const [alice, bob] = rows();
  // P06-P6: the API serves a result only from the reveal deadline, so a link now would be dead.
  expect(within(alice as HTMLElement).getByText(`Revealed · sha256 ${HASH_A}`)).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
  // An entry that is not revealed yet is still sealed: it can be revealed until the window ends.
  expect(
    within(bob as HTMLElement).getByText(/^Sealed entry · committed at block 123456$/),
  ).toBeTruthy();
});

test("entries_link_to_their_content_once_the_reveal_window_is_over", () => {
  for (const phase of ["judging", "fallback", "expired", "settled"] as const) {
    const { unmount } = render(
      <EntryList entries={[revealed("alice.testnet", HASH_A)]} phase={phase} />,
    );

    const link = screen.getByRole("link", { name: /open content/i }) as HTMLAnchorElement;
    expect(link.getAttribute("href"), phase).toBe(`http://api.test/v1/blobs/${HASH_A}`);
    // The hash is next to it, so that the bytes behind the link can be checked.
    expect(rows()[0]?.textContent, phase).toContain(`sha256 ${HASH_A}`);
    // And the link says where it goes, since the address is whatever the entrant wrote.
    expect(rows()[0]?.textContent, phase).toContain("api.test");
    unmount();
  }
});

test("entries_that_never_revealed_say_so_once_the_window_is_over", () => {
  render(
    <EntryList entries={[entry("bob.testnet", { committed_height: "99" })]} phase="judging" />,
  );

  expect(rows()[0]?.textContent).toBe("bob.testnetNot revealed · committed at block 99");
  expect(screen.queryByText(/sealed entry/i)).toBeNull();
});

test("entries_open_links_in_a_new_tab_without_handing_over_the_page", () => {
  render(<EntryList entries={[revealed("alice.testnet", HASH_A)]} phase="settled" />);

  const link = screen.getByRole("link", { name: /open content/i });
  expect(link.getAttribute("target")).toBe("_blank");
  const rel = (link.getAttribute("rel") ?? "").split(" ");
  expect(rel).toContain("noopener");
  expect(rel).toContain("noreferrer");
});

test("entries_never_make_a_link_of_a_uri_that_could_run_script", () => {
  const evil = "javascript:alert(document.cookie)";
  render(
    <EntryList entries={[revealed("alice.testnet", HASH_A, { uri: evil })]} phase="settled" />,
  );

  // No link at all. The address is shown as text, so a reader can see what the entrant wrote.
  expect(screen.queryByRole("link")).toBeNull();
  expect(document.querySelector("a")).toBeNull();
  expect(rows()[0]?.textContent).toContain(evil);
  expect(rows()[0]?.textContent).toContain(`sha256 ${HASH_A}`);
});

test("entries_render_a_uri_as_text_not_as_html", () => {
  const markup = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  render(
    <EntryList entries={[revealed("alice.testnet", HASH_A, { uri: markup })]} phase="settled" />,
  );

  expect(rows()[0]?.textContent).toContain(markup);
  expect(document.querySelector("img")).toBeNull();
  expect(document.querySelector("script")).toBeNull();
});

test("entries_label_the_teams_agents", () => {
  render(
    <EntryList
      entries={[entry("agent.tender-team.testnet", { is_team: true }), entry("carol.testnet")]}
      phase="open"
    />,
  );

  const [team, other] = rows();
  expect(within(team as HTMLElement).getByText("Run by Tender team")).toBeTruthy();
  expect(within(other as HTMLElement).queryByText("Run by Tender team")).toBeNull();
});

test("entries_say_when_there_are_none", () => {
  render(<EntryList entries={[]} phase="open" />);

  expect(screen.getByText(/no entries yet/i)).toBeTruthy();
  expect(screen.queryAllByTestId("entry-row")).toHaveLength(0);
});

test("entries_count_what_is_committed_and_what_is_revealed", () => {
  render(
    <EntryList
      entries={[
        revealed("alice.testnet", HASH_A),
        revealed("bob.testnet", HASH_B, { entry_index: 1 }),
        entry("carol.testnet", { entry_index: 2 }),
      ]}
      phase="revealing"
    />,
  );

  expect(screen.getByTestId("entry-summary").textContent).toBe("3 committed · 2 revealed");
});

test("entries_let_a_long_hash_and_a_long_address_wrap_on_a_phone", () => {
  render(
    <EntryList
      entries={[revealed("alice.testnet", HASH_A, { uri: `ipfs://${"x".repeat(240)}` })]}
      phase="settled"
    />,
  );

  // The class that lets text with no place to break wrap, which a 375 px phone needs (the e2e spec
  // measures the page itself).
  expect(screen.getByText(`Revealed · sha256 ${HASH_A}`).className).toContain("wrap-anywhere");
  expect(screen.getByText(/^Content address \(not a web link\): ipfs:\/\/x+$/).className).toContain(
    "wrap-anywhere",
  );
});

// ---- The verifier -----------------------------------------------------------------------------

test("verifier_record_shows_the_account_and_its_record", () => {
  render(
    <VerifierRecord
      account="judge.tender-team.testnet"
      isTeam
      picks_made={12}
      voids_after_reveals={1}
      isPoster={false}
    />,
  );

  const record = screen.getByTestId("verifier-record");
  expect(within(record).getByText("judge.tender-team.testnet")).toBeTruthy();
  expect(within(record).getByText("Run by Tender team")).toBeTruthy();
  expect(within(record).getByTestId("picks-made").textContent).toBe("12");
  expect(within(record).getByTestId("voids-after-reveals").textContent).toBe("1");
  expect(screen.queryByText("Poster judges their own task")).toBeNull();
});

test("verifier_record_flags_a_poster_who_judges_their_own_task", () => {
  render(
    <VerifierRecord
      account="alice.testnet"
      isTeam={false}
      picks_made={0}
      voids_after_reveals={0}
      isPoster
    />,
  );

  expect(screen.getByText("Poster judges their own task")).toBeTruthy();
  expect(screen.queryByText("Run by Tender team")).toBeNull();
});

test("verifier_record_says_when_the_contract_keeps_none", () => {
  // The counts live in an agent's profile. A verifier that never registered has no profile, and
  // zero would be a claim the contract does not make.
  render(
    <VerifierRecord
      account="alice.testnet"
      isTeam={false}
      picks_made={null}
      voids_after_reveals={null}
      isPoster={false}
    />,
  );

  expect(screen.getByText(/no record/i)).toBeTruthy();
  expect(screen.queryByTestId("picks-made")).toBeNull();
  expect(screen.queryByTestId("voids-after-reveals")).toBeNull();
});

test("verifier_record_says_when_the_profile_could_not_be_read", () => {
  // Not the same as a verifier that never registered: that is a fact, and this is a failure.
  render(
    <VerifierRecord
      account="judge.tender-team.testnet"
      isTeam={false}
      picks_made={null}
      voids_after_reveals={null}
      isPoster
      unavailable
    />,
  );

  expect(screen.getByText("Checker record unavailable")).toBeTruthy();
  expect(screen.queryByText(/no record/i)).toBeNull();
  expect(screen.queryByTestId("picks-made")).toBeNull();
  // What the task itself says is still said.
  expect(screen.getByText("Poster judges their own task")).toBeTruthy();
});
