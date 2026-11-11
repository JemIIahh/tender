import type { Service } from "@tender/shared";

export function apiService(endpoint = "https://asp.example/lookup"): Service {
  return {
    id: "1",
    provider: "provider.testnet",
    agent: "lookup.provider.testnet",
    title: "Tender team inventory API",
    description: "Returns the number of items in the supplied boxes.",
    tags: ["data"],
    category: "other",
    output_format: "json",
    token: "token.testnet",
    price: "1000",
    payment_mode: "x402",
    x402: {
      endpoint,
      network: "near:testnet",
      pay_to: "provider.testnet",
      max_timeout_seconds: 60,
    },
    commit_secs: 0,
    reveal_secs: 0,
    pick_secs: 0,
    verification: { kind: "none" },
    status: "active",
    available: true,
    is_team: true,
    created_at: "2026-11-10T00:00:00.000Z",
    updated_at: "2026-11-10T00:00:00.000Z",
    agent_record: null,
  };
}
