import {
  ApiError,
  type BlobUpload,
  sha256Hex,
  type TenderCall,
  type TenderEvent,
  TenderEventSchema,
} from "@tender/shared";
import { expect, test } from "vitest";
import { buildDocuments, type PostForm } from "../lib/post";
import { type SubmitDeps, SubmitFailure, type SubmitInput, submitPost } from "../lib/postSubmit";
import type { VaultData } from "../lib/vault";
import {
  TransactionFailed,
  WALLET_CANNOT_SIGN_MESSAGE,
  WalletCannotSign,
  WalletError,
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

function vaultData(o: {
  vault?: bigint;
  wallet?: bigint | null;
  storage?: boolean;
  enabled?: boolean;
}): VaultData {
  return {
    storage: o.storage === false ? null : { total: 50_000_000_000_000_000_000_000n, available: 1n },
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
      return options.vault ?? vaultData({});
    },
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

test("an_account_with_no_storage_or_too_little_in_the_wallet_sends_nothing", async () => {
  const form = regexForm({ amount: "5" });

  const noStorage = world(form, { vault: vaultData({ storage: false }) });
  const failure = (await rejection(submitPost(input(form), noStorage.deps))) as SubmitFailure;
  expect(failure.stage).toBe("vault");
  expect(failure.message).toContain("isn't set up with Tender");

  // The vault holds 2 and the wallet 2.5: 3 are needed, and the wallet is half a token short.
  const short = world(form, { vault: vaultData({ vault: 2_000_000n, wallet: 2_500_000n }) });
  const shortFailure = (await rejection(submitPost(input(form), short.deps))) as SubmitFailure;
  expect(shortFailure.message).toBe("You need 0.50 tUSDC more in your wallet to fund this reward.");

  // The wallet may not say what it holds; the token's own transfer then decides.
  const unknown = world(form, { vault: vaultData({ wallet: null }) });
  await expect(submitPost(input(form), unknown.deps)).resolves.toMatchObject({ kind: "posted" });

  for (const w of [noStorage, short]) expect(w.sent).toEqual([]);
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
  expect(failure.message).toContain("Your documents are saved with Tender");
  // Everything was uploaded before the wallet was asked.
  expect(w.log).toEqual(["blob:brief", "blob:criteria", "heldout", "vault", "send"]);

  // Pressing Post again needs nothing retyped: the same form goes through.
  await expect(submitPost(input(form), w.deps)).resolves.toEqual({ kind: "posted", taskId: "17" });
  expect(w.sent).toHaveLength(2);
  expect(w.sent[1]).toEqual(w.sent[0]);
});

test("a_post_the_contract_turns_down_says_why_and_whether_the_deposit_went_through", async () => {
  const form = regexForm({ amount: "5" });
  const panic = (code: string | null) => async () => {
    throw new TransactionFailed("txhash", code);
  };

  // With a deposit in front: the contract's panic is from `post_task`, which ran after it.
  const withDeposit = world(form, { send: panic("E_STORAGE") });
  const first = (await rejection(submitPost(input(form), withDeposit.deps))) as SubmitFailure;
  expect(first.message).toBe(
    "Your storage with Tender is too full to hold this task, and this site can't add more. Your deposit went through, so the funds are in your vault. Press Post again once this is sorted.",
  );

  // With the reward in the vault already: nothing else went through.
  const noDeposit = world(form, {
    vault: vaultData({ vault: 5_000_000n }),
    send: panic("E_PAUSED"),
  });
  const second = (await rejection(submitPost(input(form), noDeposit.deps))) as SubmitFailure;
  expect(second.message).toBe("Tender isn't taking new tasks right now. Nothing was posted.");

  // A code the page has no words for is shown as the code.
  const unknown = world(form, { vault: vaultData({ vault: 5_000_000n }), send: panic("E_HASH") });
  const third = (await rejection(submitPost(input(form), unknown.deps))) as SubmitFailure;
  expect(third.message).toContain("(E_HASH)");

  // A failure with no code could be either transaction: the words say to look at the vault.
  const noCode = world(form, { send: panic(null) });
  const fourth = (await rejection(submitPost(input(form), noCode.deps))) as SubmitFailure;
  expect(fourth.message).toContain("check your vault on the Wallet page");
});

test("an_answer_the_page_cannot_read_is_not_taken_for_a_refusal", async () => {
  const form = regexForm();
  const w = world(form, {
    send: async () => {
      throw new WalletResultUnreadable("transaction");
    },
  });

  const failure = (await rejection(submitPost(input(form), w.deps))) as SubmitFailure;

  expect(failure.stage).toBe("wallet");
  expect(failure.message).toContain("didn't say how it went");
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
  expect(failure.message).toContain("another account");
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
