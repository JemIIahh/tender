import { expect, test } from "vitest";
import { toBase64 } from "../lib/base64";

test("base64_pads_to_a_multiple_of_four", () => {
  expect(toBase64(new Uint8Array([]))).toBe("");
  expect(toBase64(new Uint8Array([102]))).toBe("Zg==");
  expect(toBase64(new Uint8Array([102, 111]))).toBe("Zm8=");
  expect(toBase64(new Uint8Array([102, 111, 111]))).toBe("Zm9v");
});

test("base64_writes_every_byte_value_in_the_standard_alphabet", () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);

  const text = toBase64(all);

  expect(text).toBe(Buffer.from(all).toString("base64"));
  // The standard alphabet has + and /, the URL one has - and _. The API takes only the first.
  expect(text).toMatch(/[+/]/);
  expect(text).not.toMatch(/[-_]/);
});

test("base64_handles_more_bytes_than_fit_in_one_call", () => {
  // The largest result the API keeps is 256 KiB, many times what one slice holds.
  const big = Uint8Array.from({ length: 262_144 + 1 }, (_, i) => (i * 7 + (i >> 8)) % 256);

  expect(toBase64(big)).toBe(Buffer.from(big).toString("base64"));
});
