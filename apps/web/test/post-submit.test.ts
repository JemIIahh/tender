import {
  ApiError,
  type BlobUpload,
  sha256Hex,
  storageShortfall,
  type TaskView,
  TaskViewSchema,
  type TenderCall,
  type TenderEvent,
  TenderEventSchema,
} from "@tender/shared";
import { expect, test, vi } from "vitest";
import { clearApiToken, keepToken, signInTicket } from "../lib/apiToken";
import { buildDocuments, POST_TASK_BYTES, type PostForm, VAULT_SLOT_BYTES } from "../lib/post";
import {
  liveToken,
  PostStopped,
  recentTasks,
  type SubmitDeps,
  SubmitFailure,
  type SubmitInput,
  submitPost,
} from "../lib/postSubmit";
import { RpcError } from "../lib/rpc";
import type { VaultData } from "../lib/vault";
import {
  TransactionFailed,
  WALLET_CANNOT_SIGN_MESSAGE,
  WalletCannotSign,
  WalletError,
  WalletNotConnected,
  WalletResultUnreadable,
} from "../lib/walletErrors";
import { JUDGE, regexForm, SECRET, TOKEN } from "./postForms";
import { rejection } from "./support";

// Posting a task, step by step (lib/postSubmit.ts), with the world stood in for: an API that keeps
// what it is sent, a vault that holds what a test says, and a wallet that sends what it is given.

const ALICE = "alice.testnet";
const CONTRACT = "tender.testnet";

interface World {
  /** Everything that happened, in order. */
  log: string[];
  /** The blobs the API was sent, with their kind. */
  blobs: Array<{ token: string; kind: string; bytes: Uint8Array }>;
  heldouts: Array<{ token: string; commitment: string; bytes: Uint8Array }>;
  /** What the wallet was asked to send. */
  sent: TenderCall[][];
  /** The token held for ALICE now. Null: none. */
  held: string | null;
  signIns: number;
  deps: SubmitDeps;
}

/** What one byte of Tender storage costs, in yoctoNEAR. */
const BYTE = 10n ** 19n;

function vaultData(o: {
  vault?: bigint;
  wallet?: bigint | null;
  storage?: boolean;
  /** The storage that is free, in yoctoNEAR. Room for 5,000 bytes unless said. */
  available?: bigint;
  enabled?: boolean;
}): VaultData {
  return {
    storage:
      o.storage === false
        ? null
        : { total: 50_000_000_000_000_000_000_000n, available: o.available ?? 5_000n * BYTE },
    rows: [
      {
        token: TOKEN,
        enabled: o.enabled ?? true,
        vault: o.vault ?? 0n,
        wallet: o.wallet === undefined ? 100_000_000n : o.wallet,
      },
    ],
  };
}

/** The event the contract logs for the task of `form` once the wallet has sent it. */
function createdEvent(form: PostForm, overrides: Record<string, unknown> = {}): TenderEvent {
  const docs = buildDocuments(form);
  return TenderEventSchema.parse({
    event: "task_created",
    data: {
      id: "17",
      poster: ALICE,
      token: TOKEN,
      reward: "5000000",
      fee_bps: 500,
      brief_uri: `http://api.test/v1/blobs/${docs.briefHash}`,
      brief_hash: docs.briefHash,
      criteria_hash: docs.criteriaHash,
      heldout_commitment: docs.heldoutCommitment,
      verifier: JUDGE,
      created_at: "1793307169820229000",
      commit_deadline: "1793307769820229000",
      reveal_deadline: "1793308069820229000",
      pick_deadline: "1793308669820229000",
      fallback_deadline: "1793309269820229000",
      max_entries: 0,
      max_winners: 1,
      invited: [],
      parent: null,
      ...overrides,
    },
  });
}

function world(
  form: PostForm,
  options: {
    held?: string | null;
    vault?: VaultData;
    /** Called for each upload with the count so far; throw to fail it. */
    onUpload?: (n: number, token: string) => void;
    send?: (calls: TenderCall[]) => Promise<{ events: TenderEvent[]; txHashes: string[] }>;
    account?: () => string | null;
    uploadReply?: (blob: BlobUpload) => { sha256: string; uri: string };
    /** What the vault says when it is read again, after the send failed. An error is thrown. */
    vaultThen?: VaultData | Error;
    /** The newest tasks on chain, for a look for an earlier post. An error is thrown. */
    recent?: TaskView[] | Error;
    /** Whether the person has stopped waiting, asked after each wait on the wallet. */
    stopped?: () => boolean;
  } = {},
): World {
  const w: World = {
    log: [],
    blobs: [],
    heldouts: [],
    sent: [],
    held: options.held === undefined ? "tok-1" : options.held,
    signIns: 0,
    deps: undefined as unknown as SubmitDeps,
  };
  let uploads = 0;
  let reads = 0;
  w.deps = {
    account: options.account ?? (() => ALICE),
    token: (account) => (account === ALICE ? w.held : null),
    async signIn() {
      w.log.push("signIn");
      w.signIns++;
      w.held = `tok-${w.signIns + 1}`;
      return w.held;
    },
    async uploadBlob(token, blob) {
      w.log.push(`blob:${blob.kind}`);
      options.onUpload?.(++uploads, token);
      w.blobs.push({ token, kind: blob.kind, bytes: blob.bytes });
      return (
        options.uploadReply?.(blob) ?? {
          sha256: sha256Hex(blob.bytes),
          uri: `http://api.test/v1/blobs/${sha256Hex(blob.bytes)}`,
        }
      );
    },
    async uploadHeldout(token, commitment, bytes) {
      w.log.push("heldout");
      options.onUpload?.(++uploads, token);
      w.heldouts.push({ token, commitment, bytes });
    },
    async readVault() {
      w.log.push("vault");
      if (++reads > 1 && options.vaultThen !== undefined) {
        if (options.vaultThen instanceof Error) throw options.vaultThen;
        return options.vaultThen;
      }
      return options.vault ?? vaultData({});
    },
    async recentTasks() {
      w.log.push("recent");
      if (options.recent instanceof Error) throw options.recent;
      return options.recent ?? [];
    },
    stopped: options.stopped,
    async signAndSend(calls) {
      w.log.push("send");
      w.sent.push([...calls]);
      return options.send
        ? options.send([...calls])
        : { events: [createdEvent(form)], txHashes: calls.map((_, i) => `tx${i + 1}`) };
    },
  };
  return w;
}

const input = (form: PostForm, patch: Partial<SubmitInput> = {}): SubmitInput => ({
  form,
  account: ALICE,
  tokenId: TOKEN,
  judgeAccount: JUDGE,
  ...patch,
});

// ---- The order ----------------------------------------------------------------------------------

test("the_documents_are_uploaded_before_the_wallet_is_asked_for_anything", async () => {
  const form = regexForm({ amount: "5" });
  const w = world(form, { held: null, vault: vaultData({ vault: 2_000_000n }) });

  const result = await submitPost(input(form), w.deps);

  // Sign in, then the three uploads, then the vault, then the one send.
  expect(w.log).toEqual(["signIn", "blob:brief", "blob:criteria", "heldout", "vault", "send"]);
  expect(result).toEqual({ kind: "posted", taskId: "17" });
  expect(w.sent).toHaveLength(1);
  // A vault that is 3 short: the deposit comes first, in the same send.
  expect(w.sent[0]?.map((call) => call.methodName)).toEqual(["ft_transfer_call", "post_task"]);
  expect(w.sent[0]?.[0]?.args.amount).toBe("3000000");
});

test("a_task_whose_vault_holds_the_reward_sends_only_the_post", async () => {
  const form = regexForm({ amount: "5" });
  const w = world(form, { vault: vaultData({ vault: 5_000_000n }) });

  await submitPost(input(form), w.deps);

  expect(w.sent[0]?.map((call) => call.methodName)).toEqual(["post_task"]);
});

test("a_storage_balance_that_is_short_is_topped_up_in_the_same_send_before_the_deposit", async () => {
  const form = regexForm({ amount: "5" });
  // 1,000 bytes are free. A post needs 1,600, and the first deposit of the token 200 more.
  const w = world(form, { vault: vaultData({ vault: 0n, available: 1_000n * BYTE }) });

  await submitPost(input(form), w.deps);

  const [calls] = w.sent;
  expect(calls?.map((call) => [call.receiverId, call.methodName])).toEqual([
    [CONTRACT, "storage_deposit"],
    [TOKEN, "ft_transfer_call"],
    [CONTRACT, "post_task"],
  ]);
  // The 800 bytes that are missing, in NEAR from the account that signs: no account is named.
  expect(calls?.[0]?.args).toEqual({});
  expect(calls?.[0]?.deposit).toBe(800n * BYTE);
});

test("a_storage_balance_that_pays_for_the_post_sends_no_top_up", async () => {
  const form = regexForm({ amount: "5" });
  // The vault holds the reward, so there is no deposit; the post needs 1,600 bytes, and 1,600 are free.
  const w = world(form, { vault: vaultData({ vault: 5_000_000n, available: 1_600n * BYTE }) });

  await submitPost(input(form), w.deps);

  expect(w.sent[0]?.map((call) => call.methodName)).toEqual(["post_task"]);
});

test("the_task_points_at_the_address_the_api_gave_the_brief", async () => {
  const form = regexForm();
  const docs = buildDocuments(form);
  const w = world(form);

  await submitPost(input(form), w.deps);

  const post = w.sent[0]?.at(-1);
  expect(post?.args.task).toMatchObject({
    brief_uri: `http://api.test/v1/blobs/${docs.briefHash}`,
  });
  // The bytes sent are the bytes the hashes on chain are of.
  expect(sha256Hex(w.blobs[0]?.bytes ?? new Uint8Array())).toBe(docs.briefHash);
  expect(sha256Hex(w.blobs[1]?.bytes ?? new Uint8Array())).toBe(docs.criteriaHash);
  expect(w.heldouts[0]?.commitment).toBe(docs.heldoutCommitment);
  expect(sha256Hex(w.heldouts[0]?.bytes ?? new Uint8Array())).toBe(docs.heldoutCommitment);
});

test("the_heldout_checks_go_to_the_heldout_route_and_nowhere_else", async () => {
  const form = regexForm();
  const w = world(form);

  await submitPost(input(form), w.deps);

  const decoder = new TextDecoder();
  // Not in a blob, and not in the calls the wallet is given.
  for (const blob of w.blobs) expect(decoder.decode(blob.bytes)).not.toContain(SECRET);
  expect(
    JSON.stringify(w.sent, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  ).not.toContain(SECRET);
  expect(decoder.decode(w.heldouts[0]?.bytes)).toContain(SECRET);
});

test("a_task_without_heldout_checks_uploads_none", async () => {
  const form = regexForm({ heldoutMatch: "", heldoutNoMatch: "" });
  const w = world(form);

  await submitPost(input(form), w.deps);

  expect(w.log).toEqual(["blob:brief", "blob:criteria", "vault", "send"]);
  expect(w.heldouts).toEqual([]);
});

// ---- Nothing is sent for what is wrong ----------------------------------------------------------

test("amounts_that_are_no_good_upload_nothing_and_send_nothing", async () => {
  for (const amount of ["", "0", "-1", "1e3", "1.2345678", "abc"]) {
    const form = regexForm({ amount });
    const w = world(form, { held: null });

    const failure = await rejection(submitPost(input(form), w.deps));

    expect(failure, amount).toBeInstanceOf(SubmitFailure);
    expect((failure as SubmitFailure).stage, amount).toBe("documents");
    // Not even a sign-in: the wallet is not asked to sign anything for a form that cannot post.
    expect(w.log, amount).toEqual([]);
  }
});

test("a_form_that_cannot_be_made_into_documents_sends_nothing", async () => {
  const form = regexForm({ title: "" });
  const w = world(form);

  const failure = (await rejection(submitPost(input(form), w.deps))) as SubmitFailure;

  expect(failure.stage).toBe("documents");
  expect(failure.message).toContain("The brief does not fit");
  expect(w.log).toEqual([]);
});

test("the_judge_chosen_in_a_build_that_does_not_know_it_sends_nothing", async () => {
  const form = regexForm({ verifier: "judge" });
  const w = world(form);

  const failure = (await rejection(
    submitPost(input(form, { judgeAccount: null }), w.deps),
  )) as SubmitFailure;

  expect(failure.stage).toBe("documents");
  expect(w.log).toEqual([]);
});

test("an_upload_that_fails_sends_nothing_to_the_wallet", async () => {
  const form = regexForm();
  const w = world(form, {
    onUpload: (n) => {
      if (n === 2) throw new ApiError(500, { error: "internal", message: "boom" });
    },
  });

  const failure = (await rejection(submitPost(input(form), w.deps))) as SubmitFailure;

  expect(failure.stage).toBe("upload");
  expect(failure.message).toBe(
    "The Tender API had a problem (status 500). Try again in a moment. Nothing was sent to your wallet.",
  );
  expect(w.log).toEqual(["blob:brief", "blob:criteria"]);
  expect(w.sent).toEqual([]);
});

test("a_blob_the_api_stored_as_something_else_is_not_posted", async () => {
  const form = regexForm();
  const wrongHash = world(form, {
    uploadReply: () => ({ sha256: "f".repeat(64), uri: "http://api.test/v1/blobs/x" }),
  });
  const tooLong = world(form, {
    uploadReply: (blob) => ({
      sha256: sha256Hex(blob.bytes),
      uri: `http://api.test/${"u".repeat(300)}`,
    }),
  });
  const notWeb = world(form, {
    uploadReply: (blob) => ({ sha256: sha256Hex(blob.bytes), uri: "javascript:alert(1)" }),
  });

  for (const w of [wrongHash, tooLong, notWeb]) {
    const failure = (await rejection(submitPost(input(form), w.deps))) as SubmitFailure;
    expect(failure.stage).toBe("upload");
    expect(failure.message).toBe(
      "Tender stored something other than what was sent, so nothing was posted.",
    );
    expect(w.sent).toEqual([]);
  }
});

test.each([
  { name: "the_judge", verifier: "judge", other: "", uploaded: true },
  { name: "the_judges_account_typed_in", verifier: "other", other: JUDGE, uploaded: true },
  { name: "the_poster", verifier: "me", other: "", uploaded: false },
  { name: "another_account", verifier: "other", other: "bob.testnet", uploaded: false },
] as const)(
  "the_held_out_checks_go_to_the_api_only_when_the_judge_is_to_pick_$name",
  async ({ verifier, other, uploaded }) => {
    const form = regexForm({ amount: "5", verifier, otherVerifier: other });
    const w = world(form, { vault: vaultData({ vault: 5_000_000n }) });

    await expect(submitPost(input(form), w.deps)).resolves.toMatchObject({ kind: "posted" });

    // The brief and the criteria are public and always go up; the held-out checks are a secret that
    // only the Judge reads at the API.
    expect(w.blobs.map(({ kind }) => kind)).toEqual(["brief", "criteria"]);
    expect(w.heldouts).toHaveLength(uploaded ? 1 : 0);
    // The commitment is on chain either way: it is in the post.
    const task = w.sent[0]?.at(-1)?.args.task as { heldout_commitment: string } | undefined;
    expect(task?.heldout_commitment).toBe(buildDocuments(form).heldoutCommitment);
  },
);

test("an_account_that_has_never_deposited_is_set_up_by_the_same_send", async () => {
  const form = regexForm({ amount: "5" });
  const w = world(form, { vault: vaultData({ storage: false }) });

  const result = await submitPost(input(form), w.deps);

  // One send, with the registration first: no detour to the Wallet page.
  expect(result).toEqual({ kind: "posted", taskId: "17" });
  expect(w.sent).toHaveLength(1);
  expect(w.sent[0]?.map((call) => call.methodName)).toEqual([
    "storage_deposit",
    "ft_transfer_call",
    "post_task",
  ]);
  expect(w.sent[0]?.[0]?.deposit).toBe(storageShortfall(null, POST_TASK_BYTES + VAULT_SLOT_BYTES));
});

test("an_account_with_too_little_in_the_wallet_sends_nothing", async () => {
  const form = regexForm({ amount: "5" });

  // The vault holds 2 and the wallet 2.5: 3 are needed, and the wallet is half a token short.
  const short = world(form, { vault: vaultData({ vault: 2_000_000n, wallet: 2_500_000n }) });
  const shortFailure = (await rejection(submitPost(input(form), short.deps))) as SubmitFailure;
  expect(shortFailure.message).toBe("You need 0.50 tUSDC more in your wallet to fund this reward.");

  // The wallet may not say what it holds; the token's own transfer then decides.
  const unknown = world(form, { vault: vaultData({ wallet: null }) });
  await expect(submitPost(input(form), unknown.deps)).resolves.toMatchObject({ kind: "posted" });

  expect(short.sent).toEqual([]);
});

// ---- The token ----------------------------------------------------------------------------------

test("each_request_reads_the_token_held_at_that_moment", async () => {
  const form = regexForm();
  const seen: string[] = [];
  const w = world(form, { held: "tok-1", onUpload: (_n, token) => seen.push(token) });
  // The keeping place drops the token between the first upload and the second, as it does when the
  // wallet session ends; the next request must not use a copy of the old one.
  const upload = w.deps.uploadBlob.bind(w.deps);
  w.deps.uploadBlob = async (token, blob) => {
    const stored = await upload(token, blob);
    if (blob.kind === "brief") w.held = null;
    return stored;
  };

  await submitPost(input(form), w.deps);

  expect(seen).toEqual(["tok-1", "tok-2", "tok-2"]);
  expect(w.log.filter((line) => line === "signIn")).toHaveLength(1);
});

test("a_token_the_api_turns_away_is_signed_in_for_again_and_never_cleared_from_here", async () => {
  const form = regexForm();
  let refused = false;
  const w = world(form, {
    held: "tok-old",
    onUpload: (_n, token) => {
      if (token === "tok-old" && !refused) {
        refused = true;
        throw new ApiError(401, { error: "unauthorized", message: "token expired" });
      }
    },
  });

  const result = await submitPost(input(form), w.deps);

  expect(result).toMatchObject({ kind: "posted" });
  // The brief went with the old token and was turned away; after a new sign-in it went again, and
  // the rest went with the new one.
  expect(w.log).toEqual([
    "blob:brief",
    "signIn",
    "blob:brief",
    "blob:criteria",
    "heldout",
    "vault",
    "send",
  ]);
  expect(w.blobs.map((blob) => blob.token)).toEqual(["tok-2", "tok-2"]);
  expect(w.heldouts[0]?.token).toBe("tok-2");
});

test("a_second_refusal_is_a_failure_and_not_a_loop", async () => {
  const form = regexForm();
  const w = world(form, {
    onUpload: () => {
      throw new ApiError(401, { error: "unauthorized", message: "no" });
    },
  });

  const failure = (await rejection(submitPost(input(form), w.deps))) as SubmitFailure;

  expect(failure.stage).toBe("upload");
  expect(w.signIns).toBe(1);
  expect(w.sent).toEqual([]);
});

test("the_token_a_request_takes_is_the_one_the_hook_would_give", () => {
  const stored = { accountId: ALICE, token: "tok-held", expiresAtMs: Date.now() + 60_000 };
  try {
    expect(liveToken(ALICE)).toBeNull();
    keepToken(stored, signInTicket());
    expect(liveToken(ALICE)).toBe("tok-held");
    expect(liveToken("bob.testnet")).toBeNull();
  } finally {
    clearApiToken();
    sessionStorage.clear();
  }
});

test("a_wallet_that_cannot_sign_a_message_stops_at_the_sign_in", async () => {
  const form = regexForm();
  const w = world(form, { held: null });
  w.deps.signIn = async () => {
    throw new WalletCannotSign();
  };

  const failure = (await rejection(submitPost(input(form), w.deps))) as SubmitFailure;

  expect(failure.stage).toBe("signin");
  expect(failure.message).toBe(WALLET_CANNOT_SIGN_MESSAGE);
  expect(w.log).toEqual([]);
});

test("a_sign_in_that_leaves_no_token_is_a_session_that_ended", async () => {
  const form = regexForm();
  const w = world(form, { held: null });
  w.deps.signIn = async () => undefined;

  const failure = (await rejection(submitPost(input(form), w.deps))) as SubmitFailure;

  expect(failure.stage).toBe("signin");
  expect(failure.message).toContain("disconnected or changed during sign-in");
  expect(w.blobs).toEqual([]);
});

// ---- The wallet ---------------------------------------------------------------------------------

test("a_wallet_that_refuses_leaves_the_uploads_and_a_second_try_goes_through", async () => {
  const form = regexForm({ amount: "5" });
  let attempt = 0;
  const w = world(form, {
    send: async (calls) => {
      if (++attempt === 1) throw new WalletError("send", new Error("User rejected"));
      return { events: [createdEvent(form)], txHashes: calls.map((_, i) => `tx${i}`) };
    },
  });

  const failure = (await rejection(submitPost(input(form), w.deps))) as SubmitFailure;
  expect(failure.stage).toBe("wallet");
  expect(failure.message).toBe(
    "The wallet didn't finish. A deposit may have gone through: check the Wallet page. Your documents are saved; press Post to try again.",
  );
  // Everything was uploaded before the wallet was asked.
  expect(w.log).toEqual(["blob:brief", "blob:criteria", "heldout", "vault", "send"]);

  // Pressing Post again needs nothing retyped: the same form goes through.
  await expect(submitPost(input(form), w.deps)).resolves.toEqual({ kind: "posted", taskId: "17" });
  expect(w.sent).toHaveLength(2);
  expect(w.sent[1]).toEqual(w.sent[0]);
});

/** What the page says of a wallet that threw, and of a transaction that failed with no code. */
const DID_NOT_FINISH =
  "The wallet didn't finish. A deposit may have gone through: check the Wallet page. Your documents are saved; press Post to try again.";

/** Runs `work` with the console's errors held back: the page logs a failure it has handled. */
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    return await work();
  } finally {
    spy.mockRestore();
  }
}

test("a_post_the_contract_turns_down_says_why_and_what_became_of_the_deposit", async () => {
  const form = regexForm({ amount: "5" });
  const panic = (code: string | null) => async () => {
    throw new TransactionFailed("txhash", code);
  };

  // With a deposit in front, the vault is read again and the words say what it holds. The storage
  // ran short here, which the page tops up the next time: the words say to press Post.
  const withDeposit = world(form, {
    send: panic("E_STORAGE"),
    vaultThen: vaultData({ vault: 5_000_000n }),
  });
  const first = (await rejection(submitPost(input(form), withDeposit.deps))) as SubmitFailure;
  expect(first.stage).toBe("wallet");
  expect(first.message).toBe(
    "Your storage with Tender ran short as the task was posted. Your vault holds 5.00 tUSDC. If the deposit isn't there, it went back to your wallet. Press Post to try again: the page adds what's missing.",
  );

  // With the reward in the vault already, nothing else went through, and the vault is not read.
  const noDeposit = world(form, {
    vault: vaultData({ vault: 5_000_000n }),
    send: panic("E_PAUSED"),
  });
  const second = (await rejection(submitPost(input(form), noDeposit.deps))) as SubmitFailure;
  expect(second.message).toBe("Tender isn't taking new tasks right now. Nothing was posted.");
  expect(noDeposit.log.filter((line) => line === "vault")).toHaveLength(1);

  // No deposit and a storage that ran short: nothing went through, and pressing Post is the way on.
  const storageOnly = world(form, {
    vault: vaultData({ vault: 5_000_000n }),
    send: panic("E_STORAGE"),
  });
  const third = (await rejection(submitPost(input(form), storageOnly.deps))) as SubmitFailure;
  expect(third.message).toBe(
    "Your storage with Tender ran short as the task was posted. Nothing was posted. Press Post to try again: the page adds what's missing.",
  );

  // A code the page has no words for is shown as the code.
  const unknown = world(form, { vault: vaultData({ vault: 5_000_000n }), send: panic("E_HASH") });
  const fourth = (await rejection(submitPost(input(form), unknown.deps))) as SubmitFailure;
  expect(fourth.message).toContain("(E_HASH)");

  // A failure with no code could be either transaction: the words say to look at the Wallet page.
  const noCode = world(form, { send: panic(null) });
  const fifth = (await rejection(submitPost(input(form), noCode.deps))) as SubmitFailure;
  expect(fifth.message).toBe(DID_NOT_FINISH);
  expect(noCode.log.filter((line) => line === "vault")).toHaveLength(1);
});

test.each([
  // Pressing Post again is the way on after a refusal that was about the amounts...
  ["E_FUNDS", "The reward wasn't in your vault.", " Press Post to try again."],
  // ...and no way on after one that pressing again cannot get past.
  ["E_TOKEN", "Tender isn't taking this token right now.", ""],
  ["E_PAUSED", "Tender isn't taking new tasks right now.", ""],
])(
  "a_%s_after_a_deposit_says_what_the_vault_holds_and_not_where_the_deposit_went",
  async (code, why, again) => {
    const form = regexForm({ amount: "5" });
    const refuse = async () => {
      throw new TransactionFailed("txhash", code);
    };
    const failureOf = async (w: World) =>
      (await quietly(() => rejection(submitPost(input(form), w.deps)))) as SubmitFailure;
    const hedge = "If the deposit isn't there, it went back to your wallet.";

    // The deposit was refused, as `ft_on_transfer` does when it cannot take one, and the token
    // handed the tokens back: the transaction of the deposit ended well, the post then failed, and
    // the vault holds what it did before. One read says what the vault holds, and no more.
    const refused = world(form, {
      vault: vaultData({ vault: 2_000_000n }),
      send: refuse,
      vaultThen: vaultData({ vault: 2_000_000n }),
    });
    const first = await failureOf(refused);
    expect(first.stage).toBe("wallet");
    expect(first.message).toBe(`${why} Your vault holds 2.00 tUSDC. ${hedge}${again}`);
    expect(first.message).not.toContain("went through");
    // The plan began with a deposit, and the vault was read again after the send.
    expect(refused.sent[0]?.map((call) => call.methodName)).toEqual([
      "ft_transfer_call",
      "post_task",
    ]);
    expect(refused.log).toEqual([
      "blob:brief",
      "blob:criteria",
      "heldout",
      "vault",
      "send",
      "vault",
    ]);

    // The vault holds the reward by the second look: the same words, since a read of the vault
    // doesn't tell a deposit that landed from a reward that was there all along.
    const landed = world(form, {
      vault: vaultData({ vault: 2_000_000n }),
      send: refuse,
      vaultThen: vaultData({ vault: 5_000_000n }),
    });
    expect((await failureOf(landed)).message).toBe(
      `${why} Your vault holds 5.00 tUSDC. ${hedge}${again}`,
    );

    // The vault cannot be read: nothing is claimed, and the Wallet page is where to look.
    const unknown = world(form, {
      vault: vaultData({ vault: 2_000_000n }),
      send: refuse,
      vaultThen: new Error("down"),
    });
    expect((await failureOf(unknown)).message).toBe(
      `${why} The deposit may have come back to your wallet: check the Wallet page.${again}`,
    );
  },
);

test("a_result_the_wallet_could_not_read_is_taken_for_sent_and_not_for_a_refusal", async () => {
  const form = regexForm({ amount: "5" });
  const w = world(form, {
    send: async () => {
      throw new WalletResultUnreadable("transaction");
    },
  });

  // The transactions may well have posted the task, and a second press would deposit and post it
  // again. So it is an outcome and not a failure: the page has no hashes to show, and keeps Post off.
  await expect(submitPost(input(form), w.deps)).resolves.toEqual({ kind: "sent", txHashes: [] });
  // Nothing is said of the deposit, since nothing is known of it, and the vault is not read again.
  expect(w.log).toEqual(["blob:brief", "blob:criteria", "heldout", "vault", "send"]);
});

// A wallet that threw may have sent the transactions first: a window that closed after the
// broadcast, a connection that dropped before the answer. Only a person who turned the request down
// is known to have sent nothing.
test.each([
  ["a_window_that_closed", () => new WalletError("send", new Error("Wallet closed"))],
  ["a_connection_that_dropped", () => new WalletError("send", new TypeError("Failed to fetch"))],
  ["a_message_and_no_error", () => new WalletError("send", "connection lost")],
  ["an_object_with_a_message", () => new WalletError("send", { message: "RPC request timed out" })],
  ["nothing_said", () => new WalletError("send", undefined)],
  [
    "a_rejection_that_is_the_networks",
    () => new WalletError("send", new Error("The transaction was rejected by the network")),
  ],
  ["an_error_that_is_not_the_wallets", () => new TypeError("Cannot read properties of undefined")],
] as const)(
  "a_send_that_fails_without_saying_whether_it_went_out_is_an_unknown_outcome_%s",
  async (_name, make) => {
    const form = regexForm({ amount: "5" });
    const cause = make();
    const w = world(form, {
      send: async () => {
        throw cause;
      },
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      // It may well be posted, so it is an outcome and not a failure: the page keeps Post off.
      await expect(submitPost(input(form), w.deps)).resolves.toEqual({ kind: "unknown" });
      // What the wallet threw is for the console, as it was.
      expect(spy).toHaveBeenCalledWith(cause);
    } finally {
      spy.mockRestore();
    }
    // The wallet was asked once. Nothing is read after, since nothing read would say what happened.
    expect(w.log).toEqual(["blob:brief", "blob:criteria", "heldout", "vault", "send"]);
    expect(w.sent).toHaveLength(1);
  },
);

test.each([
  ["User rejected"],
  ["User cancelled the action"],
  ["User canceled the request"],
  ["User declined the transaction"],
  ["User denied transaction signature"],
  ["Transaction rejected by user"],
  ["The user refused to sign"],
] as const)(
  "a_wallet_the_person_turned_down_is_a_refusal_and_not_an_unknown_outcome_%s",
  async (words) => {
    const form = regexForm({ amount: "5" });
    // Wallets throw an error, a string or an object with a message.
    for (const thrown of [new Error(words), words, { message: words }]) {
      const w = world(form, {
        send: async () => {
          throw new WalletError("send", thrown);
        },
      });

      const failure = (await rejection(submitPost(input(form), w.deps))) as SubmitFailure;

      expect(failure.stage).toBe("wallet");
      expect(failure.message).toBe(DID_NOT_FINISH);
      expect(w.sent).toHaveLength(1);
    }
  },
);

test("a_wallet_that_is_not_connected_is_a_failure_with_nothing_sent", async () => {
  const form = regexForm({ amount: "5" });
  const w = world(form, {
    send: async () => {
      throw new WalletNotConnected();
    },
  });

  const failure = (await rejection(submitPost(input(form), w.deps))) as SubmitFailure;

  expect(failure.stage).toBe("wallet");
  expect(failure.message).toBe("Sign in first.");
});

test("a_wallet_connected_as_another_account_is_sent_nothing", async () => {
  const form = regexForm();
  // The uploads were made as ALICE; by the time the wallet would sign, it is BOB's.
  let account: string | null = ALICE;
  const w = world(form, { account: () => account });
  const vault = w.deps.readVault.bind(w.deps);
  w.deps.readVault = async (who) => {
    account = "bob.testnet";
    return vault(who);
  };

  const failure = (await rejection(submitPost(input(form), w.deps))) as SubmitFailure;

  expect(failure.stage).toBe("wallet");
  // A wallet that was disconnected and one that changed look the same from here, and the words
  // fit both.
  expect(failure.message).toBe("The wallet was disconnected or changed, so nothing was sent.");
  expect(w.sent).toEqual([]);
});

test("a_wallet_that_was_disconnected_is_sent_nothing", async () => {
  const form = regexForm();
  let account: string | null = ALICE;
  const w = world(form, { account: () => account });
  const vault = w.deps.readVault.bind(w.deps);
  w.deps.readVault = async (who) => {
    account = null;
    return vault(who);
  };

  const failure = (await rejection(submitPost(input(form), w.deps))) as SubmitFailure;

  expect(failure.message).toBe("The wallet was disconnected or changed, so nothing was sent.");
  expect(w.sent).toEqual([]);
});

// ---- The outcome --------------------------------------------------------------------------------

test("a_send_with_no_task_created_for_this_task_is_not_called_a_post", async () => {
  const form = regexForm();
  const others: TenderEvent[][] = [
    [],
    // Another poster's task, and a task of the same poster with other documents.
    [createdEvent(form, { poster: "bob.testnet" })],
    [createdEvent(form, { brief_hash: "9".repeat(64) })],
    [createdEvent(form, { criteria_hash: "9".repeat(64) })],
  ];
  for (const events of others) {
    const w = world(form, { send: async () => ({ events, txHashes: ["tx1", "tx2"] }) });

    const result = await submitPost(input(form), w.deps);

    expect(result).toEqual({ kind: "sent", txHashes: ["tx1", "tx2"] });
  }
});

test("the_id_comes_from_the_event_of_this_task_among_others", async () => {
  const form = regexForm();
  const w = world(form, {
    send: async () => ({
      events: [
        createdEvent(form, { id: "3", poster: "bob.testnet" }),
        createdEvent(form, { id: "9" }),
      ],
      txHashes: ["tx1"],
    }),
  });

  await expect(submitPost(input(form), w.deps)).resolves.toEqual({ kind: "posted", taskId: "9" });
});

test("stages_are_reported_as_the_post_goes", async () => {
  const form = regexForm();
  const w = world(form, { held: null });
  const stages: string[] = [];

  await submitPost(input(form), w.deps, (stage) => stages.push(stage));

  expect(stages).toEqual(["upload", "signin", "upload", "vault", "wallet"]);
});

test("the_calls_name_the_contract_and_the_token_of_the_config", async () => {
  const form = regexForm({ amount: "5" });
  const w = world(form);

  await submitPost(input(form), w.deps);

  expect(w.sent[0]?.map((call) => call.receiverId)).toEqual([TOKEN, CONTRACT]);
});

// ---- A look for an earlier post -----------------------------------------------------------------

/** The task of `form` as the chain lists it, with what a listing adds to the event. */
function listed(form: PostForm, patch: Record<string, unknown> = {}): TaskView {
  return TaskViewSchema.parse({
    ...createdEvent(form).data,
    commit_count: 0,
    reveal_count: 0,
    cleaned: 0,
    funders: [],
    outcome: null,
    phase: "open",
    ...patch,
  });
}

test("an_earlier_post_that_is_on_the_chain_is_the_result_and_nothing_is_sent_again", async () => {
  const form = regexForm({ amount: "5" });
  // The index has not caught up, and the person unlocked Post: the chain has the task.
  const w = world(form, { held: null, recent: [listed(form, { id: "9" })] });
  const stages: string[] = [];

  const result = await submitPost({ ...input(form), lookFirst: true }, w.deps, (stage) =>
    stages.push(stage),
  );

  expect(result).toEqual({ kind: "posted", taskId: "9" });
  // Not a sign-in, not an upload, not a read of the vault, not a send.
  expect(w.log).toEqual(["recent"]);
  expect(stages).toEqual(["check"]);
});

test("a_look_that_finds_nothing_goes_on_to_post_the_task", async () => {
  const form = regexForm({ amount: "5" });
  const other = regexForm({ amount: "5", title: "another task" });
  const w = world(form, { vault: vaultData({ vault: 5_000_000n }), recent: [listed(other)] });
  const stages: string[] = [];

  const result = await submitPost({ ...input(form), lookFirst: true }, w.deps, (stage) =>
    stages.push(stage),
  );

  expect(result).toEqual({ kind: "posted", taskId: "17" });
  expect(w.log).toEqual(["recent", "blob:brief", "blob:criteria", "heldout", "vault", "send"]);
  expect(stages).toEqual(["check", "upload", "vault", "wallet"]);
});

// A task is this one only if it has this poster and the same brief, criteria and held-out
// commitment: any one that differs is another task, and the post goes on.
test.each([
  ["another_poster", { poster: "bob.testnet" }],
  ["another_brief", { brief_hash: "ab".repeat(32) }],
  ["other_criteria", { criteria_hash: "cd".repeat(32) }],
  ["another_heldout_commitment", { heldout_commitment: "ef".repeat(32) }],
  ["no_heldout_commitment", { heldout_commitment: null }],
])("a_listed_task_with_%s_is_not_the_one_looked_for", async (_name, patch) => {
  const form = regexForm({ amount: "5" });
  const w = world(form, {
    vault: vaultData({ vault: 5_000_000n }),
    recent: [listed(form, patch)],
  });

  const result = await submitPost({ ...input(form), lookFirst: true }, w.deps);

  expect(result).toEqual({ kind: "posted", taskId: "17" });
  expect(w.sent).toHaveLength(1);
});

test("the_chain_is_not_read_unless_the_press_follows_a_send_of_unknown_outcome", async () => {
  const form = regexForm({ amount: "5" });
  const w = world(form, {
    vault: vaultData({ vault: 5_000_000n }),
    recent: [listed(form, { id: "9" })],
  });

  const result = await submitPost(input(form), w.deps);

  expect(result).toEqual({ kind: "posted", taskId: "17" });
  expect(w.log).not.toContain("recent");
});

test("a_look_that_cannot_be_made_sends_nothing_and_says_so", async () => {
  const form = regexForm({ amount: "5" });
  const w = world(form, { held: null, recent: new Error("Failed to fetch") });

  const failure = (await quietly(() =>
    rejection(submitPost({ ...input(form), lookFirst: true }, w.deps)),
  )) as SubmitFailure;

  // A post that can't tell whether the task is there does not guess: the person tries again.
  expect(failure.stage).toBe("check");
  expect(failure.message).toBe(
    "Couldn't look for your earlier post. Can't reach the server. Check your connection and try again. Nothing was sent to your wallet.",
  );
  expect(w.log).toEqual(["recent"]);
});

/** Answers the node's views with what `answer` says, and gives back what was asked. */
function stubViews(answer: (method: string, args: Record<string, unknown>) => unknown) {
  const asked: Array<{ method: string; args: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      id: string;
      params: { method_name: string; args_base64: string };
    };
    const method = body.params.method_name;
    const args = JSON.parse(atob(body.params.args_base64)) as Record<string, unknown>;
    asked.push({ method, args });
    const bytes = Array.from(new TextEncoder().encode(JSON.stringify(answer(method, args))));
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { result: bytes } }),
      {
        status: 200,
      },
    );
  });
  return asked;
}

test.each([
  // The newest fifty, so from count - 49; and from the first when there are fewer.
  ["sixty_tasks", "60", "11", 50],
  ["fifty_tasks", "50", "1", 50],
  ["fifty_one_tasks", "51", "2", 50],
  ["three_tasks", "3", "1", 3],
  ["no_tasks", "0", "1", 0],
])("recent_tasks_reads_the_newest_page_of_%s", async (_name, count, from, size) => {
  const form = regexForm();
  const asked = stubViews((method) =>
    method === "task_count"
      ? count
      : Array.from({ length: size }, (_, i) => listed(form, { id: String(Number(from) + i) })),
  );
  try {
    const tasks = await recentTasks();

    expect(asked.map(({ method }) => method)).toEqual(["task_count", "get_tasks"]);
    expect(asked[1]?.args).toEqual({ from_id: from, limit: 50 });
    expect(tasks.map(({ id }) => id)).toEqual(
      Array.from({ length: size }, (_, i) => String(Number(from) + i)),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

test.each([
  ["a_count_that_is_no_number", (method: string) => (method === "task_count" ? "many" : [])],
  ["a_page_that_is_no_list", (method: string) => (method === "task_count" ? "3" : { tasks: [] })],
  ["a_task_that_is_not_one", (method: string) => (method === "task_count" ? "1" : [{ id: "1" }])],
])("recent_tasks_rejects_%s", async (_name, answer) => {
  stubViews(answer);
  try {
    const error = await rejection(recentTasks());
    expect(error).toBeInstanceOf(RpcError);
  } finally {
    vi.unstubAllGlobals();
  }
});

// ---- The amounts the person saw -----------------------------------------------------------------

test("a_deposit_larger_than_the_one_shown_is_not_sent", async () => {
  const form = regexForm({ amount: "5" });
  // Review showed 3 to deposit (a vault of 2); the vault holds nothing when the post reads it.
  const w = world(form, { vault: vaultData({ vault: 0n }) });

  const failure = (await rejection(
    submitPost({ ...input(form), shown: { toDeposit: 3_000_000n, storageTopUp: 0n } }, w.deps),
  )) as SubmitFailure;

  expect(failure.stage).toBe("vault");
  expect(failure.message).toBe("Your balances changed. Check the amounts and press Post again.");
  expect(w.sent).toEqual([]);
});

test("a_storage_top_up_larger_than_the_one_shown_is_not_sent", async () => {
  const form = regexForm({ amount: "5" });
  // The reward is in the vault; 1,000 bytes are free and the post needs 1,600.
  const w = world(form, { vault: vaultData({ vault: 5_000_000n, available: 1_000n * BYTE }) });

  const failure = (await rejection(
    submitPost({ ...input(form), shown: { toDeposit: 0n, storageTopUp: 0n } }, w.deps),
  )) as SubmitFailure;

  expect(failure.stage).toBe("vault");
  expect(failure.message).toBe("Your balances changed. Check the amounts and press Post again.");
  expect(w.sent).toEqual([]);
});

test.each([
  ["the_same_amounts", { toDeposit: 3_000_000n, storageTopUp: 600n * BYTE }],
  ["larger_amounts", { toDeposit: 9_000_000n, storageTopUp: 900n * BYTE }],
])("%s_than_the_fresh_read_asks_for_are_sent", async (_name, shown) => {
  const form = regexForm({ amount: "5" });
  const w = world(form, { vault: vaultData({ vault: 2_000_000n, available: 1_000n * BYTE }) });

  const result = await submitPost({ ...input(form), shown }, w.deps);

  expect(result).toEqual({ kind: "posted", taskId: "17" });
  // The 3 that are missing, then the 600 bytes of storage that are: whatever the amounts, they are
  // not more than the person saw.
  expect(w.sent[0]?.map((call) => call.methodName)).toEqual([
    "storage_deposit",
    "ft_transfer_call",
    "post_task",
  ]);
});

// ---- Giving up on the wallet --------------------------------------------------------------------

test("a_post_given_up_on_at_the_sign_in_goes_no_further_when_the_wallet_answers", async () => {
  const form = regexForm({ amount: "5" });
  let stopped = false;
  const w = world(form, { held: null, stopped: () => stopped });
  const signIn = w.deps.signIn.bind(w.deps);
  w.deps.signIn = async () => {
    // The person gave up while the wallet had the message; it signs after all.
    stopped = true;
    return signIn();
  };

  const error = await rejection(submitPost(input(form), w.deps));

  expect(error).toBeInstanceOf(PostStopped);
  // Not an upload, not a read of the vault, and above all not a send.
  expect(w.log).toEqual(["signIn"]);
  expect(w.sent).toEqual([]);
});

test("a_post_given_up_on_is_not_sent_to_the_wallet_whatever_it_was_doing_before", async () => {
  const form = regexForm({ amount: "5" });
  let stopped = false;
  const w = world(form, { vault: vaultData({ vault: 5_000_000n }), stopped: () => stopped });
  const readVault = w.deps.readVault.bind(w.deps);
  w.deps.readVault = async (who) => {
    const data = await readVault(who);
    stopped = true;
    return data;
  };

  const error = await rejection(submitPost(input(form), w.deps));

  expect(error).toBeInstanceOf(PostStopped);
  expect(w.log.at(-1)).toBe("vault");
  expect(w.sent).toEqual([]);
});
