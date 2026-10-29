import { describe, expect, test } from "vitest";
import { errorCodeOf, parseContractError, TenderError } from "../src/errors";

// The chain reports a panic as `Smart contract panicked: <text>`. The texts below are the ones the
// plan 01 sandbox suite asserts (contract/sandbox/tests/{admin,args,lifecycle,vault}.rs), copied in
// full from what the local chain returned for res/tender.wasm and res/test_token.wasm (near-sdk
// 5.29.1). A near-sdk bump that rewords one fails here; client.sandbox.test.ts sends each of them.
const PANIC = "Smart contract panicked: ";
const MISSPELLED_KEY =
  "Failed to deserialize input from JSON. Error: `unknown field `verifer`, expected one of " +
  "`token`, `reward`, `brief_uri`, `brief_hash`, `criteria_hash`, `heldout_commitment`, " +
  "`verifier`, `commit_secs`, `reveal_secs`, `pick_secs`, `fallback_secs`, `max_entries`, " +
  "`max_winners`, `invited`, `parent` at line 1 column 395`";

describe("parseContractError", () => {
  test("returns_the_code_a_contract_panic_starts_with", () => {
    expect(
      parseContractError(`${PANIC}E_AUTH: the poster and the verifier cannot enter task 1`),
    ).toBe("E_AUTH");
    expect(parseContractError(`${PANIC}E_NOT_FOUND: no task 9`)).toBe("E_NOT_FOUND");
  });

  test("returns_the_first_code_in_the_text", () => {
    expect(parseContractError("E_PHASE: task 1 is not open for commits; E_AUTH: x")).toBe(
      "E_PHASE",
    );
  });

  test("reads_a_code_inside_a_serialized_failure", () => {
    const failure = {
      ActionError: {
        index: 0,
        kind: {
          FunctionCallError: { ExecutionError: `${PANIC}E_FUNDS: insufficient vault balance` },
        },
      },
    };
    expect(parseContractError(JSON.stringify(failure))).toBe("E_FUNDS");
  });

  test("returns_null_without_a_code", () => {
    expect(parseContractError(`${PANIC}Method new is private`)).toBeNull();
    expect(parseContractError("E_AUTH without a colon")).toBeNull();
    expect(parseContractError("e_auth: lowercase is not a code")).toBeNull();
    expect(parseContractError("")).toBeNull();
  });
});

describe("errorCodeOf", () => {
  // One row per line of the P02-R16 table, with the sandbox suite's texts.
  test.each([
    [`${PANIC}Requires attached deposit of exactly 1 yoctoNEAR`, "E_AUTH"],
    [`${PANIC}Method new is private`, "E_AUTH"],
    [`${PANIC}Method migrate is private`, "E_AUTH"],
    [`${PANIC}${MISSPELLED_KEY}`, "E_ARGS"],
    [`${PANIC}Method commit doesn't accept deposit`, "E_ARGS"],
    [`${PANIC}Method pick doesn't accept deposit`, "E_ARGS"],
    [`${PANIC}The contract has already been initialized`, "E_INITIALIZED"],
  ])("maps %j to %s", (message, code) => {
    expect(errorCodeOf(message)).toBe(code);
  });

  test("a_contract_code_comes_first", () => {
    expect(errorCodeOf(`${PANIC}E_OWNER: alice.sandbox is not the owner`)).toBe("E_OWNER");
    expect(errorCodeOf(`${PANIC}E_GAS: withdraw needs at least 35 Tgas prepaid, got 30`)).toBe(
      "E_GAS",
    );
  });

  test("anything_else_is_unknown", () => {
    const missingAccount = {
      ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: "x.sandbox" } } },
    };
    expect(errorCodeOf(JSON.stringify(missingAccount))).toBe("E_UNKNOWN");
    expect(errorCodeOf(`${PANIC}The account nobody.sandbox is not registered`)).toBe("E_UNKNOWN");
    expect(errorCodeOf("")).toBe("E_UNKNOWN");
  });
});

describe("TenderError", () => {
  test("carries_the_code_the_message_and_the_transaction", () => {
    const cause = { ActionError: { index: 0 } };
    const error = new TenderError("E_AUTH", "E_AUTH: no", { txHash: "abc", cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("TenderError");
    expect(error.code).toBe("E_AUTH");
    expect(error.message).toBe("E_AUTH: no");
    expect(error.txHash).toBe("abc");
    expect(error.cause).toBe(cause);
  });

  test("has_no_transaction_when_none_was_sent", () => {
    expect(new TenderError("E_UNKNOWN", "x").txHash).toBeUndefined();
  });
});
