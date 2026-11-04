import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { HowItWorksView } from "../components/HowItWorksView";
import { json } from "./accountFakes";

// How it works (components/HowItWorksView.tsx): the explainer, with the fee and the agent bond read
// from the contract's config view through the browser's node (http://rpc.test), never written in.

const TOKEN = "tusdc.tender-team.testnet";

const CONFIG = {
  owner: "owner.testnet",
  pending_owner: null,
  treasury: "treasury.testnet",
  fee_bps: 250,
  min_window_secs: 60,
  max_window_secs: 1_209_600,
  paused: false,
  version: 1,
  tokens: [{ token: TOKEN, min_reward: "1", max_reward: "1000000000000", enabled: true }],
  agent_bond_token: TOKEN,
  agent_bond_amount: "5000000",
  agent_bond_cooldown_secs: "604800",
};

let config: () => Response;
let calls: string[];

/** The node's answer to a view call that returned `value`. */
const viewResult = (value: unknown) =>
  json({
    jsonrpc: "2.0",
    id: "x",
    result: { result: [...new TextEncoder().encode(JSON.stringify(value))], logs: [] },
  });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  calls = [];
  config = () => viewResult(CONFIG);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const { params } = JSON.parse(String(init.body ?? "{}")) as {
      params?: { method_name?: string };
    };
    calls.push(`${url.origin} ${params?.method_name ?? ""}`);
    return config();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("how_it_works_reads_the_fee_and_the_bond_from_the_contract", async () => {
  render(<HowItWorksView />);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("How it works.");
  // The lifecycle stepper, five steps.
  expect(within(screen.getByRole("tablist")).getAllByRole("tab")).toHaveLength(5);

  const fee = screen.getByTestId("fee");
  expect(fee.textContent).toBe("Reading the contract…");
  await within(fee).findByText("2.5%");
  expect(fee.textContent).toBe("2.5% of a reward, taken when it is paid out.");
  expect(screen.getByTestId("bond").textContent).toBe(
    "An agent registers by locking 5.00 tUSDC in the contract, from its own balance.",
  );
  expect(screen.getByTestId("how-bond").textContent).toContain("cooldown (7d)");
  // One read of the config view, from the browser's node.
  expect(calls).toEqual(["http://rpc.test get_config"]);
});

test("how_it_works_says_when_the_contract_takes_no_bond", async () => {
  config = () => viewResult({ ...CONFIG, agent_bond_token: null, agent_bond_amount: null });
  render(<HowItWorksView />);
  await screen.findByText(/registers with no bond/);
});

test("how_it_works_says_when_the_contract_cannot_be_read_and_reads_again", async () => {
  config = () => viewResult({ not: "a config" });
  render(<HowItWorksView />);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Not read from the contract just now.");
  // No figure stands in for the one that could not be read; the bond says it is missing too.
  expect(screen.getByTestId("fee").textContent).not.toMatch(/%/);
  expect(screen.getByTestId("bond").textContent).toBe("Not read from the contract just now.");
  config = () => viewResult(CONFIG);
  await userEvent.click(screen.getByRole("button", { name: "Read again" }));
  await within(screen.getByTestId("fee")).findByText("2.5%");
});

test("how_it_works_makes_no_claim_it_cannot_back_and_names_what_is_ours", async () => {
  const { container } = render(<HowItWorksView />);
  await within(screen.getByTestId("fee")).findByText("2.5%");
  const text = (container.textContent ?? "").toLowerCase();
  for (const word of ["trustless", "provably fair", "private"]) {
    expect(text, word).not.toContain(word);
  }
  // The Judge and the upgrade key are the team's, and the page says so.
  expect(screen.getByTestId("how-verifier").textContent).toContain(
    "the Tender Judge, which we run",
  );
  expect(screen.getByTestId("how-trust").textContent).toContain(
    "The Tender team holds the full-access key of the contract's account",
  );
  // No fee is written into the page: the only percentage is the one read.
  expect(container.textContent?.match(/\d+(?:\.\d+)?%/g)).toEqual(["2.5%"]);
});
