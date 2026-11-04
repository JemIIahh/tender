import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  addDelegateCall,
  claimAgentBondCall,
  cleanupCall,
  commitCall,
  computeCommitment,
  depositCall,
  GAS,
  mintCall,
  ONE_YOCTO,
  type PostTaskInput,
  pickCall,
  postTaskCall,
  registerAgentCall,
  removeDelegateCall,
  revealCall,
  setAgentBondCall,
  setAgentBondCooldownCall,
  sha256Hex,
  storageDepositCall,
  storageWithdrawCall,
  type TenderCall,
  toConnectorAction,
  tokenStorageDepositCall,
  topUpTaskCall,
  unregisterAgentCall,
  voidTaskCall,
  withdrawCall,
} from "../src/index";

const TENDER = "tender.near";
const TOKEN = "usdc.token.near";
const ALICE = "alice.near";
const BOB = "bob.near";
const PUBLIC_KEY = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
const TERA = 10n ** 12n;
const U64_MAX = 2n ** 64n - 1n;
const U128_MAX = 2n ** 128n - 1n;

const BRIEF_HASH = sha256Hex("brief");
const CRITERIA_HASH = sha256Hex("criteria");
const HELDOUT_HASH = sha256Hex("held-out tests");
const CONTENT_HASH = sha256Hex("work");
const SCORECARD_HASH = sha256Hex("scorecard");
const PROFILE_HASH = sha256Hex("profile");
const SALT = "11".repeat(32);
const COMMITMENT = computeCommitment(42n, ALICE, CONTENT_HASH, SALT);

/** A task that sets every field of `PostTaskInput`. */
const FULL_INPUT: PostTaskInput = {
  token: TOKEN,
  reward: U128_MAX,
  briefUri: "ipfs://brief",
  briefHash: BRIEF_HASH,
  criteriaHash: CRITERIA_HASH,
  heldoutCommitment: HELDOUT_HASH,
  verifier: "judge.near",
  commitSecs: 60,
  revealSecs: 120,
  pickSecs: 180,
  fallbackSecs: 240,
  maxEntries: 2,
  maxWinners: 3,
  invited: [BOB, "carol.near"],
  parent: U64_MAX,
};

/** A task that sets only the fields `PostTaskInput` requires. */
const MIN_INPUT: PostTaskInput = {
  token: TOKEN,
  reward: 1_000_000n,
  briefUri: "ipfs://brief",
  briefHash: BRIEF_HASH,
  criteriaHash: CRITERIA_HASH,
  commitSecs: 60,
  revealSecs: 120,
  pickSecs: 180,
  fallbackSecs: 240,
};

const sorted = (names: string[]) => [...names].sort();

/** The fifteen fields of the contract's `PostTaskArgs`, which `post_task`'s `task` holds. */
const TASK_KEYS = [
  "token",
  "reward",
  "brief_uri",
  "brief_hash",
  "criteria_hash",
  "heldout_commitment",
  "verifier",
  "commit_secs",
  "reveal_secs",
  "pick_secs",
  "fallback_secs",
  "max_entries",
  "max_winners",
  "invited",
  "parent",
];

/**
 * One call from every builder, in the forms that send the most arguments and the fewest, next to
 * the call it has to be: the receiver, method, JSON arguments, gas and deposit that the contract
 * (or the token) takes. The names were read from the contract source; the next tests check them
 * against it again.
 */
function wire(): { name: string; call: TenderCall; expected: TenderCall }[] {
  return [
    {
      name: "postTaskCall",
      call: postTaskCall(TENDER, FULL_INPUT),
      expected: {
        receiverId: TENDER,
        methodName: "post_task",
        args: {
          task: {
            token: TOKEN,
            reward: "340282366920938463463374607431768211455",
            brief_uri: "ipfs://brief",
            brief_hash: BRIEF_HASH,
            criteria_hash: CRITERIA_HASH,
            heldout_commitment: HELDOUT_HASH,
            verifier: "judge.near",
            commit_secs: 60,
            reveal_secs: 120,
            pick_secs: 180,
            fallback_secs: 240,
            max_entries: 2,
            max_winners: 3,
            invited: [BOB, "carol.near"],
            parent: "18446744073709551615",
          },
        },
        gas: 30n * TERA,
        deposit: 1n,
      },
    },
    {
      name: "topUpTaskCall",
      call: topUpTaskCall(TENDER, 42n, 500n),
      expected: {
        receiverId: TENDER,
        methodName: "top_up_task",
        args: { task_id: "42", amount: "500" },
        gas: 20n * TERA,
        deposit: 1n,
      },
    },
    {
      name: "commitCall",
      call: commitCall(TENDER, 42n, COMMITMENT),
      expected: {
        receiverId: TENDER,
        methodName: "commit",
        args: { task_id: "42", commitment: COMMITMENT },
        gas: 15n * TERA,
        deposit: 0n,
      },
    },
    {
      name: "revealCall",
      call: revealCall(TENDER, 42n, CONTENT_HASH, SALT, "ipfs://work"),
      expected: {
        receiverId: TENDER,
        methodName: "reveal",
        args: { task_id: "42", content_hash: CONTENT_HASH, salt: SALT, uri: "ipfs://work" },
        gas: 15n * TERA,
        deposit: 0n,
      },
    },
    {
      name: "pickCall",
      call: pickCall(
        TENDER,
        42n,
        [
          { account: ALICE, bps: 7000 },
          { account: BOB, bps: 3000 },
        ],
        SCORECARD_HASH,
        "ipfs://scorecard",
      ),
      expected: {
        receiverId: TENDER,
        methodName: "pick",
        args: {
          task_id: "42",
          winners: [
            { account: ALICE, bps: 7000 },
            { account: BOB, bps: 3000 },
          ],
          scorecard_hash: SCORECARD_HASH,
          scorecard_uri: "ipfs://scorecard",
        },
        gas: 60n * TERA,
        deposit: 0n,
      },
    },
    {
      name: "pickCall, no winners",
      call: pickCall(TENDER, 42n, [], SCORECARD_HASH, "ipfs://scorecard"),
      expected: {
        receiverId: TENDER,
        methodName: "pick",
        args: {
          task_id: "42",
          winners: [],
          scorecard_hash: SCORECARD_HASH,
          scorecard_uri: "ipfs://scorecard",
        },
        gas: 60n * TERA,
        deposit: 0n,
      },
    },
    {
      name: "voidTaskCall",
      call: voidTaskCall(TENDER, 42n),
      expected: {
        receiverId: TENDER,
        methodName: "void_task",
        args: { task_id: "42" },
        gas: 60n * TERA,
        deposit: 0n,
      },
    },
    {
      name: "cleanupCall",
      call: cleanupCall(TENDER, 42n),
      expected: {
        receiverId: TENDER,
        methodName: "cleanup",
        args: { task_id: "42", limit: 50 },
        gas: 150n * TERA,
        deposit: 0n,
      },
    },
    {
      name: "cleanupCall, own limit",
      call: cleanupCall(TENDER, 42n, 7),
      expected: {
        receiverId: TENDER,
        methodName: "cleanup",
        args: { task_id: "42", limit: 7 },
        gas: 150n * TERA,
        deposit: 0n,
      },
    },
    {
      name: "withdrawCall",
      call: withdrawCall(TENDER, TOKEN, 400n),
      expected: {
        receiverId: TENDER,
        methodName: "withdraw",
        args: { token: TOKEN, amount: "400" },
        gas: 50n * TERA,
        deposit: 1n,
      },
    },
    {
      name: "withdrawCall, to another account",
      call: withdrawCall(TENDER, TOKEN, 400n, BOB),
      expected: {
        receiverId: TENDER,
        methodName: "withdraw",
        args: { token: TOKEN, amount: "400", to: BOB },
        gas: 50n * TERA,
        deposit: 1n,
      },
    },
    {
      name: "storageDepositCall",
      call: storageDepositCall(TENDER, 10n ** 22n),
      expected: {
        receiverId: TENDER,
        methodName: "storage_deposit",
        args: {},
        gas: 10n * TERA,
        deposit: 10n ** 22n,
      },
    },
    {
      name: "storageDepositCall, for another account",
      call: storageDepositCall(TENDER, 10n ** 22n, BOB),
      expected: {
        receiverId: TENDER,
        methodName: "storage_deposit",
        args: { account_id: BOB },
        gas: 10n * TERA,
        deposit: 10n ** 22n,
      },
    },
    {
      name: "storageWithdrawCall",
      call: storageWithdrawCall(TENDER),
      expected: {
        receiverId: TENDER,
        methodName: "storage_withdraw",
        args: {},
        gas: 15n * TERA,
        deposit: 1n,
      },
    },
    {
      name: "storageWithdrawCall, an amount",
      call: storageWithdrawCall(TENDER, 5n),
      expected: {
        receiverId: TENDER,
        methodName: "storage_withdraw",
        args: { amount: "5" },
        gas: 15n * TERA,
        deposit: 1n,
      },
    },
    {
      name: "depositCall",
      call: depositCall(TOKEN, TENDER, 5_000_000n),
      expected: {
        receiverId: TOKEN,
        methodName: "ft_transfer_call",
        args: { receiver_id: TENDER, amount: "5000000", msg: "" },
        gas: 100n * TERA,
        deposit: 1n,
      },
    },
    {
      name: "depositCall, for another account",
      call: depositCall(TOKEN, TENDER, 5_000_000n, BOB),
      expected: {
        receiverId: TOKEN,
        methodName: "ft_transfer_call",
        args: { receiver_id: TENDER, amount: "5000000", msg: '{"for":"bob.near"}' },
        gas: 100n * TERA,
        deposit: 1n,
      },
    },
    {
      name: "tokenStorageDepositCall",
      call: tokenStorageDepositCall(TOKEN, ALICE),
      expected: {
        receiverId: TOKEN,
        methodName: "storage_deposit",
        args: { account_id: ALICE, registration_only: true },
        gas: 10n * TERA,
        deposit: 1_250_000_000_000_000_000_000n,
      },
    },
    {
      name: "mintCall",
      call: mintCall(TOKEN, ALICE, 20_000_000n),
      expected: {
        receiverId: TOKEN,
        methodName: "mint",
        args: { account_id: ALICE, amount: "20000000" },
        gas: 15n * TERA,
        deposit: 0n,
      },
    },
    {
      name: "registerAgentCall",
      call: registerAgentCall(TENDER, "ipfs://profile", PROFILE_HASH, ["rust", "audit"]),
      expected: {
        receiverId: TENDER,
        methodName: "register_agent",
        args: {
          profile_uri: "ipfs://profile",
          profile_hash: PROFILE_HASH,
          tags: ["rust", "audit"],
        },
        gas: 15n * TERA,
        deposit: 1n,
      },
    },
    {
      name: "unregisterAgentCall",
      call: unregisterAgentCall(TENDER),
      expected: {
        receiverId: TENDER,
        methodName: "unregister_agent",
        args: {},
        gas: 15n * TERA,
        deposit: 1n,
      },
    },
    {
      name: "claimAgentBondCall",
      call: claimAgentBondCall(TENDER),
      expected: {
        receiverId: TENDER,
        methodName: "claim_agent_bond",
        args: {},
        gas: 15n * TERA,
        deposit: 1n,
      },
    },
    {
      name: "setAgentBondCall",
      call: setAgentBondCall(TENDER, TOKEN, U128_MAX),
      expected: {
        receiverId: TENDER,
        methodName: "set_agent_bond",
        args: { token: TOKEN, amount: "340282366920938463463374607431768211455" },
        gas: 15n * TERA,
        deposit: 1n,
      },
    },
    {
      name: "setAgentBondCooldownCall",
      call: setAgentBondCooldownCall(TENDER, 3_600),
      expected: {
        receiverId: TENDER,
        methodName: "set_agent_bond_cooldown",
        args: { secs: "3600" },
        gas: 15n * TERA,
        deposit: 1n,
      },
    },
    {
      name: "addDelegateCall",
      call: addDelegateCall(TENDER, PUBLIC_KEY, TOKEN, 5_000n, 10_000n),
      expected: {
        receiverId: TENDER,
        methodName: "add_delegate",
        args: { public_key: PUBLIC_KEY, token: TOKEN, per_task_cap: "5000", total_cap: "10000" },
        gas: 15n * TERA,
        deposit: 1n,
      },
    },
    {
      name: "removeDelegateCall",
      call: removeDelegateCall(TENDER, PUBLIC_KEY),
      expected: {
        receiverId: TENDER,
        methodName: "remove_delegate",
        args: { public_key: PUBLIC_KEY },
        gas: 15n * TERA,
        deposit: 1n,
      },
    },
  ];
}

// The brief's tests.

test("post_task_args_are_snake_case_strings", () => {
  const call = postTaskCall(TENDER, FULL_INPUT);
  // The contract reads `{"task": {...}}`. u64 and u128 values travel as decimal strings, which is
  // the only way to keep a value above 2^53 exact, and u8 and u32 values as JSON numbers.
  expect(call.args).toStrictEqual({
    task: {
      token: TOKEN,
      reward: "340282366920938463463374607431768211455",
      brief_uri: "ipfs://brief",
      brief_hash: BRIEF_HASH,
      criteria_hash: CRITERIA_HASH,
      heldout_commitment: HELDOUT_HASH,
      verifier: "judge.near",
      commit_secs: 60,
      reveal_secs: 120,
      pick_secs: 180,
      fallback_secs: 240,
      max_entries: 2,
      max_winners: 3,
      invited: [BOB, "carol.near"],
      parent: "18446744073709551615",
    },
  });
  expect(call.receiverId).toBe(TENDER);
  expect(call.methodName).toBe("post_task");
  expect(call.deposit).toBe(ONE_YOCTO);
});

test("optional_fields_become_null", () => {
  const call = postTaskCall(TENDER, MIN_INPUT);
  // Every key is present. An optional one that the caller left out is `null`, not missing and not
  // `undefined`, and the three with a default take it: open to anyone, no cap, one winner.
  expect(call.args).toStrictEqual({
    task: {
      token: TOKEN,
      reward: "1000000",
      brief_uri: "ipfs://brief",
      brief_hash: BRIEF_HASH,
      criteria_hash: CRITERIA_HASH,
      heldout_commitment: null,
      verifier: null,
      commit_secs: 60,
      reveal_secs: 120,
      pick_secs: 180,
      fallback_secs: 240,
      max_entries: 0,
      max_winners: 1,
      invited: [],
      parent: null,
    },
  });

  // A value of zero is a value. It is not "absent", and it is not replaced by the default.
  const zeros = postTaskCall(TENDER, { ...MIN_INPUT, parent: 0n, maxWinners: 0 });
  expect(zeros.args).toMatchObject({ task: { parent: "0", max_winners: 0 } });
});

test("deposit_call_msg_for_other_account", () => {
  // The vault credits the sender when `msg` is empty, and the named account for exactly this
  // object (vault.rs, `DepositMsg`).
  const own = depositCall(TOKEN, TENDER, 5_000_000n);
  expect(own.args.msg).toBe("");

  const other = depositCall(TOKEN, TENDER, 5_000_000n, BOB);
  expect(other.args.msg).toBe('{"for":"bob.near"}');
  expect(JSON.parse(other.args.msg as string)).toStrictEqual({ for: BOB });

  // It is a call to the token, which calls Tender back.
  expect(other.receiverId).toBe(TOKEN);
  expect(other.methodName).toBe("ft_transfer_call");
  expect(other.args.receiver_id).toBe(TENDER);
  expect(other.args.amount).toBe("5000000");
});

test("to_connector_action_strings", () => {
  // 1 NEAR is 10^24 yoctoNEAR, far above 2^53, so the deposit has to reach the wallet as a string.
  const call = storageDepositCall(TENDER, 10n ** 24n, BOB);
  const action = toConnectorAction(call);
  expect(action).toStrictEqual({
    type: "FunctionCall",
    params: {
      methodName: "storage_deposit",
      args: { account_id: BOB },
      gas: "10000000000000",
      deposit: "1000000000000000000000000",
    },
  });
  expect(typeof action.params.gas).toBe("string");
  expect(typeof action.params.deposit).toBe("string");

  // The action holds nothing that JSON cannot carry, whatever the call.
  for (const entry of wire()) {
    const { params } = toConnectorAction(entry.call);
    expect(params.methodName, entry.name).toBe(entry.call.methodName);
    expect(params.gas, entry.name).toBe(entry.call.gas.toString());
    expect(params.deposit, entry.name).toBe(entry.call.deposit.toString());
    expect(JSON.parse(JSON.stringify(params.args)), entry.name).toStrictEqual(entry.call.args);
  }
});

test("spend_calls_attach_one_yocto", () => {
  // A call that spends from the vault or moves money out attaches exactly 1 yoctoNEAR (the
  // contract's `authorize_spend` and `assert_one_yocto`), which a function-call key cannot do.
  expect(ONE_YOCTO).toBe(1n);
  const spends = [
    postTaskCall(TENDER, MIN_INPUT),
    topUpTaskCall(TENDER, 1n, 10n),
    withdrawCall(TENDER, TOKEN, 10n),
    withdrawCall(TENDER, TOKEN, 10n, BOB),
    storageWithdrawCall(TENDER),
    storageWithdrawCall(TENDER, 10n),
    depositCall(TOKEN, TENDER, 10n),
    depositCall(TOKEN, TENDER, 10n, BOB),
    addDelegateCall(TENDER, PUBLIC_KEY, TOKEN, 1n, 2n),
    removeDelegateCall(TENDER, PUBLIC_KEY),
    // The agent bond (contract Task 16b): registering and the way out take exactly 1 yoctoNEAR,
    // which is why no function-call key, a delegate key among them, can send them. The owner's two
    // setters take it too.
    registerAgentCall(TENDER, "ipfs://profile", PROFILE_HASH, []),
    unregisterAgentCall(TENDER),
    claimAgentBondCall(TENDER),
    setAgentBondCall(TENDER, TOKEN, 1n),
    setAgentBondCooldownCall(TENDER, 5),
  ];
  for (const call of spends) {
    expect(call.deposit, `${call.receiverId}.${call.methodName}`).toBe(ONE_YOCTO);
  }
});

test("delegate_option_attaches_no_deposit_and_changes_nothing_else", () => {
  // A delegate key is a function-call key, which cannot attach a deposit. With `delegate: true` the
  // spend goes through `authorize_spend`'s delegate path (the caps the account registered for the
  // key), so no yoctoNEAR is attached; every other part of the call is the one it always was.
  const post = postTaskCall(TENDER, FULL_INPUT);
  const topUp = topUpTaskCall(TENDER, 42n, 500n);
  expect(postTaskCall(TENDER, FULL_INPUT, { delegate: true })).toStrictEqual({
    ...post,
    deposit: 0n,
  });
  expect(topUpTaskCall(TENDER, 42n, 500n, { delegate: true })).toStrictEqual({
    ...topUp,
    deposit: 0n,
  });
  // Anything but `delegate: true` keeps the 1 yoctoNEAR of a spend from a full-access key.
  for (const opts of [undefined, {}, { delegate: false }]) {
    expect(postTaskCall(TENDER, FULL_INPUT, opts).deposit).toBe(ONE_YOCTO);
    expect(topUpTaskCall(TENDER, 42n, 500n, opts).deposit).toBe(ONE_YOCTO);
  }
});

test("commit_reveal_pick_attach_zero", () => {
  // These methods are not `#[payable]`, so the contract refuses any NEAR attached to them. Zero
  // is also what lets a function-call key send them.
  const free = [
    commitCall(TENDER, 1n, COMMITMENT),
    revealCall(TENDER, 1n, CONTENT_HASH, SALT, "ipfs://work"),
    pickCall(TENDER, 1n, [{ account: ALICE, bps: 10_000 }], SCORECARD_HASH, "ipfs://scorecard"),
    pickCall(TENDER, 1n, [], SCORECARD_HASH, "ipfs://scorecard"),
    voidTaskCall(TENDER, 1n),
    cleanupCall(TENDER, 1n),
    // The test token's `mint` is not payable either.
    mintCall(TOKEN, ALICE, 1n),
  ];
  for (const call of free) {
    expect(call.deposit, `${call.receiverId}.${call.methodName}`).toBe(0n);
  }
});

test("bond_calls_have_no_delegate_form", () => {
  // A delegate key is a function-call key and attaches no deposit, but the contract takes
  // registering, unregistering and claiming with exactly 1 yoctoNEAR and no key that cannot attach
  // it. So these builders take no `SpendOptions`: a `delegate: true` slipped past the types (a
  // plain JS caller, a value from elsewhere) changes nothing, and the call still attaches 1.
  const asAny = (builder: unknown, ...args: unknown[]) =>
    (builder as (...a: unknown[]) => TenderCall)(...args);
  const opts = { delegate: true };
  const calls = [
    asAny(registerAgentCall, TENDER, "ipfs://profile", PROFILE_HASH, [], opts),
    asAny(unregisterAgentCall, TENDER, opts),
    asAny(claimAgentBondCall, TENDER, opts),
  ];
  for (const call of calls) {
    expect(call.deposit, call.methodName).toBe(ONE_YOCTO);
  }
});

// What the builders send.

test("every_builder_sends_the_expected_call", () => {
  // The table has all twenty builders: Tender's seventeen and the three token calls (the NEP-145
  // registration, and the test token's `mint`). One of those has Tender's method name
  // `storage_deposit`, so the receiver is part of the key.
  const covered = new Set(wire().map(({ call }) => `${call.receiverId} ${call.methodName}`));
  expect(covered.size).toBe(20);
  for (const { name, call, expected } of wire()) {
    expect(call, name).toStrictEqual(expected);
  }
});

test("gas_is_in_gas_units", () => {
  // Tgas times 10^12: 1 Tgas is 1_000_000_000_000 gas.
  expect(GAS).toStrictEqual({
    postTask: 30n * TERA,
    topUpTask: 20n * TERA,
    commit: 15n * TERA,
    reveal: 15n * TERA,
    pick: 60n * TERA,
    voidTask: 60n * TERA,
    cleanup: 150n * TERA,
    withdraw: 50n * TERA,
    storageDeposit: 10n * TERA,
    storageWithdraw: 15n * TERA,
    registerAgent: 15n * TERA,
    unregisterAgent: 15n * TERA,
    claimAgentBond: 15n * TERA,
    setAgentBond: 15n * TERA,
    setAgentBondCooldown: 15n * TERA,
    ftTransferCall: 100n * TERA,
    tokenStorageDeposit: 10n * TERA,
    mint: 15n * TERA,
    addDelegate: 15n * TERA,
    removeDelegate: 15n * TERA,
  });
  // `withdraw` fails with E_GAS below 35 Tgas prepaid (MIN_WITHDRAW_GAS in the contract).
  expect(GAS.withdraw).toBeGreaterThanOrEqual(35n * TERA);
});

test("optional_arguments_are_left_out_not_undefined", () => {
  const key = (call: TenderCall) => Object.keys(call.args);
  expect(key(withdrawCall(TENDER, TOKEN, 1n))).toStrictEqual(["token", "amount"]);
  expect(key(withdrawCall(TENDER, TOKEN, 1n, BOB))).toStrictEqual(["token", "amount", "to"]);
  expect(key(storageDepositCall(TENDER, 1n))).toStrictEqual([]);
  expect(key(storageDepositCall(TENDER, 1n, BOB))).toStrictEqual(["account_id"]);
  expect(key(storageWithdrawCall(TENDER))).toStrictEqual([]);
  // Zero is an amount. It must not read as "all of it".
  expect(storageWithdrawCall(TENDER, 0n).args).toStrictEqual({ amount: "0" });
});

test("storage_deposits_attach_the_amount", () => {
  // Tender's `storage_deposit` credits whatever NEAR is attached, so the amount is the deposit.
  expect(storageDepositCall(TENDER, 123_456n).deposit).toBe(123_456n);
  // The token's NEP-145 `storage_deposit`: 0.00125 NEAR by default, or the amount given.
  expect(tokenStorageDepositCall(TOKEN, ALICE).deposit).toBe(1_250_000_000_000_000_000_000n);
  expect(tokenStorageDepositCall(TOKEN, ALICE, 2n * 10n ** 21n).deposit).toBe(2n * 10n ** 21n);
});

test("only_contract_fields_reach_the_wire", () => {
  // TypeScript rejects extra properties only on an object literal. A value that came from
  // elsewhere may carry more, and the contract rejects any key it does not know.
  const input = { ...MIN_INPUT, note: "not a contract field" } as PostTaskInput;
  const { task } = postTaskCall(TENDER, input).args as { task: Record<string, unknown> };
  expect(sorted(Object.keys(task))).toStrictEqual(sorted(TASK_KEYS));

  const winner = { account: ALICE, bps: 10_000, amount: "1" };
  const pick = pickCall(TENDER, 1n, [winner], SCORECARD_HASH, "ipfs://scorecard");
  expect(pick.args.winners).toStrictEqual([{ account: ALICE, bps: 10_000 }]);
});

test("calls_are_json_safe_and_do_not_alias_the_callers_arrays", () => {
  // `JSON.stringify` throws on a bigint and drops an `undefined`, so a round trip that returns the
  // same value proves there is neither.
  for (const { name, call } of wire()) {
    expect(JSON.parse(JSON.stringify(call.args)), name).toStrictEqual(call.args);
  }

  const invited = [BOB];
  const tags = ["rust"];
  const winner = { account: ALICE, bps: 10_000 };
  const post = postTaskCall(TENDER, { ...MIN_INPUT, invited });
  const register = registerAgentCall(TENDER, "ipfs://profile", PROFILE_HASH, tags);
  const pick = pickCall(TENDER, 1n, [winner], SCORECARD_HASH, "ipfs://scorecard");
  invited.push("carol.near");
  tags.push("audit");
  winner.bps = 1;
  expect(post.args).toMatchObject({ task: { invited: [BOB] } });
  expect(register.args.tags).toStrictEqual(["rust"]);
  expect(pick.args.winners).toStrictEqual([{ account: ALICE, bps: 10_000 }]);
});

// Checked against the contract's own source.
//
// The contract's change methods reject a top-level key they do not take
// (`#[deny_unknown_arguments]`), and `post_task`'s `task` and each `pick` winner reject an unknown
// field. A misspelled key therefore fails on chain, and nothing short of a sandbox run would show
// it. These tests read the Rust signatures and compare every name, and whether the method is
// `#[payable]`, with what the builders send.

/** The repo root, three directories up from this file. */
const REPO = new URL("../../../", import.meta.url);

interface RustMethod {
  payable: boolean;
  params: { name: string; optional: boolean }[];
}

/**
 * The methods that plan 01 has not built yet (Tasks 13 and 15), as those task briefs give them.
 * Once the contract defines one, its source is checked instead.
 */
const PLANNED: Record<string, RustMethod> = {
  top_up_task: {
    payable: true,
    params: [
      { name: "task_id", optional: false },
      { name: "amount", optional: false },
    ],
  },
  add_delegate: {
    payable: true,
    params: [
      { name: "public_key", optional: false },
      { name: "token", optional: false },
      { name: "per_task_cap", optional: false },
      { name: "total_cap", optional: false },
    ],
  },
  remove_delegate: { payable: true, params: [{ name: "public_key", optional: false }] },
};

const sources = new Map<string, string>();

/** Every `.rs` file in the repo directory `dir`, as one string. */
function readSources(dir: string): string {
  const cached = sources.get(dir);
  if (cached !== undefined) return cached;
  const path = fileURLToPath(new URL(dir, REPO));
  const all = readdirSync(path)
    .filter((file) => file.endsWith(".rs"))
    .map((file) => readFileSync(`${path}${file}`, "utf8"))
    .join("\n");
  sources.set(dir, all);
  return all;
}

/** Splits `text` at the commas that are not inside `<>`, `()` or `[]`. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if ("<([".includes(char)) depth += 1;
    if (">)]".includes(char)) depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

/**
 * The method `name` in `source`: its arguments, which of them are `Option`s (and so may be left
 * out), and whether it is `#[payable]`. `declaration` is the text before the name, `pub fn ` for
 * Tender's public methods. There must be exactly one definition.
 */
function rustMethod(source: string, name: string, declaration: string): RustMethod {
  const matches = [...source.matchAll(new RegExp(`${declaration}${name}\\(([^)]*)\\)`, "g"))];
  const match = matches[0];
  if (matches.length !== 1 || match === undefined) {
    throw new Error(`expected one \`${declaration}${name}(\`, found ${matches.length}`);
  }
  // The attributes are the lines of `#[...]` right above the method.
  const above = source.slice(0, match.index).split("\n");
  above.pop(); // the indentation in front of the method
  const attributes: string[] = [];
  for (const line of above.reverse()) {
    if (!line.trim().startsWith("#[")) break;
    attributes.push(line.trim());
  }
  const params = splitTopLevel(match[1] ?? "")
    .filter((param) => param.includes(":")) // not `&mut self`
    .map((param) => {
      const colon = param.indexOf(":");
      return {
        name: param.slice(0, colon).trim(),
        optional: param
          .slice(colon + 1)
          .trim()
          .startsWith("Option<"),
      };
    });
  return { payable: attributes.includes("#[payable]"), params };
}

/** The public fields of `struct name` in `source`, in order. */
function rustFields(source: string, name: string): string[] {
  const body = new RegExp(`pub struct ${name} \\{([^}]*)\\}`).exec(source)?.[1];
  if (body === undefined) throw new Error(`no \`pub struct ${name}\` in the contract source`);
  return [...body.matchAll(/^\s*pub (\w+):/gm)].flatMap((field) => (field[1] ? [field[1]] : []));
}

/** The contract's definition of the method that `call` calls. */
function definitionOf(call: TenderCall): RustMethod {
  const planned = PLANNED[call.methodName];
  if (call.receiverId === TENDER) {
    const source = readSources("contract/tender/src/");
    return source.includes(`pub fn ${call.methodName}(`)
      ? rustMethod(source, call.methodName, "pub fn ")
      : (planned ?? rustMethod(source, call.methodName, "pub fn "));
  }
  // A token. The test token implements NEP-141 and NEP-145 trait methods, which are not `pub`.
  return rustMethod(readSources("contract/test-token/src/"), call.methodName, "fn ");
}

test("argument_names_match_the_contract_source", () => {
  for (const { name, call } of wire()) {
    const method = definitionOf(call);
    const known = method.params.map((param) => param.name);
    const required = method.params.filter((param) => !param.optional).map((param) => param.name);
    const sent = Object.keys(call.args);
    for (const key of sent) {
      expect(known, `${name}: \`${key}\` is not an argument of ${call.methodName}`).toContain(key);
    }
    for (const key of required) {
      expect(sent, `${name}: ${call.methodName} needs \`${key}\``).toContain(key);
    }
  }
});

/** The call of `wire()` that is called `name`. */
function wired(name: string): TenderCall {
  const entry = wire().find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`no call named ${name} in wire()`);
  return entry.call;
}

test("nested_argument_names_match_the_contract_source", () => {
  const source = readSources("contract/tender/src/");

  // `task` holds every field of `PostTaskArgs`, the optional ones as null, and nothing else.
  const { task } = wired("postTaskCall").args as { task: Record<string, unknown> };
  expect(sorted(Object.keys(task))).toStrictEqual(sorted(rustFields(source, "PostTaskArgs")));
  expect(sorted(TASK_KEYS)).toStrictEqual(sorted(rustFields(source, "PostTaskArgs")));

  // A winner is exactly a `WinnerArg`.
  const { winners } = wired("pickCall").args as { winners: Record<string, unknown>[] };
  expect(winners.length).toBeGreaterThan(0);
  for (const winner of winners) {
    expect(sorted(Object.keys(winner))).toStrictEqual(sorted(rustFields(source, "WinnerArg")));
  }
});

test("deposits_follow_the_contracts_payable_methods", () => {
  for (const { name, call } of wire()) {
    const { payable } = definitionOf(call);
    if (payable) {
      expect(call.deposit, `${name}: ${call.methodName} is payable`).toBeGreaterThan(0n);
    } else {
      expect(call.deposit, `${name}: ${call.methodName} is not payable`).toBe(0n);
    }
  }
});
