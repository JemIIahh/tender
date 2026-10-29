import { hexToBytes, sha256Hex } from "./hash";

const U64_MAX = 2n ** 64n - 1n;
const U64_BYTES = 8;
const U32_BYTES = 4;
/** The content hash and the salt are each a `[u8; 32]` in the contract. */
const ARRAY_BYTES = 32;

/** Decodes `hex` and checks that it is exactly 32 bytes. `name` says which argument in errors. */
function array32(name: string, hex: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(hex);
  } catch (cause) {
    throw new Error(`${name} is not valid hex`, { cause });
  }
  if (bytes.length !== ARRAY_BYTES) {
    throw new Error(`${name} must be ${ARRAY_BYTES} bytes, got ${bytes.length}`);
  }
  return bytes;
}

/**
 * The commitment that enters `account` in task `taskId` with the work whose SHA-256 is
 * `contentHashHex`, as 64 lowercase hex characters. It matches the contract's `commitment_of`: the
 * SHA-256 of the Borsh encoding of `(task id, account, content hash, salt)`. Byte for byte, that is
 *
 *   u64 LE task id | u32 LE byte length of account | account in UTF-8 | content hash | salt
 *
 * where the content hash and the salt are 32 bytes each. Throws if the task id does not fit a u64
 * or if either hex string is not 32 bytes of hex.
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
