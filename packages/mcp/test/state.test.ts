import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computeCommitment, type NetworkId, sha256Hex } from "@tender/shared";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createStateStore, type Draft, defaultStateDir } from "../src/state";

// Only `rename` is wrapped, so that a test can make it fail the way a crash would. Every other
// function is the real one, and so is `rename` until a test says otherwise.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const ACCOUNT = "alice.test.near";
const SALT = "5a".repeat(32);
/** File modes mean nothing on Windows, so the tests about them are skipped there. */
const NO_POSIX_MODES = process.platform === "win32";

// Every test gets a temp dir of its own, and the store only ever sees a path inside it, so no test
// can touch ~/.tender. `dir` does not exist yet, which makes the store create it.
let root: string;
let dir: string;
let draftsDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tender-state-"));
  dir = join(root, "state");
  draftsDir = join(dir, "drafts");
});

afterEach(async () => {
  vi.mocked(rename).mockReset();
  await rm(root, { recursive: true, force: true });
});

/** A draft the way `commit_result` will make one: the hash, the salt and the commitment agree. */
function makeDraft(taskId: string, options: { content?: string; salt?: string } = {}): Draft {
  const content = options.content ?? `answer for task ${taskId}`;
  const salt = options.salt ?? SALT;
  const contentHash = sha256Hex(content);
  return {
    taskId,
    contentBase64: Buffer.from(content).toString("base64"),
    contentHash,
    salt,
    commitment: computeCommitment(BigInt(taskId), ACCOUNT, contentHash, salt),
  };
}

const modeOf = async (path: string) => (await stat(path)).mode & 0o777;

test("draft_round_trip", async () => {
  const store = createStateStore(dir);

  // Reading makes nothing. A machine that never committed has no state dir, and asking for a draft
  // must not create one.
  expect(await store.getDraft("7")).toBeNull();
  expect(await readdir(root)).toEqual([]);

  const draft = makeDraft("7");
  await store.saveDraft(draft);
  expect(await store.getDraft("7")).toEqual(draft);
  expect(await store.getDraft("8")).toBeNull();

  // The optional fields come back too, once the commit has set them.
  const committed = { ...draft, committedAt: "2026-11-04T10:00:00.000Z" };
  await store.saveDraft(committed);
  expect(await store.getDraft("7")).toEqual(committed);

  // A new store on the same directory is a restarted process, and the draft is still there.
  expect(await createStateStore(dir).getDraft("7")).toEqual(committed);
});

test("an_empty_state_dir_is_refused", () => {
  // `process.env.TENDER_STATE_DIR ?? fallback` gives "" when the variable is set but empty. That
  // must not become the current directory, which could be inside a git repo.
  expect(() => createStateStore("")).toThrow(/state directory/);
});

test("saving_again_replaces_the_draft_in_the_same_file", async () => {
  const store = createStateStore(dir);
  await store.saveDraft(makeDraft("5"));

  // A replaced commit: same task, new content and salt.
  const replaced = makeDraft("5", { content: "a better answer", salt: "c3".repeat(32) });
  await store.saveDraft(replaced);

  expect(await store.getDraft("5")).toEqual(replaced);
  expect(await readdir(draftsDir)).toEqual(["5.json"]);
});

test("mark_revealed_records_the_uri_and_keeps_the_rest", async () => {
  const store = createStateStore(dir);
  const draft = { ...makeDraft("3"), committedAt: "2026-11-04T10:00:00.000Z" };
  await store.saveDraft(draft);

  // A missing uri would write the draft back as it was and look as if it had worked.
  await expect(store.markRevealed("3", undefined as unknown as string)).rejects.toThrow(/uri/);
  expect(await store.getDraft("3")).toEqual(draft);

  await store.markRevealed("3", "https://tender.example/blobs/abc");

  const revealed = { ...draft, revealedUri: "https://tender.example/blobs/abc" };
  expect(await store.getDraft("3")).toEqual(revealed);
  expect(await createStateStore(dir).getDraft("3")).toEqual(revealed);

  // With no draft there is nothing to mark, and no file is made up for it.
  await expect(store.markRevealed("4", "https://tender.example/blobs/def")).rejects.toThrow(
    /no draft for task 4/,
  );
  expect(await readdir(draftsDir)).toEqual(["3.json"]);
});

test("atomic_write_never_leaves_partial_file", async () => {
  const store = createStateStore(dir);
  const file = join(draftsDir, "7.json");
  const killed = new Error("killed before the rename");

  // A replaced commit whose rename fails, as when the process is killed after the new copy is
  // written, leaves the old draft exactly as it was. The unfinished copy is removed.
  const original = makeDraft("7");
  await store.saveDraft(original);
  const before = await readFile(file, "utf8");
  vi.mocked(rename).mockRejectedValueOnce(killed);
  await expect(
    store.saveDraft(makeDraft("7", { content: "second try", salt: "c3".repeat(32) })),
  ).rejects.toBe(killed);
  expect(await readFile(file, "utf8")).toBe(before);
  expect(await store.getDraft("7")).toEqual(original);
  expect(await readdir(draftsDir)).toEqual(["7.json"]);

  // A first draft that fails there leaves nothing at all: no file, and no half of one.
  vi.mocked(rename).mockRejectedValueOnce(killed);
  await expect(store.saveDraft(makeDraft("8"))).rejects.toBe(killed);
  expect(await store.getDraft("8")).toBeNull();
  expect(await readdir(draftsDir)).toEqual(["7.json"]);

  // Marking a reveal rewrites the draft, so it must be just as safe.
  vi.mocked(rename).mockRejectedValueOnce(killed);
  await expect(store.markRevealed("7", "https://tender.example/blobs/abc")).rejects.toBe(killed);
  expect(await readFile(file, "utf8")).toBe(before);
  expect(await readdir(draftsDir)).toEqual(["7.json"]);
});

test.skipIf(NO_POSIX_MODES)("file_modes_are_private", async () => {
  const store = createStateStore(dir);

  // Watch the one rename that the save makes, to see the temp file at the last moment before it
  // becomes the draft.
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const renames: { from: string; to: string; mode: number }[] = [];
  vi.mocked(rename).mockImplementationOnce(async (from, to) => {
    renames.push({ from: String(from), to: String(to), mode: await modeOf(String(from)) });
    await actual.rename(from, to);
  });
  await store.saveDraft(makeDraft("7"));

  const file = join(draftsDir, "7.json");
  expect(await modeOf(dir)).toBe(0o700);
  expect(await modeOf(draftsDir)).toBe(0o700);
  expect(await modeOf(file)).toBe(0o600);

  // The temp file was private as well, and it sat next to the draft, on the same filesystem.
  expect(renames).toEqual([{ from: expect.any(String), to: file, mode: 0o600 }]);
  expect(dirname(renames[0]?.from ?? "")).toBe(draftsDir);

  // A rewrite makes a new file, and that one is private too.
  await store.markRevealed("7", "https://tender.example/blobs/abc");
  expect(await modeOf(file)).toBe(0o600);
});

test.skipIf(NO_POSIX_MODES)("a_looser_existing_directory_is_made_private", async () => {
  // Someone ran `mkdir -p` by hand, which gives the default umask's 0755. `mkdir` in the store
  // leaves a directory that is already there alone, so the store has to tighten it itself.
  await mkdir(draftsDir, { recursive: true });
  await chmod(draftsDir, 0o755);

  await createStateStore(dir).saveDraft(makeDraft("7"));

  expect(await modeOf(draftsDir)).toBe(0o700);
  expect(await modeOf(join(draftsDir, "7.json"))).toBe(0o600);
});

test("list_drafts", async () => {
  const store = createStateStore(dir);

  // Nothing saved yet, and listing makes nothing either.
  expect(await store.listDrafts()).toEqual([]);
  expect(await readdir(root)).toEqual([]);

  // Saved out of order. They come back by task number, so 2 comes before 10, which a sort on the
  // file names would get wrong. Revealed drafts are listed as well, and the caller filters.
  const ten = makeDraft("10");
  const two = makeDraft("2");
  const one = { ...makeDraft("1"), revealedUri: "https://tender.example/blobs/abc" };
  await store.saveDraft(ten);
  await store.saveDraft(two);
  await store.saveDraft(one);
  expect(await store.listDrafts()).toEqual([one, two, ten]);

  // Whatever is not a draft is left out: the temp file of a writer that was killed half way, a
  // note someone left, a backup, and a name that is not a canonical task number.
  await writeFile(join(draftsDir, ".4.json.4242.beef.tmp"), '{"taskId":"4","contentBa');
  await writeFile(join(draftsDir, "notes.txt"), "not a draft");
  await writeFile(join(draftsDir, "2.json.bak"), "not a draft");
  await writeFile(join(draftsDir, "04.json"), "{}");
  expect(await store.listDrafts()).toEqual([one, two, ten]);
});

test("rejects_task_ids_that_are_not_u64_decimals", async () => {
  const store = createStateStore(dir);
  const bad = [
    "../x",
    "../../etc/passwd",
    "..",
    ".",
    "1/2",
    "1\\2",
    "x.json",
    "",
    "01",
    "007",
    "-1",
    "+1",
    "1.5",
    "1e3",
    "0x10",
    " 1",
    "1 ",
    "1\n",
    "1\0",
    "٣", // an Arabic-Indic three, which a Unicode-aware \d would take for a digit
    "18446744073709551616", // one more than a u64 holds
    "9".repeat(400),
  ];

  for (const taskId of bad) {
    await expect(store.getDraft(taskId), `getDraft(${JSON.stringify(taskId)})`).rejects.toThrow(
      /invalid task id/,
    );
    await expect(
      store.saveDraft({ ...makeDraft("1"), taskId }),
      `saveDraft(${JSON.stringify(taskId)})`,
    ).rejects.toThrow(/invalid task id/);
    await expect(
      store.markRevealed(taskId, "https://tender.example/blobs/abc"),
      `markRevealed(${JSON.stringify(taskId)})`,
    ).rejects.toThrow(/invalid task id/);
  }
  // Every one was refused before the disk was touched, so none of them made a file anywhere.
  expect(await readdir(root)).toEqual([]);

  // The attack the check is for: a crafted id that would reach a file outside drafts/. The file
  // is there and holds a perfectly good draft, and the id still cannot get at it or replace it.
  await mkdir(draftsDir, { recursive: true });
  const outside = join(dir, "x.json");
  await writeFile(outside, JSON.stringify(makeDraft("1")));
  await expect(store.getDraft("../x")).rejects.toThrow(/invalid task id/);
  await expect(store.saveDraft({ ...makeDraft("2"), taskId: "../x" })).rejects.toThrow(
    /invalid task id/,
  );
  expect(await readFile(outside, "utf8")).toBe(JSON.stringify(makeDraft("1")));

  // Both ends of the u64 range are fine.
  for (const taskId of ["0", "18446744073709551615"]) {
    const draft = { ...makeDraft("1"), taskId };
    await store.saveDraft(draft);
    expect(await store.getDraft(taskId)).toEqual(draft);
  }
  expect((await readdir(draftsDir)).sort()).toEqual(["0.json", "18446744073709551615.json"]);
});

test("rejects_a_draft_with_missing_or_mistyped_fields", async () => {
  const store = createStateStore(dir);
  const good = makeDraft("1");

  // A draft that does not have its salt is no use at the reveal, so it must not be written as if
  // it were one.
  const { salt: _salt, ...withoutSalt } = good;
  await expect(store.saveDraft(withoutSalt as Draft)).rejects.toThrow(/invalid draft/);
  await expect(store.saveDraft({ ...good, contentBase64: 5 } as unknown as Draft)).rejects.toThrow(
    /invalid draft/,
  );
  expect(await readdir(root)).toEqual([]);

  // The content may be empty. Anything else about the strings is the caller's business.
  const empty = { ...good, contentBase64: "" };
  await store.saveDraft(empty);
  expect(await store.getDraft("1")).toEqual(empty);
});

test("an_unreadable_draft_is_an_error_not_a_missing_draft", async () => {
  const store = createStateStore(dir);
  await store.saveDraft(makeDraft("1"));
  const file = join(draftsDir, "9.json");

  // Cut off half way, as a failing disk might leave it. If this came back as null, a caller would
  // take it for "no draft" and write a new one over what may still be recoverable.
  const secret = "SECRET-SALT-0123456789";
  await writeFile(file, `{"taskId":"9","salt":"${secret}","commit`);
  const error = await store.getDraft("9").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  // The error says which file, and does not repeat what is in it.
  expect(String(error)).toContain(file);
  expect(String(error)).not.toContain(secret);
  await expect(store.listDrafts()).rejects.toThrow(file);

  // A file that is valid JSON but not the draft for this task is just as unusable.
  await writeFile(file, JSON.stringify(makeDraft("10")));
  await expect(store.getDraft("9")).rejects.toThrow(file);
  await writeFile(file, JSON.stringify({ taskId: "9" }));
  await expect(store.getDraft("9")).rejects.toThrow(file);

  // And a read that fails for any reason other than "no such file" is not hidden either.
  await rm(file);
  await mkdir(file);
  await expect(store.getDraft("9")).rejects.toThrow();
});

// The tests of `defaultStateDir` use `root` as the home directory, so none of them can reach the
// real ~/.tender. The function only builds a path, and the one test that writes under it goes
// through the store.

test("default_state_dir_is_dot_tender_network_account_under_home", () => {
  const stateDir = defaultStateDir("testnet", "alice.test.near", root);
  expect(stateDir).toBe(join(root, ".tender", "testnet", "alice.test.near"));

  // One directory for each network and each account, so two agents never share drafts.
  for (const network of ["sandbox", "testnet", "mainnet"] as const) {
    expect(defaultStateDir(network, "alice.near", root)).toBe(
      join(root, ".tender", network, "alice.near"),
    );
  }
  expect(defaultStateDir("mainnet", "alice.test.near", root)).not.toBe(stateDir);
  expect(defaultStateDir("testnet", "bob.test.near", root)).not.toBe(stateDir);

  // Real account ids are all fine, the shortest, the longest and the 64 hex characters of an
  // implicit account among them.
  for (const account of [
    "a1",
    "a-b_c.d",
    "sub.alice.test.near",
    "a".repeat(64),
    "0123456789abcdef".repeat(4),
  ]) {
    expect(defaultStateDir("testnet", account, root)).toBe(
      join(root, ".tender", "testnet", account),
    );
  }

  // The home is the operating system's unless the caller says otherwise. This only builds a path.
  expect(defaultStateDir("testnet", "alice.test.near")).toBe(
    join(homedir(), ".tender", "testnet", "alice.test.near"),
  );
});

test.skipIf(NO_POSIX_MODES)("default_state_dir_works_with_the_store_and_is_private", async () => {
  const stateDir = defaultStateDir("testnet", "alice.test.near", root);
  const store = createStateStore(stateDir);
  await store.saveDraft(makeDraft("7"));

  expect(await store.getDraft("7")).toEqual(makeDraft("7"));
  expect(await readdir(join(stateDir, "drafts"))).toEqual(["7.json"]);
  // The store makes every level that is missing, and each one is closed to other users, so
  // ~/.tender is private too and not only the drafts directory at the bottom.
  for (const path of [
    join(root, ".tender"),
    join(root, ".tender", "testnet"),
    stateDir,
    join(stateDir, "drafts"),
  ]) {
    expect(await modeOf(path), path).toBe(0o700);
  }
});

test("default_state_dir_rejects_an_account_that_is_not_a_near_account_id", () => {
  const bad = [
    "../x", // the attack: up and out of ~/.tender/{network}
    "..",
    ".",
    "x/..",
    "a/b",
    "a\\b",
    "/etc",
    "~",
    "",
    "Alice.near", // a NEAR account id is lowercase
    "ALICE",
    "alice.NEAR",
    "alice near",
    "alice\n",
    "alice\0",
    "alice.near/",
    "a", // one character is too short
    "a".repeat(65), // and 65 too long
    "-alice",
    "alice-",
    ".alice",
    "alice.",
    "a..b",
    "a--b",
  ];
  for (const account of bad) {
    expect(
      () => defaultStateDir("testnet", account, root),
      `account ${JSON.stringify(account)}`,
    ).toThrow(/invalid account/);
  }
});

test("default_state_dir_rejects_an_unknown_network", () => {
  const bad = [
    "devnet",
    "Mainnet",
    "TESTNET",
    "",
    " testnet",
    "testnet/../mainnet",
    "../x",
    // Names an object has without being a network.
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
  ];
  for (const network of bad) {
    expect(
      () => defaultStateDir(network as NetworkId, "alice.near", root),
      `network ${JSON.stringify(network)}`,
    ).toThrow(/invalid network/);
  }
});

test("default_state_dir_needs_a_real_absolute_home", () => {
  // A "~" read from a JSON config is not expanded here, and an empty or relative home would put the
  // state wherever the process happens to run, which could be inside a git repo.
  for (const home of ["", "~", "~/home", "relative/home", "./home"]) {
    expect(
      () => defaultStateDir("testnet", "alice.near", home),
      `home ${JSON.stringify(home)}`,
    ).toThrow(/absolute/);
  }
});
