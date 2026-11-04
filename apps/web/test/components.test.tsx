import { NETWORKS } from "@tender/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { Amount, RawUnits } from "../components/Amount";
import { ErrorState } from "../components/ErrorState";
import { Nav } from "../components/Nav";
import { TaskCard } from "../components/TaskCard";
import { TeamBadge } from "../components/TeamBadge";
import { knowsToken } from "../lib/tokens";
import { summary } from "./tasks";

// No jest-dom here (X-20): plain assertions on what the Testing Library finds.

const pathname = vi.hoisted(() => ({ current: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));

const USDC_TESTNET = NETWORKS.testnet.usdc ?? "";

// ---- Amount -----------------------------------------------------------------------------------

test("amount_shows_a_known_token_in_whole_units_with_its_symbol", () => {
  const { container } = render(<Amount value="1250000" token={USDC_TESTNET} />);

  expect(container.textContent).toBe("1.25 USDC");
});

test("amount_reads_the_test_token_as_tusdc", () => {
  const { container } = render(<Amount value="500000" token="tusdc.tender-team.testnet" />);

  expect(container.textContent).toBe("0.50 tUSDC");
});

test("amount_shows_the_raw_amount_and_the_token_id_for_an_unknown_token", () => {
  const { container } = render(<Amount value="1250000" token="mystery.token.near" />);

  expect(container.textContent).toBe("1250000 mystery.token.near");
});

test("amount_sets_an_unknown_tokens_id_apart_from_the_number", () => {
  const apart = "[data-testid=amount] > span";

  const unknown = render(<Amount value="5" token="mystery.token.near" />);
  expect(unknown.container.querySelector(apart)?.textContent).toBe("mystery.token.near");
  unknown.unmount();

  const known = render(<Amount value="5000000" token={USDC_TESTNET} />);
  expect(known.container.querySelector(apart)).toBeNull();
});

test("amount_looks_the_token_up_on_the_network_it_is_given", () => {
  // The same account is USDC on testnet and nothing the app knows on mainnet.
  const testnet = render(<Amount value="1000000" token={USDC_TESTNET} network="testnet" />);
  expect(testnet.container.textContent).toBe("1.00 USDC");
  testnet.unmount();

  const mainnet = render(<Amount value="1000000" token={USDC_TESTNET} network="mainnet" />);
  expect(mainnet.container.textContent).toBe(`1000000 ${USDC_TESTNET}`);
});

test("amount_uses_the_configured_network_by_default", () => {
  // vitest.config.ts sets testnet.
  const { container } = render(<Amount value="2000000" token={USDC_TESTNET} />);

  expect(container.textContent).toBe("2.00 USDC");
});

test("amount_keeps_every_digit_of_the_largest_amount", () => {
  const max = "340282366920938463463374607431768211455";
  const { container } = render(<Amount value={max} token="mystery.token.near" />);

  expect(container.textContent).toBe(`${max} mystery.token.near`);
});

test("amount_shows_a_missing_value_as_a_dash_with_the_token", () => {
  for (const value of [null, undefined, ""]) {
    const { container, unmount } = render(<Amount value={value} token="mystery.token.near" />);
    expect(container.textContent, String(value)).toBe("— mystery.token.near");
    unmount();
  }
});

test("amount_shows_a_value_that_is_no_amount_as_it_was_written_with_the_tokens_id", () => {
  // A `view` result is unchecked JSON: a malformed value must not take the page down with it.
  for (const value of ["12x", "-5", "1.5", "1e3", " 7", "0x10", "\u0663", "NaN"]) {
    // A token that is known is not named by its symbol: there is no telling what unit this is in.
    const known = render(<Amount value={value} token={USDC_TESTNET} />);
    expect(known.container.textContent, value).toBe(`${value} ${USDC_TESTNET}`);
    known.unmount();

    const unknown = render(<Amount value={value} token="mystery.token.near" />);
    expect(unknown.container.textContent, value).toBe(`${value} mystery.token.near`);
    unknown.unmount();
  }
});

test("amount_still_scales_an_amount_next_to_one_that_is_none", () => {
  const { container } = render(
    <>
      <Amount value="1250000" token={USDC_TESTNET} />
      <Amount value={null} token={USDC_TESTNET} />
      <Amount value="2500000" token={USDC_TESTNET} />
    </>,
  );

  expect(container.textContent).toBe(`1.25 USDC— ${USDC_TESTNET}2.50 USDC`);
});

// ---- TeamBadge --------------------------------------------------------------------------------

test("team_badge_labels_an_account_the_team_runs", () => {
  render(<TeamBadge account="poster.tender-team.testnet" isTeam />);

  expect(screen.getByText("poster.tender-team.testnet")).toBeTruthy();
  expect(screen.getByText("Run by Tender team")).toBeTruthy();
});

test("team_badge_shows_only_the_account_of_anyone_else", () => {
  render(<TeamBadge account="alice.near" isTeam={false} />);

  expect(screen.getByText("alice.near")).toBeTruthy();
  expect(screen.queryByText("Run by Tender team")).toBeNull();
});

// ---- ErrorState -------------------------------------------------------------------------------

test("error_state_shows_the_message_as_an_alert_with_a_retry_button", async () => {
  const onRetry = vi.fn();
  render(<ErrorState message="Can't reach the server." onRetry={onRetry} />);

  expect(screen.getByRole("alert").textContent).toContain("Can't reach the server.");
  const button = screen.getByRole("button", { name: "Retry" });
  expect(button.getAttribute("aria-disabled")).not.toBe("true");
  await userEvent.click(button);
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test("error_state_while_retrying_reads_retrying_and_asks_for_nothing_more", async () => {
  const onRetry = vi.fn();
  render(<ErrorState message="Can't reach the server." onRetry={onRetry} retrying />);

  const button = screen.getByRole("button", { name: "Retrying…" }) as HTMLButtonElement;
  expect(button.getAttribute("aria-disabled")).toBe("true");
  // Not `disabled`: a button that is can't hold the focus of the person who pressed it.
  expect(button.disabled).toBe(false);
  expect(screen.getByRole("alert").textContent).toContain("Can't reach the server.");
  await userEvent.click(button);
  expect(onRetry).not.toHaveBeenCalled();
});

// ---- A board card in a token the app knows no decimals for --------------------------------------

test("task_card_labels_an_unknown_token_as_the_live_panel_does_and_never_breaks_the_number", () => {
  const MAX = "340282366920938463463374607431768211455";
  const IMPLICIT = "5f3a9c0e".repeat(8);
  render(
    <ul>
      <TaskCard task={summary({ token: IMPLICIT, reward: MAX })} nowNs={0n} />
    </ul>,
  );
  const raw = screen.getByTestId("card-raw-reward");
  // The amount as the contract holds it, one unbroken run of figures that never wraps.
  const amount = raw.querySelector(".whitespace-nowrap");
  expect(amount?.textContent).toBe(MAX);
  expect(amount?.className).not.toContain("wrap-anywhere");
  // Under it, the Live panel's label: the token's account with its middle left out, whole for a
  // screen reader and in the title. The number is in the page twice: whole for a screen reader,
  // and cut for the eye.
  expect(raw.textContent).toBe(
    `Reward: ${MAX}${MAX}smallest units of 5f3a9c0e…5f3a9c0e${IMPLICIT}`,
  );
  expect(raw.querySelector(`[title="${IMPLICIT}"]`)).toBeTruthy();
  // The token's account is not run into the number any more.
  expect(raw.textContent).not.toContain(`${MAX} ${IMPLICIT}`);
  expect(knowsToken(IMPLICIT)).toBe(false);
  expect(knowsToken(USDC_TESTNET)).toBe(true);
});

test("raw_units_cut_a_long_number_in_the_middle_visibly_and_keep_every_digit_in_the_page", () => {
  const MAX = "340282366920938463463374607431768211455";
  render(<RawUnits value={MAX} token="mystery.token.near" amountTestId="raw" />);
  const amount = screen.getByTestId("raw");
  // Every digit is in the page, for a screen reader, and in the tooltip.
  expect(amount.textContent).toBe(MAX);
  expect(amount.getAttribute("title")).toBe(MAX);
  // The head gives way with a visible "…" (CSS), and the last six digits always show.
  const head = screen.getByTestId("raw-head");
  expect(head.className).toContain("text-ellipsis");
  expect(head.className).toContain("overflow-hidden");
  expect(head.textContent).toBe(MAX.slice(0, -6));
  expect(head.nextElementSibling?.textContent).toBe("211455");
  expect(head.nextElementSibling?.className).toContain("shrink-0");
  // Never a scroller that cuts it off at the edge, and never a wrap in the middle.
  expect(amount.className).not.toMatch(/overflow-x-auto|wrap-anywhere/);
  // The cut is for the eye: a screen reader is given the whole number once, as one text, and not
  // the two parts, which could read as two numbers.
  expect(amount.getAttribute("aria-hidden")).toBe("true");
  const spoken = amount.parentElement?.querySelectorAll(".sr-only") ?? [];
  expect([...spoken].map((part) => part.textContent)).toEqual([MAX]);
  expect(amount.previousElementSibling?.textContent).toBe(MAX);

  // A short amount is shown as it is, with nothing to cut.
  render(<RawUnits value="42" token="mystery.token.near" amountTestId="short" />);
  expect(screen.getByTestId("short").textContent).toBe("42");
  expect(screen.getByTestId("short").children).toHaveLength(0);
  // Nothing is cut, so it is the one text a screen reader reads.
  expect(screen.getByTestId("short").getAttribute("aria-hidden")).toBeNull();
  expect(screen.getByTestId("short").parentElement?.querySelector(".sr-only")).toBeNull();
});

// ---- Nav --------------------------------------------------------------------------------------

// The sidebar calls the board "Marketplace", as the app restyle brief names it, and groups the
// agents' pages under Agents, the provider (ASP) pages and the services for hire among them (the
// ASP and the services briefs).
// The parity brief adds Activity and Metrics beside it, My tasks, Settings, and How it works at the
// foot.
const LINKS = [
  ["Marketplace", "/tasks"],
  ["Activity", "/activity"],
  ["Metrics", "/metrics"],
  ["Post a task", "/post"],
  ["My tasks", "/my-tasks"],
  ["Browse agents", "/agents"],
  ["Providers", "/providers"],
  ["Services", "/services"],
  ["Add an agent", "/my-agents/new"],
  ["My agents", "/my-agents"],
  ["Earnings", "/earnings"],
  ["Wallet", "/wallet"],
  ["Telegram", "/telegram"],
  ["Settings", "/settings"],
  ["How it works", "/how-it-works"],
] as const;

test("nav_links_every_page_of_the_app", () => {
  pathname.current = "/tasks";
  render(<Nav />);

  const nav = screen.getByRole("navigation");
  for (const [label, href] of LINKS) {
    const link = screen.getByRole("link", { name: label });
    expect(link.getAttribute("href"), label).toBe(href);
    expect(nav.contains(link), label).toBe(true);
  }
  // In this order, and nothing else.
  expect(screen.getAllByRole("link").map((link) => link.getAttribute("aria-label"))).toEqual(
    LINKS.map(([label]) => label),
  );
});

test("nav_groups_the_pages_under_their_titles", () => {
  pathname.current = "/tasks";
  const { container } = render(<Nav />);

  const groups = [...container.querySelectorAll("nav > div")].map((group) => ({
    title: group.querySelector("p")?.textContent ?? null,
    links: [...group.querySelectorAll("a")].map((link) => link.getAttribute("aria-label")),
  }));
  expect(groups).toEqual([
    { title: null, links: ["Marketplace", "Activity", "Metrics"] },
    { title: "Tasks", links: ["Post a task", "My tasks"] },
    {
      title: "Agents",
      links: ["Browse agents", "Providers", "Services", "Add an agent", "My agents"],
    },
    { title: "Account", links: ["Earnings", "Wallet", "Telegram", "Settings"] },
    // The foot, in no group.
    { title: null, links: ["How it works"] },
  ]);
});

test("nav_marks_the_page_you_are_on", () => {
  const current = () =>
    screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page")
      .map((link) => link.textContent);

  pathname.current = "/tasks";
  const home = render(<Nav />);
  expect(current()).toEqual(["Marketplace"]);
  home.unmount();

  // A page under a link belongs to it: an agent's page to Browse agents, a task's page to Tasks, a
  // provider's page to Providers.
  pathname.current = "/agents/alice.near";
  const agent = render(<Nav />);
  expect(current()).toEqual(["Browse agents"]);
  agent.unmount();

  pathname.current = "/providers/acme.near";
  const provider = render(<Nav />);
  expect(current()).toEqual(["Providers"]);
  provider.unmount();

  pathname.current = "/tasks/7";
  const task = render(<Nav />);
  expect(current()).toEqual(["Marketplace"]);
  task.unmount();

  // Adding an agent has a link of its own, the longest that fits: My agents is not marked too.
  pathname.current = "/my-agents/new";
  const adding = render(<Nav />);
  expect(current()).toEqual(["Add an agent"]);
  adding.unmount();

  pathname.current = "/my-agents";
  const mine = render(<Nav />);
  expect(current()).toEqual(["My agents"]);
  mine.unmount();

  pathname.current = "/wallet";
  render(<Nav />);
  expect(current()).toEqual(["Wallet"]);
});
