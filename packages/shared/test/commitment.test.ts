import { expect, test } from "vitest";
import { bytesToHex, computeCommitment, hexToBytes, randomSalt, sha256Hex } from "../src/index";

// The two vectors below are the ones the contract's unit test pins `commitment_of` to
// (contract/tender/src/entries.rs, `commitment_matches_cross_language_vector`).

test("vector_matches_rust", () => {
  const salt = bytesToHex(Uint8Array.from({ length: 32 }, (_, i) => i));
  expect(computeCommitment(7n, "alice.testnet", sha256Hex("hello world"), salt)).toBe(
    "7e92e9a2323f2ca960418263d394956e0c4cacd348f83b46a915ab4ac8537977",
  );
});

test("edge_vector_matches_rust", () => {
  expect(
    computeCommitment(2n ** 64n - 1n, "0123456789abcdef".repeat(4), sha256Hex(""), "ff".repeat(32)),
  ).toBe("76d8bcd34b9d099fb7fd104a1831cde0061451ecbcb9fb36ebebb479da4bb9d6");
});

test("rejects_bad_hex", () => {
  expect(() => computeCommitment(1n, "a.near", "zz", "00".repeat(32))).toThrow();
});

test("rejects_hashes_that_are_not_64_lowercase_hex_characters", () => {
  const ok = "00".repeat(32);
  const bad = [
    "",
    "00".repeat(31),
    "00".repeat(33),
    `0x${"00".repeat(31)}`,
    `${ok} `,
    `${ok}\n`,
    "zz".repeat(32),
  ];
  for (const b of bad) {
    expect(() => computeCommitment(1n, "a.near", b, ok)).toThrow(
      /content hash must be 64 lowercase hex characters/,
    );
    expect(() => computeCommitment(1n, "a.near", ok, b)).toThrow(
      /salt must be 64 lowercase hex characters/,
    );
  }
});

test("rejects_uppercase_hex", () => {
  // The contract's parse_hash rejects uppercase, so an uppercase commit would succeed and the
  // reveal would then fail with E_HASH. Reject it when the commitment is made.
  const hash = "ab".repeat(32);
  const salt = "cd".repeat(32);
  expect(computeCommitment(1n, "a.near", hash, salt)).toMatch(/^[0-9a-f]{64}$/);
  expect(() => computeCommitment(1n, "a.near", hash.toUpperCase(), salt)).toThrow(
    /content hash must be 64 lowercase hex characters/,
  );
  expect(() => computeCommitment(1n, "a.near", hash, salt.toUpperCase())).toThrow(
    /salt must be 64 lowercase hex characters/,
  );
  // One uppercase digit is enough.
  expect(() => computeCommitment(1n, "a.near", `A${hash.slice(1)}`, salt)).toThrow(/content hash/);
  expect(() => computeCommitment(1n, "a.near", hash, `${salt.slice(0, 63)}F`)).toThrow(/salt/);
});

test("rejects_accounts_that_are_not_account_ids", () => {
  // The account is held to the contract's form like the hashes are. Only an account id can commit,
  // so a commitment made for anything else is one that no account can reveal.
  const h = "00".repeat(32);
  const bad = [
    "Alice.near",
    "",
    "a",
    "alice.near ",
    "alice..near",
    ".near",
    "alice.near\n",
    "älice.near",
    "a".repeat(65),
  ];
  for (const account of bad) {
    expect(() => computeCommitment(1n, account, h, h), JSON.stringify(account)).toThrow(
      /account must be a NEAR account id/,
    );
  }
  // The edges of the form pass: 2 and 64 characters, with every separator.
  for (const account of ["ab", "a.b", "a-b_c.near", "a".repeat(64)]) {
    expect(computeCommitment(1n, account, h, h), account).toMatch(/^[0-9a-f]{64}$/);
  }
});

test("rejects_task_ids_outside_u64", () => {
  const h = "00".repeat(32);
  expect(() => computeCommitment(-1n, "a.near", h, h)).toThrow(RangeError);
  expect(() => computeCommitment(2n ** 64n, "a.near", h, h)).toThrow(RangeError);
  expect(computeCommitment(0n, "a.near", h, h)).toMatch(/^[0-9a-f]{64}$/);
});

test("commitment_binds_task_account_content_and_salt", () => {
  const h = sha256Hex("work");
  const s = "11".repeat(32);
  const base = computeCommitment(1n, "alice.near", h, s);
  expect(computeCommitment(1n, "alice.near", h, s)).toBe(base);
  expect(computeCommitment(2n, "alice.near", h, s)).not.toBe(base);
  expect(computeCommitment(1n, "bob.near", h, s)).not.toBe(base);
  expect(computeCommitment(1n, "alice.near", sha256Hex("other"), s)).not.toBe(base);
  expect(computeCommitment(1n, "alice.near", h, "22".repeat(32))).not.toBe(base);
});

test("sha256_known_answers", () => {
  expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  // A string is hashed as its UTF-8 bytes, and a byte array as itself.
  expect(sha256Hex("é")).toBe(sha256Hex(Uint8Array.of(0xc3, 0xa9)));
  expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(sha256Hex("abc"));
});

test("hex_round_trip_and_errors", () => {
  const bytes = Uint8Array.of(0, 1, 15, 16, 171, 255);
  expect(bytesToHex(bytes)).toBe("00010f10abff");
  expect(hexToBytes("00010f10abff")).toEqual(bytes);
  expect(hexToBytes("00010F10ABFF")).toEqual(bytes);
  expect(hexToBytes("")).toEqual(new Uint8Array());
  expect(() => hexToBytes("abc")).toThrow();
  expect(() => hexToBytes("zz")).toThrow();
  expect(() => hexToBytes("0x00")).toThrow();
  expect(() => hexToBytes("00 ")).toThrow();
});

test("random_salt_is_32_random_bytes_as_hex", () => {
  const a = randomSalt();
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(hexToBytes(a)).toHaveLength(32);
  expect(randomSalt()).not.toBe(a);
});
