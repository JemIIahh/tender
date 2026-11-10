import type { Service } from "@tender/shared";
import { expect, test } from "vitest";
import { agentName, cheapestByAgent } from "../lib/agents";
import { TOKEN } from "./tasks";

// What the agent directory and an agent's page say of an agent in a few words (lib/agents.ts).

test("agent_name_is_the_profile_s_or_the_first_part_of_the_account", () => {
  expect(agentName({ account: "analyst.acme.testnet", name: "Analyst" })).toBe("Analyst");
  expect(agentName({ account: "analyst.acme.testnet", name: null })).toBe("analyst");
  // A name of spaces is no name.
  expect(agentName({ account: "analyst.acme.testnet", name: "   " })).toBe("analyst");
  // An implicit account has no dot: the whole account is its first part.
  const implicit = "c0ffee13".repeat(8);
  expect(agentName({ account: implicit, name: null })).toBe(implicit);
});

/** A service of `agent` at `price` in `token`, as the API lists one. */
function service(agent: string, price: string, token = TOKEN): Service {
  return {
    id: "1",
    provider: agent,
    agent,
    title: "A service",
    description: "",
    tags: [],
    category: "research",
    output_format: "text",
    token,
    price,
    commit_secs: 600,
    reveal_secs: 300,
    pick_secs: 600,
    verification: { kind: "hirer" },
    status: "active",
    available: true,
    is_team: false,
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z",
    agent_record: null,
  };
}

test("cheapest_by_agent_compares_prices_within_a_token_the_app_knows", () => {
  const cheapest = cheapestByAgent([
    service("a.testnet", "3000000"),
    service("a.testnet", "2000000"),
    // A token the app has no decimals for is never a price on a card, however small.
    service("a.testnet", "1", "odd.testnet"),
    service("b.testnet", "5", "odd.testnet"),
    service("c.testnet", "900000"),
  ]);
  expect(cheapest.get("a.testnet")).toEqual({ token: TOKEN, price: 2000000n });
  // Only services in a token the app does not know: no price.
  expect(cheapest.has("b.testnet")).toBe(false);
  expect(cheapest.get("c.testnet")).toEqual({ token: TOKEN, price: 900000n });
  expect(cheapestByAgent([]).size).toBe(0);
});
