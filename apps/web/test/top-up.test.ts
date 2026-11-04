import {
  STORAGE_BYTE_COST,
  storageDepositCall,
  type TenderCall,
  topUpTaskCall,
} from "@tender/shared";
import { expect, test, vi } from "vitest";
import { submitRefund } from "../lib/refund";
import {
  funderRecordBytes,
  MAX_FUNDERS,
  planTopUp,
  submitTopUp,
  TopUpFailure,
  type TopUpTerms,
  topUpProblem,
  topUpStorage,
} from "../lib/topUp";
import type { SendResult } from "../lib/wallet";
import { TransactionFailed, WalletError } from "../lib/walletErrors";
import { rejection } from "./support";

// Topping up a task from the vault, held to the contract's rules (`top_up_task`), and refunding
// one (`void_task`): what the form refuses before anything is sent, and what is sent.

const ALICE = "alice.testnet";
const TOKEN = "tusdc.tender-team.testnet";
const COMMIT = 1_793_307_769_820_229_000n;
const NOW = COMMIT - 60_000_000_000n;

function terms(overrides: Partial<TopUpTerms> = {}): TopUpTerms {
  return {
    token: TOKEN,
    enabled: true,
    paused: false,
    minReward: 1_000_000n,
    maxReward: 100_000_000n,
    reward: 1_500_000n,
    funders: 1,
    isFunder: false,
    commitDeadline: COMMIT,
    settled: false,
    vault: 5_000_000n,
    storage: { total: 5n * 10n ** 22n, available: 10n ** 22n },
    ...overrides,
  };
}

test("a_new_funders_first_top_up_is_at_least_the_minimum_reward", () => {
  expect(topUpProblem(999_999n, terms(), NOW)).toBe(
    "Your first top-up of a task must be at least 1.00 tUSDC.",
  );
  expect(topUpProblem(1_000_000n, terms(), NOW)).toBeNull();
  // An account that funds the task already adds any amount.
  expect(topUpProblem(1n, terms({ isFunder: true }), NOW)).toBeNull();
});

test("a_top_up_is_held_to_every_other_rule_of_the_contract_in_its_order", () => {
  expect(topUpProblem(2_000_000n, terms({ paused: true }), NOW)).toBe(
    "Tender isn't taking top-ups right now.",
  );
  // The commit window is half-open: at the deadline itself it is over.
  expect(topUpProblem(2_000_000n, terms(), COMMIT - 1n)).toBeNull();
  expect(topUpProblem(2_000_000n, terms(), COMMIT)).toBe(
    "This task stopped taking top-ups: its commit window has closed.",
  );
  expect(topUpProblem(2_000_000n, terms({ settled: true }), NOW)).toMatch(/stopped taking/);
  // Fifty funders take no new one, but each of them can still add.
  expect(topUpProblem(2_000_000n, terms({ funders: MAX_FUNDERS }), NOW)).toBe(
    "This task has 50 funders, the most it can have.",
  );
  expect(topUpProblem(1n, terms({ funders: MAX_FUNDERS, isFunder: true }), NOW)).toBeNull();
  expect(topUpProblem(2_000_000n, terms({ enabled: false }), NOW)).toBe(
    "Tender isn't taking this token right now.",
  );
  expect(topUpProblem(98_500_001n, terms({ vault: 10n ** 9n }), NOW)).toBe(
    "That would take the reward past 100.00 tUSDC, the most Tender takes for this token.",
  );
  expect(topUpProblem(98_500_000n, terms({ vault: 10n ** 9n }), NOW)).toBeNull();
  expect(topUpProblem(5_000_001n, terms(), NOW)).toBe("That's more than you have in the vault.");
  expect(topUpProblem(2_000_000n, terms({ storage: null }), NOW)).toBe(
    "Set up your account on the Wallet page first.",
  );
});

test("a_new_funder_whose_storage_cannot_hold_its_record_adds_storage_in_the_same_approval", () => {
  const bytes = funderRecordBytes(ALICE);
  expect(bytes).toBe(BigInt(4 + ALICE.length + 16));
  const tight = terms({ storage: { total: 10n ** 22n, available: 10n * STORAGE_BYTE_COST } });
  const short = topUpStorage(tight, ALICE);
  expect(short).toBe((bytes - 10n) * STORAGE_BYTE_COST);
  expect(topUpStorage(terms(), ALICE)).toBe(0n);
  expect(topUpStorage({ ...tight, isFunder: true }, ALICE)).toBe(0n);

  expect(planTopUp({ taskId: "7", amount: 2_000_000n, storageTopUp: short })).toEqual([
    storageDepositCall("tender.testnet", short),
    topUpTaskCall("tender.testnet", 7n, 2_000_000n),
  ]);
  expect(planTopUp({ taskId: "7", amount: 2_000_000n, storageTopUp: 0n })).toEqual([
    topUpTaskCall("tender.testnet", 7n, 2_000_000n),
  ]);
});

const toppedUp: SendResult = {
  txHashes: ["TX"],
  events: [
    {
      event: "task_topped_up",
      data: { task_id: "7", funder: ALICE, amount: "2000000", reward: "3500000" },
    },
  ],
};

function topUpDeps(read: TopUpTerms = terms()) {
  return {
    account: vi.fn((): string | null => ALICE),
    readTerms: vi.fn(async () => read),
    signAndSend: vi.fn(async (): Promise<SendResult> => toppedUp),
    nowNs: () => NOW,
  };
}

test("a_top_up_reads_the_terms_again_and_sends_one_approval", async () => {
  const deps = topUpDeps();
  const result = await submitTopUp(
    { taskId: "7", account: ALICE, amount: 2_000_000n, shownStorage: 0n },
    deps,
  );
  expect(result).toEqual({ kind: "toppedUp", amount: "2000000", reward: "3500000" });
  expect(deps.readTerms).toHaveBeenCalledWith("7", ALICE);
  expect(deps.signAndSend).toHaveBeenCalledExactlyOnceWith([
    topUpTaskCall("tender.testnet", 7n, 2_000_000n),
  ]);
});

test("a_top_up_the_fresh_terms_refuse_is_not_sent", async () => {
  for (const [read, words] of [
    [terms({ vault: 1_000_000n }), "That's more than you have in the vault."],
    [terms({ storage: { total: 10n ** 22n, available: 0n } }), /^Your storage changed\./],
  ] as const) {
    const deps = topUpDeps(read);
    const error = await rejection(
      submitTopUp({ taskId: "7", account: ALICE, amount: 2_000_000n, shownStorage: 0n }, deps),
    );
    expect(error).toBeInstanceOf(TopUpFailure);
    expect(error.message).toMatch(words);
    expect(deps.signAndSend).not.toHaveBeenCalled();
  }
});

test("a_top_up_refused_on_chain_is_said_in_words", async () => {
  for (const [code, words] of [
    ["E_LIMIT", "This task has 50 funders, the most it can have."],
    ["E_PHASE", "This task stopped taking top-ups: its commit window has closed."],
    ["E_FUNDS", "Your vault doesn't hold that much."],
    ["E_REWARD", "That amount is outside what Tender takes for this token and task."],
    ["E_PAUSED", "Tender isn't taking top-ups right now."],
  ] as const) {
    const deps = topUpDeps();
    deps.signAndSend.mockRejectedValueOnce(new TransactionFailed("TX", code));
    const error = await rejection(
      submitTopUp({ taskId: "7", account: ALICE, amount: 2_000_000n, shownStorage: 0n }, deps),
    );
    expect(error.message, code).toBe(words);
  }
});

test("a_refund_is_one_void_task_and_says_who_got_what_back", async () => {
  const deps = {
    account: () => ALICE,
    signAndSend: vi.fn(
      async (_calls: readonly TenderCall[]): Promise<SendResult> => ({
        txHashes: ["TX"],
        events: [
          {
            event: "voided",
            data: {
              task_id: "7",
              reason: "no_reveals",
              by: null,
              refunds: [{ account: "poster.testnet", amount: "1500000" }],
              scorecard_hash: null,
              scorecard_uri: null,
            },
          },
        ],
      }),
    ),
  };
  expect(await submitRefund({ taskId: "7", account: ALICE }, deps)).toEqual({
    kind: "voided",
    refunds: [{ account: "poster.testnet", amount: "1500000" }],
  });
  expect(deps.signAndSend.mock.calls[0]?.[0]).toEqual([
    {
      receiverId: "tender.testnet",
      methodName: "void_task",
      args: { task_id: "7" },
      gas: 60_000_000_000_000n,
      deposit: 0n,
    },
  ]);

  for (const [code, words] of [
    ["E_SETTLED", "This task is settled already: someone refunded or picked it first."],
    ["E_PHASE", "This task can't be refunded yet."],
  ] as const) {
    deps.signAndSend.mockRejectedValueOnce(new TransactionFailed("TX", code));
    expect((await rejection(submitRefund({ taskId: "7", account: ALICE }, deps))).message).toBe(
      words,
    );
  }
  deps.signAndSend.mockRejectedValueOnce(
    new WalletError("send", new Error("User cancelled the action")),
  );
  expect((await rejection(submitRefund({ taskId: "7", account: ALICE }, deps))).message).toMatch(
    /^The wallet didn't finish/,
  );
});
