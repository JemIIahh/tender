import type { NetworkId } from "@tender/shared";
import { expect, test } from "vitest";
import { FAUCET_AMOUNT, faucetOffered, faucetToken, planFaucet } from "../lib/faucet";
import { describeAmount } from "../lib/vault";
import { groupCalls } from "../lib/wallet";

// The faucet's decisions, with no page: where it is offered, which token it mints, and the calls
// one press sends. The page that uses them is test/wallet-faucet.test.tsx.

const TOKEN = "tusdc.tender-team.testnet";
const ALICE = "alice.testnet";

test("the_faucet_is_offered_on_testnet_and_nowhere_else", () => {
  const offered = (["sandbox", "testnet", "mainnet"] as NetworkId[]).filter(faucetOffered);
  expect(offered).toEqual(["testnet"]);
});

test("one_press_mints_twenty_tusdc", () => {
  // Documented in docs/MCP.md and told on the page: change them together.
  expect(FAUCET_AMOUNT).toBe(20_000_000n);
  expect(describeAmount(FAUCET_AMOUNT, TOKEN)).toBe("20.00 tUSDC");
});

test("the_token_is_the_test_usdc_of_tenders_own_list", () => {
  const list = [
    { token: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af", enabled: true },
    { token: TOKEN, enabled: true },
  ];
  expect(faucetToken(list, "testnet")).toBe(TOKEN);
  // A redeploy of the test token is another account, and the list is what names it.
  expect(faucetToken([{ token: "tusdc.next.testnet", enabled: true }], "testnet")).toBe(
    "tusdc.next.testnet",
  );
});

test("a_test_token_tender_does_not_take_is_not_minted", () => {
  expect(faucetToken([{ token: TOKEN, enabled: false }], "testnet")).toBeNull();
  // The first one Tender takes, not the first one listed.
  expect(
    faucetToken(
      [
        { token: TOKEN, enabled: false },
        { token: "tusdc.next.testnet", enabled: true },
      ],
      "testnet",
    ),
  ).toBe("tusdc.next.testnet");
});

test("no_test_token_in_the_list_is_no_token", () => {
  expect(faucetToken([], "testnet")).toBeNull();
  expect(faucetToken([{ token: "wrap.testnet", enabled: true }], "testnet")).toBeNull();
  // A name that looks like the test token is not one on mainnet: anyone can register it there.
  expect(faucetToken([{ token: TOKEN, enabled: true }], "mainnet")).toBeNull();
});

test("a_registered_account_is_minted_to_and_not_registered_again", () => {
  const calls = planFaucet({ token: TOKEN, account: ALICE, registered: true });

  expect(calls).toEqual([
    {
      receiverId: TOKEN,
      methodName: "mint",
      args: { account_id: ALICE, amount: "20000000" },
      gas: 15_000_000_000_000n,
      // `mint` is not payable: the token refuses any NEAR attached to it.
      deposit: 0n,
    },
  ]);
});

test("an_account_the_token_does_not_know_is_registered_first_then_minted_to", () => {
  const calls = planFaucet({ token: TOKEN, account: ALICE, registered: false });

  expect(calls.map((call) => [call.receiverId, call.methodName])).toEqual([
    [TOKEN, "storage_deposit"],
    [TOKEN, "mint"],
  ]);
  expect(calls[0]?.args).toEqual({ account_id: ALICE, registration_only: true });
  expect(calls[1]?.args).toEqual({ account_id: ALICE, amount: "20000000" });
});

test("the_registration_and_the_mint_are_one_transaction_so_one_approval", () => {
  for (const registered of [true, false]) {
    const batch = groupCalls(planFaucet({ token: TOKEN, account: ALICE, registered }));
    expect(batch, `registered ${registered}`).toHaveLength(1);
    expect(batch[0]?.receiverId).toBe(TOKEN);
    expect(batch[0]?.actions.map((action) => action.params.methodName)).toEqual(
      registered ? ["mint"] : ["storage_deposit", "mint"],
    );
  }
});

test("the_amount_can_be_set_for_a_plan_and_defaults_to_the_faucets", () => {
  const [mint] = planFaucet({ token: TOKEN, account: ALICE, registered: true, amount: 3n });
  expect(mint?.args).toEqual({ account_id: ALICE, amount: "3" });
});
