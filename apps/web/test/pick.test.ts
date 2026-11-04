import {
  ApiError,
  type BlobUpload,
  pickCall,
  sha256Hex,
  type TaskDetailResponse,
  type TenderCall,
} from "@tender/shared";
import { expect, test, vi } from "vitest";
import { PickFailure, type PickInput, submitPick } from "../lib/pick";
import type { SendResult } from "../lib/wallet";
import { TransactionFailed, WalletError, WalletResultUnreadable } from "../lib/walletErrors";
import { rejection } from "./support";
import { AT, detail, entry, SECOND } from "./tasks";

// A pick from the task page: the scorecard is written from the person's choice, checked by the
// shared rules, uploaded and picked with in one approval, in that order, and every failure is said
// in words that tell whether the scorecard went up.

const PICKER = "poster.testnet";
const CRITERIA = "22".repeat(32);
const HELDOUT = "33".repeat(32);
const blob = (hash: string) => `http://api.test/v1/blobs/${hash}`;

/**
 * The SHA-256 of the scorecard of the pick by hand that packages/shared/test/pick.test.ts and
 * packages/mcp/test/tools.test.ts pin: the same input, so the same bytes from the page as from the
 * MCP tool.
 */
const HAND_PICK_HASH = "54ad6282bb3f35bdea6c7e6f77a3b2bde7576298e19ec3e785f797afb2942eb1";

/** The task of that pick, as the API lists it: four entries, three of them revealed. */
function pickedTask(task: Partial<TaskDetailResponse["task"]> = {}): TaskDetailResponse {
  return detail(
    {
      verifier: PICKER,
      criteria_hash: CRITERIA,
      heldout_commitment: HELDOUT,
      max_winners: 2,
      reveal_count: 3,
      commit_count: 4,
      ...task,
    },
    {
      entries: [
        entry("bob.testnet", {
          committed_height: "120",
          content_hash: "bb".repeat(32),
          uri: blob("bb".repeat(32)),
          revealed: true,
        }),
        entry("alice.testnet", {
          entry_index: 1,
          committed_height: "120",
          content_hash: "aa".repeat(32),
          uri: blob("aa".repeat(32)),
          revealed: true,
        }),
        entry("carol.testnet", { entry_index: 2, committed_height: "100" }),
        entry("dave.testnet", {
          entry_index: 3,
          committed_height: "90",
          content_hash: "cc".repeat(32),
          uri: blob("cc".repeat(32)),
          revealed: true,
        }),
      ],
    },
  );
}

const WINNERS = [
  { account: "bob.testnet", bps: 6_000 },
  { account: "alice.testnet", bps: 4_000 },
];

const INPUT: PickInput = {
  taskId: "7",
  account: PICKER,
  judgeAccount: "judge.tender-team.testnet",
  winners: WINNERS,
  reasons: { "alice.testnet": "  Covers every case.  ", "dave.testnet": "" },
  writtenAt: new Date("2026-11-04T10:00:00.000Z"),
};

const picked = (taskId = "7"): SendResult => ({
  txHashes: ["TX_PICK"],
  events: [
    {
      event: "picked",
      data: {
        task_id: taskId,
        by: PICKER,
        winners: [],
        fee: "0",
        scorecard_hash: HAND_PICK_HASH,
        scorecard_uri: blob(HAND_PICK_HASH),
      },
    },
  ],
});

/** The world of a pick: the API, the sign-in and the wallet, each recorded in one log. */
function world(options: { detail?: TaskDetailResponse | null; token?: string | null } = {}) {
  const order: string[] = [];
  let token = options.token === undefined ? "tok" : options.token;
  const uploads: BlobUpload[] = [];
  const sends: TenderCall[][] = [];
  const deps = {
    account: vi.fn((): string | null => PICKER),
    token: vi.fn(() => token),
    signIn: vi.fn(async () => {
      order.push("signIn");
      token = "tok-new";
    }),
    getTask: vi.fn(async (id: string) => {
      order.push(`getTask ${id}`);
      return options.detail === undefined ? pickedTask() : options.detail;
    }),
    uploadBlob: vi.fn(async (_token: string, upload: BlobUpload) => {
      order.push("upload");
      uploads.push(upload);
      const hash = sha256Hex(upload.bytes);
      return { sha256: hash, uri: blob(hash) };
    }),
    signAndSend: vi.fn(async (calls: readonly TenderCall[]): Promise<SendResult> => {
      order.push("send");
      sends.push([...calls]);
      return picked();
    }),
    // Inside the verifier's window.
    nowNs: () => AT.reveal + 30n * SECOND,
  };
  return { deps, order, uploads, sends };
}

test("a_pick_uploads_the_scorecard_the_mcp_tool_uploads_and_picks_with_its_hash", async () => {
  const { deps, order, uploads, sends } = world();
  const stages: string[] = [];

  const result = await submitPick(INPUT, deps, (stage) => stages.push(stage));

  expect(result).toEqual({ kind: "picked", txHash: "TX_PICK", scorecardHash: HAND_PICK_HASH });
  // The task is read again first; nothing is published before every check, and the pick comes last.
  expect(order).toEqual(["getTask 7", "upload", "send"]);
  expect(stages).toEqual(["check", "upload", "wallet"]);
  // The same bytes as `pick_winners` uploads for the same pick.
  expect(uploads).toHaveLength(1);
  expect(uploads[0]?.kind).toBe("scorecard");
  expect(uploads[0]?.contentType).toBe("application/json");
  expect(sha256Hex(uploads[0]?.bytes ?? new Uint8Array())).toBe(HAND_PICK_HASH);
  // One approval: `pick`, with the scorecard's hash and the address the API serves it at.
  expect(sends).toEqual([
    [pickCall("tender.testnet", 7n, WINNERS, HAND_PICK_HASH, blob(HAND_PICK_HASH))],
  ]);
  const card = JSON.parse(new TextDecoder().decode(uploads[0]?.bytes));
  expect(card.verifier).toBe(PICKER);
  expect(card.judge).toEqual({ software: "tender-web/1", model: null });
});

test("picking_nobody_publishes_a_scorecard_with_no_winner_and_refunds", async () => {
  const { deps, uploads } = world();
  deps.signAndSend.mockResolvedValueOnce({
    txHashes: ["TX_VOID"],
    events: [
      {
        event: "voided",
        data: {
          task_id: "7",
          reason: "no_award",
          by: PICKER,
          refunds: [],
          scorecard_hash: "ee".repeat(32),
          scorecard_uri: blob("ee".repeat(32)),
        },
      },
    ],
  });

  const result = await submitPick({ ...INPUT, winners: [] }, deps);

  expect(result).toMatchObject({ kind: "voided", txHash: "TX_VOID" });
  const card = JSON.parse(new TextDecoder().decode(uploads[0]?.bytes));
  expect(card.winners).toEqual([]);
  expect(card.entries.map((one: { score: number }) => one.score)).toEqual([0, 0, 0]);
  expect(deps.signAndSend.mock.calls[0]?.[0]?.[0]?.args.winners).toEqual([]);
});

test("a_pick_the_shared_rules_refuse_publishes_nothing", async () => {
  // The index does not show bob's reveal yet: the pick waits, and nothing goes up.
  const lagging = pickedTask();
  lagging.entries = lagging.entries.map((one) =>
    one.account === "alice.testnet" ? { ...one, revealed: false } : one,
  );
  const cases: Array<[string, Partial<PickInput>, TaskDetailResponse | null, RegExp]> = [
    [
      "a winner the index does not show as revealed",
      {},
      lagging,
      /^Nothing was published or sent: alice\.testnet has no revealed entry in task 7.*try again\.$/,
    ],
    ["no such task", {}, null, /^Tender's API doesn't have this task right now\./],
    [
      "more winners than the task pays",
      {},
      pickedTask({ max_winners: 1 }),
      /^Nothing was published or sent: task 7 pays at most 1 winners/,
    ],
    [
      "shares that do not add up",
      { winners: [{ account: "bob.testnet", bps: 9_000 }] },
      pickedTask(),
      /add up to 9000, and they must add up to exactly 10000\.$/,
    ],
    [
      "the task's criteria not served",
      {},
      { ...pickedTask(), criteria: null },
      /doesn't serve this task's criteria/,
    ],
    [
      "a window that is not this account's",
      {},
      pickedTask({ verifier: "someone.testnet" }),
      /^The pick window isn't open for this account now\. Nothing was published or sent\.$/,
    ],
  ];
  for (const [what, change, found, words] of cases) {
    const { deps, uploads, sends } = world({ detail: found });
    const error = await rejection(submitPick({ ...INPUT, ...change }, deps));
    expect(error, what).toBeInstanceOf(PickFailure);
    expect(error.message, what).toMatch(words);
    expect((error as PickFailure).published, what).toBe(false);
    expect(uploads, what).toEqual([]);
    expect(sends, what).toEqual([]);
  }
});

test("a_pick_signs_in_first_when_there_is_no_token_and_again_after_a_401", async () => {
  const { deps, order } = world({ token: null });
  await submitPick(INPUT, deps);
  expect(order).toEqual(["getTask 7", "signIn", "upload", "send"]);

  const again = world();
  again.deps.uploadBlob.mockRejectedValueOnce(
    new ApiError(401, { error: "unauthorized", message: "no token" }),
  );
  await submitPick(INPUT, again.deps);
  expect(again.order).toEqual(["getTask 7", "signIn", "upload", "send"]);
  expect(again.deps.uploadBlob.mock.calls.map(([token]) => token)).toEqual(["tok", "tok-new"]);
});

test("a_pick_refused_on_chain_says_why_and_that_the_scorecard_is_published", async () => {
  const words: Array<[string | null, RegExp]> = [
    ["E_AUTH", /delegate key can spend within its caps but can never pick/],
    ["E_PHASE", /^The pick window isn't open for this account now\./],
    ["E_SETTLED", /^This task is settled already/],
    ["E_WINNERS", /^Tender refused the winners/],
    ["E_SOMETHING", /^Tender refused the pick \(E_SOMETHING\)\./],
    [null, /^The wallet didn't finish, and nothing changed on chain\./],
  ];
  for (const [code, expected] of words) {
    const { deps } = world();
    deps.signAndSend.mockRejectedValueOnce(new TransactionFailed("TX", code));
    const error = (await rejection(submitPick(INPUT, deps))) as PickFailure;
    expect(error.message, String(code)).toMatch(expected);
    expect(error.message, String(code)).toMatch(/The scorecard is published; nobody was paid\.$/);
    expect(error.published, String(code)).toBe(true);
    expect(error.stage, String(code)).toBe("wallet");
  }

  // A person who turns the request down in the wallet: nothing was sent.
  const { deps } = world();
  deps.signAndSend.mockRejectedValueOnce(
    new WalletError("send", new Error("User rejected the request")),
  );
  expect((await rejection(submitPick(INPUT, deps))).message).toMatch(/^The wallet didn't finish/);
});

test("a_pick_whose_outcome_the_wallet_cannot_tell_is_not_offered_again_as_failed", async () => {
  for (const thrown of [
    new WalletResultUnreadable("transaction"),
    new WalletError("send", new Error("the window closed")),
  ]) {
    const { deps } = world();
    deps.signAndSend.mockRejectedValueOnce(thrown);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await submitPick(INPUT, deps)).toEqual({
      kind: "unknown",
      scorecardHash: HAND_PICK_HASH,
    });
  }
});

test("a_pick_by_a_wallet_that_changed_account_is_not_sent", async () => {
  const { deps, sends } = world();
  deps.account.mockReturnValue("other.testnet");
  const error = (await rejection(submitPick(INPUT, deps))) as PickFailure;
  expect(error.message).toMatch(/^The wallet was disconnected or changed, so nothing was sent\./);
  expect(sends).toEqual([]);
});

test("a_scorecard_the_api_stores_under_another_hash_is_not_picked_with", async () => {
  const { deps, sends } = world();
  deps.uploadBlob.mockResolvedValueOnce({ sha256: "ff".repeat(32), uri: blob("ff".repeat(32)) });
  expect((await rejection(submitPick(INPUT, deps))).message).toBe(
    "Tender stored something other than the scorecard, so nothing was sent.",
  );
  const odd = world();
  odd.deps.uploadBlob.mockImplementationOnce(async (_token, upload) => ({
    sha256: sha256Hex(upload.bytes),
    uri: "javascript:alert(1)",
  }));
  await rejection(submitPick(INPUT, odd.deps));
  expect(sends).toEqual([]);
  expect(odd.sends).toEqual([]);
});
