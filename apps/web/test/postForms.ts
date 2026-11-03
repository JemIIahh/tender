import type { PostForm, PostLimits } from "../lib/post";
import { emptyForm } from "../lib/post";

// Filled-in forms of the post wizard for the tests that need one. vitest.config.ts gives the config
// the network testnet, in which `tusdc.*` is the test USDC with six decimals.

export const TOKEN = "tusdc.testnet";
export const JUDGE = "judge.testnet";
/** A line of the held-out checks that must never leave the page except in the held-out upload. */
export const SECRET = "held-out-secret-7f3a";

/** What `get_config` allows: 1 to 1,000 test USDC, windows of a minute to 14 days. */
export const LIMITS: PostLimits = {
  paused: false,
  feeBps: 500,
  minWindowSecs: 60,
  maxWindowSecs: 1_209_600,
  tokens: [{ token: TOKEN, minReward: 1_000_000n, maxReward: 1_000_000_000n }],
};

/** A form for a regex task, with every step filled in. */
export function regexForm(overrides: Partial<PostForm> = {}): PostForm {
  return {
    ...emptyForm({ judgeAccount: JUDGE }),
    title: "Regex for NEAR account ids",
    summary: "Write one regex that tells valid account ids from invalid ones.",
    instructions: "Return the pattern and its flags.\nAnchor it at both ends.",
    category: "coding",
    tags: "Regex, near #validation",
    outputFormat: "regex_json",
    maxBytes: "4096",
    kind: "regex_cases",
    minScore: "100",
    examplesMatch: "alice.near\nbob.testnet",
    examplesNoMatch: "-bad\nUPPER",
    heldoutMatch: `${SECRET}.near\ncarol.near`,
    heldoutNoMatch: "dave..near\n_eve.near",
    token: TOKEN,
    amount: "5",
    ...overrides,
  };
}

export function exactForm(overrides: Partial<PostForm> = {}): PostForm {
  return {
    ...emptyForm({ judgeAccount: JUDGE }),
    title: "Capital of Australia",
    instructions: "Answer with the name of the city.",
    kind: "exact",
    outputFormat: "text",
    expected: "Canberra\nCanberra, ACT",
    lowercase: true,
    token: TOKEN,
    amount: "2.5",
    ...overrides,
  };
}

export function jsonForm(overrides: Partial<PostForm> = {}): PostForm {
  return {
    ...emptyForm({ judgeAccount: JUDGE }),
    title: "Invoice total",
    instructions: "Return the total.",
    kind: "json_schema",
    outputFormat: "json",
    schema: '{"type":"object","required":["total"],"properties":{"total":{"type":"number"}}}',
    assertions: [
      { path: "$.total", equals: "1250.5" },
      { path: "$.lines[0].sku", equals: '"A-1"' },
    ],
    token: TOKEN,
    amount: "10",
    ...overrides,
  };
}

export function rubricForm(overrides: Partial<PostForm> = {}): PostForm {
  return {
    ...emptyForm({ judgeAccount: JUDGE }),
    title: "Write a launch note",
    instructions: "Write a short launch note.",
    kind: "rubric",
    outputFormat: "text",
    minScore: "70",
    rubric: [
      { criterion: "Clear about what changed", weight: "8" },
      { criterion: "Short", weight: "3" },
    ],
    token: TOKEN,
    amount: "20",
    ...overrides,
  };
}
