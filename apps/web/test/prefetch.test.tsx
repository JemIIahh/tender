import type { Service } from "@tender/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { AgentCard } from "../components/AgentCard";
import { ProviderCard } from "../components/ProviderCard";
import { ServiceCard } from "../components/ServiceCard";
import { TaskCard } from "../components/TaskCard";
import { groupProviders } from "../lib/providers";
import { agent, summary } from "./tasks";

// A card fetches its page ahead the first time the pointer comes onto it or the focus comes into
// it, and once only (lib/prefetch.ts). The router is the app's, given here as its context gives it.

afterEach(() => {
  vi.restoreAllMocks();
});

function withRouter(children: ReactNode) {
  const prefetch = vi.fn();
  const router = { prefetch, push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn() };
  render(
    <AppRouterContext.Provider value={router as never}>
      <ul>{children}</ul>
    </AppRouterContext.Provider>,
  );
  return prefetch;
}

/** The pointer onto the card, off it, onto it again, and the focus into its link. */
function showInterest(card: HTMLElement) {
  fireEvent.pointerEnter(card);
  fireEvent.pointerLeave(card);
  fireEvent.pointerEnter(card);
  card.querySelector("a")?.focus();
}

test("a_task_card_fetches_its_page_ahead_once_when_the_pointer_or_the_focus_comes", () => {
  const prefetch = withRouter(<TaskCard task={summary({ id: "7" })} nowNs={0n} />);
  const card = screen.getByTestId("task-card");
  expect(prefetch).not.toHaveBeenCalled();

  fireEvent.pointerEnter(card);
  // The whole route, not only as far as its loading.tsx.
  expect(prefetch).toHaveBeenCalledWith("/tasks/7", { kind: "full" });
  showInterest(card);
  expect(prefetch).toHaveBeenCalledTimes(1);
});

test("a_task_card_fetches_its_page_ahead_from_the_keyboard_too", () => {
  const prefetch = withRouter(<TaskCard task={summary({ id: "9" })} nowNs={0n} />);
  screen.getByTestId("task-card").querySelector("a")?.focus();
  expect(prefetch).toHaveBeenCalledWith("/tasks/9", { kind: "full" });
  expect(prefetch).toHaveBeenCalledTimes(1);
});

/** A service of writer.acme.testnet, as the API lists one. */
function service(): Service {
  return {
    id: "4",
    provider: "acme.testnet",
    agent: "writer.acme.testnet",
    title: "Summarise a public filing",
    description: "Reads a filing and returns five lines.",
    tags: ["research"],
    category: "research",
    output_format: "text",
    token: "tusdc.testnet",
    price: "2500000",
    commit_secs: 3_600,
    reveal_secs: 1_800,
    pick_secs: 3_600,
    verification: { kind: "hirer" },
    status: "active",
    available: true,
    is_team: false,
    created_at: "2026-11-04T09:00:00.000Z",
    updated_at: "2026-11-04T09:00:00.000Z",
    agent_record: null,
  };
}

test("agent_provider_and_service_cards_fetch_their_pages_ahead_once", () => {
  const writer = agent({ account: "writer.acme.testnet", asp: "acme.testnet" });
  const [provider] = groupProviders([writer]);
  if (provider === undefined) throw new Error("acme.testnet is a provider");
  const cards: Array<[ReactNode, string, string]> = [
    [<AgentCard key="agent" agent={writer} />, "agent-card", "/agents/writer.acme.testnet"],
    [
      <ProviderCard key="provider" provider={provider} />,
      "provider-card",
      "/providers/acme.testnet",
    ],
    [<ServiceCard key="service" service={service()} />, "service-card", "/services/4"],
  ];
  for (const [element, testId, href] of cards) {
    const prefetch = withRouter(element);
    showInterest(screen.getByTestId(testId));
    expect(prefetch.mock.calls, testId).toEqual([[href, { kind: "full" }]]);
    cleanup();
  }
});

test("a_card_outside_the_app_s_router_fetches_nothing_and_does_not_fail", () => {
  render(
    <ul>
      <TaskCard task={summary({ id: "7" })} nowNs={0n} />
    </ul>,
  );
  const card = screen.getByTestId("task-card");
  expect(() => showInterest(card)).not.toThrow();
});
