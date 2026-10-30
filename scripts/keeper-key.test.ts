import { statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { TenderError } from "@tender/client";
import { NETWORKS } from "@tender/shared";
import { KeyPair } from "near-api-js";
import { afterEach, expect, test, vi } from "vitest";
import { DeployEnv } from "./deploy";
import {
  addRoleKey,
  type ChainPermission,
  type KeyChain,
  type KeyResult,
  type KeyTarget,
  loadTarget,
  main,
} from "./keeper-key";

// Everything here runs without a chain and without the network. The script is tested against a
// chain that is a fake, with a temporary directory in place of the repository root, so that a real
// `.env.deploy.testnet` on this machine can never make a test add a key for real. The command line
// is tested with a stand-in for the script's function, as deploy's is.

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A new directory holding the given files, whose names may have directories in them. */
async function dirWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tender-keeper-key-unit-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

const PARENT = "tender-dev-20261030.testnet";
const CONTRACT = `tender.${PARENT}`;
const KEEPER = `keeper.${PARENT}`;
const JUDGE = `judge.${PARENT}`;
const TARGET: KeyTarget = {
  network: "testnet",
  rpcUrl: "http://127.0.0.1:9",
  contractId: CONTRACT,
};
const ENV_FILE = ".env.deploy.testnet";

/** The full-access keys the deploy made for the two accounts. */
const keeperFull = KeyPair.fromRandom("ed25519");
const judgeFull = KeyPair.fromRandom("ed25519");

/** Shaped like a key, and recognisable in any output: it must never be printed. */
const LEAKY = "ed25519:LEAKY-KEY-MATERIAL-that-must-never-be-printed";

/** The env file the deploy leaves: the contract and, for each account, its id and full-access key. */
function deployed(extra = ""): string {
  return `${[
    "# Written by scripts/deploy.ts. It holds private keys: never commit this file.",
    `TENDER_CONTRACT=${CONTRACT}`,
    `KEEPER_ACCOUNT=${KEEPER}`,
    `KEEPER_FULL_ACCESS_KEY=${keeperFull.toString()}`,
    `JUDGE_ACCOUNT=${JUDGE}`,
    `JUDGE_FULL_ACCESS_KEY=${judgeFull.toString()}`,
    extra,
  ]
    .filter((line) => line !== "")
    .join("\n")}\n`;
}

type Added = Parameters<KeyChain["addFunctionCallKey"]>[0];

/**
 * A chain with the two accounts and their full-access keys on it. It remembers the keys that are
 * added to it, and reports the chain id it is given. `beforeAdd` runs when a key is being added,
 * before the key is on the chain.
 */
function fakeChain(
  opts: { chainId?: string; beforeAdd?: (added: Added) => void | Promise<void> } = {},
) {
  const keys = new Map<string, ChainPermission>([
    [`${KEEPER} ${keeperFull.getPublicKey()}`, "FullAccess"],
    [`${JUDGE} ${judgeFull.getPublicKey()}`, "FullAccess"],
  ]);
  const added: Added[] = [];
  const asked: string[] = [];
  const chain: KeyChain = {
    async chainId() {
      asked.push("chainId");
      return opts.chainId ?? "testnet";
    },
    async viewAccessKey(accountId, publicKey) {
      asked.push("viewAccessKey");
      const permission = keys.get(`${accountId} ${publicKey}`);
      return permission === undefined ? null : { permission };
    },
    async addFunctionCallKey(args) {
      asked.push("addFunctionCallKey");
      await opts.beforeAdd?.(args);
      added.push(args);
      keys.set(`${args.signer.accountId} ${args.publicKey}`, {
        FunctionCall: {
          receiver_id: args.contractId,
          method_names: [...args.methods],
          allowance: null,
        },
      });
    },
  };
  return { chain, keys, added, asked };
}

/** What `run` hands back: the lines the script printed, and what it returned. */
interface Run {
  lines: string[];
  result: KeyResult;
}

async function run(
  role: "keeper" | "judge",
  dir: string,
  chain: KeyChain,
  target: KeyTarget = TARGET,
): Promise<Run> {
  const lines: string[] = [];
  const result = await addRoleKey(role, target, { dir, log: (line) => lines.push(line), chain });
  return { lines, result };
}

/** The variables of the env file in `dir`, read as node reads them. */
async function envOf(dir: string): Promise<Record<string, string | undefined>> {
  return parseEnv(await readFile(join(dir, ENV_FILE), "utf8"));
}

/** The part of a key after `ed25519:`, which is all the secret there is to it. */
const secretOf = (key: string) => key.slice("ed25519:".length);

// ---- The function -------------------------------------------------------------------------------

test("key_script_writes_the_new_key_to_the_env_file_before_it_adds_it_and_never_prints_it", async () => {
  const dir = await dirWith({ [ENV_FILE]: deployed() });
  const before = await readFile(join(dir, ENV_FILE), "utf8");
  const atAdd: string[] = [];
  const { chain, added } = fakeChain({
    // The key is on disk when the chain is first asked to take it.
    beforeAdd: async (args) => {
      const stored = (await envOf(dir)).KEEPER_PRIVATE_KEY;
      atAdd.push(
        stored !== undefined &&
          KeyPair.fromString(stored as `ed25519:${string}`)
            .getPublicKey()
            .toString() === args.publicKey
          ? "stored first"
          : "not stored",
      );
    },
  });

  const { lines, result } = await run("keeper", dir, chain);

  expect(atAdd).toEqual(["stored first"]);
  // A function-call key limited to Tender and the two methods of the keeper, added to the keeper
  // account, signed with the full-access key of the deploy.
  expect(added).toEqual([
    {
      signer: { accountId: KEEPER, privateKey: keeperFull.toString() },
      publicKey: result.publicKey,
      contractId: CONTRACT,
      methods: ["void_task", "cleanup"],
    },
  ]);
  expect(result).toEqual({ outcome: "OK", accountId: KEEPER, publicKey: result.publicKey });
  expect(result.publicKey).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/);

  // The file keeps what it had, and gains the key on a line of its own, readable by its owner alone.
  const after = await readFile(join(dir, ENV_FILE), "utf8");
  expect(after.startsWith(before)).toBe(true);
  expect(after.slice(before.length)).toMatch(/^KEEPER_PRIVATE_KEY=ed25519:\S+\n$/);
  expect(statSync(join(dir, ENV_FILE)).mode & 0o777).toBe(0o600);
  const stored = (await envOf(dir)).KEEPER_PRIVATE_KEY ?? "";
  expect(
    KeyPair.fromString(stored as `ed25519:${string}`)
      .getPublicKey()
      .toString(),
  ).toBe(result.publicKey);

  // The one line says what was done and shows the public key; no key of either kind is in it.
  expect(lines).toEqual([`OK add keeper key ${result.publicKey} to ${KEEPER}`]);
  const printed = lines.join("\n");
  expect(printed).not.toContain(secretOf(stored));
  expect(printed).not.toContain(secretOf(keeperFull.toString()));
});

test("key_script_is_idempotent", async () => {
  const dir = await dirWith({ [ENV_FILE]: deployed() });
  const { chain, added } = fakeChain();
  const first = await run("keeper", dir, chain);
  const afterFirst = await readFile(join(dir, ENV_FILE), "utf8");

  const second = await run("keeper", dir, chain);

  // The same key, found on the chain with the right permission: nothing is added or written.
  expect(second.result).toEqual({ ...first.result, outcome: "SKIP" });
  expect(second.lines).toEqual([
    `SKIP add keeper key ${first.result.publicKey} to ${KEEPER} (exists)`,
  ]);
  expect(added).toHaveLength(1);
  expect(await readFile(join(dir, ENV_FILE), "utf8")).toBe(afterFirst);
});

test("key_script_adds_the_key_the_file_holds_when_the_chain_lacks_it_and_makes_no_new_one", async () => {
  const stored = KeyPair.fromRandom("ed25519");
  const dir = await dirWith({ [ENV_FILE]: deployed(`KEEPER_PRIVATE_KEY=${stored.toString()}`) });
  const text = await readFile(join(dir, ENV_FILE), "utf8");
  const { chain, added } = fakeChain();

  const { lines, result } = await run("keeper", dir, chain);

  expect(result.outcome).toBe("OK");
  expect(result.publicKey).toBe(stored.getPublicKey().toString());
  expect(added.map((a) => a.publicKey)).toEqual([stored.getPublicKey().toString()]);
  // Nothing was written: the file has the key already.
  expect(await readFile(join(dir, ENV_FILE), "utf8")).toBe(text);
  expect(lines.join("\n")).not.toContain(secretOf(stored.toString()));
});

test("key_script_carries_on_after_a_run_that_stopped_at_the_chain", async () => {
  const dir = await dirWith({ [ENV_FILE]: deployed() });
  const down = fakeChain({
    beforeAdd: () => {
      throw new Error("the node went away");
    },
  });

  // The key was written before the chain was asked, so it is not lost with the failed call...
  await expect(run("keeper", dir, down.chain)).rejects.toThrow("the node went away");
  const stored = (await envOf(dir)).KEEPER_PRIVATE_KEY ?? "";
  expect(stored).toMatch(/^ed25519:/);
  const publicKey = KeyPair.fromString(stored as `ed25519:${string}`)
    .getPublicKey()
    .toString();
  expect(down.added).toEqual([]);

  // ... and the next run adds that key, not another one, and writes nothing more.
  const text = await readFile(join(dir, ENV_FILE), "utf8");
  const up = fakeChain();
  const { result } = await run("keeper", dir, up.chain);
  expect(result).toEqual({ outcome: "OK", accountId: KEEPER, publicKey });
  expect(up.added.map((a) => a.publicKey)).toEqual([publicKey]);
  expect(await readFile(join(dir, ENV_FILE), "utf8")).toBe(text);
});

test("key_script_uses_a_key_that_only_the_plain_env_file_holds_and_writes_nothing", async () => {
  // The service key is the owner's, put in `.env`. The network file wins over `.env`, so a key
  // appended to it would replace the owner's: the script uses the one it finds.
  const stored = KeyPair.fromRandom("ed25519");
  const dir = await dirWith({
    ".env": `KEEPER_PRIVATE_KEY=${stored.toString()}\n`,
    [ENV_FILE]: deployed(),
  });
  const text = await readFile(join(dir, ENV_FILE), "utf8");
  const { chain, added } = fakeChain();

  const { result } = await run("keeper", dir, chain);

  expect(result.publicKey).toBe(stored.getPublicKey().toString());
  expect(added).toHaveLength(1);
  expect(await readFile(join(dir, ENV_FILE), "utf8")).toBe(text);
});

test("key_script_takes_a_blank_service_key_for_none", async () => {
  // `.env.example` has `KEEPER_PRIVATE_KEY=` blank, and an owner copies it as it is.
  const dir = await dirWith({ [ENV_FILE]: deployed("KEEPER_PRIVATE_KEY=") });
  const { chain, added } = fakeChain();

  const { result } = await run("keeper", dir, chain);

  expect(result.outcome).toBe("OK");
  expect(added).toHaveLength(1);
  // The new line comes after the blank one, and the file reads back as the key.
  const stored = (await envOf(dir)).KEEPER_PRIVATE_KEY ?? "";
  expect(
    KeyPair.fromString(stored as `ed25519:${string}`)
      .getPublicKey()
      .toString(),
  ).toBe(result.publicKey);
});

test("key_script_refuses_a_stored_function_call_key_with_another_permission_and_says_to_remove_it", async () => {
  const stored = KeyPair.fromRandom("ed25519");
  const fc = (over: Record<string, unknown>): ChainPermission => ({
    FunctionCall: {
      receiver_id: CONTRACT,
      method_names: ["void_task", "cleanup"],
      allowance: null,
      ...over,
    },
  });
  const cases: Array<[string, ChainPermission, RegExp]> = [
    [
      "another receiver",
      fc({ receiver_id: "other.testnet" }),
      /function-call key to other\.testnet/,
    ],
    [
      "one method more",
      fc({ method_names: ["void_task", "cleanup", "pick"] }),
      /void_task, cleanup, pick/,
    ],
    ["one method less", fc({ method_names: ["void_task"] }), /for void_task with/],
    ["an allowance", fc({ allowance: "1000000000000000000000000" }), /with an allowance/],
    // An empty list means every method on NEAR, and is said so.
    ["every method", fc({ method_names: [] }), /for any method with unlimited allowance/],
  ];
  for (const [what, permission, message] of cases) {
    const dir = await dirWith({ [ENV_FILE]: deployed(`KEEPER_PRIVATE_KEY=${stored.toString()}`) });
    const text = await readFile(join(dir, ENV_FILE), "utf8");
    const { chain, keys, added } = fakeChain();
    keys.set(`${KEEPER} ${stored.getPublicKey()}`, permission);

    const error = await run("keeper", dir, chain).then(
      () => "ran",
      (e: Error) => e.message,
    );

    expect(error, what).toMatch(message);
    expect(error, what).not.toContain("for  with");
    // A function-call key comes off the account without a loss: that is the advice for it.
    expect(error, what).toContain(
      "remove that key from the account and the KEEPER_PRIVATE_KEY line from the env file, and run it again",
    );
    expect(error, what).toContain("KEEPER_PRIVATE_KEY");
    expect(error, what).toContain(stored.getPublicKey().toString());
    expect(error, what).not.toContain(secretOf(stored.toString()));
    expect(added, what).toEqual([]);
    expect(await readFile(join(dir, ENV_FILE), "utf8"), what).toBe(text);
  }
});

test("key_script_never_advises_deleting_the_full_access_key_when_the_service_key_is_it", async () => {
  // The mix-up that P02-R27 is about: the full-access key of the deploy, put under the service's
  // name. "Remove the key from the account" would delete the only way into the account for good.
  const roles = [
    ["keeper", KEEPER, keeperFull],
    ["judge", JUDGE, judgeFull],
  ] as const;
  for (const [role, account, full] of roles) {
    const stem = role.toUpperCase();
    const dir = await dirWith({ [ENV_FILE]: deployed(`${stem}_PRIVATE_KEY=${full.toString()}`) });
    const text = await readFile(join(dir, ENV_FILE), "utf8");
    const { chain, added } = fakeChain();

    const error = await run(role, dir, chain).then(
      () => "ran",
      (e: Error) => e.message,
    );

    expect(error, role).toContain(`${stem}_PRIVATE_KEY holds ${full.getPublicKey()}`);
    // It says whose key it is, and what is wrong with it.
    expect(error, role).toContain(`is the same key as ${stem}_FULL_ACCESS_KEY`);
    expect(error, role).toContain(`a full-access key on ${account}`);
    // The advice is for the variable, and against touching the account.
    expect(error, role).toContain(`Remove only the ${stem}_PRIVATE_KEY line from the env file`);
    expect(error, role).toContain("Do not delete the key from the account");
    expect(error, role).not.toMatch(/remove (that|the|this) key from the account/i);
    expect(error, role).not.toContain(secretOf(full.toString()));
    // Nothing was changed, on the chain or in the file.
    expect(added, role).toEqual([]);
    expect(await readFile(join(dir, ENV_FILE), "utf8"), role).toBe(text);
  }
});

test("key_script_says_to_remove_the_variable_alone_for_any_stored_key_that_is_no_function_call_key", async () => {
  const stored = KeyPair.fromRandom("ed25519");
  const cases: Array<[string, ChainPermission, RegExp]> = [
    // A full-access key of the owner's, which is not the one of the deploy.
    ["another full-access key", "FullAccess", /which is a full-access key on keeper\./],
    // A kind the script does not know, such as a key for paying gas that a newer node reports.
    [
      "a key of another kind",
      { GasKeyFullAccess: { balance: "1", num_nonces: 1 } } as unknown as ChainPermission,
      /which is a key of another kind on keeper\./,
    ],
  ];
  for (const [what, permission, message] of cases) {
    const dir = await dirWith({ [ENV_FILE]: deployed(`KEEPER_PRIVATE_KEY=${stored.toString()}`) });
    const text = await readFile(join(dir, ENV_FILE), "utf8");
    const { chain, keys, added } = fakeChain();
    keys.set(`${KEEPER} ${stored.getPublicKey()}`, permission);

    const error = await run("keeper", dir, chain).then(
      () => "ran",
      (e: Error) => e.message,
    );

    expect(error, what).toMatch(message);
    expect(error, what).toContain(stored.getPublicKey().toString());
    // It is not the deploy's key, so it does not say so.
    expect(error, what).not.toContain("is the same key as");
    expect(error, what).toContain("Remove only the KEEPER_PRIVATE_KEY line from the env file");
    expect(error, what).toContain("Do not delete the key from the account");
    expect(error, what).not.toMatch(/remove (that|the|this) key from the account/i);
    expect(error, what).not.toContain(secretOf(stored.toString()));
    expect(added, what).toEqual([]);
    expect(await readFile(join(dir, ENV_FILE), "utf8"), what).toBe(text);
  }
});

test("key_script_refuses_a_service_key_that_is_the_full_access_key_of_another_account", async () => {
  // The mix-up of P02-R27 across roles: the keeper's variable holds the judge's full-access key. The
  // keeper's account has no such key, so the script would add it there as a function-call key, and
  // the keeper's service would sign with a secret that has full access to the judge's account.
  const dir = await dirWith({ [ENV_FILE]: deployed(`KEEPER_PRIVATE_KEY=${judgeFull.toString()}`) });
  const text = await readFile(join(dir, ENV_FILE), "utf8");
  const { chain, added, asked } = fakeChain();

  const error = await run("keeper", dir, chain).then(
    () => "ran",
    (e: Error) => e.message,
  );

  // Both variables are named, and the key is shown by its public half alone.
  expect(error).toContain("KEEPER_PRIVATE_KEY");
  expect(error).toContain("JUDGE_FULL_ACCESS_KEY");
  expect(error).toContain(judgeFull.getPublicKey().toString());
  expect(error).not.toContain(secretOf(judgeFull.toString()));
  // The advice is for the variable, and never to delete a key.
  expect(error).toContain("Remove only the KEEPER_PRIVATE_KEY line from the env file");
  expect(error).not.toMatch(/remove (that|the|this) key from the account/i);
  // Nothing is written, and the chain is not even asked.
  expect(added).toEqual([]);
  expect(asked).toEqual([]);
  expect(await readFile(join(dir, ENV_FILE), "utf8")).toBe(text);
});

test("key_script_refuses_a_service_key_that_is_the_parent_key_or_the_contracts_full_access_key", async () => {
  const parent = KeyPair.fromRandom("ed25519");
  const contract = KeyPair.fromRandom("ed25519");
  const cases: Array<[string, "keeper" | "judge", string, KeyPair, Record<string, string>]> = [
    // The owner's parent account key lives in `.env`, where the deploy reads it.
    [
      "the parent key under the judge",
      "judge",
      "DEPLOY_PARENT_PRIVATE_KEY",
      parent,
      {
        ".env": `DEPLOY_PARENT_PRIVATE_KEY=${parent.toString()}\n`,
        [ENV_FILE]: deployed(`JUDGE_PRIVATE_KEY=${parent.toString()}`),
      },
    ],
    [
      "the contract's key under the keeper",
      "keeper",
      "TENDER_CONTRACT_FULL_ACCESS_KEY",
      contract,
      {
        [ENV_FILE]: deployed(
          `TENDER_CONTRACT_FULL_ACCESS_KEY=${contract.toString()}\nKEEPER_PRIVATE_KEY=${contract.toString()}`,
        ),
      },
    ],
  ];
  for (const [what, role, holder, key, files] of cases) {
    const dir = await dirWith(files);
    const text = await readFile(join(dir, ENV_FILE), "utf8");
    const { chain, added, asked } = fakeChain();

    const error = await run(role, dir, chain).then(
      () => "ran",
      (e: Error) => e.message,
    );

    expect(error, what).toContain(`${role.toUpperCase()}_PRIVATE_KEY`);
    expect(error, what).toContain(holder);
    expect(error, what).toContain(key.getPublicKey().toString());
    expect(error, what).not.toContain(secretOf(key.toString()));
    expect(error, what).toContain(
      `Remove only the ${role.toUpperCase()}_PRIVATE_KEY line from the env file`,
    );
    expect(added, what).toEqual([]);
    expect(asked, what).toEqual([]);
    expect(await readFile(join(dir, ENV_FILE), "utf8"), what).toBe(text);
  }
});

test("key_script_goes_on_when_another_full_access_variable_holds_no_key_and_never_shows_it", async () => {
  // Only a key that is the same key is a clash: a value that is no key is somebody else's concern.
  const dir = await dirWith({ [ENV_FILE]: deployed(`OWNER_FULL_ACCESS_KEY=${LEAKY}`) });
  const { chain, added } = fakeChain();

  const { lines, result } = await run("keeper", dir, chain);

  expect(result.outcome).toBe("OK");
  expect(added).toHaveLength(1);
  expect(lines.join("\n")).not.toContain("LEAKY");
});

test("key_script_accepts_the_methods_of_the_key_in_any_order", async () => {
  const stored = KeyPair.fromRandom("ed25519");
  const dir = await dirWith({ [ENV_FILE]: deployed(`KEEPER_PRIVATE_KEY=${stored.toString()}`) });
  const { chain, keys, added } = fakeChain();
  keys.set(`${KEEPER} ${stored.getPublicKey()}`, {
    FunctionCall: { receiver_id: CONTRACT, method_names: ["cleanup", "void_task"] },
  });

  const { result } = await run("keeper", dir, chain);

  expect(result.outcome).toBe("SKIP");
  expect(added).toEqual([]);
});

test("key_script_checks_the_full_access_key_before_it_writes_anything", async () => {
  const cases: Array<[string, (keys: Map<string, ChainPermission>) => void, RegExp]> = [
    [
      "a key the account lacks",
      (keys) => keys.delete(`${KEEPER} ${keeperFull.getPublicKey()}`),
      /KEEPER_FULL_ACCESS_KEY is not a key of keeper\.tender-dev-20261030\.testnet/,
    ],
    [
      "a function-call key",
      (keys) =>
        keys.set(`${KEEPER} ${keeperFull.getPublicKey()}`, {
          FunctionCall: { receiver_id: CONTRACT, method_names: [] },
        }),
      /KEEPER_FULL_ACCESS_KEY is a function-call key of keeper\.tender-dev-20261030\.testnet/,
    ],
  ];
  for (const [what, damage, message] of cases) {
    const dir = await dirWith({ [ENV_FILE]: deployed() });
    const text = await readFile(join(dir, ENV_FILE), "utf8");
    const { chain, keys, added } = fakeChain();
    damage(keys);

    await expect(run("keeper", dir, chain), what).rejects.toThrow(message);

    // No service key was made for an account the script cannot add it to.
    expect(added, what).toEqual([]);
    expect(await readFile(join(dir, ENV_FILE), "utf8"), what).toBe(text);
  }
});

test("key_script_names_what_is_wrong_with_the_env_file_and_never_shows_a_value", async () => {
  const attempt = async (files: Record<string, string>) => {
    const dir = await dirWith(files);
    const { chain, added, asked } = fakeChain();
    const error = await run("keeper", dir, chain).then(
      () => "ran",
      (e: Error) => e.message,
    );
    // Nothing reaches the chain, whatever is wrong.
    expect(added).toEqual([]);
    expect(asked).toEqual([]);
    return error;
  };
  const withKeeper = (over: Record<string, string>) => {
    const values: Record<string, string> = {
      TENDER_CONTRACT: CONTRACT,
      KEEPER_ACCOUNT: KEEPER,
      KEEPER_FULL_ACCESS_KEY: keeperFull.toString(),
      ...over,
    };
    return {
      [ENV_FILE]: `${Object.entries(values)
        .map(([name, value]) => `${name}=${value}`)
        .join("\n")}\n`,
    };
  };

  // Variables that are missing, in either file: the message names them all.
  expect(await attempt({})).toMatch(
    /missing keys for network testnet: KEEPER_ACCOUNT, KEEPER_FULL_ACCESS_KEY/,
  );
  expect(await attempt({ [ENV_FILE]: `KEEPER_ACCOUNT=${KEEPER}\n` })).toMatch(
    /missing keys for network testnet: KEEPER_FULL_ACCESS_KEY/,
  );

  // A key that landed in the account variable may be the real thing: it is not shown.
  const keyInPlace = await attempt(withKeeper({ KEEPER_ACCOUNT: LEAKY }));
  expect(keyInPlace).toMatch(/^KEEPER_ACCOUNT is not a valid NEAR account id/);
  expect(keyInPlace).not.toContain("LEAKY");

  // Keys that are no keys: named, but never shown.
  for (const name of ["KEEPER_FULL_ACCESS_KEY", "KEEPER_PRIVATE_KEY"]) {
    const message = await attempt(withKeeper({ [name]: "not-a-key-at-all" }));
    expect(message, name).toMatch(new RegExp(`^${name} is not a valid private key`));
    expect(message, name).not.toContain("not-a-key-at-all");
  }
});

test("key_script_refuses_a_contract_that_is_no_account_id_without_showing_it", async () => {
  const dir = await dirWith({ [ENV_FILE]: deployed() });
  const { chain, added } = fakeChain();

  const error = await run("keeper", dir, chain, { ...TARGET, contractId: LEAKY }).then(
    () => "ran",
    (e: Error) => e.message,
  );

  expect(error).toMatch(/contract is not a valid NEAR account id/);
  expect(error).not.toContain("LEAKY");
  expect(added).toEqual([]);
});

test("key_script_refuses_mainnet_by_name_and_by_chain_id_before_it_writes_anything", async () => {
  // A file for each network the loop below names, so that the env file is never what fails.
  const dir = await dirWith({ [ENV_FILE]: deployed(), ".env.deploy.sandbox": deployed() });
  const text = await readFile(join(dir, ENV_FILE), "utf8");

  // By name: nothing is asked of the chain.
  const named = fakeChain();
  await expect(run("keeper", dir, named.chain, { ...TARGET, network: "mainnet" })).rejects.toThrow(
    /mainnet.*plan 07/s,
  );
  expect(named.asked).toEqual([]);

  // By what the node says it is, whatever the target calls it.
  for (const network of ["testnet", "sandbox"] as const) {
    const node = fakeChain({ chainId: "mainnet" });
    await expect(run("keeper", dir, node.chain, { ...TARGET, network })).rejects.toThrow(
      /mainnet.*plan 07.*chain id "mainnet"/s,
    );
    expect(node.added).toEqual([]);
  }
  // A testnet run needs a testnet node.
  const local = fakeChain({ chainId: "localnet" });
  await expect(run("keeper", dir, local.chain)).rejects.toThrow(
    /testnet, but the node answered with chain id "localnet"/,
  );

  expect(await readFile(join(dir, ENV_FILE), "utf8")).toBe(text);
});

test("key_script_gives_the_judge_the_methods_of_a_pick_and_leaves_the_keeper_alone", async () => {
  const keeperKey = KeyPair.fromRandom("ed25519");
  const dir = await dirWith({ [ENV_FILE]: deployed(`KEEPER_PRIVATE_KEY=${keeperKey.toString()}`) });
  const { chain, added, keys } = fakeChain();

  const { lines, result } = await run("judge", dir, chain);

  expect(added).toEqual([
    {
      signer: { accountId: JUDGE, privateKey: judgeFull.toString() },
      publicKey: result.publicKey,
      contractId: CONTRACT,
      methods: ["pick", "pick_attested"],
    },
  ]);
  expect(lines).toEqual([`OK add judge key ${result.publicKey} to ${JUDGE}`]);
  // The key is the judge's, under the judge's name; the keeper's variable is as it was.
  const env = await envOf(dir);
  expect(
    KeyPair.fromString(env.JUDGE_PRIVATE_KEY as `ed25519:${string}`)
      .getPublicKey()
      .toString(),
  ).toBe(result.publicKey);
  expect(env.KEEPER_PRIVATE_KEY).toBe(keeperKey.toString());
  expect(keys.has(`${KEEPER} ${keeperKey.getPublicKey()}`)).toBe(false);
});

test("key_script_makes_an_existing_env_file_private_even_when_it_goes_no_further", async () => {
  // The owner makes the file by hand, with keys in it, and gets mode 0644 more often than not.
  const dir = await dirWith({
    [ENV_FILE]: `KEEPER_ACCOUNT=${LEAKY}\nKEEPER_FULL_ACCESS_KEY=${keeperFull.toString()}\n`,
  });
  const path = join(dir, ENV_FILE);
  await chmod(path, 0o644);

  await expect(run("keeper", dir, fakeChain().chain)).rejects.toThrow(
    /not a valid NEAR account id/,
  );

  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("key_script_stops_before_the_chain_when_the_env_file_does_not_read_back", async () => {
  // Node reads a line that ends in "= " as running on into the next, and the next variable is lost.
  // The script reads past that, so the file works for it; the key it appends is checked the way
  // any other reader would read it, and the chain is not asked to take a key that may be lost.
  const dir = await dirWith({ [ENV_FILE]: deployed("PADDED= \nNEXT=value") });
  const { chain, added } = fakeChain();

  const error = await run("keeper", dir, chain).then(
    () => "ran",
    (e: Error) => e.message,
  );

  expect(error).toMatch(/does not read back as written/);
  // The owner is told to run this script again, not the deploy, which has nothing to do with it.
  expect(error).toMatch(/fix that line and run this script again\.$/);
  expect(error).not.toContain("run the deploy again");
  expect(added).toEqual([]);
});

test("key_script_names_itself_in_the_header_of_an_env_file_it_creates", async () => {
  // The owner keeps the keys in `.env`, so there is no network file yet: the script makes it.
  const dir = await dirWith({ ".env": deployed() });
  const { chain } = fakeChain();

  await run("keeper", dir, chain);

  const text = await readFile(join(dir, ENV_FILE), "utf8");
  expect(text.split("\n")[0]).toBe(
    "# Written by scripts/keeper-key.ts. It holds private keys: never commit this file.",
  );
  expect(text).not.toContain("scripts/deploy.ts");
  expect(statSync(join(dir, ENV_FILE)).mode & 0o777).toBe(0o600);
  expect((await envOf(dir)).KEEPER_PRIVATE_KEY).toMatch(/^ed25519:/);
});

test("the_deploys_env_file_says_what_it_always_has_when_it_is_given_no_writer", async () => {
  // `DeployEnv` takes the name of the script that writes through it, for the header of a file it
  // makes and for what an error says to run again. The deploy passes none, and its text is unchanged.
  const dir = await dirWith({});
  const file = await DeployEnv.open(dir, "testnet");

  await file.add([["SOME_NAME", "some-value"]]);

  expect((await readFile(join(dir, ENV_FILE), "utf8")).split("\n")[0]).toBe(
    "# Written by scripts/deploy.ts. It holds private keys: never commit this file.",
  );

  await writeFile(join(dir, ENV_FILE), "PADDED= \nNEXT=value\n");
  const again = await DeployEnv.open(dir, "testnet");
  await expect(again.add([["MORE", "value"]])).rejects.toThrow(
    /does not read back as written .* fix that line and run the deploy again\.$/s,
  );
});

test("key_script_does_not_touch_the_mainnet_file", async () => {
  const dir = await dirWith({ ".env.deploy.mainnet": deployed() });
  const text = await readFile(join(dir, ".env.deploy.mainnet"), "utf8");

  await expect(
    run("keeper", dir, fakeChain().chain, { ...TARGET, network: "mainnet" }),
  ).rejects.toThrow(/mainnet/);

  expect(await readFile(join(dir, ".env.deploy.mainnet"), "utf8")).toBe(text);
});

// ---- The command line ---------------------------------------------------------------------------

/** Runs the command line against the files in a new directory, with the script's function replaced. */
async function runCli(files: Record<string, string>, args: string[]) {
  const dir = await dirWith(files);
  const out: string[] = [];
  const err: string[] = [];
  const fake = vi.fn<typeof addRoleKey>(async (role, _target, options) => {
    options?.log?.(`OK add ${role} key ed25519:PUBLIC to somebody`);
    return { outcome: "OK", accountId: "somebody", publicKey: "ed25519:PUBLIC" };
  });
  const code = await main(args, {
    dir,
    out: (line) => out.push(line),
    err: (text) => err.push(text),
    addKey: fake,
  });
  return { code, out, err: err.join("\n"), addKey: fake, dir };
}

test("cli_adds_the_keeper_key_on_testnet_with_the_networks_rpc_and_the_contract_of_the_env_file", async () => {
  const { code, out, err, addKey, dir } = await runCli({ [ENV_FILE]: deployed() }, [
    "--network",
    "testnet",
  ]);

  expect(code).toBe(0);
  expect(err).toBe("");
  // Only the script's own lines reach stdout.
  expect(out).toEqual(["OK add keeper key ed25519:PUBLIC to somebody"]);
  expect(addKey).toHaveBeenCalledTimes(1);
  expect(addKey.mock.calls[0]?.[0]).toBe("keeper");
  expect(addKey.mock.calls[0]?.[1]).toEqual({
    network: "testnet",
    rpcUrl: NETWORKS.testnet.rpcUrl,
    contractId: CONTRACT,
  });
  expect(addKey.mock.calls[0]?.[2]).toMatchObject({ dir });
});

test("cli_takes_the_role_from_the_flag", async () => {
  const files = { [ENV_FILE]: deployed() };
  const judge = await runCli(files, ["--network", "testnet", "--role", "judge"]);
  expect(judge.code).toBe(0);
  expect(judge.addKey.mock.calls[0]?.[0]).toBe("judge");

  const keeper = await runCli(files, ["--role", "keeper", "--network", "testnet"]);
  expect(keeper.code).toBe(0);
  expect(keeper.addKey.mock.calls[0]?.[0]).toBe("keeper");

  const other = await runCli(files, ["--network", "testnet", "--role", "treasury"]);
  expect(other.code).toBe(1);
  expect(other.err).toMatch(/unknown role "treasury".*keeper or judge/s);
  expect(other.addKey).not.toHaveBeenCalled();
});

test("cli_refuses_mainnet_the_sandbox_and_anything_else_without_touching_the_chain", async () => {
  const files = { [ENV_FILE]: deployed() };
  const cases: Array<[string[], RegExp]> = [
    [["--network", "mainnet"], /mainnet.*plan 07/s],
    [["--network", "sandbox"], /sandbox.*tests/s],
    [["--network", "devnet"], /unknown network "devnet"/],
    [[], /usage: .*--network testnet/],
    [["--network", "testnet", "--force"], /force/],
    [["--network"], /network/],
  ];
  for (const [args, message] of cases) {
    const { code, err, out, addKey } = await runCli(files, args);
    expect(code, args.join(" ")).toBe(1);
    expect(err, args.join(" ")).toMatch(message);
    expect(out).toEqual([]);
    expect(addKey).not.toHaveBeenCalled();
  }
});

test("cli_names_the_contract_it_lacks_or_cannot_use_without_showing_a_value", async () => {
  const lacks = await runCli({ [ENV_FILE]: "KEEPER_ACCOUNT=x.testnet\n" }, [
    "--network",
    "testnet",
  ]);
  expect(lacks.code).toBe(1);
  expect(lacks.err).toContain("TENDER_CONTRACT");
  expect(lacks.addKey).not.toHaveBeenCalled();

  const misplaced = await runCli({ [ENV_FILE]: `TENDER_CONTRACT=${LEAKY}\n` }, [
    "--network",
    "testnet",
  ]);
  expect(misplaced.code).toBe(1);
  expect(misplaced.err).toContain("TENDER_CONTRACT");
  expect(misplaced.err).not.toContain("LEAKY");
  expect(misplaced.addKey).not.toHaveBeenCalled();
});

test("cli_prints_a_failure_with_its_code_and_exits_1", async () => {
  const dir = await dirWith({ [ENV_FILE]: deployed() });
  const attempt = async (failure: unknown) => {
    const err: string[] = [];
    const code = await main(["--network", "testnet"], {
      dir,
      out: () => {},
      err: (text) => err.push(text),
      addKey: async () => {
        throw failure;
      },
    });
    return { code, err: err.join("\n") };
  };

  expect(await attempt(new Error("the RPC is down"))).toEqual({
    code: 1,
    err: "keeper-key failed: the RPC is down",
  });
  expect(
    await attempt(
      new TenderError("E_UNKNOWN", '{"AddKey":"exists"}', { txHash: "6kSpdaiEGudXLa4p" }),
    ),
  ).toEqual({
    code: 1,
    err: 'keeper-key failed with E_UNKNOWN\n{"AddKey":"exists"}\ntransaction 6kSpdaiEGudXLa4p',
  });
});

test("load_target_reads_the_contract_from_the_network_file_or_the_plain_env_file", async () => {
  const dir = await dirWith({
    ".env": "TENDER_CONTRACT=other.testnet\n",
    [ENV_FILE]: `TENDER_CONTRACT=${CONTRACT}\n`,
  });
  expect(loadTarget("testnet", { dir }).contractId).toBe(CONTRACT);

  const plain = await dirWith({ ".env": "TENDER_CONTRACT=other.testnet\n" });
  expect(loadTarget("testnet", { dir: plain }).contractId).toBe("other.testnet");
});
