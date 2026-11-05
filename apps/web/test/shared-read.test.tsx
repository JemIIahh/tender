import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { LiveStatus } from "../components/LiveStatus";
import { Ticker } from "../components/landing/Ticker";
import { sharedRead } from "../lib/sharedRead";
import { agent, summary } from "./tasks";

// One read of the platform's figures for the tab (lib/sharedRead.ts, `liveReads` in lib/live.ts):
// the landing's ticker and the top bar's Live pill used to read the same three things each, and a
// move from the landing into the app read them again at once.

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A read that answers when told to, counting how many times it was made. */
function slowRead() {
  const answers: Array<(value: number) => void> = [];
  const read = vi.fn(
    () =>
      new Promise<number>((resolve) => {
        answers.push(resolve);
      }),
  );
  return { read, answer: (value: number) => answers.shift()?.(value) };
}

test("shared_read_is_made_once_for_everyone_who_listens_at_the_same_time", async () => {
  const { read, answer } = slowRead();
  const shared = sharedRead(read, 60_000);
  const first: number[] = [];
  const second: number[] = [];
  const stopFirst = shared.subscribe((value) => first.push(value));
  const stopSecond = shared.subscribe((value) => second.push(value));
  expect(read).toHaveBeenCalledTimes(1);

  await act(async () => answer(7));
  expect(first).toEqual([7]);
  expect(second).toEqual([7]);
  stopFirst();
  stopSecond();
});

test("shared_read_hands_a_late_listener_what_was_read_less_than_a_minute_ago", async () => {
  vi.useFakeTimers();
  const { read, answer } = slowRead();
  const shared = sharedRead(read, 60_000);
  const stop = shared.subscribe(() => {});
  await act(async () => answer(1));
  stop();

  // Half a minute later, another part listens: it is given the value at once, and nothing is read.
  await vi.advanceTimersByTimeAsync(30_000);
  const late: number[] = [];
  const stopLate = shared.subscribe((value) => late.push(value));
  expect(late).toEqual([1]);
  expect(read).toHaveBeenCalledTimes(1);

  // A minute after the read, it is read again, for whoever is listening.
  await vi.advanceTimersByTimeAsync(30_000);
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => answer(2));
  expect(late).toEqual([1, 2]);
  stopLate();

  // Nobody listens: no more reads, however long.
  await vi.advanceTimersByTimeAsync(600_000);
  expect(read).toHaveBeenCalledTimes(2);

  // One who comes after the minute has passed gets a fresh read, not the old value.
  const after: number[] = [];
  shared.subscribe((value) => after.push(value));
  expect(read).toHaveBeenCalledTimes(3);
  expect(after).toEqual([]);
  await act(async () => answer(3));
  expect(after).toEqual([3]);
  shared.clear();
});

test("shared_read_is_not_made_again_while_the_tab_is_hidden", async () => {
  vi.useFakeTimers();
  const { read, answer } = slowRead();
  const shared = sharedRead(read, 60_000);
  shared.subscribe(() => {});
  await act(async () => answer(1));

  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await vi.advanceTimersByTimeAsync(180_000);
  expect(read).toHaveBeenCalledTimes(1);
  visibility.mockReturnValue("visible");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(read).toHaveBeenCalledTimes(2);
  shared.clear();
});

test("shared_read_that_throws_is_tried_again_and_never_stops_for_good", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  let calls = 0;
  const read = vi.fn(async () => {
    calls += 1;
    if (calls === 1) throw new Error("the API is down");
    return calls;
  });
  const shared = sharedRead(read, 60_000);
  const seen: number[] = [];
  shared.subscribe((value) => seen.push(value));
  await act(async () => {});
  expect(seen).toEqual([]);

  // A minute later it is read again, and that one is handed on.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(read).toHaveBeenCalledTimes(2);
  expect(seen).toEqual([2]);
  shared.clear();
});

// ---- The ticker and the pill ------------------------------------------------------------------

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

const HEALTH = {
  ok: true,
  network: "testnet",
  contract: "tender.testnet",
  indexed_height: "100",
  chain_final_height: "100",
  lag_blocks: "0",
  waiting_for_chain: false,
};

test("the_live_pill_shows_at_once_what_the_landing_s_ticker_read_and_reads_nothing_again", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const path = `${url.pathname}${url.search}`;
    urls.push(path);
    if (path === "/v1/tasks?phase=open&limit=50") {
      return json({ tasks: [summary({ id: "7", reward: "1500000" })], next_cursor: null });
    }
    if (path === "/v1/agents?limit=50") return json({ agents: [agent()], next_cursor: null });
    if (path === "/v1/health") return json(HEALTH);
    if (path === "/v1/tasks?phase=settled&limit=20") return json({ tasks: [], next_cursor: null });
    throw new TypeError("Failed to fetch");
  });

  // The landing: the ticker reads the three, and the recent payout of its own.
  const landing = render(<Ticker />);
  const strip = screen.getByRole("region", { name: "Tender right now" });
  await waitFor(() =>
    expect(within(strip).getAllByTestId("ticker-live")[0]?.textContent).toBe("Open tasks1"),
  );
  const shared = ["/v1/tasks?phase=open&limit=50", "/v1/agents?limit=50", "/v1/health"];
  for (const path of shared) expect(urls.filter((url) => url === path)).toHaveLength(1);

  // Into the app: the pill has the figures at once, and the three are not read again.
  landing.unmount();
  render(<LiveStatus />);
  expect(screen.getByRole("button", { name: "Status: Live" })).toBeTruthy();
  await act(async () => {});
  for (const path of shared) expect(urls.filter((url) => url === path)).toHaveLength(1);
});
