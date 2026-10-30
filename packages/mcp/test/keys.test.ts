import type { TenderClient } from "@tender/client";
import { expect, test, vi } from "vitest";
import { detectKeyAccess, detectKeyKind, keyMayCall } from "../src/keys";

const CONTRACT = "tender.testnet";
const ACCOUNT = "alice.testnet";
const PUBLIC_KEY = "ed25519:EXn4u2AsbaXzfzeN1q1MRG2s73isE7D1CLmiN5jCBC1E";

type AccessKey = Awaited<ReturnType<TenderClient["viewAccessKey"]>>;

/** A client whose chain holds `key` for every lookup, and the lookups it was asked for. */
function chainWith(key: AccessKey) {
  const viewAccessKey = vi.fn<TenderClient["viewAccessKey"]>(async () => key);
  return { client: { contractId: CONTRACT, viewAccessKey }, viewAccessKey };
}

test("detect_key_kind_reads_the_access_key", async () => {
  const full = chainWith({ permission: "FullAccess" });
  expect(await detectKeyKind(full.client, ACCOUNT, PUBLIC_KEY)).toBe("full_access");
  // It asks the chain about that key on that account.
  expect(full.viewAccessKey).toHaveBeenCalledExactlyOnceWith(ACCOUNT, PUBLIC_KEY);

  // A key limited to the Tender contract, whatever methods it lists.
  const limited = chainWith({
    permission: { FunctionCall: { receiver_id: CONTRACT, method_names: ["commit", "reveal"] } },
  });
  expect(await detectKeyKind(limited.client, ACCOUNT, PUBLIC_KEY)).toBe("function_call");

  // A key limited to another contract may not call Tender at all.
  const elsewhere = chainWith({
    permission: { FunctionCall: { receiver_id: "other.testnet", method_names: [] } },
  });
  expect(await detectKeyKind(elsewhere.client, ACCOUNT, PUBLIC_KEY)).toBe("unknown");

  // The key is not on the account.
  expect(await detectKeyKind(chainWith(null).client, ACCOUNT, PUBLIC_KEY)).toBe("unknown");
});

test("a_chain_that_cannot_be_read_is_not_an_unknown_key", async () => {
  const down = new Error("RPC is down");
  const client = { contractId: CONTRACT, viewAccessKey: vi.fn().mockRejectedValue(down) };

  // The server must not start believing its key is weak when it could not find out.
  await expect(detectKeyKind(client, ACCOUNT, PUBLIC_KEY)).rejects.toBe(down);
});

test("detect_key_access_reads_the_methods_of_a_function_call_key", async () => {
  const limited = chainWith({
    permission: { FunctionCall: { receiver_id: CONTRACT, method_names: ["commit", "reveal"] } },
  });
  expect(await detectKeyAccess(limited.client, ACCOUNT, PUBLIC_KEY)).toEqual({
    kind: "function_call",
    methods: ["commit", "reveal"],
  });

  // A key that lists none may call any: the chain reads an empty list that way.
  const any = chainWith({
    permission: { FunctionCall: { receiver_id: CONTRACT, method_names: [] } },
  });
  expect(await detectKeyAccess(any.client, ACCOUNT, PUBLIC_KEY)).toEqual({
    kind: "function_call",
    methods: [],
  });

  // No other kind has methods, whatever the key lists.
  const full = chainWith({ permission: "FullAccess" });
  expect(await detectKeyAccess(full.client, ACCOUNT, PUBLIC_KEY)).toEqual({
    kind: "full_access",
    methods: [],
  });
  const elsewhere = chainWith({
    permission: { FunctionCall: { receiver_id: "other.testnet", method_names: ["commit"] } },
  });
  expect(await detectKeyAccess(elsewhere.client, ACCOUNT, PUBLIC_KEY)).toEqual({
    kind: "unknown",
    methods: [],
  });
  expect(await detectKeyAccess(chainWith(null).client, ACCOUNT, PUBLIC_KEY)).toEqual({
    kind: "unknown",
    methods: [],
  });
});

test("a_key_may_call_what_its_kind_and_methods_allow", () => {
  // A full-access key may make any call.
  expect(keyMayCall("full_access", [], "pick")).toBe(true);
  expect(keyMayCall("full_access", ["commit"], "pick")).toBe(true);

  // A function-call key may make the calls of the methods it lists, and all of them if it lists none.
  expect(keyMayCall("function_call", ["commit", "reveal"], "commit")).toBe(true);
  expect(keyMayCall("function_call", ["commit", "reveal"], "reveal")).toBe(true);
  expect(keyMayCall("function_call", ["commit", "reveal"], "pick")).toBe(false);
  expect(keyMayCall("function_call", ["commit", "reveal"], "register_agent")).toBe(false);
  expect(keyMayCall("function_call", [], "pick")).toBe(true);
  expect(keyMayCall("function_call", undefined, "pick")).toBe(true);
  // A method is matched whole, as the chain does.
  expect(keyMayCall("function_call", ["commit_result"], "commit")).toBe(false);

  // A key that is not on the account, or is for another contract, may make none.
  expect(keyMayCall("unknown", [], "commit")).toBe(false);
  expect(keyMayCall("unknown", undefined, "commit")).toBe(false);
});
