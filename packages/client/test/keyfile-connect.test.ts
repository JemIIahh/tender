import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { implicitAccountOf } from "@tender/shared";
import { KeyPair } from "near-api-js";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  agentKeyFor,
  KeyInUseError,
  makeAgentKeyFile,
  moveAgentKeyToImplicit,
  prepareKeyDir,
} from "../src/index";

// Which key file "Connect your agent" uses, and when it may say the agent's account is the implicit
// account of its key: `agentKeyFor` never rewrites a file, and `moveAgentKeyToImplicit` moves one
// only from the code's own sub-account, only to the file's own key's implicit account, and only
// while the chain has no such sub-account. Each refusal leaves the file byte for byte as it was.

const SUB = "writer.alice.testnet";

let dir: string;

beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), "tender-keyfile-")), "agents");
  await prepareKeyDir(dir);
});

afterEach(async () => {
  await rm(join(dir, ".."), { recursive: true, force: true });
});

/** Agent `name`'s key file for `account` (or for none), its public key and its implicit account. */
async function fileFor(account: string | undefined, name = "writer") {
  const made = await makeAgentKeyFile({
    dir,
    name,
    network: "testnet",
    ...(account !== undefined && { account }),
  });
  const path = join(dir, `${name}.json`);
  return {
    ...made,
    path,
    implicit: implicitAccountOf(made.publicKey) ?? "",
    text: await text(path),
  };
}

const text = (path: string) => readFile(path, "utf8");

/** A chain on which `existing` are the accounts that exist; it records what it was asked. */
function chain(existing: string[] = []) {
  const asked: string[] = [];
  return {
    asked,
    exists: async (accountId: string) => {
      asked.push(accountId);
      return existing.includes(accountId);
    },
  };
}

const move = (to: string, exists: (id: string) => Promise<boolean>, from = SUB) =>
  moveAgentKeyToImplicit({ dir, name: "writer", network: "testnet", from, to, exists });

test("a_file_of_the_codes_sub_account_moves_to_its_own_implicit_account_while_the_sub_account_is_not_on_chain", async () => {
  const file = await fileFor(SUB);
  const c = chain();
  expect(await move(file.implicit, c.exists)).toEqual({
    publicKey: file.publicKey,
    path: file.path,
    made: false,
  });
  expect(c.asked).toEqual([SUB]);
  const moved = JSON.parse(await text(file.path));
  expect(moved).toEqual({ ...JSON.parse(file.text), account: file.implicit });
  expect((await stat(file.path)).mode & 0o777).toBe(0o600);
  // Moved once: a second move takes it as it is, and asks the chain nothing.
  expect((await move(file.implicit, c.exists)).publicKey).toBe(file.publicKey);
  expect(c.asked).toEqual([SUB]);
});

test("a_sub_account_that_is_on_chain_keeps_the_agent", async () => {
  const file = await fileFor(SUB);
  await expect(move(file.implicit, chain([SUB]).exists)).rejects.toThrow(
    new KeyInUseError(
      `${SUB} exists on the chain, so agent writer keeps it: its key file is not moved to ${file.implicit}`,
    ),
  );
  expect(await text(file.path)).toBe(file.text);
});

test("a_file_of_another_account_or_of_none_is_never_moved", async () => {
  // A registered agent of another owner, which a code for its name must not take over.
  const other = await fileFor("writer.bob.testnet");
  const c = chain();
  await expect(move(other.implicit, c.exists)).rejects.toThrow(
    /is for writer\.bob\.testnet, not writer\.alice\.testnet, the account this code was made for/,
  );
  expect(c.asked).toEqual([]);
  expect(await text(other.path)).toBe(other.text);

  await rm(other.path);
  const none = await fileFor(undefined);
  await expect(move(none.implicit, c.exists)).rejects.toThrow(/is for no account yet/);
  expect(await text(none.path)).toBe(none.text);
});

test("only_to_the_implicit_account_of_the_files_own_key", async () => {
  const file = await fileFor(SUB);
  const stranger = implicitAccountOf(KeyPair.fromRandom("ed25519").getPublicKey().toString()) ?? "";
  const c = chain();
  for (const to of [stranger, "mallory.testnet", SUB]) {
    await expect(move(to, c.exists), to).rejects.toBeInstanceOf(KeyInUseError);
  }
  expect(c.asked).toEqual([]);
  expect(await text(file.path)).toBe(file.text);
});

test("a_missing_file_or_one_for_another_network_is_not_moved", async () => {
  await expect(move("ab".repeat(32), chain().exists)).rejects.toThrow(/has no key file/);
  const made = await makeAgentKeyFile({ dir, name: "writer", network: "sandbox", account: SUB });
  const path = join(dir, "writer.json");
  const before = await text(path);
  await expect(move(implicitAccountOf(made.publicKey) ?? "", chain().exists)).rejects.toThrow(
    /has a key for sandbox/,
  );
  expect(await text(path)).toBe(before);
});

test("agent_key_for_never_rewrites_a_file_and_takes_a_moved_one_only_for_the_implicit_route", async () => {
  const file = await fileFor(SUB);
  const keyFor = (implicit: string | null, account = SUB) =>
    agentKeyFor({ dir, name: "writer", network: "testnet", account, implicit, mayMake: false });

  // The code's sub-account: the file as it is.
  expect((await keyFor(null))?.publicKey).toBe(file.publicKey);
  // Asked for its own implicit account as the code's account: refused, and not rewritten.
  await expect(keyFor(null, file.implicit)).rejects.toBeInstanceOf(KeyInUseError);
  expect(await text(file.path)).toBe(file.text);

  // Moved: the file counts for the code whose record names that implicit account...
  await move(file.implicit, chain().exists);
  expect((await keyFor(file.implicit))?.publicKey).toBe(file.publicKey);
  // ...and not for a record on the sub-account, nor one naming another implicit account; none of
  // them rewrites it.
  const moved = await text(file.path);
  await expect(keyFor(null)).rejects.toBeInstanceOf(KeyInUseError);
  await expect(keyFor("ab".repeat(32))).rejects.toBeInstanceOf(KeyInUseError);
  expect(await text(file.path)).toBe(moved);
});
