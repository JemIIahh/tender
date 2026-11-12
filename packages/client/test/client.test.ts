import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type extractEvents, NETWORKS, type PostTaskInput, type TenderCall } from "@tender/shared";
import { Account, actions, JsonRpcProvider, KeyPair } from "near-api-js";
import {
  CostOverflowError,
  InvalidChainError,
  InvalidNonceError,
  InvalidReceiverIdError,
  InvalidSignatureError,
  InvalidSignerIdError,
  InvalidTransactionVersionError,
  NonceTooLargeError,
  NotEnoughBalanceError,
  ShardCongestedError,
  ShardStuckError,
  SignerDoesNotExistError,
  TransactionExpiredError,
  TransactionSizeExceededError,
  TransactionTimeoutError,
} from "near-api-js/rpc-errors";
import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";
import { sendRefused, TenderClient, TenderError, type TxResult, toTxResult } from "../src/index";

const CONTRACT = "tender.test.near";
const BLOCK = { block_hash: "6kSpdaiEGudXLa4p43ALXFHCu96ozdEJ3c8KsCuajXyj", block_height: 34 };

interface RpcRequest {
  method: string;
  params: Record<string, unknown>;
}

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise((resolve) => s.close(() => resolve(undefined)))),
  );
});

/**
 * A JSON-RPC endpoint on localhost that answers each request with `answer(request)`: an object
 * with `result` or `error`, sent with HTTP 200 the way nearcore sends its errors (near-api-js
 * retries a 5xx, which would only slow the test down).
 */
async function fakeRpc(answer: (request: RpcRequest) => object) {
  const requests: RpcRequest[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const request = JSON.parse(body) as RpcRequest & { id: string };
      requests.push(request);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...answer(request) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  servers.push(server);
  const client = new TenderClient({
    network: "testnet",
    contractId: CONTRACT,
    rpcUrl: `http://127.0.0.1:${port}`,
  });
  return { client, requests };
}

/** What `call_function` returns: the view's JSON as an array of bytes. */
const viewResult = (value: unknown) => ({
  result: { result: [...Buffer.from(JSON.stringify(value))], logs: [], ...BLOCK },
});

/** The view method and its decoded arguments, of a `call_function` query. */
function viewCall(request: RpcRequest) {
  const { params } = request;
  return {
    method: params.method_name as string,
    args: JSON.parse(Buffer.from(params.args_base64 as string, "base64").toString()),
  };
}

const PUBLIC_KEY = "ed25519:8oM18aZ1sUM15npryCGoe2CdL4PphfsarZdJysVfiVXs";

function taskView(fields: { commit_count: number; cleaned: number }) {
  return {
    id: "7",
    poster: "poster.test.near",
    token: "usdc.test.near",
    reward: "1000000",
    fee_bps: 500,
    brief_uri: "ipfs://brief",
    brief_hash: "29a8825bd242f14386ee528d76e0e8f1e38f3c8c4047d7b2d6df7493368a17d0",
    criteria_hash: "262d517bffd06484e2341b4a379c7f4fa4be9284a9a82631c03420953d60bd67",
    heldout_commitment: null,
    verifier: "judge.test.near",
    created_at: "1793307169820229000",
    commit_deadline: "1793307289820229000",
    reveal_deadline: "1793307409820229000",
    pick_deadline: "1793307529820229000",
    fallback_deadline: "1793307649820229000",
    max_entries: 0,
    max_winners: 1,
    invited: [],
    parent: null,
    reveal_count: 0,
    funders: [{ account: "poster.test.near", amount: "1000000" }],
    outcome: { kind: "voided", reason: "no_reveals", scorecard_hash: null, scorecard_uri: null },
    phase: "settled",
    ...fields,
  };
}

function entryView(index: number) {
  return {
    task_id: "7",
    account: `e${index}.test.near`,
    index,
    commitment: "f8ea8d0472958708781004e27f609f4ac0087a4820e165d819a2ee4812098c0e",
    committed_at_block: "65",
    content_hash: null,
    uri: null,
  };
}

/** A task with `commitCount` entries, of which only the indexes in `present` are left. */
function entriesChain(commitCount: number, cleaned: number, present: (index: number) => boolean) {
  return (request: RpcRequest) => {
    const { method, args } = viewCall(request);
    if (method === "get_task") return viewResult(taskView({ commit_count: commitCount, cleaned }));
    // The contract's paging: the limit is clamped to 1..=50, and the page stops at the last index.
    const end = Math.min(args.from_index + Math.min(Math.max(args.limit, 1), 50), commitCount);
    const page = [];
    for (let i = args.from_index; i < end; i++) if (present(i)) page.push(entryView(i));
    return viewResult(page);
  };
}

describe("TenderClient construction", () => {
  test("a_sandbox_client_needs_the_chain_rpc_url", () => {
    expect(NETWORKS.sandbox.rpcUrl).toBe("");
    expect(() => new TenderClient({ network: "sandbox", contractId: "tender.sandbox" })).toThrow(
      /no RPC URL for network sandbox.*LocalChain\.rpcUrl/,
    );
    expect(
      () => new TenderClient({ network: "testnet", contractId: CONTRACT, rpcUrl: "" }),
    ).toThrow(/no RPC URL/);
  });

  test("the_network_url_is_the_default", () => {
    const client = new TenderClient({ network: "testnet", contractId: CONTRACT });
    expect(client.rpcUrl).toBe(NETWORKS.testnet.rpcUrl);
    expect(client.contractId).toBe(CONTRACT);
    expect(client.accountId).toBeUndefined();
    const local = new TenderClient({
      network: "sandbox",
      contractId: "tender.sandbox",
      rpcUrl: "http://127.0.0.1:3030",
    });
    expect(local.rpcUrl).toBe("http://127.0.0.1:3030");
  });

  test("a_signer_sets_the_account", () => {
    const client = new TenderClient({
      network: "testnet",
      contractId: CONTRACT,
      signer: {
        accountId: "alice.test.near",
        privateKey: KeyPair.fromRandom("ed25519").toString(),
      },
    });
    expect(client.accountId).toBe("alice.test.near");
  });

  test("send_without_a_signer_throws", async () => {
    const client = new TenderClient({ network: "testnet", contractId: CONTRACT });
    await expect(client.voidTask(1n)).rejects.toThrow(/no signer/);
  });
});

describe("delegate sends", () => {
  /** A client whose `send` records the call it is given and answers with a task id. */
  function recording() {
    const client = new TenderClient({ network: "testnet", contractId: CONTRACT });
    const calls: TenderCall[] = [];
    vi.spyOn(client, "send").mockImplementation(async (call) => {
      calls.push(call);
      return { returnValue: "7" } as TxResult;
    });
    return { client, calls };
  }

  const INPUT: PostTaskInput = {
    token: "usdc.test.near",
    reward: 1_000_000n,
    briefUri: "ipfs://brief",
    briefHash: "a".repeat(64),
    criteriaHash: "b".repeat(64),
    commitSecs: 60,
    revealSecs: 60,
    pickSecs: 60,
    fallbackSecs: 60,
  };

  test("postTask_and_topUpTask_attach_a_yocto_unless_the_key_is_a_delegate", async () => {
    const { client, calls } = recording();
    await client.postTask(INPUT);
    await client.topUpTask(7n, 500n);
    await client.postTask(INPUT, { delegate: true });
    await client.topUpTask(7n, 500n, { delegate: true });
    expect(calls.map((call) => [call.methodName, call.deposit])).toStrictEqual([
      ["post_task", 1n],
      ["top_up_task", 1n],
      ["post_task", 0n],
      ["top_up_task", 0n],
    ]);
  });

  test("a_delegate_postTask_still_gives_the_task_id", async () => {
    const { client } = recording();
    const posted = await client.postTask(INPUT, { delegate: true });
    expect(posted.taskId).toBe(7n);
  });
});

describe("the agent bond calls", () => {
  /** A client whose `send` records the calls it is given. */
  function recording() {
    const client = new TenderClient({ network: "testnet", contractId: CONTRACT });
    const calls: TenderCall[] = [];
    vi.spyOn(client, "send").mockImplementation(async (call) => {
      calls.push(call);
      return { returnValue: undefined } as TxResult;
    });
    return { client, calls };
  }

  test("each_sender_sends_its_builders_call_with_one_yocto", async () => {
    const { client, calls } = recording();
    await client.registerAgent("ipfs://profile", "a".repeat(64), ["rust"]);
    await client.unregisterAgent();
    await client.claimAgentBond();
    await client.setAgentBond("usdc.test.near", 1_000_000n);
    await client.setAgentBondCooldown(3_600);
    expect(
      calls.map((call) => [call.receiverId, call.methodName, call.args, call.deposit]),
    ).toEqual([
      [
        CONTRACT,
        "register_agent",
        { profile_uri: "ipfs://profile", profile_hash: "a".repeat(64), tags: ["rust"] },
        1n,
      ],
      [CONTRACT, "unregister_agent", {}, 1n],
      [CONTRACT, "claim_agent_bond", {}, 1n],
      [CONTRACT, "set_agent_bond", { token: "usdc.test.near", amount: "1000000" }, 1n],
      [CONTRACT, "set_agent_bond_cooldown", { secs: "3600" }, 1n],
    ]);
  });

  /** A client that signs with `key` as alice, against an RPC that says the key's permission is `permission`. */
  async function signedAgainst(permission: unknown) {
    const key = KeyPair.fromRandom("ed25519");
    const publicKey = key.getPublicKey().toString();
    const { client: reader, requests } = await fakeRpc(() =>
      permission === null
        ? {
            result: {
              ...BLOCK,
              error: `access key ${publicKey} does not exist while viewing`,
              logs: [],
            },
          }
        : { result: { ...BLOCK, nonce: 29_000_000, permission } },
    );
    const client = new TenderClient({
      network: "testnet",
      contractId: CONTRACT,
      rpcUrl: reader.rpcUrl,
      signer: { accountId: "alice.test.near", privateKey: key.toString() },
    });
    return { client, requests, publicKey };
  }

  const FUNCTION_CALL_KEY = {
    FunctionCall: {
      allowance: "1000000000000000000000000",
      receiver_id: CONTRACT,
      method_names: ["register_agent", "unregister_agent", "claim_agent_bond", "commit"],
    },
  };

  test("a_client_knows_the_public_half_of_its_key", async () => {
    const { client, publicKey } = await signedAgainst("FullAccess");
    expect(client.publicKey).toBe(publicKey);
    expect(
      new TenderClient({ network: "testnet", contractId: CONTRACT }).publicKey,
    ).toBeUndefined();
  });

  test("a_function_call_key_is_refused_before_anything_is_sent", async () => {
    // A delegate key is one of these: it lists methods, but it cannot attach the 1 yoctoNEAR.
    const { client, requests } = await signedAgainst(FUNCTION_CALL_KEY);
    for (const attempt of [
      () => client.registerAgent("ipfs://profile", "a".repeat(64), []),
      () => client.unregisterAgent(),
      () => client.claimAgentBond(),
      () => client.requireFullAccessKey("register_agent"),
    ]) {
      const error = await attempt().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(TenderError);
      expect(error).toMatchObject({ code: "E_AUTH", txHash: undefined });
      expect((error as Error).message).toContain("full-access key");
      expect((error as Error).message).toContain("Nothing was sent");
    }
    // Only the key was looked up: not the block, not a nonce, no transaction.
    expect(new Set(requests.map((r) => `${r.method} ${r.params.request_type}`))).toEqual(
      new Set(["query view_access_key"]),
    );
  });

  test("a_key_the_account_does_not_have_is_refused_too", async () => {
    const { client, requests, publicKey } = await signedAgainst(null);
    const error = await client.claimAgentBond().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: "E_AUTH" });
    expect((error as Error).message).toContain(`${publicKey} is not a key of that account`);
    expect(requests.map((r) => r.method)).toEqual(["query"]);
  });

  test("a_full_access_key_goes_on_to_send", async () => {
    const { client, requests } = await signedAgainst("FullAccess");
    // The fake node answers every request alike, so the send fails after the guard; what matters
    // is that it got that far: the guard looked once, and the send asked the node for more.
    const error = await client.unregisterAgent().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).not.toMatchObject({
      code: "E_AUTH",
      message: expect.stringContaining("Nothing was sent"),
    });
    expect(requests.length).toBeGreaterThan(1);
  });

  test("other_calls_are_not_checked_against_the_key", async () => {
    // Only the three methods that take 1 yoctoNEAR of a full-access key look the key up.
    const { client, requests } = await signedAgainst(FUNCTION_CALL_KEY);
    await client.commit(1n, "a".repeat(64)).catch(() => undefined);
    const lookups = requests.filter((r) => r.params.request_type === "view_access_key");
    // near-api-js reads the key's nonce to sign; the guard adds no read of its own to a commit.
    expect(lookups.length).toBeLessThanOrEqual(2);
  });
});

describe("views", () => {
  test("read_the_last_final_block_and_validate", async () => {
    const config = {
      owner: "owner.test.near",
      pending_owner: null,
      treasury: "treasury.test.near",
      fee_bps: 500,
      min_window_secs: 60,
      max_window_secs: 1_209_600,
      paused: false,
      version: 1,
      tokens: [],
      agent_bond_token: "usdc.test.near",
      agent_bond_amount: "1000000",
      agent_bond_cooldown_secs: "3600",
    };
    const { client, requests } = await fakeRpc(() => viewResult(config));
    expect(await client.getConfig()).toEqual(config);
    expect(requests[0]?.params).toMatchObject({
      request_type: "call_function",
      account_id: CONTRACT,
      method_name: "get_config",
      finality: "final",
    });
  });

  test("the_agent_view_carries_its_status_and_bond", async () => {
    const agent = {
      account: "alice.test.near",
      asp: "test.near",
      profile_uri: "ipfs://alice",
      profile_hash: "a".repeat(64),
      tags: ["rust"],
      registered_at: "1793307169435833000",
      entries: 0,
      reveals: 0,
      wins: 0,
      earned: [],
      picks_made: 0,
      voids_after_reveals: 0,
      status: "unregistering",
      bond_token: "usdc.test.near",
      bond_amount: "1000000",
      claimable_at: "1793307179435833000",
      locked_until: "1793307189435833000",
    };
    const { client } = await fakeRpc(() => viewResult(agent));
    expect(await client.getAgent("alice.test.near")).toEqual(agent);
    // A contract from before the bond sends none of the five: that is not an agent in some state.
    const {
      status: _s,
      bond_token: _t,
      bond_amount: _a,
      claimable_at: _c,
      locked_until: _l,
      ...old
    } = agent;
    const { client: oldClient } = await fakeRpc(() => viewResult(old));
    await expect(oldClient.getAgent("alice.test.near")).rejects.toThrow();
  });

  test("a_view_that_breaks_its_schema_is_an_error", async () => {
    // A u128 as a JSON number loses digits, and is refused.
    const { client } = await fakeRpc(() =>
      viewResult({ ...taskView({ commit_count: 0, cleaned: 0 }), reward: 1e6 }),
    );
    await expect(client.getTask(7n)).rejects.toThrow();
  });

  test("a_missing_value_is_null", async () => {
    const { client, requests } = await fakeRpc(() => viewResult(null));
    expect(await client.getTask(7n)).toBeNull();
    expect(await client.getEntry(7n, "alice.test.near")).toBeNull();
    expect(await client.getAgent("alice.test.near")).toBeNull();
    expect(await client.storageBalanceOf("alice.test.near")).toBeNull();
    expect(await client.ftStorageBalanceOf("usdc.test.near", "alice.test.near")).toBeNull();
    expect(requests.map(viewCall)).toEqual([
      { method: "get_task", args: { task_id: "7" } },
      { method: "get_entry", args: { task_id: "7", account_id: "alice.test.near" } },
      { method: "get_agent", args: { account_id: "alice.test.near" } },
      { method: "storage_balance_of", args: { account_id: "alice.test.near" } },
      { method: "storage_balance_of", args: { account_id: "alice.test.near" } },
    ]);
    expect(requests[4]?.params.account_id).toBe("usdc.test.near");
  });

  test("amounts_and_counts_are_bigints", async () => {
    const { client } = await fakeRpc((request) => {
      const { method } = viewCall(request);
      return viewResult(
        method === "task_count"
          ? "18446744073709551615"
          : "340282366920938463463374607431768211455",
      );
    });
    expect(await client.taskCount()).toBe(2n ** 64n - 1n);
    expect(await client.balanceOf("alice.test.near", "usdc.test.near")).toBe(2n ** 128n - 1n);
    expect(await client.ftBalanceOf("usdc.test.near", "alice.test.near")).toBe(2n ** 128n - 1n);
  });

  test("the_final_block_gives_height_and_time", async () => {
    const { client, requests } = await fakeRpc(() => ({
      result: { header: { height: 120, timestamp_nanosec: "1793307169820229123" } },
    }));
    expect(await client.finalHeight()).toBe(120n);
    expect(await client.blockTimestampNs()).toBe(1793307169820229123n);
    for (const request of requests) {
      expect(request).toMatchObject({ method: "block", params: { finality: "final" } });
    }
  });
});

describe("getAllEntries", () => {
  test("pages_from_the_cleaned_count_to_the_last_index", async () => {
    const { client, requests } = await fakeRpc(entriesChain(130, 60, () => true));
    const entries = await client.getAllEntries(7n);
    expect(entries.map((e) => e.index)).toEqual(Array.from({ length: 70 }, (_, i) => 60 + i));
    const pages = requests.map(viewCall).filter((c) => c.method === "get_entries");
    expect(pages.map((c) => c.args)).toEqual([
      { task_id: "7", from_index: 60, limit: 50 },
      { task_id: "7", from_index: 110, limit: 50 },
    ]);
  });

  test("does_not_stop_at_an_empty_page", async () => {
    // Nothing is left of the first 50 indexes, although the task says none were cleaned.
    const { client } = await fakeRpc(entriesChain(120, 0, (i) => i >= 50 && i % 2 === 0));
    const entries = await client.getAllEntries(7n);
    expect(entries.map((e) => e.index)).toEqual(Array.from({ length: 35 }, (_, i) => 50 + 2 * i));
  });

  test("a_missing_task_has_no_entries", async () => {
    const { client, requests } = await fakeRpc(() => viewResult(null));
    expect(await client.getAllEntries(7n)).toEqual([]);
    expect(requests).toHaveLength(1);
  });
});

describe("viewAccessKey", () => {
  test("passes_the_permission_through_unmodified", async () => {
    // A variant KeyPermission does not name: the verifier, not the client, decides what to allow.
    const permission = {
      GasKeyFunctionCall: {
        allowance: null,
        balance: "0",
        method_names: [],
        num_nonces: 1,
        receiver_id: CONTRACT,
      },
    };
    const { client, requests } = await fakeRpc(() => ({
      result: { ...BLOCK, nonce: 29_000_000, permission },
    }));
    expect(await client.viewAccessKey("alice.test.near", PUBLIC_KEY)).toEqual({ permission });
    expect(requests[0]).toMatchObject({
      method: "query",
      params: {
        request_type: "view_access_key",
        account_id: "alice.test.near",
        public_key: PUBLIC_KEY,
        finality: "final",
      },
    });
  });

  test("a_missing_key_is_null", async () => {
    // nearcore 2.13.4 answers this way, for an account without the key and for a missing account.
    const { client } = await fakeRpc(() => ({
      result: {
        ...BLOCK,
        error: `access key ${PUBLIC_KEY} does not exist while viewing`,
        logs: [],
      },
    }));
    expect(await client.viewAccessKey("alice.test.near", PUBLIC_KEY)).toBeNull();
  });

  test("a_missing_key_in_the_structured_error_form_is_null", async () => {
    const { client } = await fakeRpc(() => ({
      error: {
        name: "HANDLER_ERROR",
        cause: { name: "UNKNOWN_ACCESS_KEY", info: { public_key: PUBLIC_KEY, ...BLOCK } },
        code: -32000,
        message: "Server error",
      },
    }));
    expect(await client.viewAccessKey("alice.test.near", PUBLIC_KEY)).toBeNull();
  });

  test("a_missing_account_is_null", async () => {
    const { client } = await fakeRpc(() => ({
      error: {
        name: "HANDLER_ERROR",
        cause: {
          name: "UNKNOWN_ACCOUNT",
          info: { requested_account_id: "nobody.test.near", ...BLOCK },
        },
        code: -32000,
        message: "Server error",
      },
    }));
    expect(await client.viewAccessKey("nobody.test.near", PUBLIC_KEY)).toBeNull();
  });

  test.each([
    [{ name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK", info: {} } }],
    [{ name: "HANDLER_ERROR", cause: { name: "NO_SYNCED_BLOCKS", info: {} } }],
    [
      {
        name: "INTERNAL_ERROR",
        cause: { name: "INTERNAL_ERROR", info: { error_message: "boom" } },
      },
    ],
  ])("any_other_rpc_error_is_thrown %j", async (error) => {
    const { client } = await fakeRpc(() => ({ error: { ...error, code: -32000, message: "x" } }));
    await expect(client.viewAccessKey("alice.test.near", PUBLIC_KEY)).rejects.toThrow();
  });
});

describe("toTxResult", () => {
  const base64 = (text: string) => Buffer.from(text).toString("base64");
  const event = (name: string, data: object) =>
    `EVENT_JSON:${JSON.stringify({ standard: "tender", version: "1.0.0", event: name, data: [data] })}`;
  const voided = event("voided", {
    task_id: "7",
    reason: "no_reveals",
    by: null,
    refunds: [{ account: "poster.test.near", amount: "1000000" }],
    scorecard_hash: null,
    scorecard_uri: null,
  });
  const withdraw = event("withdraw", {
    account: "bob.test.near",
    token: "usdc.test.near",
    amount: "5",
    to: "bob.test.near",
  });
  const response = (status: unknown) => ({
    status,
    transaction: { hash: "TX" },
    receipts_outcome: [
      {
        id: "R1",
        outcome: { executor_id: CONTRACT, status: { SuccessValue: "" }, logs: [voided, "note"] },
      },
      // A failed receipt keeps its logs, and they are not events.
      { id: "R2", outcome: { executor_id: CONTRACT, status: { Failure: {} }, logs: [withdraw] } },
      // Another contract can log what looks like a Tender event.
      {
        id: "R3",
        outcome: { executor_id: "evil.test.near", status: { SuccessValue: "" }, logs: [withdraw] },
      },
    ],
  });

  test("a_success_returns_the_events_and_the_value", () => {
    const result = toTxResult(response({ SuccessValue: base64('"7"') }), CONTRACT);
    expect(result.txHash).toBe("TX");
    expect(result.returnValue).toBe("7");
    expect(result.events).toMatchObject([{ event: "voided", receiptId: "R1", logIndex: 0 }]);
    // The type has the receipt id and the log index too, which consumers deduplicate on.
    expectTypeOf(result.events).toEqualTypeOf<ReturnType<typeof extractEvents>>();
    expect(result.receipts.map((r) => r.status)).toEqual(["success", "failure", "success"]);
  });

  test("the_return_value_is_decoded_json", () => {
    expect(toTxResult(response({ SuccessValue: base64("false") }), CONTRACT).returnValue).toBe(
      false,
    );
    expect(toTxResult(response({ SuccessValue: base64("1") }), CONTRACT).returnValue).toBe(1);
    expect(toTxResult(response({ SuccessValue: "" }), CONTRACT).returnValue).toBeUndefined();
    expect(toTxResult(response({ SuccessValue: base64("not json") }), CONTRACT).returnValue).toBe(
      "not json",
    );
  });

  test("a_failure_throws_the_code", () => {
    const panic =
      "Smart contract panicked: E_AUTH: the poster and the verifier cannot enter task 7";
    const failure = {
      ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: panic } } },
    };
    let thrown: unknown;
    try {
      toTxResult(response({ Failure: failure }), CONTRACT);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TenderError);
    expect(thrown).toMatchObject({ code: "E_AUTH", message: panic, txHash: "TX", cause: failure });
  });

  test("a_failure_without_a_panic_is_unknown", () => {
    const failure = {
      ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: CONTRACT } } },
    };
    expect(() => toTxResult(response({ Failure: failure }), CONTRACT)).toThrow(
      expect.objectContaining({ code: "E_UNKNOWN", message: JSON.stringify(failure) }),
    );
  });

  test.each([["Started"], ["NotStarted"], [{}], [null], [{ SuccessValue: 1 }]])(
    "an_unfinished_or_unknown_status_throws %j",
    (status) => {
      expect(() => toTxResult(response(status), CONTRACT)).toThrow(
        expect.objectContaining({ code: "E_UNKNOWN", txHash: "TX" }),
      );
    },
  );
});

describe("NEAR transfers and balances", () => {
  /** What `view_account` answers for an account that holds `amount` yoctoNEAR. */
  const accountView = (amount: string) => ({
    result: {
      ...BLOCK,
      amount,
      locked: "0",
      code_hash: "11111111111111111111111111111111",
      storage_usage: 182,
      storage_paid_at: 0,
    },
  });

  test("the_balance_is_the_accounts_amount_at_the_last_final_block", async () => {
    const amount = "340282366920938463463374607431768211455";
    const { client, requests } = await fakeRpc(() => accountView(amount));
    expect(await client.nearBalanceOf("alice.test.near")).toBe(BigInt(amount));
    expect(requests[0]).toMatchObject({
      method: "query",
      params: { request_type: "view_account", account_id: "alice.test.near", finality: "final" },
    });
  });

  test("an_account_that_does_not_exist_holds_nothing", async () => {
    // An implicit account that nobody has sent NEAR to is not on chain yet.
    const { client } = await fakeRpc(() => ({
      error: {
        name: "HANDLER_ERROR",
        cause: {
          name: "UNKNOWN_ACCOUNT",
          info: { requested_account_id: "ab".repeat(32), ...BLOCK },
        },
        code: -32000,
        message: "Server error",
      },
    }));
    expect(await client.nearBalanceOf("ab".repeat(32))).toBe(0n);
  });

  test.each([
    [{ name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK", info: {} } }],
    [{ name: "INTERNAL_ERROR", cause: { name: "INTERNAL_ERROR", info: { error_message: "x" } } }],
  ])("any_other_rpc_error_is_thrown_and_never_read_as_nothing %j", async (error) => {
    const { client } = await fakeRpc(() => ({ error: { ...error, code: -32000, message: "x" } }));
    await expect(client.nearBalanceOf("alice.test.near")).rejects.toThrow();
  });

  /** A signing client whose sends do not reach a node: `answer` is what each send returns. */
  function signing(answer: () => unknown) {
    const key = KeyPair.fromRandom("ed25519");
    const client = new TenderClient({
      network: "testnet",
      contractId: CONTRACT,
      signer: { accountId: "gift.test.near", privateKey: key.toString() },
    });
    const sent = vi
      .spyOn(Account.prototype, "signAndSendTransaction")
      .mockImplementation(async () => answer() as never);
    return { client, sent };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a_transfer_is_one_transfer_action_and_waits_until_it_has_executed", async () => {
    const { client, sent } = signing(() => ({
      status: { SuccessValue: "" },
      transaction: { hash: "TX" },
      receipts_outcome: [
        {
          id: "R1",
          outcome: { executor_id: "ab".repeat(32), status: { SuccessValue: "" }, logs: [] },
        },
      ],
    }));
    const result = await client.transfer("ab".repeat(32), 100n);
    expect(result).toMatchObject({ txHash: "TX", events: [], returnValue: undefined });
    expect(sent).toHaveBeenCalledTimes(1);
    const [args] = sent.mock.calls[0] ?? [];
    expect(args).toMatchObject({
      receiverId: "ab".repeat(32),
      waitUntil: "EXECUTED",
      throwOnFailure: false,
      retries: 0,
    });
    expect(args?.actions).toEqual([actions.transfer(100n)]);
  });

  test("a_transfer_that_failed_on_chain_throws_with_its_hash", async () => {
    const failure = { ActionError: { index: 0, kind: { LackBalanceForState: {} } } };
    const { client } = signing(() => ({
      status: { Failure: failure },
      transaction: { hash: "TX" },
      receipts_outcome: [],
    }));
    await expect(client.transfer("ab".repeat(32), 100n)).rejects.toMatchObject({
      code: "E_UNKNOWN",
      txHash: "TX",
    });
  });

  test("a_transfer_needs_a_signer_and_an_amount", async () => {
    const reader = new TenderClient({ network: "testnet", contractId: CONTRACT });
    await expect(reader.transfer("ab".repeat(32), 100n)).rejects.toThrow(/no signer/);
    const { client, sent } = signing(() => ({}));
    await expect(client.transfer("ab".repeat(32), 0n)).rejects.toThrow(RangeError);
    expect(sent).not.toHaveBeenCalled();
  });

  test("a_transfer_the_node_refused_or_that_failed_on_chain_is_refused_for_certain", async () => {
    const refusedByTheNode = new InvalidSignatureError("TX", "BLOCK");
    const { client } = signing(() => {
      throw refusedByTheNode;
    });
    const error = await client.transfer("ab".repeat(32), 100n).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBe(refusedByTheNode);
    expect(sendRefused(error)).toBe(true);
    // The other refusals that are properties of the signed bytes alone.
    for (const [what, refused] of [
      ["a signer id that is no account id", new InvalidSignerIdError("Not An Id", "TX", "BLOCK")],
      [
        "a receiver id that is no account id",
        new InvalidReceiverIdError("Not An Id", "TX", "BLOCK"),
      ],
      ["bytes over the size limit", new TransactionSizeExceededError(1, 2, "TX", "BLOCK")],
      ["a version the protocol does not take", new InvalidTransactionVersionError("TX", "BLOCK")],
    ] as const) {
      expect(sendRefused(refused), what).toBe(true);
    }

    // A final outcome that is a failure: the transaction ran and kept nothing.
    const failed = (() => {
      try {
        toTxResult(
          {
            status: { Failure: { ActionError: { index: 0, kind: { LackBalanceForState: {} } } } },
            transaction: { hash: "TX" },
            receipts_outcome: [],
          },
          CONTRACT,
        );
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(sendRefused(failed)).toBe(true);
  });

  test("a_transfer_is_signed_once_even_when_its_nonce_is_refused", async () => {
    // The node is stubbed at the provider: every transaction signed is counted, and every one sent
    // is answered `InvalidNonce`, which can be the answer to a resent copy of one that was taken.
    const key = KeyPair.fromRandom("ed25519");
    const client = new TenderClient({
      network: "testnet",
      contractId: CONTRACT,
      signer: { accountId: "gift.test.near", privateKey: key.toString() },
    });
    const signed = vi
      .spyOn(Account.prototype, "createSignedTransaction")
      .mockImplementation(
        async () =>
          ({ transaction: { publicKey: key.getPublicKey(), nonceIndex: undefined } }) as never,
      );
    const sent = vi
      .spyOn(JsonRpcProvider.prototype, "sendTransactionUntil")
      .mockImplementation(async () => {
        throw new InvalidNonceError(7, 7, "TX", "BLOCK");
      });

    const error = await client.transfer("ab".repeat(32), 100n).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(InvalidNonceError);
    expect(sendRefused(error)).toBe(false);
    // Neither near-api-js nor the queue signed a second transfer.
    expect(signed).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledTimes(1);

    // Every other send is as it was: near-api-js signs anew up to 10 times, then the queue once more
    // after 500 ms, and near-api-js 10 times again.
    signed.mockClear();
    sent.mockClear();
    await expect(client.voidTask(1n)).rejects.toBeInstanceOf(InvalidNonceError);
    expect(signed).toHaveBeenCalledTimes(22);
    expect(sent).toHaveBeenCalledTimes(22);
  });

  test("a_send_whose_outcome_is_not_known_is_never_refused_for_certain", () => {
    // Each of these may be followed by the transaction landing all the same.
    const unfinished = (() => {
      try {
        toTxResult(
          { status: "Started", transaction: { hash: "TX" }, receipts_outcome: [] },
          CONTRACT,
        );
      } catch (thrown) {
        return thrown;
      }
    })();
    for (const [what, error] of [
      ["a timeout of the client", new TenderError("E_TIMEOUT", "TenderClient.transfer timed out")],
      ["an outcome that is not final", unfinished],
      ["a timeout of the node's own wait", new TransactionTimeoutError()],
      // near-api-js sends the same bytes again after a 408, 500 or 503, and a second copy can be
      // refused for its receiver's shard while the first is already taken.
      ["a congested shard", new ShardCongestedError(1, 0, "TX", "BLOCK")],
      ["a stuck shard", new ShardStuckError(5, 0, "TX", "BLOCK")],
      // The same, for a second copy of bytes whose first copy already ran: it used the nonce, or
      // landed before its block expired; and a signer's balance is the chain's state at that
      // moment, not part of the signed bytes.
      ["a nonce that is used", new InvalidNonceError(7, 7, "TX", "BLOCK")],
      [
        "a signer short of NEAR",
        new NotEnoughBalanceError(1n, 2n, "gift.test.near", "TX", "BLOCK"),
      ],
      ["an expired block", new TransactionExpiredError("TX", "BLOCK")],
      // What the node sees at that moment, which another node behind the same address may not.
      ["a block the node does not know", new InvalidChainError("TX", "BLOCK")],
      ["a nonce too large for the node's height", new NonceTooLargeError(9, 8, "TX", "BLOCK")],
      [
        "a signer the node does not see",
        new SignerDoesNotExistError("gift.test.near", "TX", "BLOCK"),
      ],
      ["a cost that overflows at that gas price", new CostOverflowError("TX", "BLOCK")],
      ["a network error", new TypeError("fetch failed")],
      ["a contract's code, made by hand", new TenderError("E_AUTH", "E_AUTH: no")],
      ["nothing that is an error", "boom"],
    ] as const) {
      expect(sendRefused(error), what).toBe(false);
    }
  });
});
