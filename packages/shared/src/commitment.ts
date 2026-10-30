import { hexToBytes, sha256Hex } from "./hash";
import { AccountIdSchema } from "./primitives";

const U64_MAX = 2n ** 64n - 1n;
const U64_BYTES = 8;
const U32_BYTES = 4;
/** The content hash and the salt are each a `[u8; 32]` in the contract. */
const ARRAY_BYTES = 32;
/** The contract's `parse_hash` takes 64 lowercase hex characters and rejects uppercase. */
const LOWERCASE_HEX_32 = /^[0-9a-f]{64}$/;

/** Decodes a 32-byte value given as 64 lowercase hex characters. `name` says which in errors. */
function array32(name: string, hex: string): Uint8Array {
  if (!LOWERCASE_HEX_32.test(hex)) {
    throw new Error(`${name} must be 64 lowercase hex characters`);
  }
  return hexToBytes(hex);
}

/**
 * The commitment that enters `account` in task `taskId` with the work whose SHA-256 is
 * `contentHashHex`, as 64 lowercase hex characters. It matches the contract's `commitment_of`: the
 * SHA-256 of the Borsh encoding of `(task id, account, content hash, salt)`. Byte for byte, that is
 *
 *   u64 LE task id | u32 LE byte length of account | account in UTF-8 | content hash | salt
 *
 * where the content hash and the salt are 32 bytes each. Both must be given as exactly 64 lowercase
 * hex characters, the form the contract takes (its `parse_hash` rejects uppercase). Uppercase hex
 * would give a valid commitment, but revealing with the same strings would then fail with E_HASH,
 * so it is refused here. The account must be a NEAR account id (`AccountIdSchema`): `"Alice.near"`
 * or `""` would give a commitment too, but no account could ever reveal it. Throws if either
 * string is anything else, if the account is no account id, or if the task id does not fit a u64.
 */
export function computeCommitment(
  taskId: bigint,
  account: string,
  contentHashHex: string,
  saltHex: string,
): string {
  if (taskId < 0n || taskId > U64_MAX) {
    throw new RangeError(`task id must fit a u64, got ${taskId}`);
  }
  if (!AccountIdSchema.safeParse(account).success) {
    throw new Error("account must be a NEAR account id");
  }
  const contentHash = array32("content hash", contentHashHex);
  const salt = array32("salt", saltHex);
  const accountBytes = new TextEncoder().encode(account);

  const accountStart = U64_BYTES + U32_BYTES;
  const contentHashStart = accountStart + accountBytes.length;
  const saltStart = contentHashStart + ARRAY_BYTES;
  const preimage = new Uint8Array(saltStart + ARRAY_BYTES);
  const view = new DataView(preimage.buffer);
  view.setBigUint64(0, taskId, true);
  view.setUint32(U64_BYTES, accountBytes.length, true);
  preimage.set(accountBytes, accountStart);
  preimage.set(contentHash, contentHashStart);
  preimage.set(salt, saltStart);
  return sha256Hex(preimage);
}
