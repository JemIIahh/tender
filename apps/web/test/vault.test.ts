import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RpcError } from "../lib/rpc";
import { isRegisteredAtToken, readAmount, readVault, SETUP_DEPOSIT_YOCTO } from "../lib/vault";
import { FakeChain, FakeNode, fakeFetch } from "./fakeChain";
import { rejection } from "./support";

// What the wallet page reads and sends (lib/vault.ts), against a model of the contract and its
// tokens behind a fake RPC node. vitest.config.ts gives the config the network testnet, the
// contract tender.testnet and the node http://rpc.test.

const CONTRACT = "tender.testnet";
const USDC = "tusdc.testnet";
const OTHER = "tother.testnet";
const ALICE = "alice.testnet";

let chain: FakeChain;
let node: FakeNode;

beforeEach(() => {
  chain = new FakeChain(CONTRACT, [{ token: USDC }, { token: OTHER, enabled: false }]);
  node = new FakeNode(chain);
  vi.stubGlobal("fetch", fakeFetch("http://rpc.test", node));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- Reading ------------------------------------------------------------------------------------

test("vault_reads_the_storage_balance_and_each_tokens_vault_and_wallet_balances", async () => {
  chain.fundVault(ALICE, USDC, 2_500_000n);
  chain.give(USDC, ALICE, 7_000_000n);
  chain.give(OTHER, ALICE, 3n);

  const data = await readVault(ALICE);

  // Tokens in Tender's order, an unlisted flag for the one it no longer takes.
  expect(data.rows).toEqual([
    { token: USDC, enabled: true, vault: 2_500_000n, wallet: 7_000_000n },
    { token: OTHER, enabled: false, vault: 0n, wallet: 3n },
  ]);
  expect(data.storage).not.toBeNull();
  expect(data.storage?.total).toBe(5n * 10n ** 22n);
  // What is left after the 173 bytes the account and its vault slot use.
  expect(data.storage?.available).toBe(5n * 10n ** 22n - 173n * 10n ** 19n);
});

test("an_account_that_never_set_up_has_no_storage_and_nothing_in_the_vault", async () => {
  chain.give(USDC, ALICE, 10n);

  const data = await readVault(ALICE);

  expect(data.storage).toBeNull();
  expect(data.rows.map((row) => [row.token, row.vault, row.wallet])).toEqual([
    [USDC, 0n, 10n],
    [OTHER, 0n, 0n],
  ]);
});

test("a_token_with_a_vault_balance_is_listed_even_if_tender_does_not_list_it", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  chain.fundVault(ALICE, USDC, 1n);
  chain.vault.get(ALICE)?.set("gone.testnet", 9n);

  const data = await readVault(ALICE);

  // Its balance is shown, and can be withdrawn. The token itself would not answer (it is not on
  // this chain): the wallet balance is unknown and not zero, and a developer sees why.
  expect(data.rows.at(-1)).toEqual({
    token: "gone.testnet",
    enabled: false,
    vault: 9n,
    wallet: null,
  });
  expect(log).toHaveBeenCalledTimes(1);
});

test("a_contract_view_that_is_not_what_the_contract_promises_is_an_rpc_error", async () => {
  const wrong: Array<[string, unknown]> = [
    ["balances_of", "nope"],
    ["balances_of", [{ token: USDC, amount: -5 }]],
    ["balances_of", [{ token: "Not An Account", amount: "5" }]],
    ["balances_of", [null]],
    ["storage_balance_of", { total: "1" }],
    ["get_config", { tokens: [] }],
  ];
  for (const [method, answer] of wrong) {
    const real = chain.view.bind(chain);
    chain.view = (contractId, name, args) =>
      contractId === CONTRACT && name === method ? answer : real(contractId, name, args);

    const failure = await rejection(readVault(ALICE));

    expect(failure, method).toBeInstanceOf(RpcError);
    chain.view = real;
  }
});

test("a_node_that_is_down_is_thrown_as_it_came", async () => {
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("fetch failed");
  });

  expect(await rejection(readVault(ALICE))).toBeInstanceOf(TypeError);
});

test("registered_at_a_token_is_what_the_token_says_of_the_account", async () => {
  chain.give(USDC, ALICE, 1n);

  expect(await isRegisteredAtToken(USDC, ALICE)).toBe(true);
  expect(await isRegisteredAtToken(USDC, "bob.testnet")).toBe(false);

  const real = chain.view.bind(chain);
  chain.view = (contractId, name, args) =>
    name === "storage_balance_of" && contractId === USDC
      ? { total: "x" }
      : real(contractId, name, args);
  expect(await rejection(isRegisteredAtToken(USDC, ALICE))).toBeInstanceOf(RpcError);
});

// ---- Sending ------------------------------------------------------------------------------------

test("set_up_account_attaches_half_of_a_tenth_of_a_near", () => {
  expect(SETUP_DEPOSIT_YOCTO).toBe(50_000_000_000_000_000_000_000n);
});

// ---- Amounts a person types ---------------------------------------------------------------------

test("an_amount_is_read_in_whole_units_of_the_token_and_refused_in_words", () => {
  // tusdc.* is the test USDC: six decimal places.
  const read = (text: string, max: bigint | null = 10_000_000n) =>
    readAmount(text, USDC, max, "vault");

  expect(read("1.25")).toEqual({ ok: true, amount: 1_250_000n });
  expect(read("  3 ")).toEqual({ ok: true, amount: 3_000_000n });
  expect(read("0.000001")).toEqual({ ok: true, amount: 1n });
  expect(read("10")).toEqual({ ok: true, amount: 10_000_000n });
  // With no limit known the token's own contract is left to refuse an amount that is too large.
  expect(read("99999", null)).toEqual({ ok: true, amount: 99_999_000_000n });

  const refused = (text: string, max: bigint | null = 10_000_000n) => {
    const reading = read(text, max);
    if (reading.ok) throw new Error(`expected ${JSON.stringify(text)} to be refused`);
    return reading.message;
  };
  expect(refused("")).toBe("Enter an amount.");
  expect(refused("   ")).toBe("Enter an amount.");
  expect(refused("0")).toBe("Enter more than 0.");
  expect(refused("0.00")).toBe("Enter more than 0.");
  expect(refused("-1")).toBe("An amount can't be negative.");
  expect(refused("abc")).toBe("Use digits and one point, like 12.5.");
  expect(refused("1e3")).toBe("Use digits and one point, like 12.5.");
  expect(refused("1,5")).toBe("Use digits and one point, like 12.5.");
  expect(refused(".5")).toBe("Use digits and one point, like 12.5.");
  expect(refused("0.0000001")).toBe("This token has 6 decimal places at most.");
  expect(refused("10.000001")).toBe("That's more than you have in the vault.");
  expect(readAmount("2", USDC, 1_000_000n, "wallet")).toEqual({
    ok: false,
    message: "That's more than you have in your wallet.",
  });
});

test("a_token_the_app_does_not_know_counts_in_whole_units_of_its_smallest", () => {
  // `tokenMeta` never guesses decimals: an unknown token has none, so only a whole number goes.
  expect(readAmount("12", "mystery.testnet", 100n, "vault")).toEqual({ ok: true, amount: 12n });
  const half = readAmount("1.5", "mystery.testnet", 100n, "vault");
  expect(half).toEqual({
    ok: false,
    message: "This token has no decimal places. Use a whole number.",
  });
});
