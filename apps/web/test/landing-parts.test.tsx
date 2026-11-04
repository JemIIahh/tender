import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DitherArt } from "../components/landing/DitherArt";
import { Stepper } from "../components/landing/Stepper";
import { Ticker } from "../components/landing/Ticker";
import { TypedCode } from "../components/landing/TypedCode";
import { Dither, INKS, type Scene, showAt } from "../lib/dither";
import { factItems, liveItems } from "../lib/ticker";
import { agent, detail, HASH_C, summary, TOKEN, VERIFIER } from "./tasks";

// The landing's parts (components/landing, lib/dither.ts, lib/ticker.ts): what the ticker shows
// from the API and when it can't, the stepper, the typed code, and the art that has to stop when
// it isn't seen. The page itself is in landing.test.tsx.

// No jest-dom here (X-20): plain assertions on what the Testing Library finds.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A `fetch` that answers by the address's path and query, and fails anything else. */
function fakeApi(routes: Record<string, () => Response>): string[] {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    urls.push(`${url.pathname}${url.search}`);
    const answer = routes[`${url.pathname}${url.search}`] ?? routes[url.pathname];
    if (answer === undefined) throw new TypeError("Failed to fetch");
    return answer();
  });
  return urls;
}

/** The API down: every request fails before it is answered. */
const apiDown = () =>
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("Failed to fetch");
  });

/** `matchMedia` that says whether reduced motion is asked for. */
function reducedMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  // jsdom has no canvas: a page with art draws nothing, unless a test gives it a context.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---- The ticker ---------------------------------------------------------------------------------

test("ticker_shows_only_facts_and_no_figures_when_the_api_cannot_answer", async () => {
  apiDown();
  render(<Ticker />);

  const strip = screen.getByRole("region", { name: "Tender right now" });
  await waitFor(() =>
    expect(within(strip).getAllByTestId("ticker-fact").length).toBeGreaterThan(0),
  );
  // Give the failed reads time to land: they leave nothing behind.
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));

  expect(within(strip).queryAllByTestId("ticker-live")).toEqual([]);
  expect(strip.textContent).toContain("Held-out checksPublished by the Judge");
  expect(strip.textContent).not.toMatch(/\d/);
});

test("ticker_reads_its_figures_from_the_api", async () => {
  const open = [
    summary({ id: "7", reward: "1500000" }),
    summary({ id: "8", reward: "500000", is_team_poster: false }),
  ];
  const settled = summary({ id: "5", phase: "settled", outcome_kind: "picked" });
  const urls = fakeApi({
    "/v1/tasks?phase=open&limit=50": () => json({ tasks: open, next_cursor: null }),
    "/v1/tasks?phase=settled&limit=20": () => json({ tasks: [settled], next_cursor: null }),
    "/v1/tasks/5": () =>
      json(
        detail({
          id: "5",
          phase: "settled",
          outcome_kind: "picked",
          outcome: {
            kind: "picked",
            task_id: "5",
            by: VERIFIER,
            winners: [
              { account: "alice.testnet", bps: 6000, amount: "855000" },
              { account: "bob.testnet", bps: 4000, amount: "570000" },
            ],
            fee: "75000",
            scorecard_hash: HASH_C,
            scorecard_uri: "http://api.test/v1/blobs/scorecard",
          },
        }),
      ),
    "/v1/agents?limit=50": () =>
      json({ agents: [agent(), agent({ account: "bob.testnet" })], next_cursor: null }),
    "/v1/health": () =>
      json({
        ok: true,
        network: "testnet",
        contract: "tender.testnet",
        indexed_height: "100",
        chain_final_height: "100",
        lag_blocks: "0",
        waiting_for_chain: false,
      }),
  });
  render(<Ticker />);

  const strip = screen.getByRole("region", { name: "Tender right now" });
  await waitFor(() => expect(within(strip).getAllByTestId("ticker-live").length).toBe(5 * 2));
  const live = within(strip)
    .getAllByTestId("ticker-live")
    .slice(0, 5)
    .map((item) => item.textContent);
  expect(live).toEqual([
    "Open tasks2",
    "In escrow on open tasks2.00 tUSDC",
    "Agents2",
    "Recent payout · task 51.425 tUSDC",
    "Indexin sync",
  ]);
  // Only reads: nothing is written to the API.
  expect(urls.every((url) => url.startsWith("/v1/"))).toBe(true);
});

test("ticker_figures_are_exact_or_say_they_are_a_floor", () => {
  const items = (data: Parameters<typeof liveItems>[0]) =>
    Object.fromEntries(liveItems(data, "testnet").map((item) => [item.key, item.value]));

  // A page with more after it: the count is a floor, and no sum is given for part of the tasks.
  const full = Array.from({ length: 50 }, (_, i) => summary({ id: String(i + 1) }));
  expect(items({ open: { tasks: full, next_cursor: "1" } })).toEqual({ open: "50+" });
  expect(items({ agents: { agents: [agent()], next_cursor: "alice.testnet" } }).agents).toBe("1+");

  // A token whose decimals the app does not know is not summed in its smallest unit.
  const odd = summary({ id: "9", token: "odd.testnet", reward: "12" });
  expect(items({ open: { tasks: [summary(), odd], next_cursor: null } }).escrow).toBe(
    "1.50 tUSDC + OTHER TOKENS",
  );
  expect(items({ open: { tasks: [odd], next_cursor: null } }).escrow).toBeUndefined();
  // No open tasks: a count of 0, and no escrow line.
  expect(items({ open: { tasks: [], next_cursor: null } })).toEqual({ open: "0" });

  const health = (lag: string, waiting = false) => ({
    ok: true as const,
    network: "testnet",
    contract: "tender.testnet",
    indexed_height: "90",
    chain_final_height: "102",
    lag_blocks: lag,
    waiting_for_chain: waiting,
  });
  expect(items({ health: health("12") }).index).toBe("12 blocks behind");
  // While the services wait for the chain, a lag of 0 does not mean the index is in sync.
  expect(items({ health: health("0", true) }).index).toBe("waiting for the chain");
  expect(items({ payout: { taskId: "3", token: TOKEN, amount: 2_000_000n } }).payout).toBe(
    "2.00 tUSDC",
  );
  expect(liveItems({}, "testnet")).toEqual([]);
});

test("ticker_facts_name_the_network_of_the_build", () => {
  expect(factItems("mainnet").find((item) => item.key === "network")?.value).toBe("NEAR mainnet");
  expect(factItems("testnet").every((item) => !item.live)).toBe(true);
});

// ---- The stepper --------------------------------------------------------------------------------

test("stepper_shows_the_step_a_person_picks_with_its_fields", async () => {
  const user = userEvent.setup();
  render(<Stepper />);

  const tabs = screen.getAllByRole("tab");
  expect(tabs.map((tab) => tab.textContent)).toEqual([
    "Posted",
    "Sealed",
    "Revealed",
    "Judged",
    "Paid",
  ]);
  const panel = screen.getByTestId("step-panel");
  expect(panel.textContent).toContain("In escrow");
  expect(panel.textContent).toContain("Commit · reveal · pick");
  expect(panel.textContent).toContain("Judge or poster");

  await user.click(screen.getByRole("tab", { name: "Judged" }));
  expect(screen.getByRole("tab", { name: "Judged" }).getAttribute("aria-selected")).toBe("true");
  expect(panel.textContent).toContain("Public + held-out");
  expect(panel.getAttribute("aria-labelledby")).toBe(
    screen.getByRole("tab", { name: "Judged" }).id,
  );

  // The arrow keys move along the steps and take the focus with them.
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement?.textContent).toBe("Paid");
  // A pick pays the platform fee to the treasury (contract/tender/src/settle.rs, `split_reward`).
  expect(panel.textContent).toContain("less the platform fee");
  expect(panel.textContent).toContain("Set by the contract");
  expect(panel.textContent).toContain("Refunded in full");
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement?.textContent).toBe("Posted");
});

// ---- The typed code ---------------------------------------------------------------------------

test("typed_code_uses_the_mcp_servers_real_tool_and_field_names", () => {
  reducedMotion(true);
  const { container } = render(<TypedCode />);
  const code = container.querySelector("pre")?.textContent ?? "";

  const tools = readFileSync(
    join(import.meta.dirname, "../../../packages/mcp/src/tools/write.ts"),
    "utf8",
  );
  for (const name of [
    "commit_result",
    "reveal_result",
    "task_id",
    "content",
    "commitment",
    "reveal_opens_at",
    "uri",
    "tx_hash",
  ]) {
    expect(code, name).toContain(name);
    expect(tools, name).toContain(name);
  }
});

test("typed_code_is_whole_and_still_with_reduced_motion_and_types_itself_otherwise", () => {
  vi.useFakeTimers();
  reducedMotion(true);
  const still = render(<TypedCode />);
  const whole = still.container.querySelector("pre")?.textContent;
  act(() => vi.advanceTimersByTime(2000));
  expect(still.container.querySelector("pre")?.textContent).toBe(whole);
  expect(still.container.querySelector(".caret")).toBeNull();
  still.unmount();

  reducedMotion(false);
  const moving = render(<TypedCode />);
  // The block keeps its size from the start: what is not typed yet is there, unseen.
  const shown = () =>
    [...moving.container.querySelectorAll("pre span:not(.invisible):not(.caret)")]
      .filter((span) => span.children.length === 0)
      .map((span) => span.textContent)
      .join("");
  expect(shown()).toBe("");
  act(() => vi.advanceTimersByTime(1500));
  expect(shown().length).toBeGreaterThan(0);
  expect(whole?.startsWith(shown())).toBe(true);
  expect(moving.container.querySelector(".caret")).not.toBeNull();
});

// ---- The art ------------------------------------------------------------------------------------

/** A 2D context that keeps what is drawn, enough for the art. */
function fakeContext() {
  const context = {
    puts: 0,
    createImageData: (width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    }),
    putImageData: () => {
      context.puts++;
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  return context;
}

test("art_draws_one_still_frame_and_never_runs_with_reduced_motion", () => {
  reducedMotion(true);
  const context = fakeContext();
  const frame = vi.fn(() => 1);
  vi.stubGlobal("requestAnimationFrame", frame);
  vi.stubGlobal("cancelAnimationFrame", () => {});

  render(<DitherArt art="hero" wide={{ x: 0.5, y: 0.5, scale: 0.4 }} />);

  expect(context.puts).toBeGreaterThan(0);
  expect(frame).not.toHaveBeenCalled();
});

test("art_runs_while_seen_and_stops_when_the_tab_is_hidden", () => {
  reducedMotion(false);
  fakeContext();
  const frame = vi.fn(() => 7);
  const cancel = vi.fn();
  vi.stubGlobal("requestAnimationFrame", frame);
  vi.stubGlobal("cancelAnimationFrame", cancel);
  let visibility: DocumentVisibilityState = "visible";
  vi.spyOn(Document.prototype, "visibilityState", "get").mockImplementation(() => visibility);

  const { unmount } = render(<DitherArt art="escrow" wide={{ x: 0.5, y: 0.5, scale: 0.4 }} />);
  expect(frame).toHaveBeenCalledTimes(1);

  visibility = "hidden";
  fireEvent(document, new Event("visibilitychange"));
  expect(cancel).toHaveBeenCalledWith(7);

  visibility = "visible";
  fireEvent(document, new Event("visibilitychange"));
  expect(frame).toHaveBeenCalledTimes(2);

  unmount();
  expect(cancel).toHaveBeenCalledTimes(2);
});

test("dither_lights_what_a_scene_lights_in_its_ink_and_leaves_the_rest_clear", () => {
  const flat = (l: number, a: number): Scene => ({
    frame: () => {},
    shade: (_u, _v, out) => {
      out.l = l;
      out.a = a;
    },
  });
  const dither = new Dither(16, 16);
  const focus = { x: 0.5, y: 0.5, scale: 0.5 };

  dither.draw(flat(1, 0), focus);
  expect(new Set(dither.pixels)).toEqual(new Set([INKS.bone[31]]));
  dither.draw(flat(1, 1), focus);
  expect(new Set(dither.pixels)).toEqual(new Set([INKS.seal[31]]));
  // Half lit: about half the pixels, as the Bayer matrix spreads them.
  dither.draw(flat(0.5, 0), focus);
  const lit = dither.pixels.filter((pixel) => pixel !== 0).length;
  expect(lit / dither.pixels.length).toBeGreaterThan(0.45);
  expect(lit / dither.pixels.length).toBeLessThan(0.6);

  // A change of scene: all of the old one at the start, all of the new one at the end.
  dither.draw(flat(1, 1), focus, { from: flat(1, 0), mix: 0 });
  expect(new Set(dither.pixels)).toEqual(new Set([INKS.bone[31]]));
  dither.draw(flat(1, 1), focus, { from: flat(1, 0), mix: 1 });
  expect(new Set(dither.pixels)).toEqual(new Set([INKS.seal[31]]));
});

test("a_show_holds_each_scene_then_changes_to_the_next_and_loops", () => {
  // Three scenes, each held 5 s, with changes of 1 s.
  expect(showAt(-1, 3, 5, 1)).toEqual({ index: 0, time: 0, mix: 1 });
  expect(showAt(2, 3, 5, 1)).toEqual({ index: 0, time: 3, mix: 1 });
  const changing = showAt(5.5, 3, 5, 1);
  expect(changing.index).toBe(1);
  expect(changing.from).toEqual({ index: 0, time: 6.5 });
  expect(changing.time).toBeCloseTo(0.5);
  expect(changing.mix).toBeCloseTo(0.5);
  // The last scene changes back to the first.
  expect(showAt(17.5, 3, 5, 1).index).toBe(0);
  expect(showAt(17.5, 3, 5, 1).from?.index).toBe(2);
  expect(showAt(18, 3, 5, 1)).toEqual({ index: 0, time: 1, mix: 1 });
  // One scene simply runs.
  expect(showAt(42, 1, 5, 1)).toEqual({ index: 0, time: 42, mix: 1 });
});
