import { expect, test } from "vitest";
import { heldOnImplicit, heldOnSubAccount, storageNote } from "../lib/connect";

// The words "Connect your agent" says of what Tender holds for the other way's account, and when
// it says nothing (only then does it let that way be paid for).

const SUB = "writer.alice.testnet";
const IMPLICIT = "ab".repeat(32);
const BOND = { token: "tusdc.testnet", amount: 5_000_000n };
const nothing = { key: "missing" as const, storage: false, vault: 0n };

test("nothing_on_the_sub_account_says_nothing_and_each_thing_on_it_is_named", () => {
  expect(heldOnSubAccount(SUB, nothing, BOND)).toBeNull();
  // A vault balance of no bond's token is no bond.
  expect(heldOnSubAccount(SUB, { ...nothing, vault: 7n }, null)).toBeNull();
  expect(heldOnSubAccount(SUB, { ...nothing, storage: true, vault: BOND.amount }, BOND)).toBe(
    `Your bond and storage are waiting for ${SUB}; they stay there until that account is created. Finish with a wallet that allows the setup step.`,
  );
  // Storage alone stops nothing: Tender takes a storage deposit for any account id from anyone.
  expect(heldOnSubAccount(SUB, { ...nothing, storage: true }, BOND)).toBeNull();
  expect(heldOnSubAccount(SUB, { ...nothing, vault: 1n }, BOND)).toBe(
    `A bond is waiting for ${SUB}; it stays there until that account is created. Finish with a wallet that allows the setup step.`,
  );
});

test("an_account_that_exists_is_named_by_whose_key_it_has", () => {
  expect(heldOnSubAccount(SUB, { ...nothing, key: "has-key" }, BOND)).toBe(
    `${SUB} exists now, with your agent's key, so your agent keeps it. Nothing more was sent.`,
  );
  expect(heldOnSubAccount(SUB, { ...nothing, key: "other-keys" }, BOND)).toBe(
    `${SUB} exists, and not with your agent's key, so nothing was sent for it or for a separate account. Start over with another name.`,
  );
});

test("what_the_separate_account_holds_stops_a_payment_for_the_sub_account", () => {
  expect(heldOnImplicit(IMPLICIT, SUB, nothing, BOND)).toBeNull();
  // NEAR sent to the separate account is the agent's: only Tender's storage or a bond counts.
  expect(heldOnImplicit(IMPLICIT, SUB, { ...nothing, key: "has-key" }, BOND)).toBeNull();
  expect(heldOnImplicit(IMPLICIT, SUB, { ...nothing, storage: true }, BOND)).toBeNull();
  expect(heldOnImplicit(IMPLICIT, SUB, { ...nothing, vault: 1n }, BOND)).toBe(
    `A bond is already waiting for ${IMPLICIT}, your agent's separate account, so nothing more is paid for ${SUB}. Read the page again before you press anything.`,
  );
});

test("storage_alone_is_noted_and_never_named_where_a_bond_is", () => {
  expect(storageNote(IMPLICIT, { ...nothing, storage: true }, BOND)).toBe(
    `Some storage is already paid for ${IMPLICIT}; it stays with that account.`,
  );
  expect(storageNote(IMPLICIT, nothing, BOND)).toBeNull();
  expect(storageNote(IMPLICIT, { ...nothing, storage: true, vault: 1n }, BOND)).toBeNull();
});
