import { expect, test } from "vitest";
import {
  base58Decode,
  base58Encode,
  looksSecret,
  readAgentName,
  readPublicKey,
  SECRET_WARNING,
} from "../lib/agentKey";
import { secretShapes } from "./accountFakes";

// What "Add an agent" reads from what a person types: the agent's public key and its account name.

/** A public key, as `pnpm agent:init` prints one: 32 bytes in base58. */
const PUBLIC = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
/** 64 bytes in base58, which is how NEAR writes a private key: made-up bytes, no one's key. */
const SECRET = `ed25519:${base58Encode(new Uint8Array(64).fill(7))}`;

test("base58_decodes_as_bitcoin_writes_it", () => {
  expect([...(base58Decode("") ?? [])]).toEqual([]);
  expect([...(base58Decode("1") ?? [])]).toEqual([0]);
  expect([...(base58Decode("11") ?? [])]).toEqual([0, 0]);
  expect([...(base58Decode("2") ?? [])]).toEqual([1]);
  expect([...(base58Decode("z") ?? [])]).toEqual([57]);
  expect([...(base58Decode("21") ?? [])]).toEqual([58]);
  // "Hello World!" in base58.
  expect(new TextDecoder().decode(base58Decode("2NEpo7TZRRrLZSi2U") ?? new Uint8Array())).toBe(
    "Hello World!",
  );
  // 0, O, I and l are not in the alphabet.
  for (const bad of ["0", "O", "I", "l", "a b"]) expect(base58Decode(bad), bad).toBeNull();
  expect(base58Decode(PUBLIC.slice(8))?.length).toBe(32);
  expect(base58Decode(SECRET.slice(8))?.length).toBe(64);
});

test("base58_encodes_back_to_what_it_decodes", () => {
  expect(base58Encode(new Uint8Array())).toBe("");
  expect(base58Encode(Uint8Array.from([0, 0, 1]))).toBe("112");
  expect(base58Encode(new TextEncoder().encode("Hello World!"))).toBe("2NEpo7TZRRrLZSi2U");
  const bytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 37) % 256);
  expect([...(base58Decode(base58Encode(bytes)) ?? [])]).toEqual([...bytes]);
  expect(base58Encode(base58Decode(PUBLIC.slice(8)) ?? new Uint8Array())).toBe(PUBLIC.slice(8));
});

test("a_public_key_is_ed25519_and_32_bytes", () => {
  expect(readPublicKey(PUBLIC)).toEqual({ ok: true, publicKey: PUBLIC });
  // Spaces around a paste are not part of it.
  expect(readPublicKey(`  ${PUBLIC}\n`)).toEqual({ ok: true, publicKey: PUBLIC });
});

test("a_key_that_is_not_one_says_what_to_change", () => {
  const refused = (text: string) => {
    const reading = readPublicKey(text);
    if (reading.ok) throw new Error(`${text} was taken`);
    return reading;
  };
  expect(refused("").message).toBe("Paste the public key the agent's tool printed.");
  expect(refused(PUBLIC.slice(8)).message).toBe("A public key starts with ed25519:");
  expect(refused("secp256k1:abc").message).toBe("A public key starts with ed25519:");
  expect(refused("ed25519:0OIl").message).toMatch(/characters a key can't have/);
  expect(refused("ed25519:").message).toMatch(/characters a key can't have/);
  expect(refused(PUBLIC.slice(0, -4)).message).toMatch(/isn't a whole public key/);
  for (const text of ["", PUBLIC.slice(8), "ed25519:0", PUBLIC.slice(0, -4)]) {
    expect(refused(text).secret, text).toBe(false);
  }
});

test("a_private_key_is_refused_as_one_so_that_the_page_can_drop_it", () => {
  const reading = readPublicKey(SECRET);
  expect(reading.ok).toBe(false);
  if (reading.ok) return;
  expect(reading.secret).toBe(true);
  expect(reading.message).toBe(SECRET_WARNING);
  // The words never repeat the key.
  expect(reading.message).not.toContain(SECRET.slice(8, 20));
});

const SECRET_SHAPES = secretShapes(PUBLIC);

test("every_shape_of_key_material_is_refused_as_a_secret", () => {
  for (const [shape, text] of Object.entries(SECRET_SHAPES)) {
    expect(looksSecret(text), shape).toBe(true);
    const reading = readPublicKey(text);
    expect(reading.ok, shape).toBe(false);
    if (reading.ok) continue;
    expect(reading.secret, shape).toBe(true);
    expect(reading.message, shape).toBe(SECRET_WARNING);
  }
  expect(SECRET_WARNING).toBe(
    "That looks like a private key or seed phrase, so it was cleared and not kept. Never paste it here: paste only the public key, which starts with ed25519: and is marked public.",
  );
});

test("a_public_key_and_a_key_being_typed_are_not_taken_for_secrets", () => {
  // A public key, alone or with spaces around it.
  expect(looksSecret(PUBLIC)).toBe(false);
  expect(readPublicKey(` ${PUBLIC} `).ok).toBe(true);
  // Typing one, a character at a time, never looks like a secret on the way.
  for (let end = 1; end <= PUBLIC.length; end++) {
    expect(looksSecret(PUBLIC.slice(0, end)), PUBLIC.slice(0, end)).toBe(false);
  }
  // A public key with its prefix in capitals is a format to fix, not a secret.
  const capitals = readPublicKey(`ED25519:${PUBLIC.slice(8)}`);
  expect(capitals).toEqual({
    ok: false,
    secret: false,
    message: "A public key starts with ed25519:",
  });
  // So are a few words, and a 32-byte key in base58 with no prefix.
  expect(looksSecret("the public key")).toBe(false);
  expect(readPublicKey(PUBLIC.slice(8))).toEqual({
    ok: false,
    secret: false,
    message: "A public key starts with ed25519:",
  });
});

test("an_agent_name_makes_a_direct_sub_account_of_the_connected_one", () => {
  expect(readAgentName("scout", "alice.testnet")).toEqual({
    ok: true,
    accountId: "scout.alice.testnet",
  });
  expect(readAgentName(" scout-2_b ", "alice.testnet")).toEqual({
    ok: true,
    accountId: "scout-2_b.alice.testnet",
  });
  expect(readAgentName("a", "alice.testnet")).toEqual({ ok: true, accountId: "a.alice.testnet" });
});

test("a_name_that_makes_no_account_says_what_to_change", () => {
  const message = (name: string, parent = "alice.testnet") => {
    const reading = readAgentName(name, parent);
    if (reading.ok) throw new Error(`${name} was taken`);
    return reading.message;
  };
  expect(message("")).toBe("Choose a name for the agent's account.");
  expect(message("Scout")).toBe("Use lower case: an account id has no capitals.");
  expect(message("a.b")).toBe(
    "One part only, with no dots: the account will be <name>.alice.testnet.",
  );
  for (const bad of ["-scout", "scout-", "sc--out", "sc_-out", "sc out", "scöut"]) {
    expect(message(bad), bad).toBe("Use a to z and 0 to 9, with a single - or _ between them.");
  }
  // 50 + 1 + 13 = 64 is the most; one more is too long.
  expect(readAgentName("x".repeat(50), "alice.testnet").ok).toBe(true);
  expect(message("x".repeat(51))).toBe(
    `Too long: ${"x".repeat(51)}.alice.testnet is 65 characters, and an account id is 64 at most.`,
  );
});

test("an_implicit_account_has_no_room_for_an_agent_under_it", () => {
  const implicit = "c0ffee13".repeat(8);
  const reading = readAgentName("scout", implicit);
  expect(reading.ok).toBe(false);
  if (reading.ok) return;
  expect(reading.message).toBe(
    `${implicit} is too long to have accounts under it. Connect a named account, such as you.testnet.`,
  );
});
