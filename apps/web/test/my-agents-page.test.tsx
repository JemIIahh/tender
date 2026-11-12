import { cleanup as cleanupAll, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MyAgentsView } from "../components/account/MyAgentsView";
import { clearApiToken, keepToken, signInTicket } from "../lib/apiToken";
import { createWalletStore, type WalletStore } from "../lib/wallet";
import { ALICE, accountWallet, row, SCOUT, serve, TOKEN, type World, world } from "./accountFakes";
import { fakeProvider } from "./walletDoubles";

// My agents, as a provider uses it: the real hook and store over a wallet double, and a fake API.

const holder = vi.hoisted(() => ({ store: undefined as unknown as WalletStore }));
vi.mock("../lib/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wallet")>();
  return { ...actual, useWallet: () => actual.useWalletStore(holder.store) };
});

const OTHER = "5f3a9c0e".repeat(8);
const MAX = "340282366920938463463374607431768211455";
const LONG = `${"u".repeat(50)}.${ALICE}`;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearApiToken();
  sessionStorage.clear();
});

/** Alice's page, her wallet connected (or not), over `state`. */
function open(state: World, connected = true) {
  serve(state);
  const session = accountWallet(state);
  const provider = fakeProvider(session, { restored: connected });
  holder.store = createWalletStore(async () => provider);
  render(<MyAgentsView />);
  return { provider, user: userEvent.setup() };
}

/** Alice is an agent herself, and runs two more under her account. */
function aliceAndHerAgents(bonds = false): World {
  const state = world();
  const bond = (status: string, amount: string, claimable?: string) =>
    bonds
      ? {
          status,
          bond_token: TOKEN,
          bond_amount: amount,
          ...(claimable ? { claimable_at: claimable } : {}),
        }
      : {};
  state.agents.set(
    ALICE,
    row({
      account: ALICE,
      name: "Alice Extractor",
      tags: ["json"],
      entries: 5,
      reveals: 4,
      wins: 1,
      earned: { [TOKEN]: "1900000" },
      ...bond("active", "5000000"),
    }),
  );
  state.under.set(ALICE, [
    row({
      account: SCOUT,
      asp: ALICE,
      name: "Alice Scout",
      entries: 9,
      reveals: 8,
      wins: 2,
      earned: { [TOKEN]: "2850000" },
      ...bond("retired", "5000000"),
    }),
    row({
      account: LONG,
      asp: ALICE,
      name: "u".repeat(64),
      tags: ["a".repeat(24)],
      entries: 4_294_967_295,
      reveals: 4_294_967_295,
      wins: 4_294_967_295,
      earned: { [TOKEN]: MAX, [OTHER]: MAX },
      ...bond("unregistering", "3000000", "1793307169820229000"),
    }),
  ]);
  return state;
}

test("my_agents_asks_to_connect_and_reads_nothing_until_then", async () => {
  const state = aliceAndHerAgents();
  const { user, provider } = open(state, false);

  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
    "My agents. What they entered, won and earned.",
  );
  // The head opens on its headline: no label over it, as the sidebar already says where it is.
  expect(screen.getByRole("banner").textContent?.startsWith("My agents.")).toBe(true);
  // The page is the account's provider (ASP) dashboard, and says what the letters stand for.
  expect(screen.getByRole("banner").textContent).toContain(
    "Your agent service provider (ASP) dashboard: your agents, as their provider.",
  );
  expect(screen.getByRole("status").textContent).toBe("Checking if you're signed in…");
  await screen.findByRole("heading", { name: "You're not signed in" });
  expect(state.requests).toEqual([]);
  // The way to add an agent is offered once there is an account to add it under.
  expect(screen.queryByRole("link", { name: "Add an agent" })).toBeNull();

  await user.click(screen.getByRole("button", { name: "Sign in" }));

  expect(provider.connects).toBe(1);
  // The account's own row and the rows under it come from two reads: wait for all three.
  await waitFor(() => expect(screen.getAllByTestId("my-agent")).toHaveLength(3));
});

test("my_agents_lists_the_account_itself_first_then_the_agents_under_it_with_their_record", async () => {
  const state = aliceAndHerAgents();
  open(state);

  // The account's own row and the rows under it come from two reads: wait for all three.
  await waitFor(() => expect(screen.getAllByTestId("my-agent")).toHaveLength(3));
  const rows = screen.getAllByTestId("my-agent");
  expect(rows.map((one) => within(one).getByTestId("my-agent-account").textContent)).toEqual([
    ALICE,
    SCOUT,
    LONG,
  ]);
  expect(state.requests).toEqual([
    `GET /v1/agents/${ALICE}`,
    `GET /v1/agents?asp=${ALICE}&limit=50`,
    // The provider's services, paused ones and all (components/account/ServicesSection).
    `GET /v1/services?provider=${ALICE}&status=all&limit=50`,
  ]);

  const [alice, scout, long] = rows as [HTMLElement, HTMLElement, HTMLElement];
  expect(within(alice).getByTestId("this-account").textContent).toBe("This account");
  expect(within(scout).queryByTestId("this-account")).toBeNull();
  expect(within(alice).getByRole("link", { name: "Alice Extractor" }).getAttribute("href")).toBe(
    `/agents/${ALICE}`,
  );
  expect(within(alice).getByTestId("entries").textContent).toBe("5");
  expect(within(alice).getByTestId("reveals").textContent).toBe("4");
  expect(within(alice).getByTestId("wins").textContent).toBe("1");
  expect(within(alice).getByTestId("earned").textContent).toBe("1.90 tUSDC");
  expect(within(long).getByTestId("wins").textContent).toBe("4294967295");
  // The token the app knows comes first; the other's amount is in its smallest unit, with its account.
  expect(within(long).getByTestId("earned").textContent).toBe(
    `340282366920938463463374607431768.211455 tUSDC${MAX} ${OTHER}`,
  );

  // The combined record: only what the API counted, added up token by token.
  expect(screen.getByTestId("stat-agents").textContent).toContain("3");
  expect(screen.getByTestId("stat-agents").textContent).toContain("This account and 2 under it");
  expect(screen.getByTestId("stat-wins").textContent).toContain(String(1 + 2 + 4_294_967_295));
  expect(screen.getByTestId("stat-earned").textContent).toContain(
    "340282366920938463463374607431772.961455 tUSDC",
  );

  // Today's API has no bond: the agents are "Registered", and no bond or bond total is made up.
  for (const one of rows)
    expect(within(one).getByTestId("status").textContent).toBe("Status: Registered");
  expect(screen.queryByTestId("bond")).toBeNull();
  expect(screen.queryByTestId("stat-bonds")).toBeNull();
  expect(screen.getByRole("link", { name: "Add an agent" }).getAttribute("href")).toBe(
    "/my-agents/new",
  );
});

test("the_bond_fields_show_each_agents_status_and_bond_when_the_api_sends_them", async () => {
  open(aliceAndHerAgents(true));

  await waitFor(() => expect(screen.getAllByTestId("my-agent")).toHaveLength(3));
  const [alice, scout, long] = screen.getAllByTestId("my-agent") as [
    HTMLElement,
    HTMLElement,
    HTMLElement,
  ];
  expect(within(alice).getByTestId("status").textContent).toBe("Status: Active");
  expect(within(scout).getByTestId("status").textContent).toBe("Status: Retired");
  expect(within(long).getByTestId("status").textContent).toBe("Status: Unregistering");
  expect(within(alice).getByTestId("bond").textContent).toContain("5.00 tUSDC");
  expect(within(scout).getByTestId("bond").textContent).toContain("Claimed back in full");
  const claimable = within(long).getByTestId("bond").querySelector("time");
  expect(claimable?.getAttribute("datetime")).toBe(new Date(1_793_307_169_820).toISOString());
  // The bonds locked: the active and the unregistering agent's, not the retired one's.
  expect(screen.getByTestId("stat-bonds").textContent).toContain("8.00 tUSDC");
  // The client has no call to retire an agent or claim its bond yet: no button offers one.
  expect(screen.queryByRole("button", { name: /retire|claim/i })).toBeNull();
});

test("an_account_with_no_agents_is_shown_the_way_to_add_one", async () => {
  open(world());
  const empty = await screen.findByTestId("no-agents");
  expect(within(empty).getByText("No agents yet")).toBeTruthy();
  expect(within(empty).getByRole("link", { name: "Add an agent" }).getAttribute("href")).toBe(
    "/my-agents/new",
  );
  expect(screen.queryByTestId("stat-agents")).toBeNull();
});

test("a_read_that_fails_says_so_and_retry_reads_again", async () => {
  const state = aliceAndHerAgents();
  state.failing.add("/v1/agents");
  const { user } = open(state);

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Retry");
  state.failing.clear();
  await user.click(within(alert).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getAllByTestId("my-agent")).toHaveLength(3));
});

// ---- Agents set up as separate accounts ---------------------------------------------------------

const SOLO = "ab".repeat(32);
const LONE = "cd".repeat(32);

/** Alice's two agents on separate accounts: one registered, one never funded. */
function withImplicit(state: World): World {
  state.implicit = [
    {
      id: "SOLOSOLOSOLOSOLOSOLO01",
      account_id: SOLO,
      name: "solo",
      created_at: "2026-11-05T10:00:00.000Z",
      agent: { status: "active", bond_token: TOKEN, bond_amount: "5000000" },
    } as World["implicit"][number],
    {
      id: "LONELONELONELONELONE01",
      account_id: LONE,
      name: "lone",
      created_at: "2026-11-05T09:00:00.000Z",
      agent: null,
    } as World["implicit"][number],
  ];
  return state;
}

const signedIn = () =>
  keepToken(
    { accountId: ALICE, token: "tok-alice", expiresAtMs: Date.now() + 3_600_000 },
    signInTicket(),
  );

test("agents_set_up_as_separate_accounts_are_listed_once_signed_in_and_said_to_be_unlinked", async () => {
  const state = withImplicit(aliceAndHerAgents());
  signedIn();
  open(state);
  const list = await screen.findByTestId("implicit-agents");
  expect(within(list).getByText("Set up by you, not linked on chain")).toBeTruthy();
  const rows = within(list).getAllByTestId("implicit-agent");
  expect(rows.map((one) => within(one).getByRole("link").getAttribute("href"))).toEqual([
    `/agents/${SOLO}`,
    `/agents/${LONE}`,
  ]);
  expect(rows[0]?.textContent).toContain("Active");
  // A registered agent cannot be dismissed; one that never registered can.
  expect(within(rows[0] as HTMLElement).queryByRole("button", { name: "Dismiss" })).toBeNull();
  expect(rows[1]?.textContent).toContain("Not registered yet");
  // The list of agents under her is still the provider's own, from the index.
  expect(screen.getAllByTestId("my-agent")).toHaveLength(3);
});

test("an_agent_nothing_reached_is_dismissed_and_one_that_got_anything_is_kept", async () => {
  const state = withImplicit(aliceAndHerAgents());
  // Its storage reached Tender: the record is the only link to it, so it stays.
  state.storage.add(LONE);
  signedIn();
  const { user } = open(state);
  const lone = (await screen.findAllByTestId("implicit-agent"))[1] as HTMLElement;
  await user.click(within(lone).getByRole("button", { name: "Dismiss" }));
  expect((await within(lone).findByTestId("implicit-agent-note")).textContent).toBe(
    "Something already reached this account, so its record is kept.",
  );
  expect(state.requests.some((request) => request.endsWith("/dismiss"))).toBe(false);

  // Nothing reached it: it goes, and the list is read again.
  state.storage.delete(LONE);
  await user.click(within(lone).getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(screen.getAllByTestId("implicit-agent")).toHaveLength(1));
  expect(state.requests).toContain("POST /v1/connect/codes/LONELONELONELONELONE01/dismiss");
  expect(state.implicit.map((entry) => entry.account_id)).toEqual([SOLO]);
});

test("the_sign_in_line_shows_only_where_it_can_find_something", async () => {
  // Signed out, and this tab never saw a separate account set up: nothing is offered, and nothing
  // is read.
  const state = world();
  open(state);
  await screen.findByTestId("no-agents");
  expect(screen.queryByTestId("implicit-agents-signin")).toBeNull();
  expect(state.requests.filter((request) => request.includes("/v1/connect/"))).toEqual([]);

  // This tab saw one set up: the sign-in line is offered.
  cleanupAll();
  sessionStorage.setItem(`tender.connect.implicit.${ALICE}`, "1");
  open(world());
  expect((await screen.findByTestId("implicit-agents-signin")).textContent).toContain(
    "Sign in to Tender to list them",
  );

  // Signed in with nothing set up that way: nothing more is shown.
  cleanupAll();
  sessionStorage.clear();
  signedIn();
  const empty = world();
  open(empty);
  await screen.findByTestId("no-agents");
  await waitFor(() => expect(empty.requests).toContain("GET /v1/connect/implicit"));
  expect(screen.queryByTestId("implicit-agents")).toBeNull();
  expect(screen.queryByTestId("implicit-agents-signin")).toBeNull();
});

test("a_sign_in_that_ended_offers_a_new_one_and_a_failed_read_says_so_with_retry", async () => {
  // The API no longer takes the tab's token: the sign-in line, not silence.
  const state = withImplicit(world());
  state.implicitStatus = 401;
  signedIn();
  open(state);
  expect((await screen.findByTestId("implicit-agents-signin")).textContent).toContain(
    "Your sign-in to Tender has ended",
  );

  // The API is away: one line, with Retry, which reads again.
  cleanupAll();
  const away = withImplicit(world());
  away.implicitStatus = 500;
  signedIn();
  const { user } = open(away);
  const error = await screen.findByTestId("implicit-agents-error");
  expect(error.textContent).toContain("Couldn't list the agents you set up as separate accounts.");
  expect(error.textContent).not.toContain("a server's words");
  away.implicitStatus = null;
  await user.click(within(error).getByRole("button", { name: "Retry" }));
  expect(await screen.findByTestId("implicit-agents")).toBeTruthy();
});
