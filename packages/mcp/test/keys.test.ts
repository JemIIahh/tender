import type { TenderClient } from "@tender/client";
import { expect, test, vi } from "vitest";
import { detectKeyKind } from "../src/keys";

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
