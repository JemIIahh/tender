import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  AddAgentView,
  createAccountCommand,
  initCommand,
  REGISTER_COMMAND,
} from "../components/account/AddAgentView";
import { base58Encode, SECRET_WARNING } from "../lib/agentKey";
import { accountActionsOf, createWalletStore, type WalletStore } from "../lib/wallet";
import {
  ALICE,
  accountWallet,
  row,
  secretShapes,
  serve,
  TOKEN,
  type World,
  world,
} from "./accountFakes";
import { fakeProvider } from "./walletDoubles";

// "Add an agent" set up by hand ("Advanced: set up by hand", under the connect flow, which
// test/connect-agent-page.test.tsx has), as a person goes through it: the real hook and store over a
// wallet that can make accounts (or can't), and a fake API and node. The agent's private key must
// never be kept or sent.

const holder = vi.hoisted(() => ({ store: undefined as unknown as WalletStore }));
vi.mock("../lib/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wallet")>();
  return {
    ...actual,
    useWallet: () => actual.useWalletStore(holder.store),
    useAccountActions: () => actual.accountActionsOf(holder.store),
  };
});

const PUBLIC = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
const SECRET = `ed25519:${base58Encode(new Uint8Array(64).fill(7))}`;
const AGENT = `scout2.${ALICE}`;
const CONSOLE = ["error", "warn", "log", "info", "debug"] as const;

beforeEach(() => {
  for (const method of CONSOLE) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

function open(
  state: World,
  options: { connected?: boolean; accountActions?: boolean; refuse?: boolean } = {},
) {
  serve(state);
  const session = accountWallet(state, options);
  holder.store = createWalletStore(async () =>
    fakeProvider(session, { restored: options.connected ?? true }),
  );
  render(<AddAgentView watchEveryMs={30} />);
  return { sent: session.sent, user: userEvent.setup() };
}

/** The key field of the steps by hand, which the page shows once "Advanced: set up by hand" is pressed. */
async function keyField(): Promise<HTMLElement> {
  const shown = screen.queryByLabelText("The public key it printed");
  if (shown !== null) return shown;
  fireEvent.click(await screen.findByRole("button", { name: "Advanced: set up by hand" }));
  return screen.findByLabelText("The public key it printed");
}
/** The name field of the steps by hand: the connect flow above them has one of its own. */
const nameField = () => within(screen.getByTestId("by-hand")).getByLabelText("Account name");
const commands = () => screen.getAllByTestId("command").map((code) => code.textContent?.slice(2));

test("add_agent_asks_to_connect_first", async () => {
  const state = world();
  open(state, { connected: false });
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
    "Add an agent. Its key stays where it runs.",
  );
  // What it costs is said before anything else.
  expect(screen.getByRole("banner").textContent).toMatch(
    /0\.50 NEAR sent to the agent's new account.*0\.02 NEAR for its storage with Tender.*the bond it locks when it registers, paid from your wallet into the agent's own vault and refunded in full to that vault/,
  );
  await screen.findByRole("heading", { name: "Connect your wallet" });
  expect(screen.queryByLabelText("The public key it printed")).toBeNull();
  expect(state.requests).toEqual([]);
});

test("the_commands_are_the_ones_the_agent_tools_name", async () => {
  const { user } = open(world());
  await keyField();
  expect(commands()).toEqual(["pnpm agent:init --name <name>"]);
  await user.type(nameField(), "scout2");
  expect(commands()).toEqual([initCommand("scout2")]);
  expect(initCommand("scout2")).toBe("pnpm agent:init --name scout2");
  expect(REGISTER_COMMAND).toBe("pnpm agent:register");
});

test("a_pasted_private_key_is_cleared_at_once_and_kept_nowhere", async () => {
  const state = world();
  const { user } = open(state);
  const field = await keyField();

  await user.click(field);
  await user.paste(SECRET);

  expect((field as HTMLInputElement).value).toBe("");
  expect(screen.getByTestId("key-error").textContent).toBe(SECRET_WARNING);
  expect(screen.getByRole("alert").textContent).toBe(SECRET_WARNING);
  // It went nowhere: not to the API or the node, not into storage, not to the console.
  const secret = SECRET.slice(8);
  await user.type(nameField(), "scout2");
  await waitFor(() => expect(state.requests.some((line) => line.startsWith("RPC"))).toBe(true));
  for (const body of state.bodies) expect(body).not.toContain(secret);
  for (const storage of [sessionStorage, localStorage]) {
    for (let i = 0; i < storage.length; i++) {
      expect(storage.getItem(storage.key(i) ?? "")).not.toContain(secret);
    }
  }
  const logged = CONSOLE.flatMap((method) => vi.mocked(console[method]).mock.calls).flat();
  expect(JSON.stringify(logged.map(String))).not.toContain(secret);
  expect(document.body.innerHTML).not.toContain(secret);
});

test("a_key_or_a_name_that_is_wrong_says_what_to_change", async () => {
  const { user } = open(world());
  const field = await keyField();
  await user.type(field, "ed25519:abc");
  await user.tab();
  expect(screen.getByTestId("key-error").textContent).toBe(
    "That isn't a whole public key. Copy the key again, all of it.",
  );
  expect(field.getAttribute("aria-invalid")).toBe("true");

  await user.type(nameField(), "Scout");
  expect(screen.getByTestId("name-state").textContent).toBe(
    "Use lower case: an account id has no capitals.",
  );
});

test("the_wallet_creates_funds_and_keys_the_account_in_one_transaction_only_when_pressed", async () => {
  const state = world();
  state.config = {
    ...state.config,
    agent_bond: { token: TOKEN, amount: "5000000" },
    agent_bond_cooldown_secs: "604800",
  };
  const { user, sent } = open(state);

  await user.click(await keyField());
  await user.paste(PUBLIC);
  await user.type(nameField(), "scout2");
  await waitFor(() =>
    expect(screen.getByTestId("name-state").textContent).toBe(`${AGENT} is free.`),
  );
  expect(screen.getByTestId("step-1").dataset.done).toBe("true");
  expect(screen.getByTestId("deposit").textContent).toBe("0.50 NEAR");
  // Nothing is signed until the button is pressed.
  expect(sent).toEqual([]);

  await user.click(screen.getByRole("button", { name: `Create ${AGENT}` }));

  await waitFor(() => expect(screen.getByTestId("step-2").dataset.done).toBe("true"));
  expect(sent).toEqual([
    {
      receiverId: AGENT,
      actions: [
        { type: "CreateAccount" },
        { type: "Transfer", params: { deposit: "500000000000000000000000" } },
        { type: "AddKey", params: { publicKey: PUBLIC, accessKey: { permission: "FullAccess" } } },
      ],
    },
  ]);

  // Step 3: the command the agent runs, the bond from the contract's config, and a watch.
  const step3 = screen.getByTestId("step-3");
  expect(within(step3).getByTestId("command").textContent).toBe(`$ ${REGISTER_COMMAND}`);
  expect((await within(step3).findByTestId("bond-terms")).textContent).toBe(
    "Registering locks 5.00 tUSDC from the agent's own Tender vault as a bond. It is refundable: the agent gets it back in full when it retires. It can be claimed back 7d after the agent unregisters.",
  );
  expect(within(step3).getByTestId("watching").textContent).toMatch(
    /Waiting for the agent to register/,
  );

  // The agent registers itself: the page sees it in the API.
  state.agents.set(AGENT, row({ account: AGENT, asp: ALICE }));
  const registered = await within(step3).findByTestId("registered");
  expect(registered.textContent).toContain(`Registered. ${AGENT} is in the directory.`);
  expect(within(registered).getByRole("link", { name: "Open its page" }).getAttribute("href")).toBe(
    `/agents/${AGENT}`,
  );
  expect(step3.dataset.done).toBe("true");
  // One transaction, ever.
  expect(sent).toHaveLength(1);
});

test("a_wallet_that_cannot_make_accounts_gets_the_near_cli_command_and_check_again", async () => {
  const state = world();
  const { user, sent } = open(state, { accountActions: false });
  expect(accountActionsOf(holder.store).canSend()).toBe(false);

  await user.click(await keyField());
  await user.paste(PUBLIC);
  await user.type(nameField(), "scout2");
  await screen.findByText(`${AGENT} is free.`);

  expect(screen.getByTestId("cannot-create").textContent).toContain(
    "can't create accounts from the page",
  );
  expect(screen.queryByRole("button", { name: `Create ${AGENT}` })).toBeNull();
  const cli = createAccountCommand({
    accountId: AGENT,
    parent: ALICE,
    publicKey: PUBLIC,
    network: "testnet",
  });
  expect(cli).toBe(
    `near account create-account fund-myself ${AGENT} '0.50 NEAR' use-manually-provided-public-key ${PUBLIC} sign-as ${ALICE} network-config testnet sign-with-keychain send`,
  );
  expect(commands()).toContain(cli);

  // The person runs it in a terminal, and checks again.
  state.accounts.set(AGENT, [PUBLIC]);
  await user.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(screen.getByTestId("step-2").dataset.done).toBe("true"));
  expect(sent).toEqual([]);
  // A contract from before bonds: registering locks nothing, and the page says so.
  expect((await screen.findByTestId("bond-terms")).textContent).toBe(
    "This contract takes no bond yet, so registering locks nothing.",
  );
});

test("a_taken_name_is_refused_and_an_account_that_already_has_the_key_counts_as_made", async () => {
  const state = world();
  state.accounts.set(`taken.${ALICE}`, ["ed25519:someone-else"]);
  state.accounts.set(AGENT, [PUBLIC]);
  const { user, sent } = open(state);

  await user.click(await keyField());
  await user.paste(PUBLIC);
  await user.type(nameField(), "taken");
  await screen.findByText(`taken.${ALICE} already exists without this key. Choose another name.`);
  expect(
    screen.getByRole("button", { name: `Create taken.${ALICE}` }).getAttribute("aria-disabled"),
  ).toBe("true");

  await user.clear(nameField());
  await user.type(nameField(), "scout2");
  await screen.findByText(`${AGENT} exists and has this key. On to step 3.`);
  expect(screen.getByTestId("step-2").dataset.done).toBe("true");
  expect(sent).toEqual([]);
});

test("a_wallet_that_refuses_says_so_and_offers_the_terminal", async () => {
  const state = world();
  const { user } = open(state, { refuse: true });
  await user.click(await keyField());
  await user.paste(PUBLIC);
  await user.type(nameField(), "scout2");
  await screen.findByText(`${AGENT} is free.`);

  await user.click(screen.getByRole("button", { name: `Create ${AGENT}` }));

  expect((await screen.findByTestId("create-error")).textContent).toBe(
    "The wallet didn't send it. Try again, or create the account from a terminal below.",
  );
  expect(commands().some((command) => command?.startsWith("near account create-account"))).toBe(
    true,
  );
  expect(screen.getByTestId("step-2").dataset.done).toBe("false");
});

// ---- Fix round 1 ---------------------------------------------------------------------------------

test("every_shape_of_key_material_pasted_is_cleared_at_once_with_the_warning", async () => {
  const state = world();
  const { user } = open(state);
  const field = (await keyField()) as HTMLInputElement;
  const shapes = secretShapes(PUBLIC);

  for (const [shape, text] of Object.entries(shapes)) {
    await user.click(field);
    await user.paste(text);
    expect(field.value, shape).toBe("");
    expect(screen.getByTestId("key-error").textContent, shape).toBe(SECRET_WARNING);
    expect(screen.getByRole("alert").textContent, shape).toBe(SECRET_WARNING);
  }
  // Kept nowhere: not in the page, the address, storage, the console or any request.
  const leaked = (where: string) =>
    Object.entries(shapes).filter(([, text]) => text.length > 20 && where.includes(text));
  expect(leaked(document.body.innerHTML)).toEqual([]);
  expect(leaked(window.location.href)).toEqual([]);
  expect(leaked(state.bodies.join("\n"))).toEqual([]);
  expect(sessionStorage.length + localStorage.length).toBe(0);
  const logged = CONSOLE.flatMap((method) => vi.mocked(console[method]).mock.calls).flat();
  expect(leaked(JSON.stringify(logged.map(String)))).toEqual([]);

  // The public key is still taken after all that.
  await user.click(field);
  await user.paste(PUBLIC);
  expect(field.value).toBe(PUBLIC);
  expect(screen.queryByTestId("key-error")).toBeNull();
});

/** A wallet that holds its answer until `release` is called, as one does while its window is open. */
function heldWallet(state: World) {
  const session = accountWallet(state);
  const inner = session.wallet.signAndSendTransactions.bind(session.wallet);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  session.wallet.signAndSendTransactions = async (params) => {
    await held;
    return inner(params);
  };
  serve(state);
  holder.store = createWalletStore(async () => fakeProvider(session, { restored: true }));
  render(<AddAgentView watchEveryMs={30} />);
  return { sent: session.sent, release: () => release(), user: userEvent.setup() };
}

const OTHER_KEY = `ed25519:${base58Encode(new Uint8Array(32).fill(3))}`;

test("step_2_is_done_only_for_the_account_and_key_that_were_signed_for", async () => {
  const state = world();
  const { user, sent, release } = heldWallet(state);
  const key = (await keyField()) as HTMLInputElement;
  await user.click(key);
  await user.paste(PUBLIC);
  await user.type(nameField(), "scout2");
  await screen.findByText(`${AGENT} is free.`);

  await user.click(screen.getByRole("button", { name: `Create ${AGENT}` }));
  await screen.findByRole("button", { name: "Waiting for your wallet…" });

  // While the wallet is open, the name and the key can't change.
  const name = nameField() as HTMLInputElement;
  expect(name.readOnly).toBe(true);
  expect(key.readOnly).toBe(true);
  expect(
    screen.getByText("The key and the name are locked until your wallet answers."),
  ).toBeTruthy();
  await user.type(name, "x");
  await user.click(key);
  await user.paste(OTHER_KEY);
  expect(name.value).toBe("scout2");
  expect(key.value).toBe(PUBLIC);

  release();
  await waitFor(() => expect(screen.getByTestId("step-2").dataset.done).toBe("true"));
  expect(sent.map((transaction) => transaction.receiverId)).toEqual([AGENT]);
  expect(name.readOnly).toBe(false);
  expect(screen.getByTestId("command-account").textContent).toBe(AGENT);

  // An edit afterwards resets the steps at once: step 2 is not done for a name nobody made, and
  // step 3 watches nothing.
  await user.type(name, "x");
  expect(screen.getByTestId("step-2").dataset.done).toBe("false");
  expect(screen.getByTestId("step-3").dataset.open).toBe("false");
  expect(screen.queryByTestId("watching")).toBeNull();
  expect(screen.queryByTestId("command-account")).toBeNull();
  await screen.findByText(`scout2x.${ALICE} is free.`);
  expect(screen.getByTestId("step-2").dataset.done).toBe("false");

  // Another key for the account that was made: not done either, the account doesn't have it.
  await user.clear(name);
  await user.type(name, "scout2");
  await waitFor(() => expect(screen.getByTestId("step-2").dataset.done).toBe("true"));
  await user.clear(key);
  await user.click(key);
  await user.paste(OTHER_KEY);
  expect(screen.getByTestId("step-2").dataset.done).toBe("false");
  await screen.findByText(`${AGENT} already exists without this key. Choose another name.`);
  expect(sent).toHaveLength(1);
});

test("a_step_not_open_yet_is_not_faded_and_the_account_is_shown_as_it_will_be_made", async () => {
  const { user } = open(world());
  await keyField();
  // Not open yet: told apart by its edge and its title, not by fading its words below AA.
  for (const n of [2, 3]) {
    const step = screen.getByTestId(`step-${n}`);
    expect(step.dataset.open).toBe("false");
    expect(step.className).not.toMatch(/opacity/);
    expect(step.className).toContain("border-dashed");
  }
  await user.click(screen.getByLabelText("The public key it printed"));
  await user.paste(PUBLIC);
  await user.type(nameField(), "scout2");
  const create = await screen.findByRole("button", { name: `Create ${AGENT}` });
  // The pill's capitals are not put on the account it names.
  const id = within(create).getByText(AGENT);
  expect(id.className).toContain("normal-case");
  expect(screen.getByTestId("step-2").className).not.toMatch(/opacity/);
});
