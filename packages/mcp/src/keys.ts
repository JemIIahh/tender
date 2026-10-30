import { keyKindOf, type TenderClient } from "@tender/client";

/**
 * What the server's key may do on Tender, as far as the chain says:
 *
 * - `full_access`: the key can do anything, including spend (deposit, withdraw, post).
 * - `function_call`: a key limited to the Tender contract, which can call methods but cannot attach
 *   a deposit, so it cannot move money in.
 * - `unknown`: the account has no such key, or the key is limited to something else. The tools
 *   that move money treat it as the weakest kind.
 */
export type KeyKind = "full_access" | "function_call" | "unknown";

/**
 * The kind of `publicKey` on `accountId`, from the chain's `view_access_key`. It applies the same
 * policy as the NEP-413 sign-in (`keyKindOf`): a full-access key, or a function-call key whose
 * receiver is this client's contract. A key that is not on the account, or that is limited to
 * another receiver, is `unknown`.
 *
 * An RPC failure rejects and is never read as `unknown`: a server that cannot tell what its key
 * may do should not start as if it knew.
 */
export async function detectKeyKind(
  client: Pick<TenderClient, "viewAccessKey" | "contractId">,
  accountId: string,
  publicKey: string,
): Promise<KeyKind> {
  const key = await client.viewAccessKey(accountId, publicKey);
  if (key === null) return "unknown";
  return keyKindOf(key.permission, client.contractId) ?? "unknown";
}
