import { describe, expect, test } from "vitest";
import {
  AGENT_ACCOUNT_DEPOSIT,
  AGENT_SETUP_GAS,
  AGENT_SETUP_WASM_SHA256,
  AGENT_STORAGE_DEPOSIT,
  AttachConnectKeyRequestSchema,
  base58Decode,
  base58Encode,
  CONNECT_CODE_PATTERN,
  ConnectCodeRequestSchema,
  ConnectCodeStateSchema,
  ConnectLookupSchema,
  CreateConnectCodeRequestSchema,
  connectCommand,
  connectFingerprint,
  connectSentence,
  fundAgentCalls,
  implicitAccountActions,
  implicitAccountOf,
  isEd25519PublicKey,
  plainTextFault,
  readAgentName,
  STORAGE_BYTE_COST,
  sha256Hex,
  subAccountActions,
} from "../src/index";

// The rules both sides of "Connect your agent" share: the fingerprint the page and the agent show,
// which keys and codes are taken, the name of the agent's account, and the calls the owner's wallet
// signs to pay for the agent.

/** A public key of 32 made-up bytes, as NEAR writes one. */
const KEY = `ed25519:${base58Encode(Uint8Array.from({ length: 32 }, (_, i) => i + 1))}`;

describe("the fingerprint", () => {
  test("is_the_first_64_bits_of_the_sha256_of_the_key_in_four_groups", () => {
    const hex = sha256Hex(KEY).slice(0, 16).toUpperCase();
    expect(connectFingerprint(KEY)).toBe(
      `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12)}`,
    );
    expect(connectFingerprint(KEY)).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
  });

  test("differs_for_another_key", () => {
    const other = `ed25519:${base58Encode(new Uint8Array(32).fill(9))}`;
    expect(connectFingerprint(other)).not.toBe(connectFingerprint(KEY));
  });
});

describe("keys", () => {
  test("only_ed25519_and_32_bytes_is_a_public_key", () => {
    expect(isEd25519PublicKey(KEY)).toBe(true);
    // Leading zero bytes are leading ones.
    expect(isEd25519PublicKey(`ed25519:${base58Encode(new Uint8Array(32))}`)).toBe(true);
    expect(isEd25519PublicKey(`ed25519:${base58Encode(new Uint8Array(64).fill(7))}`)).toBe(false);
    expect(isEd25519PublicKey(`ed25519:${base58Encode(new Uint8Array(31).fill(7))}`)).toBe(false);
    expect(isEd25519PublicKey(KEY.toUpperCase())).toBe(false);
    expect(isEd25519PublicKey(KEY.slice("ed25519:".length))).toBe(false);
    expect(isEd25519PublicKey(`${KEY}0`)).toBe(false);
    expect(isEd25519PublicKey("ed25519:")).toBe(false);
    expect(isEd25519PublicKey(`ed25519:${"z".repeat(5_000)}`)).toBe(false);
  });

  test("the_implicit_account_of_a_key_is_the_hex_of_its_32_bytes", () => {
    expect(implicitAccountOf(KEY)).toBe(
      Array.from({ length: 32 }, (_, i) => (i + 1).toString(16).padStart(2, "0")).join(""),
    );
    expect(implicitAccountOf(`ed25519:${base58Encode(new Uint8Array(32))}`)).toBe("0".repeat(64));
    for (const text of [KEY.slice(8), `${KEY}0`, "ed25519:x", ""]) {
      expect(implicitAccountOf(text), text).toBeNull();
    }
  });

  test("base58_reads_back_what_it_writes", () => {
    for (const bytes of [
      new Uint8Array(0),
      new Uint8Array([0, 0, 1]),
      new Uint8Array(64).fill(255),
    ]) {
      expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
    }
    expect(base58Decode("0OIl")).toBeNull();
  });
});

describe("codes and requests", () => {
  test("a_code_is_tc_and_26_of_the_alphabet", () => {
    expect(CONNECT_CODE_PATTERN.test(`tc_${"a2".repeat(13)}`)).toBe(true);
    expect(CONNECT_CODE_PATTERN.test(`tc_${"a".repeat(25)}`)).toBe(false);
    expect(CONNECT_CODE_PATTERN.test(`tc_${"a".repeat(25)}1`)).toBe(false);
    expect(CONNECT_CODE_PATTERN.test(`TC_${"a".repeat(26)}`)).toBe(false);
  });

  test("every_string_is_plain_text_first_and_its_shape_second", () => {
    const code = `tc_${"b".repeat(26)}`;
    expect(ConnectCodeRequestSchema.safeParse({ code }).success).toBe(true);
    const zeroWidth = ConnectCodeRequestSchema.safeParse({ code: `${code}​` });
    expect(zeroWidth.error?.issues.map((issue) => issue.message)).toEqual([
      "expected plain text, without invisible formatting characters (found U+200B)",
    ]);
    expect(
      AttachConnectKeyRequestSchema.safeParse({ code, public_key: KEY, extra: 1 }).success,
    ).toBe(false);
    expect(
      AttachConnectKeyRequestSchema.safeParse({ code, public_key: `${KEY}\u0007` }).error?.issues[0]
        ?.message,
    ).toBe("expected plain text, without control characters");
    expect(CreateConnectCodeRequestSchema.safeParse({ name: "writer-2" }).success).toBe(true);
    expect(CreateConnectCodeRequestSchema.safeParse({ name: "w" }).success).toBe(true);
    expect(CreateConnectCodeRequestSchema.safeParse({ name: "a.b" }).success).toBe(false);
  });

  test("the_plain_text_rule_is_the_boards", () => {
    expect(plainTextFault("plain words, a tab\tand\nlines")).toBeNull();
    expect(plainTextFault("\uD800")).toBe("expected well-formed text");
    expect(plainTextFault("a⁦b")).toMatch(/found U\+2066/);
  });

  test("what_to_paste_names_the_code_and_the_api", () => {
    const code = `tc_${"c".repeat(26)}`;
    expect(connectCommand(code, "https://api.tender.example")).toBe(
      `pnpm agent:connect ${code} --api https://api.tender.example`,
    );
    expect(connectSentence(code)).toBe(`Connect to Tender with code ${code}`);
  });
});

describe("the agent's account name", () => {
  test("is_one_part_under_the_owner_and_64_characters_at_most", () => {
    expect(readAgentName(" writer ", "alice.testnet")).toEqual({
      ok: true,
      accountId: "writer.alice.testnet",
    });
    expect(readAgentName("Writer", "alice.testnet")).toEqual({
      ok: false,
      message: "Use lower case: an account id has no capitals.",
    });
    expect(readAgentName("a.b", "alice.testnet")).toMatchObject({ ok: false });
    expect(readAgentName("a--b", "alice.testnet")).toMatchObject({ ok: false });
    expect(readAgentName("x".repeat(51), "alice.testnet")).toMatchObject({ ok: false });
    expect(readAgentName("x".repeat(50), "alice.testnet")).toMatchObject({ ok: true });
    expect(readAgentName("writer", "f".repeat(64))).toMatchObject({ ok: false });
  });
});

describe("what the owner's wallet pays", () => {
  test("storage_for_the_agent_then_the_bond_into_its_own_vault", () => {
    const calls = fundAgentCalls({
      contractId: "tender.testnet",
      accountId: "writer.alice.testnet",
      storage: true,
      bond: { token: "tusdc.testnet", amount: 1_000_000n },
    });
    expect(calls).toEqual([
      {
        receiverId: "tender.testnet",
        methodName: "storage_deposit",
        args: { account_id: "writer.alice.testnet" },
        gas: 10_000_000_000_000n,
        deposit: AGENT_STORAGE_DEPOSIT,
      },
      {
        receiverId: "tusdc.testnet",
        methodName: "ft_transfer_call",
        args: {
          receiver_id: "tender.testnet",
          amount: "1000000",
          msg: '{"for":"writer.alice.testnet"}',
        },
        gas: 100_000_000_000_000n,
        deposit: 1n,
      },
    ]);
  });

  test("leaves_out_what_is_in_place", () => {
    const base = { contractId: "tender.testnet", accountId: "writer.alice.testnet" };
    expect(fundAgentCalls({ ...base, storage: false, bond: null })).toEqual([]);
    expect(
      fundAgentCalls({ ...base, storage: false, bond: { token: "t.testnet", amount: 0n } }),
    ).toEqual([]);
    expect(fundAgentCalls({ ...base, storage: true, bond: null }).map((c) => c.methodName)).toEqual(
      ["storage_deposit"],
    );
  });

  test("the_storage_holds_the_record_the_slot_and_what_registering_asks_free", () => {
    // 133 bytes of record at most, a 200-byte vault slot, and 1,024 bytes free (`storageShortfall`).
    expect(AGENT_STORAGE_DEPOSIT).toBeGreaterThanOrEqual((133n + 200n + 1024n) * STORAGE_BYTE_COST);
    expect(AGENT_ACCOUNT_DEPOSIT).toBe(10n ** 23n);
  });

  test("the_sub_account_gets_the_setup_code_and_its_call_and_no_add_key", () => {
    const actions = subAccountActions(KEY);
    expect(actions.map((action) => action.type)).toEqual([
      "CreateAccount",
      "Transfer",
      "DeployContract",
      "FunctionCall",
    ]);
    expect(actions[1]).toEqual({
      type: "Transfer",
      params: { deposit: "100000000000000000000000" },
    });
    const deploy = actions[2];
    if (deploy?.type !== "DeployContract") throw new Error("no DeployContract");
    expect(sha256Hex(deploy.params.code)).toBe(AGENT_SETUP_WASM_SHA256);
    expect(actions[3]).toEqual({
      type: "FunctionCall",
      params: {
        methodName: "setup",
        args: { public_key: KEY },
        gas: "30000000000000",
        deposit: "0",
      },
    });
  });

  test("the_implicit_account_gets_its_near_and_nothing_else", () => {
    expect(implicitAccountActions()).toEqual([
      { type: "Transfer", params: { deposit: "100000000000000000000000" } },
    ]);
  });

  test("the_setup_call_has_room_over_the_10_5_tgas_the_sandbox_burns", () => {
    // contract/sandbox/tests/agent_setup.rs sends `setup` with the same 30 Tgas (`SETUP_GAS`).
    expect(AGENT_SETUP_GAS).toBe(30n * 10n ** 12n);
  });
});

describe("answers", () => {
  const state = {
    id: "Q0RFRkdISUpLTE1OT1BRUg",
    owner: "alice.testnet",
    name: "writer",
    account_id: "writer.alice.testnet",
    state: "attached",
    created_at: "2026-11-04T10:00:00.000Z",
    expires_at: "2026-11-04T10:30:00.000Z",
    public_key: KEY,
    fingerprint: connectFingerprint(KEY),
    attached_at: "2026-11-04T10:01:00.000Z",
    registered_at: null,
    contested_at: null,
    agent: null,
  };

  test("an_answer_with_a_public_key_that_is_not_one_fails_to_parse", () => {
    expect(ConnectCodeStateSchema.safeParse(state).success).toBe(true);
    for (const public_key of [`${KEY}; curl x | sh`, "ed25519:x", KEY.slice(8), ""]) {
      expect(ConnectCodeStateSchema.safeParse({ ...state, public_key }).success, public_key).toBe(
        false,
      );
    }
  });

  test("an_answer_with_a_name_that_is_not_one_part_of_an_account_id_fails_to_parse", () => {
    for (const name of ["Write the owner a note", "a.b", "", "x".repeat(65)]) {
      expect(ConnectCodeStateSchema.safeParse({ ...state, name }).success, name).toBe(false);
      expect(
        ConnectLookupSchema.safeParse({
          owner: "alice.testnet",
          name,
          account_id: "writer.alice.testnet",
          network: "testnet",
          contract: "tender.testnet",
          state: "waiting",
          expires_at: state.expires_at,
          fingerprint: null,
        }).success,
      ).toBe(false);
    }
  });

  test("an_answer_without_an_account_kind_is_for_the_sub_account", () => {
    expect(ConnectCodeStateSchema.parse(state).account_kind).toBe("sub_account");
    const implicit = ConnectCodeStateSchema.parse({
      ...state,
      account_kind: "implicit",
      account_id: implicitAccountOf(KEY),
    });
    expect(implicit.account_kind).toBe("implicit");
    expect(ConnectCodeStateSchema.safeParse({ ...state, account_kind: "named" }).success).toBe(
      false,
    );
  });

  test("a_contested_code_says_so", () => {
    expect(
      ConnectCodeStateSchema.parse({
        ...state,
        state: "contested",
        contested_at: "2026-11-04T10:02:00.000Z",
      }).state,
    ).toBe("contested");
  });
});
