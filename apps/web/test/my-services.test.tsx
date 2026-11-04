import type { Service } from "@tender/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MyAgentsView } from "../components/account/MyAgentsView";
import { keepToken, signInTicket } from "../lib/apiToken";
import { createWalletStore, type WalletStore } from "../lib/wallet";
import { ALICE, accountWallet, row, SCOUT, serve, TOKEN, type World, world } from "./accountFakes";
import { agent } from "./tasks";
import { fakeProvider } from "./walletDoubles";

// The Services section of My agents: the provider's listings, paused ones and all, a pause and a
// resume, and the form that lists a new one, over the account fakes, signed in already (the token
// is in its keeping place, as a sign-in leaves it).

const holder = vi.hoisted(() => ({ store: undefined as unknown as WalletStore }));
vi.mock("../lib/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wallet")>();
  return { ...actual, useWallet: () => actual.useWalletStore(holder.store) };
});

const TOKEN_TEXT = "tok-alice";

function listing(over: Partial<Service> = {}): Service {
  return {
    id: "9",
    provider: ALICE,
    agent: ALICE,
    title: "Extract invoice fields",
    description: "Returns the fields of an invoice as JSON.",
    tags: ["json"],
    category: "extraction",
    output_format: "json",
    token: TOKEN,
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
    agent_record: agent({ account: ALICE }),
    ...over,
  };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

/** Alice, an active agent with a bond, and scout under her, retired: only she can take hires. */
function alicesWorld(): World {
  const state = world();
  state.agents.set(
    ALICE,
    row({
      account: ALICE,
      name: "Alice",
      status: "active",
      bond_token: TOKEN,
      bond_amount: "5000000",
    }),
  );
  state.under.set(ALICE, [
    row({
      account: SCOUT,
      asp: ALICE,
      name: "Scout",
      status: "retired",
      bond_token: null,
      bond_amount: null,
    }),
  ]);
  state.config = {
    owner: "tender.testnet",
    pending_owner: null,
    treasury: "treasury.testnet",
    fee_bps: 500,
    min_window_secs: 60,
    max_window_secs: 1_209_600,
    paused: false,
    version: 1,
    tokens: [{ token: TOKEN, min_reward: "1", max_reward: "1000000000000", enabled: true }],
    agent_bond_token: TOKEN,
    agent_bond_amount: "5000000",
    agent_bond_cooldown_secs: "604800",
  };
  state.services = [
    listing(),
    listing({
      id: "8",
      agent: SCOUT,
      title: "Research suppliers",
      status: "paused",
      available: false,
    }),
  ];
  return state;
}

function open(state: World) {
  serve(state);
  keepToken(
    { accountId: ALICE, token: TOKEN_TEXT, expiresAtMs: Date.now() + 3_600_000 },
    signInTicket(),
  );
  const session = accountWallet(state);
  holder.store = createWalletStore(async () => fakeProvider(session, { restored: true }));
  render(<MyAgentsView />);
  return userEvent.setup();
}

test("the_provider_sees_its_services_paused_ones_too_and_pauses_and_resumes_them", async () => {
  const state = alicesWorld();
  const user = open(state);

  const rows = await screen.findAllByTestId("my-service");
  expect(rows.map((one) => within(one).getByRole("link").textContent)).toEqual([
    "Extract invoice fields",
    "Research suppliers",
  ]);
  expect(rows.map((one) => within(one).getByTestId("my-service-status").textContent)).toEqual([
    "Listed",
    "Paused",
  ]);
  expect(
    within(rows[0] as HTMLElement)
      .getByRole("link")
      .getAttribute("href"),
  ).toBe("/services/9");

  await user.click(within(rows[0] as HTMLElement).getByRole("button", { name: /^Pause/ }));
  await waitFor(() =>
    expect(
      within(screen.getAllByTestId("my-service")[0] as HTMLElement).getByTestId("my-service-status")
        .textContent,
    ).toBe("Paused"),
  );
  expect(state.requests).toContain("POST /v1/services/9");
  expect(state.bodies.at(-1)).toBe('{"status":"paused"}');
  expect(state.serviceAuth).toEqual([`Bearer ${TOKEN_TEXT}`]);

  await user.click(
    within(screen.getAllByTestId("my-service")[1] as HTMLElement).getByRole("button", {
      name: /^Resume/,
    }),
  );
  await waitFor(() => expect(state.bodies.at(-1)).toBe('{"status":"active"}'));
});

test("a_service_is_listed_for_an_agent_that_can_take_hires_with_the_form_held_to_the_rules", async () => {
  const state = alicesWorld();
  const user = open(state);
  await screen.findAllByTestId("my-service");

  await user.click(screen.getByRole("button", { name: "List a service" }));
  const editor = within(await screen.findByTestId("service-editor"));
  // Only the agent that is active and bonded is offered.
  expect(
    within(editor.getByLabelText("Agent"))
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual([ALICE]);
  await waitFor(() =>
    expect(
      within(editor.getByLabelText("Token"))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["tUSDC"]),
  );

  // What a provider is told of the hirer's check: the hirer can take the delivery and not pay.
  expect(editor.getByTestId("hirer-note").textContent).toBe(
    "The hirer sees the delivery before deciding, and can pick nobody: then the agent is not paid and the hirer gets the whole price back. Choose the Judge if you need the check made by someone else.",
  );
  expect(
    editor.getByRole("radio", { name: /The hirer accepts it/ }).getAttribute("aria-describedby"),
  ).toBe(editor.getByTestId("hirer-note").id);

  // Nothing typed: the form says what is missing and sends nothing.
  await user.click(editor.getByRole("button", { name: "List it" }));
  expect(editor.getByText("Give it a title.")).toBeTruthy();
  expect(editor.getByText("Say what the agent does.")).toBeTruthy();
  expect(editor.getByText("Enter an amount.")).toBeTruthy();
  expect(state.serviceAuth).toEqual([]);

  await user.type(editor.getByLabelText("Title"), "Summarise a filing");
  await user.type(editor.getByLabelText("What the agent does"), "Five plain lines on a filing.");
  await user.type(editor.getByLabelText("Tags (optional)"), "research, filings");
  await user.type(editor.getByLabelText("Price"), "1.25");
  await user.click(editor.getByRole("button", { name: "List it" }));

  await waitFor(() => expect(screen.queryByTestId("service-editor")).toBeNull());
  expect(state.serviceAuth).toEqual([`Bearer ${TOKEN_TEXT}`]);
  expect(JSON.parse(state.bodies.at(-1) ?? "{}")).toEqual({
    agent: ALICE,
    title: "Summarise a filing",
    description: "Five plain lines on a filing.",
    tags: ["research", "filings"],
    category: "other",
    output_format: "text",
    token: TOKEN,
    price: "1250000",
    commit_secs: 3_600,
    reveal_secs: 1_800,
    pick_secs: 3_600,
    verification: { kind: "hirer" },
  });
  expect(screen.getAllByTestId("my-service")).toHaveLength(3);
});

test("an_account_whose_agents_cannot_take_hires_is_told_why", async () => {
  const state = alicesWorld();
  state.agents.set(
    ALICE,
    row({
      account: ALICE,
      name: "Alice",
      status: "unregistering",
      bond_token: TOKEN,
      bond_amount: "5000000",
    }),
  );
  state.services = [];
  const user = open(state);
  expect((await screen.findByTestId("no-my-services")).textContent).toBe(
    "You list no services yet.",
  );
  await user.click(screen.getByRole("button", { name: "List a service" }));
  expect((await screen.findByTestId("service-editor")).textContent).toContain(
    "None of your agents can take hires yet",
  );
});
