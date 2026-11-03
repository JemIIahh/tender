import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import Landing from "../app/page";

// The landing (app/page.tsx): what it says Tender is, where its links go, and what it never says.
// Its parts are in landing-parts.test.tsx.

// No jest-dom here (X-20): plain assertions on what the Testing Library finds.

/** The API down: every request fails before it is answered. */
const apiDown = () =>
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("Failed to fetch");
  });

beforeEach(() => {
  // jsdom has no canvas: the art draws nothing.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("landing_says_what_tender_is_and_its_links_lead_to_real_pages", async () => {
  apiDown();
  render(<Landing />);

  const title = screen.getByRole("heading", { level: 1 });
  expect(title.textContent).toBe("Post a task.Agents compete.The contract pays.");

  const hrefs = (name: string) =>
    screen.getAllByRole("link", { name }).map((link) => link.getAttribute("href"));
  expect(new Set(hrefs("Post a task"))).toEqual(new Set(["/post"]));
  expect(hrefs("Browse tasks")).toEqual(["/tasks"]);
  expect(hrefs("Find a task")).toEqual(["/tasks"]);
  expect(hrefs("See the records")).toEqual(["/agents"]);
  expect(hrefs("Connect wallet")).toEqual(["/wallet"]);
  expect(screen.getByRole("link", { name: /Explore tasks/ }).getAttribute("href")).toBe("/tasks");
  expect(screen.getByRole("link", { name: /Explore agents/ }).getAttribute("href")).toBe("/agents");

  // Every link stays in the app, on a page that exists.
  const pages = new Set(["/", "/tasks", "/agents", "/post", "/wallet", "/telegram"]);
  for (const link of screen.getAllByRole("link")) {
    expect(pages.has(link.getAttribute("href") ?? ""), link.textContent ?? "").toBe(true);
  }

  // The honesty line about what the team runs.
  expect(screen.getByRole("contentinfo").textContent).toContain("Run by Tender team");
  await waitFor(() => expect(screen.getAllByTestId("ticker-fact").length).toBeGreaterThan(0));
});

test("landing_never_makes_claims_it_cannot_back", () => {
  apiDown();
  const { container } = render(<Landing />);
  const text = (container.textContent ?? "").toLowerCase();
  for (const word of ["trustless", "provably fair", "private"]) {
    expect(text, word).not.toContain(word);
  }
});
