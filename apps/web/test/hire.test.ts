import {
  type BlobUpload,
  HIRE_TASK_BYTES,
  HIRER_ACCEPTS_CRITERIA,
  hireDocuments,
  type Service,
  STORAGE_BYTE_COST,
  sha256Hex,
  type TenderCall,
} from "@tender/shared";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  type HireDeps,
  HireFailure,
  hireBlocker,
  hirePlan,
  hireStorageTopUp,
  submitHire,
  teamOnlyNote,
} from "../lib/hire";
import {
  checkServiceForm,
  emptyServiceForm,
  formOfService,
  serviceRequestOf,
} from "../lib/services";
import type { VaultData } from "../lib/vault";
import type { SendResult } from "../lib/wallet";
import { TransactionFailed, WalletError } from "../lib/walletErrors";
import { agent, TOKEN } from "./tasks";

// Hiring from a service's page (lib/hire.ts) and the provider's form (lib/services.ts), with every
// part of the world a stand-in: the API, the vault read and the wallet. vitest.config.ts gives the
// config the contract tender.testnet; the Judge's account is passed in.

const CONTRACT = "tender.testnet";
const JUDGE = "judge.tender-team.testnet";
const ALICE = "alice.testnet";
const WRITER = "writer.acme.testnet";
const REQUEST = "Summarise the 2026 annual report of Example Corp in five lines.";

function service(over: Partial<Service> = {}): Service {
  return {
    id: "3",
    provider: "acme.testnet",
    agent: WRITER,
    title: "Summarise a public filing",
    description: "Reads a filing and returns five lines.",
    tags: ["research"],
    category: "research",
    output_format: "text",
    token: TOKEN,
    price: "2500000",
    commit_secs: 3_600,
    reveal_secs: 1_800,
    pick_secs: 3_600,
    verification: { kind: "hirer" },
    status: "active",
    available: true,
    is_team: false,
    created_at: "2026-11-04T09:00:00.000Z",
    updated_at: "2026-11-04T09:00:00.000Z",
    agent_record: agent({ account: WRITER }),
    ...over,
  };
}

/** A vault that holds `vault` of the token, a wallet that holds 50, and room for `free` bytes. */
function vaultOf(vault: bigint, free = 10_000n): VaultData {
  return {
    storage: { total: free * STORAGE_BYTE_COST, available: free * STORAGE_BYTE_COST },
    rows: [{ token: TOKEN, enabled: true, vault, wallet: 50_000_000n }],
  };
}

/** The world of a hire; `listed` is the service as the API holds it when the hire reads it again. */
function deps(over: Partial<HireDeps> = {}, listed: Service = service()) {
  const uploads: BlobUpload[] = [];
  const sent: TenderCall[][] = [];
  let token: string | null = null;
  const made: HireDeps = {
    account: () => ALICE,
    token: () => token,
    signIn: vi.fn(async () => {
      token = "tok-1";
    }),
    uploadBlob: vi.fn(async (_token, blob) => {
      uploads.push(blob);
      const sha256 = sha256Hex(blob.bytes);
      return { sha256, uri: `http://api.test/v1/blobs/${sha256}` };
    }),
    getService: vi.fn(async () => ({ service: listed })),
    readVault: vi.fn(async () => vaultOf(5_000_000n)),
    signAndSend: vi.fn(async (calls): Promise<SendResult> => {
      sent.push([...calls]);
      const post = calls.find((call: TenderCall) => call.methodName === "post_task");
      const task = ((post?.args ?? {}) as { task: { brief_hash: string } }).task;
      return {
        txHashes: ["tx1"],
        events: [
          {
            event: "task_created",
            data: { id: "41", poster: ALICE, brief_hash: task.brief_hash },
          } as unknown as SendResult["events"][number],
        ],
      };
    }),
    ...over,
  };
  return { deps: made, uploads, sent };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const input = (over: Partial<Parameters<typeof submitHire>[0]> = {}) => ({
  service: service(),
  request: REQUEST,
  account: ALICE,
  judgeAccount: JUDGE,
  ...over,
});

test("a_hire_signs_in_uploads_the_shared_documents_and_posts_a_pinned_task_for_the_agent", async () => {
  const world = deps();
  const stages: string[] = [];
  const result = await submitHire(input(), world.deps, (stage) => stages.push(stage));

  expect(result).toEqual({ kind: "posted", taskId: "41" });
  expect(stages).toEqual(["check", "upload", "signin", "upload", "vault", "wallet"]);
  expect(world.deps.getService).toHaveBeenCalledWith("3");
  const docs = hireDocuments(service(), REQUEST);
  expect(world.uploads.map((blob) => [blob.kind, sha256Hex(blob.bytes)])).toEqual([
    ["brief", docs.briefHash],
    ["criteria", docs.criteriaHash],
  ]);
  expect(docs.criteria).toEqual(HIRER_ACCEPTS_CRITERIA);
  // The vault holds the price: one call, the post, and nothing else.
  expect(world.sent).toHaveLength(1);
  const [post] = world.sent[0] ?? [];
  expect(post?.receiverId).toBe(CONTRACT);
  expect(post?.methodName).toBe("post_task");
  expect(post?.deposit).toBe(1n);
  expect(((post?.args ?? {}) as { task: object }).task).toEqual({
    token: TOKEN,
    reward: "2500000",
    brief_uri: `http://api.test/v1/blobs/${docs.briefHash}`,
    brief_hash: docs.briefHash,
    criteria_hash: docs.criteriaHash,
    heldout_commitment: null,
    // The hirer, as the poster, is the verifier.
    verifier: null,
    commit_secs: 3_600,
    reveal_secs: 1_800,
    pick_secs: 3_600,
    fallback_secs: 3_600,
    max_entries: 1,
    max_winners: 1,
    invited: [WRITER],
    parent: null,
  });
});

test("a_judge_checked_service_is_hired_with_the_judge_as_verifier", async () => {
  const criteria = {
    version: 1 as const,
    kind: "regex_cases" as const,
    min_score: 100,
    split: "winner_take_all" as const,
    has_heldout: false,
    examples: { match: ["a"], no_match: ["b"] },
  };
  const judged = service({
    output_format: "regex_json",
    verification: { kind: "judge", criteria, criteria_hash: "ab".repeat(32), judge: JUDGE },
  });
  const world = deps({}, judged);
  await submitHire(input({ service: judged }), world.deps);
  const task = ((world.sent[0]?.[0]?.args ?? {}) as { task: Record<string, unknown> }).task;
  expect(task.verifier).toBe(JUDGE);
  await expect(
    submitHire(input({ service: judged, judgeAccount: null }), deps().deps),
  ).rejects.toThrow("This site isn't set up with the Tender Judge's account");
});

test("what_the_vault_lacks_is_deposited_and_the_storage_topped_up_in_the_same_approval", async () => {
  const world = deps({ readVault: vi.fn(async () => vaultOf(0n, 100n)) });
  await submitHire(input(), world.deps);
  const calls = world.sent[0] ?? [];
  expect(calls.map((call) => `${call.receiverId} ${call.methodName}`)).toEqual([
    `${CONTRACT} storage_deposit`,
    `${TOKEN} ft_transfer_call`,
    `${CONTRACT} post_task`,
  ]);
  // The task record of a hire and the vault slot the deposit opens, less what is free.
  expect(calls[0]?.deposit).toBe((HIRE_TASK_BYTES + 200n - 100n) * STORAGE_BYTE_COST);
  expect(((calls[1]?.args ?? {}) as { amount: string }).amount).toBe("2500000");
});

test("a_service_changed_since_the_page_loaded_it_stops_the_hire_before_anything_leaves", async () => {
  const changes: Array<[string, Partial<Service>]> = [
    ["the price", { price: "3000000" }],
    ["the token", { token: "other.testnet" }],
    ["a window", { commit_secs: 7_200 }],
    [
      "the check",
      {
        verification: {
          kind: "judge",
          criteria: HIRER_ACCEPTS_CRITERIA,
          criteria_hash: "ab".repeat(32),
          judge: JUDGE,
        },
      },
    ],
    ["a pause", { status: "paused", available: false }],
    ["an agent that left", { available: false }],
  ];
  for (const [what, over] of changes) {
    const now = service(over);
    const world = deps({}, now);
    const failure = await submitHire(input(), world.deps).catch((error: unknown) => error);
    expect(failure, what).toBeInstanceOf(HireFailure);
    expect((failure as HireFailure).message, what).toBe(
      "The provider changed this service. Check the new terms and press Hire again.",
    );
    expect((failure as HireFailure).stage, what).toBe("check");
    // The page shows the terms the API holds now.
    expect((failure as HireFailure).fresh, what).toEqual(now);
    expect(world.deps.signIn, what).not.toHaveBeenCalled();
    expect(world.deps.uploadBlob, what).not.toHaveBeenCalled();
    expect(world.deps.signAndSend, what).not.toHaveBeenCalled();
  }
  // Words of the listing that a hire does not depend on change nothing.
  const reworded = deps({}, service({ title: "Summarise any filing", description: "Six lines." }));
  expect(await submitHire(input(), reworded.deps)).toEqual({ kind: "posted", taskId: "41" });
  // A service that is gone stops it too.
  const gone = deps({ getService: vi.fn(async () => null) });
  await expect(submitHire(input(), gone.deps)).rejects.toThrow("The provider changed this service");
});

test("a_fresh_read_that_asks_for_more_than_was_shown_sends_nothing", async () => {
  const world = deps({ readVault: vi.fn(async () => vaultOf(0n)) });
  await expect(
    submitHire(input({ shown: { toDeposit: 0n, storageTopUp: 0n } }), world.deps),
  ).rejects.toThrow("Your balances changed");
  expect(world.deps.signAndSend).not.toHaveBeenCalled();
});

test("a_hire_of_ones_own_agent_or_a_bad_request_is_refused_before_anything_leaves", async () => {
  for (const [what, over, words] of [
    ["its own agent", { account: WRITER }, "An account can't hire its own agent account."],
    ["no request", { request: "   " }, "The request can't be sent as it is"],
    ["an invisible character", { request: "hi\u200b" }, "The request can't be sent as it is"],
    ["too long", { request: "r".repeat(4001) }, "The request can't be sent as it is"],
  ] as const) {
    const world = deps();
    const failure = await submitHire(input(over), world.deps).catch((error: unknown) => error);
    expect(failure, what).toBeInstanceOf(HireFailure);
    expect((failure as HireFailure).message, what).toContain(words);
    expect((failure as HireFailure).stage, what).toBe("documents");
    expect(world.deps.uploadBlob, what).not.toHaveBeenCalled();
  }
});

test("the_wallet_and_the_contract_refusals_are_told_apart_from_an_unknown_outcome", async () => {
  const refused = deps({
    signAndSend: vi.fn(async () => {
      throw new WalletError("send", new Error("User rejected the request"));
    }),
  });
  await expect(submitHire(input(), refused.deps)).rejects.toThrow(
    "The wallet didn't finish. Nothing was hired",
  );

  const contract = deps({
    signAndSend: vi.fn(async () => {
      throw new TransactionFailed("tx9", "E_INVITE");
    }),
  });
  await expect(submitHire(input(), contract.deps)).rejects.toThrow(
    "Tender won't let this account invite this agent. Nothing was hired.",
  );

  // A window that closed may have sent the batch: the page must not offer to send it again.
  const unknown = deps({
    signAndSend: vi.fn(async () => {
      throw new WalletError("send", new Error("popup closed"));
    }),
  });
  expect(await submitHire(input(), unknown.deps)).toEqual({ kind: "unknown" });

  const noEvent = deps({
    signAndSend: vi.fn(async () => ({ txHashes: ["tx2"], events: [] })),
  });
  expect(await submitHire(input(), noEvent.deps)).toEqual({ kind: "sent", txHashes: ["tx2"] });
});

test("an_upload_the_api_stored_as_something_else_stops_the_hire", async () => {
  const world = deps({
    uploadBlob: vi.fn(async () => ({ sha256: "00".repeat(32), uri: "http://api.test/v1/blobs/x" })),
  });
  await expect(submitHire(input(), world.deps)).rejects.toThrow("Tender stored something other");
  expect(world.deps.signAndSend).not.toHaveBeenCalled();
});

test("the_plan_the_blockers_and_the_team_only_note", () => {
  expect(hirePlan(vaultOf(3_000_000n), service())).toMatchObject({
    inVault: 3_000_000n,
    toDeposit: 0n,
    storageTopUp: 0n,
    problem: null,
  });
  expect(hirePlan(vaultOf(1_000_000n), service()).toDeposit).toBe(1_500_000n);
  expect(hireStorageTopUp(null, false)).toBeGreaterThan(HIRE_TASK_BYTES * STORAGE_BYTE_COST);

  expect(hireBlocker(service(), ALICE, JUDGE)).toBeNull();
  expect(hireBlocker(service(), null, JUDGE)).toBeNull();
  expect(hireBlocker(service({ status: "paused", available: false }), ALICE, JUDGE)).toMatch(
    /paused/,
  );
  expect(hireBlocker(service({ available: false }), ALICE, JUDGE)).toMatch(/active agent/);
  // A Judge-checked service on an API with no Judge: that is the reason, not the agent.
  const judgeless = service({
    available: false,
    verification: {
      kind: "judge",
      criteria: { ...HIRER_ACCEPTS_CRITERIA },
      criteria_hash: "ab".repeat(32),
      judge: null,
    },
  });
  expect(hireBlocker(judgeless, ALICE, JUDGE)).toBe(
    "The Tender Judge checks this service, and the Tender API has no Judge set up, so it can't be hired now.",
  );
  expect(hireBlocker(service(), WRITER, JUDGE)).toMatch(/can't hire itself/);
  const judged = service({
    verification: {
      kind: "judge",
      criteria: { ...HIRER_ACCEPTS_CRITERIA },
      criteria_hash: "ab".repeat(32),
      judge: JUDGE,
    },
  });
  expect(hireBlocker(judged, ALICE, null)).toMatch(/isn't set up/);
  expect(teamOnlyNote(judged)).toMatch(/Tender team posts/);
  expect(teamOnlyNote(service())).toBeNull();
});

// ---- The provider's form ------------------------------------------------------------------------

test("the_provider_form_is_held_to_the_shared_rules_in_its_own_words", () => {
  const form = {
    ...emptyServiceForm([ALICE], TOKEN),
    title: "Summarise",
    description: "Five lines.",
    price: "2.5",
  };
  expect(checkServiceForm(form, 60)).toEqual({});
  expect(serviceRequestOf({ ...form, tags: "Research, #filings research" })).toEqual({
    agent: ALICE,
    title: "Summarise",
    description: "Five lines.",
    tags: ["research", "filings"],
    category: "other",
    output_format: "text",
    token: TOKEN,
    price: "2500000",
    commit_secs: 3_600,
    reveal_secs: 1_800,
    pick_secs: 3_600,
    verification: { kind: "hirer" },
  });

  const errors = checkServiceForm(
    {
      ...form,
      title: "two\nlines",
      description: "",
      tags: "a b c d e f",
      price: "0",
      commitMinutes: "0",
      revealMinutes: "x",
      verifier: "judge",
      criteria: '{"kind": "exact"}',
    },
    60,
  );
  expect(errors).toEqual({
    title: "Expected one line, without line breaks.",
    description: "Say what the agent does.",
    tags: "Up to 5 tags.",
    price: "Enter more than 0.",
    commitMinutes: "Use a whole number of minutes above 0, up to 14 days.",
    revealMinutes: "Use a whole number of minutes above 0, up to 14 days.",
    criteria: "Write the public criteria as JSON (kind regex_cases, tests or rubric).",
    // The unit tests' build has no Judge account, so the Judge is not offered at all.
    verifier: "This site isn't set up with the Tender Judge. Let the hirer accept the work.",
  });
  // A window under the network's shortest.
  expect(checkServiceForm({ ...form, pickMinutes: "1" }, 300).pickMinutes).toBe(
    "The pick window is at least 5m on this network.",
  );
  // Criteria the Judge would need held-out checks for.
  const exact = JSON.stringify({
    version: 1,
    kind: "exact",
    min_score: 100,
    split: "winner_take_all",
    has_heldout: false,
    normalize: [],
  });
  expect(checkServiceForm({ ...form, verifier: "judge", criteria: exact }, 60).criteria).toMatch(
    /^The Judge needs held-out checks for kind exact/,
  );
});

test("a_save_keeps_windows_that_are_no_whole_minutes_unless_they_are_edited", () => {
  const form = formOfService(service({ commit_secs: 90, reveal_secs: 45, pick_secs: 600 }));
  expect(form).toMatchObject({ commitMinutes: "2", revealMinutes: "1", pickMinutes: "10" });
  // Left as shown: the listed seconds go back, not the rounded minutes.
  expect(serviceRequestOf(form)).toMatchObject({
    commit_secs: 90,
    reveal_secs: 45,
    pick_secs: 600,
  });
  // Edited: the minutes typed.
  expect(serviceRequestOf({ ...form, commitMinutes: "3" }).commit_secs).toBe(180);
  // The network's shortest window is held to what is kept, too.
  expect(checkServiceForm({ ...form, title: "t", description: "d" }, 60).revealMinutes).toBe(
    "The reveal window is at least 1m on this network.",
  );
});

test("a_service_comes_back_into_the_form_as_it_was_written", () => {
  const form = formOfService(service({ price: "2500000", tags: ["a", "b"], commit_secs: 600 }));
  expect(form).toMatchObject({
    price: "2.5",
    tags: "a, b",
    commitMinutes: "10",
    verifier: "hirer",
  });
  expect(serviceRequestOf(form).price).toBe("2500000");
  // The form asks no category: an edited listing keeps its own, and a new one is "other".
  const research = formOfService(service({ category: "research" }));
  expect(serviceRequestOf(research).category).toBe("research");
  expect(emptyServiceForm(["alice.testnet"], "tusdc.testnet").category).toBe("other");
});
