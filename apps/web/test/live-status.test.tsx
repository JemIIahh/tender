import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { LiveStatus } from "../components/LiveStatus";
import { liveOf } from "../lib/live";
import { agent, summary } from "./tasks";

// The top bar's Live pill (components/LiveStatus.tsx, lib/live.ts): whether the index is up to date
// with the chain, and the platform's figures behind it, as the API gave them. It makes the three
// reads the sidebar's figures used to make, and never shows a block height or a count of blocks.

// No jest-dom here (X-20): plain assertions on what the Testing Library finds.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A `fetch` that answers by the address's path and query, and fails anything else. */
function fakeApi(routes: Record<string, () => Response>): string[] {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    urls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    const answer = routes[`${url.pathname}${url.search}`];
    if (answer === undefined) throw new TypeError("Failed to fetch");
    return answer();
  });
  return urls;
}

const OPEN = "/v1/tasks?phase=open&limit=50";
const AGENTS = "/v1/agents?limit=50";
const HEALTH_PATH = "/v1/health";

const HEALTH = {
  ok: true as const,
  network: "testnet",
  contract: "tender.testnet",
  indexed_height: "100",
  chain_final_height: "100",
  lag_blocks: "0",
  waiting_for_chain: false,
};

const OTHER_TOKEN = "other.testnet";

/** Two open tasks in tUSDC and one in a token with no known decimals. */
const openTasks = () =>
  json({
    tasks: [
      summary({ id: "7", reward: "1500000" }),
      summary({ id: "8", reward: "500000" }),
      summary({ id: "9", reward: "42", token: OTHER_TOKEN }),
    ],
    next_cursor: null,
  });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const pill = () => screen.findByRole("button", { name: /^Status: / });
const dot = (element: HTMLElement) =>
  within(element).getByTestId("live-dot").getAttribute("data-state");

test("live_pill_says_up_to_date_and_shows_the_api_s_figures_token_by_token", async () => {
  const urls = fakeApi({
    [OPEN]: openTasks,
    [AGENTS]: () => json({ agents: [agent()], next_cursor: "next" }),
    [HEALTH_PATH]: () => json(HEALTH),
  });
  render(<LiveStatus />);

  const button = await pill();
  expect(button.getAttribute("aria-label")).toBe("Status: Live");
  expect(button.textContent).toBe("Live");
  expect(dot(button)).toBe("synced");
  expect(button.getAttribute("aria-expanded")).toBe("false");
  // The three reads, once each, and nothing else.
  expect(urls.sort()).toEqual([`GET ${AGENTS}`, `GET ${HEALTH_PATH}`, `GET ${OPEN}`]);

  // The panel it controls is in the page while closed, hidden, so `aria-controls` names it.
  const panel = screen.getByTestId("live-panel");
  expect(button.getAttribute("aria-controls")).toBe(panel.id);
  expect(panel.hidden).toBe(true);
  await userEvent.click(button);
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(panel.hidden).toBe(false);
  expect(screen.getByTestId("live-line").textContent).toBe("Up to date");
  expect(screen.getAllByTestId("live-figure").map((row) => row.textContent)).toEqual([
    "Open tasks3",
    // A full page with more after it: at least that many, and said so.
    "Agents1+",
    // Each token on its own line: never one sum of two tokens. A token whose decimals the app does
    // not know is shown in its smallest unit, and a label under it says so.
    `In escrow on open tasks2.00 tUSDC42smallest units of ${OTHER_TOKEN}`,
  ]);
  // No block heights and no counts of blocks.
  expect(panel.textContent).not.toMatch(/block|100/i);
});

test("live_pill_says_catching_up_and_never_how_many_blocks", async () => {
  fakeApi({
    [OPEN]: openTasks,
    [AGENTS]: () => json({ agents: [], next_cursor: null }),
    [HEALTH_PATH]: () => json({ ...HEALTH, chain_final_height: "1337", lag_blocks: "1237" }),
  });
  render(<LiveStatus />);

  const button = await pill();
  expect(button.getAttribute("aria-label")).toBe("Status: Catching up");
  expect(button.textContent).toBe("Catching up");
  expect(dot(button)).toBe("behind");
  await userEvent.click(button);
  const panel = screen.getByTestId("live-panel");
  expect(screen.getByTestId("live-line").textContent).toBe("Catching up with the chain");
  expect(panel.textContent).not.toMatch(/1237|1337|block/i);
});

test("live_state_follows_the_health_check", () => {
  const health = (over: Partial<typeof HEALTH>) => ({ ...HEALTH, ...over });
  // Up to date only with no lag and no wait for the chain.
  expect(liveOf({ health: health({}), answered: true }).state).toBe("synced");
  expect(liveOf({ health: health({ lag_blocks: "3" }), answered: true }).state).toBe("behind");
  // While the services wait for the chain, a lag of 0 does not mean up to date.
  expect(liveOf({ health: health({ waiting_for_chain: true }), answered: true }).state).toBe(
    "behind",
  );
  // The API answered, but not the health check (a 503: the chain could not be read): it can't be
  // said to be up to date.
  expect(liveOf({ answered: true }).state).toBe("behind");
  // No answer at all.
  expect(liveOf({ answered: false }).state).toBe("offline");
});

test("live_pill_is_amber_when_the_health_check_says_the_chain_is_unavailable", async () => {
  fakeApi({
    [OPEN]: openTasks,
    [AGENTS]: () => json({ agents: [agent()], next_cursor: null }),
    [HEALTH_PATH]: () =>
      json({ ok: false, error: "chain_unavailable", message: "the final block height…" }, 503),
  });
  render(<LiveStatus />);
  const button = await pill();
  expect(button.getAttribute("aria-label")).toBe("Status: Catching up");
  expect(button.textContent).toBe("Catching up");
  await userEvent.click(button);
  expect(screen.getAllByTestId("live-figure").map((row) => row.textContent)).toEqual([
    "Open tasks3",
    "Agents1",
    `In escrow on open tasks2.00 tUSDC42smallest units of ${OTHER_TOKEN}`,
  ]);
});

test("live_pill_says_offline_and_shows_no_figure_when_the_api_can_t_be_reached", async () => {
  const urls = fakeApi({});
  render(<LiveStatus />);

  const button = await pill();
  expect(urls).toHaveLength(3);
  expect(button.getAttribute("aria-label")).toBe("Status: Offline");
  expect(button.textContent).toBe("Offline");
  expect(dot(button)).toBe("offline");
  await userEvent.click(button);
  expect(screen.getByTestId("live-line").textContent).toBe("Can't reach Tender right now");
  expect(screen.queryAllByTestId("live-figure")).toEqual([]);
});

test("live_pill_leaves_out_a_figure_the_api_did_not_give", async () => {
  // The open tasks run past a page: their count is "at least", and their sum is not known, so it
  // is not shown. The agents' read failed: no row for them.
  fakeApi({
    [OPEN]: () =>
      json({
        tasks: Array.from({ length: 50 }, (_, i) => summary({ id: String(i) })),
        next_cursor: "0",
      }),
    [HEALTH_PATH]: () => json(HEALTH),
  });
  render(<LiveStatus />);
  await userEvent.click(await pill());
  expect(screen.getAllByTestId("live-figure").map((row) => row.textContent)).toEqual([
    "Open tasks50+",
  ]);
});

test("live_pill_with_no_open_tasks_says_none_is_in_escrow", async () => {
  fakeApi({
    [OPEN]: () => json({ tasks: [], next_cursor: null }),
    [AGENTS]: () => json({ agents: [], next_cursor: null }),
    [HEALTH_PATH]: () => json(HEALTH),
  });
  render(<LiveStatus />);
  await userEvent.click(await pill());
  expect(screen.getAllByTestId("live-figure").map((row) => row.textContent)).toEqual([
    "Open tasks0",
    "Agents0",
    "In escrow on open tasksNone",
  ]);
});

test("live_panel_opens_from_the_keyboard_and_escape_gives_the_focus_back", async () => {
  fakeApi({ [HEALTH_PATH]: () => json(HEALTH) });
  render(
    <>
      <LiveStatus />
      <button type="button">Elsewhere</button>
    </>,
  );
  const button = await pill();
  button.focus();

  await userEvent.keyboard("{Enter}");
  expect(screen.getByTestId("live-panel").hidden).toBe(false);
  await userEvent.keyboard("{Escape}");
  expect(screen.getByTestId("live-panel").hidden).toBe(true);
  expect(document.activeElement).toBe(button);
  expect(button.getAttribute("aria-expanded")).toBe("false");

  await userEvent.keyboard(" ");
  expect(screen.getByTestId("live-panel").hidden).toBe(false);
  // The panel's one control, the link to Metrics, is the next stop: the panel stays open on it.
  await userEvent.tab();
  expect(document.activeElement?.textContent).toBe("See metrics");
  expect(screen.getByTestId("live-panel").hidden).toBe(false);
  // Moving on with the keyboard, out of the panel, closes it.
  await userEvent.tab();
  expect(document.activeElement?.textContent).toBe("Elsewhere");
  expect(screen.getByTestId("live-panel").hidden).toBe(true);
  // And going straight on from the pill, past a closed panel, never stops in it.
  button.focus();
  await userEvent.tab();
  expect(document.activeElement?.textContent).toBe("Elsewhere");
});

test("live_panel_links_to_the_metrics_page_and_closes_when_it_is_followed", async () => {
  fakeApi({ [HEALTH_PATH]: () => json(HEALTH) });
  render(<LiveStatus />);
  await userEvent.click(await pill());
  const link = within(screen.getByTestId("live-panel")).getByRole("link", { name: "See metrics" });
  expect(link.getAttribute("href")).toBe("/metrics");
  // A press on it is inside the panel; the page it opens is another, and the panel goes.
  link.addEventListener("click", (event) => event.preventDefault());
  await userEvent.click(link);
  expect(screen.getByTestId("live-panel").hidden).toBe(true);
});

test("live_panel_closes_on_a_press_elsewhere_and_not_on_one_inside_it", async () => {
  fakeApi({ [HEALTH_PATH]: () => json(HEALTH) });
  render(
    <>
      <LiveStatus />
      <p>The page</p>
    </>,
  );
  await userEvent.click(await pill());
  await userEvent.click(screen.getByTestId("live-line"));
  expect(screen.getByTestId("live-panel").hidden).toBe(false);
  await userEvent.click(screen.getByText("The page"));
  expect(screen.getByTestId("live-panel").hidden).toBe(true);
});

test("live_pill_reads_again_each_minute_only_while_the_tab_is_in_view", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const urls = fakeApi({ [HEALTH_PATH]: () => json(HEALTH) });
  render(<LiveStatus />);
  await waitFor(() => expect(urls).toHaveLength(3));

  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(urls).toHaveLength(6);

  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(urls).toHaveLength(6);
  visibility.mockRestore();
  fireEvent(document, new Event("visibilitychange"));
});

test("live_pill_is_the_dot_alone_on_a_phone_and_keeps_its_name", async () => {
  fakeApi({ [HEALTH_PATH]: () => json(HEALTH) });
  render(<LiveStatus />);
  const button = await pill();
  // The word is hidden on a phone by CSS (max-sm:sr-only), and stays in the button's name.
  const word = within(button).getByText("Live");
  expect(word.className).toContain("max-sm:sr-only");
  expect(button.className).toContain("max-sm:w-10");
  // On a phone the panel spans the screen under the top bar.
  await userEvent.click(button);
  expect(screen.getByTestId("live-panel").className).toContain("max-sm:fixed");
});

test("live_pill_dots_reach_3_to_1_on_the_pill", async () => {
  // The dot is a control's state, not its only label (the word and the name say it): it still has
  // to be seen, at 3:1 on the pill's ground (WCAG 1.4.11). Worked out as test/contrast.test.ts does.
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const css = readFileSync(join(import.meta.dirname, "../app/globals.css"), "utf8");
  const color = (name: string) =>
    new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6});`).exec(css)?.[1] ?? "";
  const luminance = (hex: string) => {
    const channel = (i: number) => {
      const c = Number.parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  };
  const ratio = (a: string, b: string) => {
    const [x, y] = [luminance(color(a)), luminance(color(b))];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  for (const dotColor of ["ok", "wait", "muted"]) {
    for (const ground of ["raised", "panel", "ink"]) {
      expect(ratio(dotColor, ground), `${dotColor} on ${ground}`).toBeGreaterThanOrEqual(3);
    }
  }
  // The words: bone and muted, small text, 4.5:1 on the pill (raised) and on the panel.
  for (const text of ["bone", "muted"]) {
    for (const ground of ["raised", "panel"]) {
      expect(ratio(text, ground), `${text} on ${ground}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test("live_escrow_labels_a_token_it_has_no_decimals_for_and_never_breaks_a_number", async () => {
  // The largest u128, in a token known by its symbol and in one the app has no decimals for, whose
  // account is an implicit one of 64 characters.
  const MAX = "340282366920938463463374607431768211455";
  const IMPLICIT = "5f3a9c0e".repeat(8);
  fakeApi({
    [OPEN]: () =>
      json({
        tasks: [
          summary({ id: "7", reward: MAX }),
          summary({ id: "8", reward: MAX, token: IMPLICIT }),
        ],
        next_cursor: null,
      }),
    [HEALTH_PATH]: () => json(HEALTH),
  });
  render(<LiveStatus />);
  await userEvent.click(await pill());

  const lines = screen.getAllByTestId("live-escrow");
  expect(lines).toHaveLength(2);
  const [known, unknown] = lines as [HTMLElement, HTMLElement];
  // The known token: its amount in whole units, then its symbol, and no label.
  expect(known.textContent).toBe("340282366920938463463374607431768.211455 tUSDC");
  expect(within(known).queryByTestId("live-escrow-unit")).toBeNull();
  // The unknown one: the amount as the contract holds it, and a visible label under it that says
  // what unit it is in, with the token's account shortened in the middle. The whole account is the
  // label's title, and what a screen reader reads.
  expect(within(unknown).getByTestId("live-escrow-amount").textContent).toBe(MAX);
  const unit = within(unknown).getByTestId("live-escrow-unit");
  expect(unit.querySelector('[aria-hidden="true"]')?.textContent).toBe("5f3a9c0e…5f3a9c0e");
  expect(unit.querySelector(`[title="${IMPLICIT}"]`)).toBeTruthy();
  expect(unit.querySelector(".sr-only")?.textContent).toBe(IMPLICIT);
  expect(unit.textContent?.startsWith("smallest units of ")).toBe(true);
  // A number is one unbroken run: it never wraps in the middle.
  for (const amount of screen.getAllByTestId("live-escrow-amount")) {
    expect(amount.className).toContain("whitespace-nowrap");
    expect(amount.className).not.toContain("wrap-anywhere");
  }
});

test("live_pill_keeps_a_true_state_when_a_read_can_t_be_made_sense_of", async () => {
  // A lag that is no number is not taken to be no lag.
  expect(liveOf({ health: { ...HEALTH, lag_blocks: "soon" }, answered: true }).state).toBe(
    "behind",
  );

  // And should working out the pill's state fail at all, the pill says what is known (the API
  // answered: Catching up), not what the last read said, nor nothing.
  vi.resetModules();
  vi.doMock("../lib/live", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../lib/live")>()),
    liveOf: () => {
      throw new RangeError("Cannot convert soon to a BigInt");
    },
  }));
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const { LiveStatus: Fresh } = await import("../components/LiveStatus");
  fakeApi({ [HEALTH_PATH]: () => json(HEALTH) });
  render(<Fresh />);

  const button = await pill();
  expect(button.getAttribute("aria-label")).toBe("Status: Catching up");
  expect(errors).toHaveBeenCalled();
  vi.doUnmock("../lib/live");
});
