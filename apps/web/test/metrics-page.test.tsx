import type { MetricsResponse } from "@tender/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MetricsView } from "../components/MetricsView";
import { json } from "./accountFakes";
import { agent } from "./tasks";

// The Metrics page (components/MetricsView.tsx) over a fake `GET /v1/metrics`: every figure as the
// API gave it, amounts token by token, the top agents linked to their pages, and the chart of the
// tasks posted each day with the same figures in a table.

const TOKEN = "tusdc.tender-team.testnet";
const OTHER = "5f3a9c0e".repeat(8);

function days(counts: number[]): MetricsResponse["posted_by_day"] {
  return counts.map((tasks, i) => ({ day: `2026-10-${18 + i}`, tasks }));
}

const METRICS: MetricsResponse = {
  tasks: { posted: 12, open: 3, settled: 7, picked: 5, voided: 2 },
  paid: [
    { token: OTHER, amount: "900" },
    { token: TOKEN, amount: "9500000" },
  ],
  fees: [{ token: TOKEN, amount: "500000" }],
  agents: { registered: 11, active: 9 },
  providers: 2,
  services: { listed: 4, available: 3 },
  top_agents: [
    agent({
      account: "alice.testnet",
      name: "Alice Extractor",
      wins: 4,
      entries: 6,
      earned: { [TOKEN]: "4750000" },
    }),
    agent({ account: "bob.testnet", name: null, wins: 1, entries: 9, earned: {} }),
  ],
  posted_by_day: days([0, 1, 0, 0, 2, 0, 0, 0, 3, 0, 0, 1, 0, 2]),
};

let answer: () => Response;
let requests: string[];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  requests = [];
  answer = () => json(METRICS);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requests.push(`${url.pathname}${url.search}`);
    return url.pathname === "/v1/metrics"
      ? answer()
      : json({ error: "not_found", message: "no" }, 404);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const figure = (id: string) => screen.getByTestId(id).textContent;

test("metrics_show_the_api_s_figures_token_by_token", async () => {
  render(<MetricsView />);
  expect(screen.getByRole("status").textContent).toBe("Counting…");
  await screen.findByTestId("metric-open");
  expect(requests).toEqual(["/v1/metrics"]);

  expect(figure("metric-open")).toContain("3");
  expect(figure("metric-settled")).toContain("5 paid out · 2 refunded, of 12 posted");
  // Paid: each token on its own line, the one the app knows first; never one sum of two tokens.
  const paid = within(screen.getByTestId("metric-paid")).getAllByRole("listitem");
  // A token the app knows no decimals for: its smallest units, labelled as the Live panel does.
  expect(paid.map((line) => line.textContent)).toEqual([
    "9.50 tUSDC",
    `900smallest units of 5f3a9c0e…5f3a9c0e${OTHER}`,
  ]);
  expect(figure("metric-fees")).toContain("0.50 tUSDC");
  expect(figure("metric-agents")).toContain("11");
  expect(figure("metric-agents")).toContain("9 active now");
  expect(figure("metric-providers")).toContain("2");
  expect(figure("metric-services")).toContain("3 can be hired now");
});

test("metrics_rank_the_top_agents_with_links_to_their_pages", async () => {
  render(<MetricsView />);
  const top = await screen.findByTestId("top-agents");
  const rows = within(top).getAllByTestId("top-agent");
  expect(rows).toHaveLength(2);
  expect(within(rows[0] as HTMLElement).getByTestId("top-agent-wins").textContent).toBe("4");
  expect(rows[0]?.textContent).toContain("4.75 tUSDC");
  expect(
    within(rows[0] as HTMLElement)
      .getByRole("link", { name: /Alice Extractor/ })
      .getAttribute("href"),
  ).toBe("/agents/alice.testnet");
  // An agent with no public profile has no name to show, and says so.
  expect(rows[1]?.textContent).toContain("Unnamed agent");
  expect(rows[1]?.textContent).toContain("Nothing yet");
});

test("metrics_chart_has_a_bar_for_each_day_with_tasks_and_a_table_of_every_day", async () => {
  render(<MetricsView />);
  const chart = await screen.findByTestId("posted-chart");
  expect(within(chart).getAllByTestId("posted-bar")).toHaveLength(5);
  expect(chart.textContent).toContain("9 in all");
  // The table a screen reader reads, one row a day.
  const table = within(chart).getByRole("table");
  expect(within(table).getAllByRole("row")).toHaveLength(15);
  expect(within(table).getAllByRole("row")[9]?.textContent).toBe("2026-10-263");
});

test("metrics_with_no_winner_yet_say_so", async () => {
  answer = () =>
    json({
      ...METRICS,
      paid: [],
      fees: [],
      top_agents: [],
      posted_by_day: days(Array(14).fill(0)),
    });
  render(<MetricsView />);
  await screen.findByTestId("no-top-agents");
  expect(figure("metric-paid")).toContain("Nothing yet");
  expect(figure("metric-fees")).toContain("None yet");
  expect(screen.queryAllByTestId("posted-bar")).toHaveLength(0);
});

test("metrics_say_when_they_cannot_be_read_and_try_again", async () => {
  answer = () => json({ error: "internal", message: "internal error" }, 500);
  render(<MetricsView />);
  const error = await screen.findByTestId("error-state");
  expect(error.textContent).toContain("status 500");
  answer = () => json(METRICS);
  await userEvent.click(within(error).getByRole("button", { name: "Retry" }));
  await screen.findByTestId("metric-open");
});
