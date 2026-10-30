import { canonicalJson } from "@tender/shared";
import { baseDecode, baseEncode } from "near-api-js";
import { expect, test } from "vitest";
import { documentText, secretCheck, urlCredentials } from "../src/secrets";

// A private key as near-api-js writes it: `ed25519:` and the base58 of 64 bytes, the 32 of the seed
// and the 32 of the public half. The bytes are made up (and the same on every run).
const RAW = Uint8Array.from({ length: 64 }, (_, index) => (index * 37 + 11) % 256);
const SEED = RAW.subarray(0, 32);
const PUBLIC_HALF = RAW.subarray(32);
const BODY = baseEncode(RAW);
const KEY = `ed25519:${BODY}`;
const SECRETS = [KEY, BODY];

const holds = secretCheck(SECRETS);
const bytesOf = (text: string) => new TextEncoder().encode(text);
const text = (value: Uint8Array | string, encoding: BufferEncoding) =>
  Buffer.from(value).toString(encoding);

/** `copy` between some text, as it would sit in a result. */
const within = (copy: Uint8Array | string) =>
  Buffer.concat([
    Buffer.from("Result of the task.\n\nThe notes say: "),
    Buffer.from(copy),
    Buffer.from("\n\nThat is all."),
  ]);

/** Every way that is looked for to write down some bytes as text. */
function encodingsOf(bytes: Uint8Array): Array<[how: string, copy: string]> {
  const hex = text(bytes, "hex");
  return [
    ["base64", text(bytes, "base64")],
    ["base64 without padding", text(bytes, "base64").replace(/=+$/, "")],
    ["base64url", text(bytes, "base64url")],
    ["hex", hex],
    ["HEX", hex.toUpperCase()],
    [
      "Hex in mixed case",
      hex.replace(/[a-f]/g, (digit, at) => (at % 2 === 0 ? digit.toUpperCase() : digit)),
    ],
    ["base58", baseEncode(bytes)],
  ];
}

test("a_secret_is_found_as_it_is_and_nothing_else_is", () => {
  expect(holds(bytesOf(`my key: ${KEY}\n`))).toBe(true);
  expect(holds(bytesOf(BODY))).toBe(true);
  // It is found inside binary bytes too, and in bytes that are a view into a larger buffer.
  const buffer = Buffer.concat([
    Buffer.from([0, 255, 1, 2]),
    Buffer.from(KEY),
    Buffer.from([9, 9]),
  ]);
  expect(holds(buffer)).toBe(true);
  expect(holds(new Uint8Array(buffer.buffer, buffer.byteOffset + 4, KEY.length))).toBe(true);

  // Some of it is not all of it, and neither is a key that differs in one letter.
  expect(holds(bytesOf(KEY.slice(0, -1)))).toBe(false);
  expect(holds(bytesOf(BODY.slice(1)))).toBe(false);
  expect(holds(bytesOf(`${KEY.slice(0, 40)}${KEY[40] === "A" ? "B" : "A"}${KEY.slice(41)}`))).toBe(
    false,
  );
  expect(holds(bytesOf("forty-two"))).toBe(false);
  expect(holds(new Uint8Array(0))).toBe(false);
});

test("an_empty_secret_is_no_secret", () => {
  // An empty string is in every text, and must not stop every result.
  expect(secretCheck([""])(bytesOf("anything"))).toBe(false);
  expect(secretCheck([])(bytesOf("anything"))).toBe(false);
  expect(secretCheck(["", KEY])(bytesOf("anything"))).toBe(false);
  expect(secretCheck(["", KEY])(bytesOf(KEY))).toBe(true);
});

test("a_key_is_found_in_the_usual_encodings_of_its_text_and_its_bytes", () => {
  // What can be copied: the key as written, the base58 after the curve's name, the 64 raw bytes and
  // the 32 of the seed, which alone are the secret.
  const sources: Array<[what: string, bytes: Uint8Array]> = [
    ["the key as written", bytesOf(KEY)],
    ["its base58 body", bytesOf(BODY)],
    ["the raw bytes", RAW],
    ["the seed", SEED],
  ];
  for (const [what, bytes] of sources) {
    for (const [how, copy] of encodingsOf(bytes)) {
      // base58 of the text is not among them: only the bytes of a key are written in base58.
      if (how === "base58" && (what === "the key as written" || what === "its base58 body"))
        continue;
      expect(holds(within(copy)), `${what} in ${how}`).toBe(true);
    }
  }
  // The bytes themselves, in a file that is no text.
  expect(holds(within(RAW)), "the raw bytes").toBe(true);
  expect(holds(within(SEED)), "the seed's raw bytes").toBe(true);
});

test("an_encoding_is_found_wherever_it_sits_in_a_longer_text", () => {
  // Base64 turns three bytes into four letters, so the letters of a copy depend on where it starts
  // in the text that is encoded: a whole document in base64 holds a key in one of three spellings.
  const sources: Array<[what: string, bytes: Uint8Array]> = [
    ["the key as written", bytesOf(KEY)],
    ["its body", bytesOf(BODY)],
    ["the raw bytes", RAW],
    ["the seed", SEED],
  ];
  let seed = 12345;
  const noise = (length: number) =>
    Buffer.from(
      Array.from({ length }, () => {
        seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
        return 32 + ((seed >> 16) % 90);
      }),
    );
  for (const [what, bytes] of sources) {
    for (let before = 0; before < 7; before++) {
      for (let after = 0; after < 4; after++) {
        const document = Buffer.concat([noise(before), Buffer.from(bytes), noise(after)]);
        for (const encoding of ["base64", "base64url"] as const) {
          const copy = document.toString(encoding);
          expect(
            holds(Buffer.from(copy)),
            `${what}, ${before} bytes before, ${after} after, ${encoding}`,
          ).toBe(true);
          expect(
            holds(Buffer.from(copy.replace(/=+$/, ""))),
            `${what} ${before}/${after} ${encoding} unpadded`,
          ).toBe(true);
        }
      }
    }
  }
  // Hex is aligned to the byte, so a copy is a copy wherever it sits.
  expect(
    holds(Buffer.from(Buffer.concat([noise(5), Buffer.from(KEY), noise(3)]).toString("hex"))),
  ).toBe(true);
});

test("white_space_and_line_breaks_do_not_hide_a_copy", () => {
  const base64 = text(RAW, "base64");
  const hex = text(RAW, "hex");
  const wrapped = (copy: string, width: number, newline: string) =>
    (copy.match(new RegExp(`.{1,${width}}`, "g")) ?? []).join(newline);
  const copies: Array<[how: string, copy: string]> = [
    ["base64 wrapped at 76 with CRLF", wrapped(base64, 76, "\r\n")],
    ["base64 wrapped at 20 with LF", wrapped(base64, 20, "\n")],
    [
      "base64 with a tab and a space inside",
      `${base64.slice(0, 30)}\t${base64.slice(30, 50)} ${base64.slice(50)}`,
    ],
    ["hex in pairs", wrapped(hex, 2, " ")],
    ["hex in lines of 32", wrapped(hex, 32, "\n")],
    ["the key one letter to a line", KEY.split("").join("\n")],
    ["the key in lines of 30", wrapped(KEY, 30, "\n")],
    ["the body split in two", `${BODY.slice(0, 40)}\n\n${BODY.slice(40)}`],
    ["the key's base64 wrapped", wrapped(text(KEY, "base64"), 64, "\n")],
  ];
  for (const [how, copy] of copies) {
    expect(holds(within(copy)), how).toBe(true);
  }
});

test("each_kind_of_break_hides_nothing", () => {
  // White space is a space, a tab, a line feed, a vertical tab, a form feed and a carriage return,
  // and a NUL is what UTF-16 text has between its letters: each alone is enough to split a copy.
  const hex = text(RAW, "hex");
  const groups = hex.match(/.{1,8}/g) ?? [];
  for (const [name, byte] of [
    ["a NUL", "\0"],
    ["a tab", "\t"],
    ["a line feed", "\n"],
    ["a vertical tab", "\v"],
    ["a form feed", "\f"],
    ["a carriage return", "\r"],
    ["a space", " "],
  ] as const) {
    expect(holds(within(groups.join(byte))), `hex in groups of 8, apart by ${name}`).toBe(true);
    expect(holds(within(KEY.split("").join(byte))), `the key, apart by ${name}`).toBe(true);
  }
  // Only breaks are taken out: a letter between the groups is another text.
  expect(holds(within(groups.join("-")))).toBe(false);
  expect(holds(within(KEY.split("").join(".")))).toBe(false);
});

test("a_copy_in_utf_16_is_found", () => {
  // Text saved by some tools has a NUL between its letters, and a byte order mark before them.
  const copies: Array<[how: string, copy: Buffer]> = [
    ["the key in UTF-16LE", Buffer.from(KEY, "utf16le")],
    [
      "the key in UTF-16LE with a byte order mark",
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${KEY}\r\n`, "utf16le")]),
    ],
    ["the key in UTF-16BE", Buffer.from(Buffer.from(KEY, "utf16le").swap16())],
    ["the body in UTF-16LE", Buffer.from(BODY, "utf16le")],
    ["a base64 copy in UTF-16LE", Buffer.from(text(RAW, "base64"), "utf16le")],
    ["a hex copy in UTF-16LE", Buffer.from(text(RAW, "hex"), "utf16le")],
    ["a result that is all UTF-16LE", Buffer.from(`Result: the key is ${KEY}.\n`, "utf16le")],
  ];
  for (const [how, copy] of copies) {
    expect(holds(within(copy)), how).toBe(true);
  }
});

test("other_texts_are_not_taken_for_a_secret", () => {
  const other = Uint8Array.from({ length: 64 }, (_, index) => (index * 91 + 7) % 256);
  const innocent: Array<[what: string, bytes: Uint8Array | string]> = [
    ["plain words", "The quick brown fox jumps over the lazy dog, twice."],
    ["the public key as written", `ed25519:${baseEncode(PUBLIC_HALF)}`],
    ["the public key in base64", text(PUBLIC_HALF, "base64")],
    ["the public key in hex", text(PUBLIC_HALF, "hex")],
    ["the public key's bytes", PUBLIC_HALF],
    ["another key as written", `ed25519:${baseEncode(other)}`],
    ["another key in base64", text(other, "base64")],
    ["another key in hex", text(other, "hex")],
    ["another key's bytes", other],
    ["half of the seed's bytes", SEED.subarray(0, 16)],
    ["part of the key's base64", text(RAW, "base64").slice(0, 30)],
    ["part of the key's hex", text(RAW, "hex").slice(0, 40)],
    ["a hash", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["the key's curve", "ed25519: the curve of the key, and secp256k1: another"],
    [
      "a base64 text that is a sentence",
      text("this is only a sentence about keys, in base64", "base64"),
    ],
  ];
  for (const [what, bytes] of innocent) {
    expect(holds(within(bytes)), what).toBe(false);
  }
});

test("a_secret_that_is_no_key_is_found_as_it_is_and_in_disguise", () => {
  const token = "not-a-key-not-a-key";
  const check = secretCheck([token]);
  expect(check(bytesOf(`token=${token};`))).toBe(true);
  for (const [how, copy] of encodingsOf(bytesOf(token))) {
    if (how === "base58") continue;
    expect(check(within(copy)), how).toBe(true);
  }
  expect(check(within(Buffer.from(token, "utf16le")))).toBe(true);
  expect(check(bytesOf("not a key not a key"))).toBe(false);
});

test("a_short_secret_is_only_looked_for_as_it_is", () => {
  // Too many texts hold a short one by chance, in a disguise as much as plain: only the exact
  // string is looked for, as it always was.
  const check = secretCheck(["hunter2"]);
  expect(check(bytesOf("my password is hunter2"))).toBe(true);
  expect(check(bytesOf(text("hunter2", "base64")))).toBe(false);
  expect(check(bytesOf(text("hunter2", "hex")))).toBe(false);
  expect(check(bytesOf("h u n t e r 2"))).toBe(false);
});

test("a_key_given_alone_is_found_by_its_body_and_its_bytes", () => {
  // The body after the curve's name is listed as a secret of its own by the server, but a check made
  // from the key alone finds it too: the key says what bytes it is.
  const check = secretCheck([KEY]);
  expect(check(within(BODY))).toBe(true);
  expect(check(within(RAW))).toBe(true);
  expect(check(within(SEED))).toBe(true);
  expect(check(within(text(RAW, "base64")))).toBe(true);
  expect(check(within(text(SEED, "hex")))).toBe(true);
  expect(check(within(baseEncode(SEED)))).toBe(true);
  expect(check(within(PUBLIC_HALF))).toBe(false);
  expect(check(within(baseEncode(PUBLIC_HALF)))).toBe(false);
});

test("a_secret_of_twelve_bytes_is_looked_for_in_disguise_and_one_of_eleven_is_not", () => {
  const eleven = secretCheck(["abcdefghijk"]);
  expect(eleven(bytesOf("x abcdefghijk x"))).toBe(true);
  expect(eleven(bytesOf(text("abcdefghijk", "hex")))).toBe(false);
  expect(eleven(bytesOf(text("abcdefghijk", "base64")))).toBe(false);

  const twelve = secretCheck(["abcdefghijkl"]);
  expect(twelve(bytesOf("x abcdefghijkl x"))).toBe(true);
  expect(twelve(bytesOf(text("abcdefghijkl", "hex")))).toBe(true);
  expect(twelve(bytesOf(text("abcdefghijkl", "base64")))).toBe(true);
  expect(twelve(bytesOf(text("abcdefghijkl", "base64url")))).toBe(true);
});

test("a_secret_made_mostly_of_white_space_does_not_stop_innocent_texts", () => {
  // Without its white space this one is `xy`, which is in many a text: that is not looked for.
  const secret = `x${" ".repeat(15)}y`;
  const check = secretCheck([secret]);
  expect(check(bytesOf(`before ${secret} after`))).toBe(true);
  expect(check(bytesOf("an xylophone, and a very yellow box"))).toBe(false);
  expect(check(bytesOf("x y"))).toBe(false);
});

test("the_bytes_of_a_token_are_not_looked_for_unless_it_is_a_key", () => {
  // This is valid base58, but at 17 bytes it is no key (a key is 64 bytes or more, and a seed 32):
  // its raw bytes are no secret that a text holds, and any binary file might hold them by chance.
  const token = "abababababababababababab";
  const raw = Buffer.from(baseDecode(token));
  expect(raw.length).toBeLessThan(32);
  const check = secretCheck([token]);
  expect(check(bytesOf(`token ${token}`))).toBe(true);
  expect(check(within(raw))).toBe(false);
  expect(check(within(text(raw, "hex")))).toBe(false);
  // Its own base64 and hex are still looked for: it is a secret of 24 bytes.
  expect(check(within(text(token, "hex")))).toBe(true);
  expect(check(within(text(token, "base64")))).toBe(true);
});

test("a_key_of_another_curve_is_found_by_its_bytes_and_its_seed", () => {
  // A secp256k1 key is 96 bytes behind its name: the 32 of the secret and the 64 of the public half.
  const raw = Uint8Array.from({ length: 96 }, (_, index) => (index * 53 + 29) % 256);
  const key = `secp256k1:${baseEncode(raw)}`;
  const check = secretCheck([key, baseEncode(raw)]);
  expect(check(within(key))).toBe(true);
  expect(check(within(raw))).toBe(true);
  expect(check(within(text(raw, "base64")))).toBe(true);
  expect(check(within(text(raw.subarray(0, 32), "hex")))).toBe(true);
  expect(check(within(raw.subarray(0, 32)))).toBe(true);
  expect(check(within(baseEncode(raw.subarray(0, 32))))).toBe(true);
  // The public half alone is not the secret.
  expect(check(within(raw.subarray(32)))).toBe(false);
  expect(check(within(text(raw.subarray(32), "hex")))).toBe(false);
  expect(check(within(baseEncode(raw.subarray(32))))).toBe(false);
});

test("only_the_bytes_that_are_given_are_looked_at", () => {
  // A view into a larger buffer is its own bytes and not the buffer's.
  const buffer = Buffer.concat([Buffer.from(KEY), Buffer.from("an innocent note")]);
  const view = new Uint8Array(buffer.buffer, buffer.byteOffset + KEY.length, 16);
  expect(Buffer.from(view).toString()).toBe("an innocent note");
  expect(holds(view)).toBe(false);
  expect(holds(new Uint8Array(buffer.buffer, buffer.byteOffset, KEY.length))).toBe(true);
  // The bytes that are checked are not changed by the check.
  const bytes = Buffer.from(` ${KEY.toUpperCase()}\n\0 `);
  const before = Buffer.from(bytes);
  holds(bytes);
  expect(bytes.equals(before)).toBe(true);
});

test("a_secret_with_a_space_in_it_is_found_with_or_without_the_space", () => {
  const check = secretCheck(["pass phrase with spaces"]);
  expect(check(bytesOf("a pass phrase with spaces here"))).toBe(true);
  expect(check(bytesOf("a passphrasewithspaces here"))).toBe(true);
  expect(check(bytesOf("a pass\nphrase\nwith\nspaces here"))).toBe(true);
  expect(check(bytesOf("a pass phrase with spacey here"))).toBe(false);
});

test("a_large_result_is_checked_without_delay", () => {
  // The most a result may have is 256 KiB, and the check runs on every commit and reveal.
  const big = Buffer.alloc(262_144);
  for (let at = 0; at < big.length; at++) big[at] = 32 + ((at * 7919) % 90);
  const check = secretCheck([
    KEY,
    BODY,
    "not-a-key-not-a-key",
    "https://rpc.example.com/v2/ab12ab12ab12ab12",
  ]);
  const started = performance.now();
  for (let round = 0; round < 20; round++) expect(check(big)).toBe(false);
  expect(performance.now() - started).toBeLessThan(2000);
});

test("the_credentials_of_a_url_are_its_userinfo_and_its_keys", () => {
  // A password, a key in the query and a token in the path are what a provider puts in a URL.
  expect(urlCredentials("https://user:s3cretpassw0rd@rpc.example.com/")).toEqual([
    "s3cretpassw0rd",
  ]);
  expect(urlCredentials("https://ab12ab12ab12ab12@rpc.example.com/")).toEqual(["ab12ab12ab12ab12"]);
  expect(urlCredentials("https://rpc.example.com/?apiKey=abc123abc123&network=mainnet")).toEqual([
    "abc123abc123",
  ]);
  expect(urlCredentials("https://rpc.example.com/?dkey=AbCAbC123123&network=near")).toEqual([
    "AbCAbC123123",
  ]);
  expect(urlCredentials("https://rpc.example.com/?access_token=tok-11112222")).toEqual([
    "tok-11112222",
  ]);
  expect(urlCredentials("https://rpc.example.com/v2/ab12ab12ab12ab12ab12/near")).toEqual([
    "ab12ab12ab12ab12ab12",
  ]);
  expect(urlCredentials("https://rpc.example.com/?k=ab12ab12ab12ab12ab12")).toEqual([
    "ab12ab12ab12ab12ab12",
  ]);
  // The spelling in the URL and the one it stands for are both listed.
  expect(urlCredentials("https://user:p%40ssw0rd%21long@rpc.example.com/")).toEqual([
    "p%40ssw0rd%21long",
    "p@ssw0rd!long",
  ]);
  expect(urlCredentials("https://rpc.example.com/?apiKey=a%2Bb%2Fc%3Dd1234")).toEqual([
    "a%2Bb%2Fc%3Dd1234",
    "a+b/c=d1234",
  ]);
});

test("a_url_without_a_credential_has_none", () => {
  for (const url of [
    "https://rpc.testnet.near.org",
    "https://rpc.mainnet.near.org/",
    "http://127.0.0.1:3030",
    "https://rpc.example.com/?network=mainnet&chain=near-mainnet",
    // A name that does not say key, a value that is short or is only words.
    "https://rpc.example.com/v2/near-mainnet-archival",
    "https://rpc.example.com/?key=1",
    "https://rpc.example.com/?token=abc",
    // A user name that is short is a name, and not a secret.
    "https://admin:@rpc.example.com/",
    "not a url",
    "",
  ]) {
    expect(urlCredentials(url), url).toEqual([]);
  }
  // A user name that is long is an identifier worth keeping out of a result, and a short one is not.
  expect(urlCredentials("https://administrator:s3cretpassw0rd@rpc.example.com/")).toEqual([
    "administrator",
    "s3cretpassw0rd",
  ]);
  expect(urlCredentials("https://admin:s3cretpassw0rd@rpc.example.com/")).toEqual([
    "s3cretpassw0rd",
  ]);
});

test("a_query_value_is_a_credential_when_its_name_says_so", () => {
  // Each of these names is one that a provider uses for a secret, with a value that is not shaped
  // like a token (it is short, or only letters), so that the name is all that gives it away.
  for (const name of [
    "key",
    "apikey",
    "api_key",
    "API-KEY",
    "dkey",
    "token",
    "access_token",
    "secret",
    "client_secret",
    "auth",
    "authorization",
    "password",
    "passwd",
    "pwd",
    "sig",
    "signature",
    "cred",
    "credentials",
    "jwt",
    "bearer",
  ]) {
    expect(urlCredentials(`https://rpc.example.com/?${name}=wordsonly`), name).toEqual([
      "wordsonly",
    ]);
  }
  // A name that is not one of them, with such a value, is not a credential.
  for (const name of ["network", "chain", "region", "format", "q", "limit"]) {
    expect(urlCredentials(`https://rpc.example.com/?${name}=wordsonly`), name).toEqual([]);
  }
  // The name is read once unescaped, and a value with no name is not taken for one.
  expect(urlCredentials("https://rpc.example.com/?%6Bey=wordsonly")).toEqual(["wordsonly"]);
  expect(urlCredentials("https://rpc.example.com/?api%5Fkey=wordsonly")).toEqual(["wordsonly"]);
  expect(urlCredentials("https://rpc.example.com/?wordsonly&key")).toEqual([]);
  expect(urlCredentials("https://rpc.example.com/?secretvalue1234")).toEqual([]);
});

test("a_value_without_a_name_is_a_credential_when_it_is_shaped_like_a_token", () => {
  // 16 or more of the characters that a token is made of, with a letter and a digit among them.
  const token16 = "ab12ab12ab12ab12";
  expect(token16).toHaveLength(16);
  expect(urlCredentials(`https://rpc.example.com/?x=${token16}`)).toEqual([token16]);
  expect(urlCredentials(`https://rpc.example.com/v2/${token16}`)).toEqual([token16]);
  // One short of that, or without a digit, or without a letter, it is not: these are 15 characters,
  // two words, a run of digits and a date.
  for (const value of [
    token16.slice(1),
    "abcdefghijklmnopqrstuvwxyz",
    "near-mainnet-archival",
    "12345678901234567890",
    "2024-10-31-12-00-00-00",
  ]) {
    expect(urlCredentials(`https://rpc.example.com/?x=${value}`), value).toEqual([]);
    expect(urlCredentials(`https://rpc.example.com/v2/${value}`), value).toEqual([]);
  }
  // It is the value as it reads once unescaped that has the shape, in a query and in a path.
  const escaped = ["ab12ab12ab12ab%31%32", "ab12ab12ab12ab12"];
  expect(urlCredentials("https://rpc.example.com/?x=ab12ab12ab12ab%31%32")).toEqual(escaped);
  expect(urlCredentials("https://rpc.example.com/v2/ab12ab12ab12ab%31%32")).toEqual(escaped);
  // A character that a token is not made of ends the shape.
  expect(urlCredentials("https://rpc.example.com/?x=ab12ab12ab12ab12$")).toEqual([]);
  // Each of its characters is one: dots, underscores, tildes and hyphens too.
  expect(urlCredentials("https://rpc.example.com/?x=ab.cd_ef~gh-1234567")).toEqual([
    "ab.cd_ef~gh-1234567",
  ]);
});

test("a_credential_is_kept_at_eight_characters_and_not_at_seven", () => {
  expect(urlCredentials("https://rpc.example.com/?key=pass1234")).toEqual(["pass1234"]);
  expect(urlCredentials("https://rpc.example.com/?key=pass123")).toEqual([]);
  expect(urlCredentials("https://user12345:pass1234@rpc.example.com/")).toEqual([
    "user12345",
    "pass1234",
  ]);
  expect(urlCredentials("https://user123:pass123@rpc.example.com/")).toEqual([]);
  // The written spelling can be long enough where the unescaped one is not, and each is judged alone.
  expect(urlCredentials("https://rpc.example.com/?key=a%40b%40c%40")).toEqual(["a%40b%40c%40"]);
});

// ---- Documents -------------------------------------------------------------------------------

/** The text of `document` as a reader has it, as a string. */
const textOf = (document: unknown) => Buffer.from(documentText(document)).toString("utf8");

test("the_text_of_a_document_is_its_keys_and_strings_one_to_a_line_in_order", () => {
  expect(textOf("just a string")).toBe("just a string");
  expect(
    textOf({ title: "T", tags: ["a", "b"], output: { format: "json", max_bytes: 4096 } }),
  ).toBe(["title", "T", "tags", "a", "b", "output", "format", "json", "max_bytes"].join("\n"));
  // Arrays of arrays and of objects are opened too, each member in its place.
  expect(textOf([["x", { k: ["y"] }], "z"])).toBe(["x", "k", "y", "z"].join("\n"));
  // The numbers, the booleans and null are not text, and a key whose value is one still is.
  expect(textOf({ n: 1, ok: true, none: null, s: "kept" })).toBe(
    ["n", "ok", "none", "s", "kept"].join("\n"),
  );
  // No text at all is no bytes at all.
  for (const empty of [{}, [], null, 7, true, undefined]) {
    expect(documentText(empty), String(empty)).toHaveLength(0);
  }
  // Anything that is no JSON value is let alone, and the strings around it are kept.
  const odd = { f: () => 1, big: 10n, s: Symbol("x"), text: "kept" };
  expect(textOf(odd)).toBe(["f", "big", "s", "text", "kept"].join("\n"));
});

test("the_escapes_of_a_document_are_read_in_its_text", () => {
  const note = 'one\ntwo\tthree\u0000four\r\n"five" \\ six';
  // The bytes spell a line break, a tab and a NUL out; the text has the characters.
  const bytes = Buffer.from(canonicalJson({ note })).toString("utf8");
  expect(bytes).toContain("one\\ntwo\\tthree\\u0000four");
  expect(textOf({ note })).toBe(`note\n${note}`);
});

test("a_copy_that_the_escapes_of_json_hide_is_found_in_the_text_of_the_document", () => {
  // The key in base64, wrapped over lines as a PEM block is. In the bytes of a document each break
  // is a backslash and a letter in the middle of it, so the bytes alone show nothing; the text does.
  const wrapped = text(KEY, "base64").replace(/(.{20})/g, "$1\n");
  // And the key's text in UTF-16, whose NULs are six characters each in the bytes.
  const utf16 = Buffer.from(KEY, "utf16le").toString("utf8");
  for (const [how, note] of [
    ["wrapped base64", `see below\n${wrapped}`],
    ["wrapped with CR LF", text(KEY, "base64").replace(/(.{20})/g, "$1\r\n")],
    ["tabs between pieces", KEY.replace(/(.{12})/g, "$1\t")],
    ["UTF-16", utf16],
  ] as const) {
    const document = { title: "t", instructions: note, tags: [] };
    expect(holds(canonicalJson(document)), `${how}: the bytes`).toBe(false);
    expect(holds(documentText(document)), `${how}: the text`).toBe(true);
  }
});

test("a_secret_is_found_in_a_key_of_a_document_and_in_a_deep_one", () => {
  expect(holds(documentText({ schema: { properties: { [KEY]: { type: "string" } } } }))).toBe(true);
  // The text of a document that is nested a hundred thousand deep is made without a stack of calls.
  let deep: unknown = ["the end", KEY];
  for (let level = 0; level < 100_000; level++) deep = { next: deep };
  expect(holds(documentText(deep))).toBe(true);
  // A document with nothing of the secret in it holds none, whatever is around it.
  expect(holds(documentText({ title: "t", instructions: `ed25519:${BODY.slice(1)}` }))).toBe(false);
});

test("a_document_that_holds_itself_is_read_once", () => {
  const loop: Record<string, unknown> = { name: "round" };
  loop.again = [loop, { inner: loop }];
  expect(textOf(loop)).toBe(["name", "round", "again", "inner"].join("\n"));
  // An object that comes up twice is read where it first comes, and not again.
  const twice = { x: "once" };
  expect(textOf({ a: twice, b: [twice] })).toBe(["a", "x", "once", "b"].join("\n"));
});
