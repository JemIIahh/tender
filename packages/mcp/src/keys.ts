import { type KeyPermission, keyKindOf, type TenderClient } from "@tender/client";

/**
 * What the server's key may do on Tender, as far as the chain says:
 *
 * - `full_access`: the key can do anything, including spend (deposit, withdraw, post).
 * - `function_call`: a key limited to the Tender contract, which can call the methods it lists but
 *   cannot attach a deposit, so it cannot move money in.
 * - `unknown`: the account has no such key, or the key is limited to something else. It can call
 *   nothing on Tender.
 */
export type KeyKind = "full_access" | "function_call" | "unknown";

/** What the chain says the server's key may do: its kind and, for a function-call key, its methods. */
export interface KeyAccess {
  kind: KeyKind;
  /**
   * The methods of the Tender contract that a `function_call` key lists, and none for any other
   * kind. A function-call key that lists none may call any, as on the chain.
   */
  methods: string[];
}

/**
 * The access of `publicKey` on `accountId`, from the chain's `view_access_key`. It applies the same
 * policy as the NEP-413 sign-in (`keyKindOf`): a full-access key, or a function-call key whose
 * receiver is this client's contract. A key that is not on the account, or that is limited to
 * another receiver, is `unknown`.
 *
 * An RPC failure rejects and is never read as `unknown`: a server that cannot tell what its key
 * may do should not start as if it knew.
 */
export async function detectKeyAccess(
  client: Pick<TenderClient, "viewAccessKey" | "contractId">,
  accountId: string,
  publicKey: string,
): Promise<KeyAccess> {
  const key = await client.viewAccessKey(accountId, publicKey);
  if (key === null) return { kind: "unknown", methods: [] };
  const kind = keyKindOf(key.permission, client.contractId) ?? "unknown";
  return { kind, methods: kind === "function_call" ? listedMethods(key.permission) : [] };
}

/** The kind of `publicKey` on `accountId`; see `detectKeyAccess`. */
export async function detectKeyKind(
  client: Pick<TenderClient, "viewAccessKey" | "contractId">,
  accountId: string,
  publicKey: string,
): Promise<KeyKind> {
  return (await detectKeyAccess(client, accountId, publicKey)).kind;
}

/** The method names of a function-call permission, whose receiver `keyKindOf` has checked. */
function listedMethods(permission: KeyPermission): string[] {
  if (permission === "FullAccess") return [];
  const names: unknown = permission.FunctionCall.method_names;
  return Array.isArray(names)
    ? names.filter((name): name is string => typeof name === "string")
    : [];
}

/**
 * Whether a key of `kind`, listing `methods`, may make a call to `method` of the Tender contract
 * that attaches no deposit. A full-access key may make any call. A function-call key may make the
 * calls of the methods it lists, and any if it lists none, as on the chain; a call that attaches a
 * deposit is out of its reach whatever it lists, which is for the tool to say (it needs full
 * access). `methods` left out counts as none listed. A key of unknown kind may make no call.
 */
export function keyMayCall(
  kind: KeyKind,
  methods: readonly string[] | undefined,
  method: string,
): boolean {
  if (kind === "full_access") return true;
  if (kind !== "function_call") return false;
  return methods === undefined || methods.length === 0 || methods.includes(method);
}
