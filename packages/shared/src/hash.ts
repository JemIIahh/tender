import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

/**
 * `bytesToHex` writes lowercase hex, two digits per byte. `hexToBytes` accepts either case and
 * throws on an odd length or a character that is not a hex digit.
 */
export { bytesToHex, hexToBytes };

/** The SHA-256 of `data` as 64 lowercase hex characters. A string is hashed as its UTF-8 bytes. */
export function sha256Hex(data: Uint8Array | string): string {
  return bytesToHex(sha256(typeof data === "string" ? new TextEncoder().encode(data) : data));
}

/** 32 random bytes, from the platform's secure generator, as 64 lowercase hex characters. */
export function randomSalt(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}
