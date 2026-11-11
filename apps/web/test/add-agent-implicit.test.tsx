import { bytesToHex, implicitAccountOf } from "@tender/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KeyPair } from "near-api-js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  AddAgentView,
  IMPLICIT_OWNER_LINE,
  implicitRegisterCommand,
  initCommand,
  isImplicitAccount,
} from "../components/account/AddAgentView";
import { base58Encode, SECRET_WARNING } from "../lib/agentKey";
import { createWalletStore, type SigningWallet, type WalletStore } from "../lib/wallet";
import { row, serve, TOKEN, type World, world } from "./accountFakes";
import { fakeProvider } from "./walletDoubles";

// "Add an agent" for an owner whose account is an implicit account, as every account of the email
// and Google login is: its 64 characters leave no room for `<name>.<owner>`, so the page offers
// the one way there is, an account made from the agent's own key, and says why in one line. Run end
// to end here on a model of the chain: the key pasted, ONE approval (the NEAR that creates the
// account, its storage with Tender and the bond into its vault), and the agent registering.

const holder = vi.hoisted(() => ({ store: undefined as unknown as WalletStore }));
vi.mock("../lib/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wallet")>();
  return {
    ...actual,
    useWallet: () => actual.useWalletStore(holder.store),
    useAccountActions: () => actual.accountActionsOf(holder.store),
  };
});

const CONTRACT = "tender.testnet";
/** The owner: the implicit account a login made. */
const OWNER = bytesToHex(KeyPair.fromRandom("ed25519").getPublicKey().data);
/** The agent's key, which the agent made where it runs, and its implicit account. */
const AGENT_KEY = KeyPair.fromRandom("ed25519").getPublicKey().toString();
const AGENT = implicitAccountOf(AGENT_KEY) as string;
const BOND = 5_000_000n;

interface Sent {
  receiverId: string;
  actions: Array<{
    type: string;
    params?: { methodName?: string; args?: Record<string, unknown> };
  }>;
}

beforeEach(() => {
  for (const method of ["error", "warn"] as const)
    vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

/**
 * The owner's wallet, which runs what it is sent on `state`: a transfer to an implicit account
 * creates it with the key its id spells, Tender's `storage_deposit` gives the account it names a
 * storage balance, and the bond's `ft_transfer_call` credits the agent's vault.
 */
function ownerWallet(state: World): { wallet: SigningWallet; sent: Sent[][] } {
  const sent: Sent[][] = [];
  const wallet: SigningWallet = {
    manifest: { features: { signMessage: true, signAndSendTransactions: true } },
    async signAndSendTransactions({ transactions }) {
      const batch = transactions as unknown as Sent[];
      sent.push(batch);
      return batch.map((transaction, index) => {
        for (const action of transaction.actions) {
          if (action.type === "Transfer" && isImplicitAccount(transaction.receiverId)) {
            state.accounts.set(transaction.receiverId, [AGENT_KEY]);
          }
          const args = action.params?.args ?? {};
          if (action.params?.methodName === "storage_deposit") {
            state.storage.add(String(args.account_id));
          }
          if (action.params?.methodName === "ft_transfer_call") {
            const { for: agent } = JSON.parse(String(args.msg)) as { for: string };
            state.vault.set(agent, BigInt(String(args.amount)));
          }
        }
        return {
          status: { SuccessValue: "" },
          transaction: { hash: `tx${index}` },
          receipts_outcome: [
            {
              id: "r",
              outcome: {
                executor_id: transaction.receiverId,
                logs: [],
                status: { SuccessValue: "" },
              },
            },
          ],
        };
      });
    },
    async signMessage() {
      throw new Error("not asked");
    },
  };
  return { wallet, sent };
}

function open(state: World) {
  serve(state);
  const { wallet, sent } = ownerWallet(state);
  holder.store = createWalletStore(async () =>
    fakeProvider({ wallet, accountId: OWNER }, { restored: true }),
  );
  render(<AddAgentView watchEveryMs={30} />);
  return { sent, user: userEvent.setup() };
}

test("an_implicit_account_is_one_of_64_hex_characters", () => {
  expect(isImplicitAccount(OWNER)).toBe(true);
  expect(isImplicitAccount("alice.testnet")).toBe(false);
  expect(isImplicitAccount(OWNER.toUpperCase())).toBe(false);
  expect(isImplicitAccount(`${OWNER}0`)).toBe(false);
});

test("an_implicit_owner_is_offered_only_the_agent_s_own_account_and_told_why", async () => {
  const state = world();
  state.accounts.set(OWNER, []);
  open(state);

  expect((await screen.findByTestId("implicit-owner")).textContent).toBe(IMPLICIT_OWNER_LINE);
  // No connect code (the API can't make one under this account), no name, no sub-account.
  expect(screen.queryByText("Advanced: set up by hand")).toBeNull();
  expect(screen.queryByLabelText("Account name")).toBeNull();
  expect(screen.getAllByTestId("command")[0]?.textContent).toBe(`$ ${initCommand("agent")}`);
});

test("the_agent_s_account_is_made_funded_and_bonded_in_one_approval_and_it_registers", async () => {
  const state = world();
  state.accounts.set(OWNER, []);
  state.config = { ...state.config, agent_bond: { token: TOKEN, amount: BOND.toString() } };
  const { sent, user } = open(state);

  await user.click(await screen.findByLabelText("The public key it printed"));
  await user.paste(AGENT_KEY);
  // The account is the key's own: the page works it out, and asks the chain about it.
  await waitFor(() => expect(screen.getByTestId("implicit-agent").textContent).toBe(AGENT));
  const create = await screen.findByRole("button", { name: "Create the agent's account" });
  await waitFor(() => expect(create.getAttribute("aria-disabled")).toBe("false"));
  // Nothing is signed until the button is pressed.
  expect(sent).toEqual([]);

  await user.click(create);

  await waitFor(() => expect(screen.getByTestId("step-2").dataset.done).toBe("true"));
  // ONE approval: NEAR to the implicit account (which the chain creates with the agent's key),
  // then Tender's storage for it and the bond into its vault.
  expect(sent).toHaveLength(1);
  const [batch] = sent;
  expect(batch?.map((tx) => tx.receiverId)).toEqual([AGENT, CONTRACT, TOKEN]);
  expect(batch?.[0]?.actions).toEqual([
    { type: "Transfer", params: { deposit: "500000000000000000000000" } },
  ]);
  expect(batch?.[1]?.actions[0]?.params).toMatchObject({
    methodName: "storage_deposit",
    args: { account_id: AGENT },
  });
  expect(batch?.[2]?.actions[0]?.params).toMatchObject({
    methodName: "ft_transfer_call",
    args: { receiver_id: CONTRACT, amount: BOND.toString(), msg: JSON.stringify({ for: AGENT }) },
  });

  // Step 3: the agent registers with its own key, named by the account it can't work out alone.
  const step3 = screen.getByTestId("step-3");
  expect(within(step3).getByTestId("command").textContent).toBe(
    `$ ${implicitRegisterCommand(AGENT)}`,
  );
  expect(implicitRegisterCommand(AGENT)).toBe(
    `pnpm agent:register --name agent --account ${AGENT}`,
  );
  state.agents.set(AGENT, row({ account: AGENT, asp: AGENT }));
  expect((await within(step3).findByTestId("registered")).textContent).toContain(
    `Registered. ${AGENT} is in the directory.`,
  );
});

test("an_agent_account_already_made_and_paid_for_is_step_two_done_with_nothing_to_send", async () => {
  const state = world();
  state.accounts.set(OWNER, []);
  state.accounts.set(AGENT, [AGENT_KEY]);
  state.storage.add(AGENT);
  const { sent, user } = open(state);

  await user.click(await screen.findByLabelText("The public key it printed"));
  await user.paste(AGENT_KEY);
  await waitFor(() => expect(screen.getByTestId("step-2").dataset.done).toBe("true"));
  expect(screen.queryByRole("button", { name: "Create the agent's account" })).toBeNull();
  expect(sent).toEqual([]);
});

test("a_private_key_pasted_is_cleared_at_once", async () => {
  const state = world();
  state.accounts.set(OWNER, []);
  const { user } = open(state);
  const field = await screen.findByLabelText("The public key it printed");
  await user.click(field);
  await user.paste(`ed25519:${base58Encode(new Uint8Array(64).fill(9))}`);
  expect((field as HTMLInputElement).value).toBe("");
  expect(screen.getByTestId("key-error").textContent).toBe(SECRET_WARNING);
});
