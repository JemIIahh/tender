import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TenderError } from "@tender/client";
import type { ConfigView } from "@tender/shared";
import { KeyPair, type KeyPairString } from "near-api-js";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  type AgentTarget,
  type ClientFactory,
  DEFAULT_ALLOWANCE,
  DELEGATE_METHODS,
  type DelegateOptions,
  delegateAgentCommand,
  initAgent,
  type KeyWriter,
  main,
  undelegateAgentCommand,
} from "./agent";

// `agent:delegate` and `agent:undelegate` on a small world instead of a chain, so that every branch
// is reached: what is added to the account, in what order, what is printed, and what a failure in
// the middle leaves behind. `agent-delegate.sandbox.test.ts` runs the same commands on a real node.

const ACCOUNT = "scout.test.near";
const CONTRACT = "tender.test.near";
const TOKEN = "tusdc.test.near";
const OTHER_TOKEN = "other.test.near";
const NEAR = 10n ** 24n;

type Permission =
  | "FullAccess"
  | {
      FunctionCall: {
        receiver_id: string;
        method_names: string[];
        allowance?: string | null;
      };
    };

interface Caps {
  token: string;
  per_task_cap: string;
  total_cap: string;
  spent: string;
}

interface World {
  /** The access keys of the account, by public key. */
  keys: Map<string, Permission>;
  /** The caps `add_delegate` registered, by public key. */
  delegates: Map<string, Caps>;
  /** Whether the account has a storage balance with Tender. */
  storage: boolean;
  /** Every change made to the account or to Tender, in order, as one line each. */
  log: string[];
  /** The access keys that were added, as the writer got them. */
  added: Array<{ publicKey: string; contractId: string; methods: string[]; allowance: bigint }>;
  /** Makes the next `add_delegate` fail as the contract does when storage cannot pay. */
  failAddDelegate: boolean;
  /** Makes `deleteKey` do nothing, as a chain that did not take it. */
  ignoreDeleteKey: boolean;
  tokens: Array<{ token: string; enabled: boolean }>;
}

const world = (): World => ({
  keys: new Map(),
  delegates: new Map(),
  storage: true,
  log: [],
  added: [],
  failAddDelegate: false,
  ignoreDeleteKey: false,
  tokens: [{ token: TOKEN, enabled: true }],
});

const publicKeyOf = (privateKey: string) =>
  KeyPair.fromString(privateKey as KeyPairString)
    .getPublicKey()
    .toString();

/** The client of the account over `w`: the chain's answers, and the full-access check of the real one. */
function fakeClients(w: World): ClientFactory {
  const tx = { txHash: "TXHASH", events: [], returnValue: undefined, receipts: [] };
  return ((_target: AgentTarget, signer: { accountId: string; privateKey: string }) => ({
    accountId: signer.accountId,
    contractId: CONTRACT,
    requireFullAccessKey: async (method: string) => {
      if (w.keys.get(publicKeyOf(signer.privateKey)) !== "FullAccess") {
        throw new TenderError("E_AUTH", `${method} needs a full-access key. Nothing was sent.`);
      }
    },
    getConfig: async () =>
      ({
        tokens: w.tokens.map((t) => ({ ...t, min_reward: "1", max_reward: "1000000000000" })),
      }) as unknown as ConfigView,
    storageBalanceOf: async () =>
      w.storage ? { total: "1", available: "1", used_bytes: "0" } : null,
    viewAccessKey: async (_account: string, publicKey: string) => {
      const permission = w.keys.get(publicKey);
      return permission === undefined ? null : { permission };
    },
    view: async (_contract: string, method: string, args: { public_key: string }) => {
      if (method !== "get_delegate") throw new Error(`unexpected view ${method}`);
      return w.delegates.get(args.public_key) ?? null;
    },
    addDelegate: async (publicKey: string, token: string, perTask: bigint, total: bigint) => {
      w.log.push(`add_delegate ${publicKey} ${token} ${perTask} ${total}`);
      if (w.failAddDelegate) {
        throw new TenderError("E_STORAGE", "E_STORAGE: not enough storage balance");
      }
      w.delegates.set(publicKey, {
        token,
        per_task_cap: perTask.toString(),
        total_cap: total.toString(),
        spent: "0",
      });
      return tx;
    },
    removeDelegate: async (publicKey: string) => {
      w.log.push(`remove_delegate ${publicKey}`);
      w.delegates.delete(publicKey);
      return tx;
    },
  })) as unknown as ClientFactory;
}

/** The writer of access keys over `w`. */
function fakeWriter(w: World): () => KeyWriter {
  return () => ({
    addFunctionCallKey: async ({ publicKey, contractId, methods, allowance }) => {
      w.log.push(`add_key ${publicKey}`);
      w.added.push({ publicKey, contractId, methods: [...methods], allowance });
      w.keys.set(publicKey, {
        FunctionCall: {
          receiver_id: contractId,
          method_names: [...methods],
          allowance: allowance.toString(),
        },
      });
    },
    deleteKey: async ({ publicKey }) => {
      w.log.push(`delete_key ${publicKey}`);
      if (!w.ignoreDeleteKey) w.keys.delete(publicKey);
    },
  });
}

let dir: string;
let keys: string;
let out: string[];
let err: string[];
let w: World;
let agentKey: string;

beforeEach(async () => {
  // The real path: the key directory is settled (symlinks followed) and `/var` is `/private/var` here.
  dir = await realpath(await mkdtemp(join(tmpdir(), "tender-delegate-")));
  keys = join(dir, "keys");
  out = [];
  err = [];
  w = world();
  // The agent's key, made by `init`, is a full-access key of the account.
  const { publicKey } = await initAgent({
    name: "scout",
    network: "sandbox",
    account: ACCOUNT,
    dir: keys,
    log: () => {},
  });
  agentKey = publicKey;
  w.keys.set(publicKey, "FullAccess");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const log = (line: string) => out.push(line);
const everything = () => [...out, ...err].join("\n");

function options(extra: Partial<DelegateOptions> = {}): DelegateOptions {
  return {
    dir: keys,
    log,
    env: {
      TENDER_NETWORK: "sandbox",
      TENDER_CONTRACT: CONTRACT,
      NEAR_RPC_URL: "http://127.0.0.1:1",
    },
    repoDir: dir,
    clientFor: fakeClients(w),
    keysFor: fakeWriter(w),
    perTask: "2",
    total: "6",
    ...extra,
  };
}

/** The command line, with the same fakes. Returns the exit code. */
const cli = (args: string[], extra: Partial<DelegateOptions> = {}) =>
  main(args, {
    // The caps come from the flags, as they do for a person.
    ...options({ perTask: undefined, total: undefined, ...extra }),
    err: (text) => err.push(text),
  });

const delegateFile = (name = "scout") => join(keys, `${name}.delegate.json`);
const readDelegate = async () => JSON.parse(await readFile(delegateFile(), "utf8"));

/** The private key of the delegate key, and the part of it after the curve's name. */
async function secretsOfDelegate(): Promise<string[]> {
  const { privateKey } = await readDelegate();
  return [privateKey, privateKey.slice("ed25519:".length)];
}

const noSecret = async () => {
  for (const secret of await secretsOfDelegate()) expect(everything()).not.toContain(secret);
  const { privateKey } = JSON.parse(await readFile(join(keys, "scout.json"), "utf8"));
  expect(everything()).not.toContain(privateKey);
  expect(everything()).not.toContain(privateKey.slice("ed25519:".length));
};

// ---- delegate ---------------------------------------------------------------------------------

test("the_method_list_is_exactly_post_top_up_commit_reveal", () => {
  expect([...DELEGATE_METHODS]).toEqual(["post_task", "top_up_task", "commit", "reveal"]);
  // Never the judge's call, money out, or a call that widens a key.
  for (const never of ["pick", "pick_attested", "withdraw", "add_delegate", "register_agent"]) {
    expect(DELEGATE_METHODS).not.toContain(never);
  }
});

test("delegate_adds_a_function_call_key_with_exactly_those_methods_and_a_finite_allowance", async () => {
  const result = await delegateAgentCommand(options());

  expect(w.added).toHaveLength(1);
  const [added] = w.added;
  expect(added?.publicKey).toBe(result.publicKey);
  expect(added?.contractId).toBe(CONTRACT);
  // The list is exact, in the order the constant has it: nothing more, nothing less.
  expect(added?.methods).toEqual(["post_task", "top_up_task", "commit", "reveal"]);
  // Finite: 0.25 NEAR unless told otherwise, and never absent or zero.
  expect(DEFAULT_ALLOWANCE).toBe("0.25");
  expect(added?.allowance).toBe(NEAR / 4n);
  expect(added?.allowance).toBeGreaterThan(0n);
  // What the chain holds is what was sent.
  expect(w.keys.get(result.publicKey)).toEqual({
    FunctionCall: {
      receiver_id: CONTRACT,
      method_names: ["post_task", "top_up_task", "commit", "reveal"],
      allowance: (NEAR / 4n).toString(),
    },
  });
});

test("delegate_registers_the_caps_in_the_tokens_units_after_the_key_is_on_the_account", async () => {
  const result = await delegateAgentCommand(options({ perTask: "2", total: "6.5" }));

  // The key first, then the caps, and nothing else.
  expect(w.log).toEqual([
    `add_key ${result.publicKey}`,
    `add_delegate ${result.publicKey} ${TOKEN} 2000000 6500000`,
  ]);
  expect(w.delegates.get(result.publicKey)).toEqual({
    token: TOKEN,
    per_task_cap: "2000000",
    total_cap: "6500000",
    spent: "0",
  });
  expect(out).toEqual(
    expect.arrayContaining([
      `OK delegate agent scout (${ACCOUNT})`,
      `delegate public key: ${result.publicKey}`,
      "methods: post_task, top_up_task, commit, reveal (never pick, withdraw or add_delegate)",
      "allowance: 0.25 NEAR of gas, finite",
      `caps: 2.00 tUSDC per call, 6.50 tUSDC in all, in ${TOKEN}; spent 0.00 tUSDC`,
    ]),
  );
});

test("delegate_allowance_flag_sets_the_allowance_and_is_always_finite", async () => {
  await delegateAgentCommand(options({ allowance: "1.5" }));
  expect(w.added[0]?.allowance).toBe(NEAR + NEAR / 2n);

  // None of these would be a finite allowance: they are all refused, and nothing is made.
  for (const allowance of [
    "0",
    "0.0",
    "-1",
    "",
    "unlimited",
    "Infinity",
    "1e3",
    "0.0000000000000000000000001",
  ]) {
    const before = w.log.length;
    await expect(
      delegateAgentCommand(options({ allowance, name: "scout" })),
      allowance,
    ).rejects.toThrow(/--allowance/);
    expect(w.log.length, allowance).toBe(before);
  }
});

test("delegate_saves_the_key_in_a_0600_file_in_the_key_directory_and_never_prints_it", async () => {
  const result = await delegateAgentCommand(options());

  expect(result.path).toBe(delegateFile());
  expect((await stat(delegateFile())).mode & 0o777).toBe(0o600);
  expect((await stat(keys)).mode & 0o777).toBe(0o700);
  const file = await readDelegate();
  expect(file).toMatchObject({
    version: 1,
    kind: "delegate",
    name: "scout",
    network: "sandbox",
    account: ACCOUNT,
    contract: CONTRACT,
    publicKey: result.publicKey,
  });
  // The file's key is the one the chain was given.
  expect(publicKeyOf(file.privateKey)).toBe(result.publicKey);
  // It is not the agent's own key.
  expect(result.publicKey).not.toBe(agentKey);

  // The public key is on one line, and no secret is anywhere in what was printed.
  expect(out.filter((line) => line.startsWith("delegate public key: "))).toEqual([
    `delegate public key: ${result.publicKey}`,
  ]);
  await noSecret();
});

test("delegate_never_prints_the_key_when_it_fails_either", async () => {
  w.failAddDelegate = true;
  const code = await cli(["delegate", "--name", "scout", "--per-task", "2", "--total", "6"]);

  expect(code).toBe(1);
  expect(err.join("\n")).toContain("E_STORAGE");
  await noSecret();
});

test("delegate_leaves_the_agents_own_key_and_file_alone", async () => {
  const before = await readFile(join(keys, "scout.json"), "utf8");
  await delegateAgentCommand(options());

  expect(await readFile(join(keys, "scout.json"), "utf8")).toBe(before);
  expect(w.keys.get(agentKey)).toBe("FullAccess");
  expect((await readdir(keys)).sort()).toEqual(["scout.delegate.json", "scout.json"]);
});

test("delegate_without_a_name_picks_the_only_agent_even_with_a_delegate_file_beside_it", async () => {
  // `scout.delegate.json` is not an agent's key file: the only agent is still scout, so a second
  // run needs no --name, and finds the key the first one saved.
  const first = await delegateAgentCommand(options());
  const second = await delegateAgentCommand(options());

  expect(second.publicKey).toBe(first.publicKey);
});

test("delegate_run_again_uses_the_saved_key_and_adds_it_once", async () => {
  const first = await delegateAgentCommand(options({ perTask: "2", total: "6" }));
  const second = await delegateAgentCommand(options({ perTask: "3", total: "9" }));

  expect(second.publicKey).toBe(first.publicKey);
  expect(w.added).toHaveLength(1);
  // The caps are the ones asked for last: that is how they are changed.
  expect(w.delegates.get(first.publicKey)).toMatchObject({
    per_task_cap: "3000000",
    total_cap: "9000000",
  });
  expect(out).toContain(`using the delegate key saved in ${delegateFile()}`);
});

test("delegate_that_stopped_after_the_key_is_finished_by_running_it_again", async () => {
  w.failAddDelegate = true;
  const failure = await delegateAgentCommand(options()).catch((e: unknown) => e);

  // The error says where the account stands and what to do; the code is the contract's.
  expect(failure).toBeInstanceOf(TenderError);
  expect(failure).toMatchObject({ code: "E_STORAGE" });
  expect((failure as Error).message).toMatch(/is on scout\.test\.near already/);
  expect((failure as Error).message).toMatch(/run the same pnpm agent:delegate command again/);
  // The key is saved, and is on the account, with no caps.
  const saved = (await readDelegate()).publicKey as string;
  expect(w.keys.has(saved)).toBe(true);
  expect(w.delegates.size).toBe(0);

  w.failAddDelegate = false;
  const done = await delegateAgentCommand(options());

  // The same key, not added a second time, now with its caps.
  expect(done.publicKey).toBe(saved);
  expect(w.added).toHaveLength(1);
  expect(w.delegates.get(saved)).toBeDefined();
  await noSecret();
});

test("delegate_whose_key_the_chain_did_not_take_says_to_run_it_again_and_then_finishes", async () => {
  const writer = fakeWriter(w);
  let refuse = true;
  const failing = (): KeyWriter => ({
    ...writer(),
    addFunctionCallKey: async (args) => {
      if (refuse) throw new TenderError("E_TIMEOUT", "the node did not answer");
      return writer().addFunctionCallKey(args);
    },
  });

  const failure = await delegateAgentCommand(options({ keysFor: failing })).catch(
    (e: unknown) => e,
  );
  expect(failure).toMatchObject({ code: "E_TIMEOUT" });
  expect((failure as Error).message).toMatch(/saved in .*scout\.delegate\.json/);
  expect((failure as Error).message).toMatch(/run the same pnpm agent:delegate command again/);
  // No caps were set for a key that is not on the account.
  expect(w.delegates.size).toBe(0);

  refuse = false;
  const saved = (await readDelegate()).publicKey as string;
  const done = await delegateAgentCommand(options({ keysFor: failing }));
  expect(done.publicKey).toBe(saved);
  expect(w.delegates.get(saved)).toBeDefined();
  await noSecret();
});

test("delegate_without_a_storage_balance_makes_nothing", async () => {
  w.storage = false;
  const failure = await delegateAgentCommand(options()).catch((e: unknown) => e);

  expect(failure).toMatchObject({ code: "E_STORAGE" });
  expect((failure as Error).message).toMatch(/pnpm agent:register --name scout first/);
  expect(w.log).toEqual([]);
  expect(await readdir(keys)).toEqual(["scout.json"]);
});

test("delegate_with_a_function_call_key_is_refused_before_anything_is_made", async () => {
  // The agent's file holds a key that is not a full-access key: `add_delegate` takes 1 yoctoNEAR.
  w.keys.set(agentKey, {
    FunctionCall: { receiver_id: CONTRACT, method_names: ["commit"], allowance: "1" },
  });

  await expect(delegateAgentCommand(options())).rejects.toMatchObject({ code: "E_AUTH" });
  expect(w.log).toEqual([]);
  expect(await readdir(keys)).toEqual(["scout.json"]);
});

test("delegate_refuses_a_key_on_the_chain_with_another_permission_and_changes_nothing", async () => {
  await delegateAgentCommand(options());
  const saved = (await readDelegate()).publicKey as string;
  const log0 = w.log.length;

  const others: Array<[string, Permission]> = [
    [
      "an extra method",
      {
        FunctionCall: {
          receiver_id: CONTRACT,
          method_names: [...DELEGATE_METHODS, "pick"],
          allowance: "1",
        },
      },
    ],
    [
      "a missing method",
      { FunctionCall: { receiver_id: CONTRACT, method_names: ["commit"], allowance: "1" } },
    ],
    ["every method", { FunctionCall: { receiver_id: CONTRACT, method_names: [], allowance: "1" } }],
    [
      "another contract",
      {
        FunctionCall: {
          receiver_id: "other.test.near",
          method_names: [...DELEGATE_METHODS],
          allowance: "1",
        },
      },
    ],
    [
      "no cap on the allowance",
      {
        FunctionCall: {
          receiver_id: CONTRACT,
          method_names: [...DELEGATE_METHODS],
          allowance: null,
        },
      },
    ],
    ["full access", "FullAccess"],
  ];
  for (const [what, permission] of others) {
    w.keys.set(saved, permission);
    await expect(delegateAgentCommand(options()), what).rejects.toThrow(/delegate key/);
    // Nothing was added, deleted or registered.
    expect(w.log.length, what).toBe(log0);
  }
});

test("delegate_takes_the_methods_in_any_order_when_the_key_is_there_already", async () => {
  const first = await delegateAgentCommand(options());
  w.keys.set(first.publicKey, {
    FunctionCall: {
      receiver_id: CONTRACT,
      method_names: ["reveal", "commit", "top_up_task", "post_task"],
      allowance: "1000",
    },
  });

  await expect(delegateAgentCommand(options())).resolves.toMatchObject({
    publicKey: first.publicKey,
  });
  expect(w.added).toHaveLength(1);
});

test("delegate_refuses_bad_caps_before_anything_is_made", async () => {
  const cases: Array<[Partial<DelegateOptions>, RegExp]> = [
    [{ perTask: undefined }, /--per-task is required/],
    [{ total: undefined }, /--total is required/],
    [{ perTask: "0" }, /--per-task must be more than 0/],
    [{ total: "0" }, /--total must be more than 0/],
    [{ perTask: "-1" }, /--per-task must be a positive number/],
    [{ total: "abc" }, /--total must be a positive number/],
    [{ perTask: "1.1234567" }, /--per-task has more than 6 decimal places/],
    [{ perTask: "7", total: "6" }, /--per-task is more than --total/],
  ];
  for (const [extra, message] of cases) {
    await expect(delegateAgentCommand(options(extra)), JSON.stringify(extra)).rejects.toThrow(
      message,
    );
  }
  expect(w.log).toEqual([]);
  expect(await readdir(keys)).toEqual(["scout.json"]);
});

test("delegate_takes_a_token_tender_takes_and_the_first_one_otherwise", async () => {
  w.tokens = [
    { token: OTHER_TOKEN, enabled: false },
    { token: TOKEN, enabled: true },
  ];
  const result = await delegateAgentCommand(options());
  expect(w.delegates.get(result.publicKey)?.token).toBe(TOKEN);

  await expect(
    delegateAgentCommand(options({ token: OTHER_TOKEN, name: "scout" })),
  ).rejects.toThrow(/is not a token Tender takes now/);
  await expect(
    delegateAgentCommand(options({ token: "nobody.test.near", name: "scout" })),
  ).rejects.toThrow(/is not a token Tender takes now/);
});

test("delegate_refuses_a_delegate_file_that_others_can_read_or_that_is_for_another_account", async () => {
  await delegateAgentCommand(options());
  const log0 = w.log.length;

  await chmod(delegateFile(), 0o644);
  await expect(delegateAgentCommand(options())).rejects.toThrow(/can be read by other users/);
  await chmod(delegateFile(), 0o600);

  const file = await readDelegate();
  await writeFile(delegateFile(), JSON.stringify({ ...file, account: "someone.test.near" }), {
    mode: 0o600,
  });
  await expect(delegateAgentCommand(options())).rejects.toThrow(/is for someone\.test\.near/);

  await writeFile(delegateFile(), "{}", { mode: 0o600 });
  await expect(delegateAgentCommand(options())).rejects.toThrow(/is not a delegate key file/);
  expect(w.log.length).toBe(log0);
});

test("delegate_refuses_a_file_that_names_the_agents_own_key", async () => {
  const own = JSON.parse(await readFile(join(keys, "scout.json"), "utf8"));
  await writeFile(
    delegateFile(),
    JSON.stringify({
      version: 1,
      kind: "delegate",
      name: "scout",
      network: "sandbox",
      account: ACCOUNT,
      contract: CONTRACT,
      publicKey: own.publicKey,
      privateKey: own.privateKey,
    }),
    { mode: 0o600 },
  );

  await expect(delegateAgentCommand(options())).rejects.toThrow(/holds the agent's own/);
  expect(w.log).toEqual([]);
});

// The key directory guard: `agent:delegate` writes a second secret, and it goes where the first
// does, under the same rule.

const REPO = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");

test("delegate_refuses_a_key_directory_inside_the_repository_that_git_does_not_ignore", async () => {
  for (const inside of [
    join(REPO, "keys-here"),
    join(REPO, "scripts"),
    REPO,
    join(REPO, "..keys"),
  ]) {
    await expect(delegateAgentCommand(options({ dir: inside })), inside).rejects.toThrow(
      /git does not say it ignores/,
    );
  }
  expect(w.log).toEqual([]);
  await expect(stat(join(REPO, "keys-here"))).rejects.toThrow();
});

test("delegate_takes_a_key_directory_inside_the_repository_that_git_ignores", async () => {
  // `.tender/` is where the keys go by default, and git ignores everything in it: the agent's file
  // and the delegate file alike.
  const probe = join(REPO, ".tender", `guard-test-delegate-${process.pid}`);
  try {
    await initAgent({
      name: "scout",
      network: "sandbox",
      account: ACCOUNT,
      dir: probe,
      log: () => {},
    });
    const { privateKey } = JSON.parse(await readFile(join(probe, "scout.json"), "utf8"));
    w.keys.set(publicKeyOf(privateKey), "FullAccess");
    const result = await delegateAgentCommand(options({ dir: probe }));
    expect((await stat(join(probe, "scout.delegate.json"))).mode & 0o777).toBe(0o600);
    expect(
      result.path.endsWith(
        join(".tender", `guard-test-delegate-${process.pid}`, "scout.delegate.json"),
      ),
    ).toBe(true);
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
});

test("delegate_on_the_command_line_needs_the_caps_and_says_how", async () => {
  expect(await cli(["delegate", "--name", "scout"])).toBe(1);
  expect(err.join("\n")).toMatch(/--per-task is required/);
  expect(err.join("\n")).toMatch(/pnpm agent:delegate --per-task <amount> --total <amount>/);
  expect(w.log).toEqual([]);

  expect(await cli(["delegate", "--name", "scout", "--per-task", "2", "--total", "6"])).toBe(0);
  expect(w.added).toHaveLength(1);
  expect(await cli(["delegate", "--per-task", "2", "--total", "6", "--allowance", "0.5"])).toBe(0);
  expect(w.keys.size).toBe(2);
});

// ---- undelegate -------------------------------------------------------------------------------

test("undelegate_removes_the_caps_then_the_key_and_then_the_file", async () => {
  const { publicKey } = await delegateAgentCommand(options());
  w.log.length = 0;
  out.length = 0;

  await undelegateAgentCommand(options());

  // The money first (the caps), then the key. Both are gone from the chain.
  expect(w.log).toEqual([`remove_delegate ${publicKey}`, `delete_key ${publicKey}`]);
  expect(w.delegates.has(publicKey)).toBe(false);
  expect(w.keys.has(publicKey)).toBe(false);
  // The agent's own key is untouched, and the dead key's file is gone.
  expect(w.keys.get(agentKey)).toBe("FullAccess");
  expect(await readdir(keys)).toEqual(["scout.json"]);
  expect(out).toEqual(
    expect.arrayContaining([
      `OK undelegate agent scout (${ACCOUNT})`,
      "key: deleted from the account",
    ]),
  );
});

test("undelegate_never_prints_the_key", async () => {
  await delegateAgentCommand(options());
  const secrets = await secretsOfDelegate();
  const { privateKey } = JSON.parse(await readFile(join(keys, "scout.json"), "utf8"));

  expect(await cli(["undelegate", "--name", "scout"])).toBe(0);

  for (const secret of [...secrets, privateKey, privateKey.slice("ed25519:".length)]) {
    expect(everything()).not.toContain(secret);
  }
});

test("a_new_delegate_after_undelegate_is_a_new_key_never_the_dead_one", async () => {
  const first = await delegateAgentCommand(options());
  await undelegateAgentCommand(options());
  const second = await delegateAgentCommand(options());

  expect(second.publicKey).not.toBe(first.publicKey);
  expect(w.added.map((a) => a.publicKey)).toEqual([first.publicKey, second.publicKey]);
});

test("undelegate_finishes_what_stopped_half_way_and_removes_only_what_is_still_there", async () => {
  const { publicKey } = await delegateAgentCommand(options());

  // The caps went and the key did not: only the key is deleted.
  w.delegates.delete(publicKey);
  w.log.length = 0;
  await undelegateAgentCommand(options());
  expect(w.log).toEqual([`delete_key ${publicKey}`]);
  expect(out).toContain("caps: none on the chain already");

  // The key went and the caps did not: only the caps are removed, and the file goes.
  const again = await delegateAgentCommand(options());
  w.keys.delete(again.publicKey);
  w.log.length = 0;
  await undelegateAgentCommand(options());
  expect(w.log).toEqual([`remove_delegate ${again.publicKey}`]);
  expect(await readdir(keys)).toEqual(["scout.json"]);
});

test("undelegate_keeps_the_file_when_the_chain_still_shows_the_key", async () => {
  const { publicKey } = await delegateAgentCommand(options());
  w.ignoreDeleteKey = true;

  await expect(undelegateAgentCommand(options())).rejects.toThrow(
    /still shows the delegate key or its caps/,
  );
  // The file is what lets the next run find the key.
  expect(await readdir(keys)).toContain("scout.delegate.json");
  expect(w.keys.has(publicKey)).toBe(true);

  w.ignoreDeleteKey = false;
  await undelegateAgentCommand(options());
  expect(w.keys.has(publicKey)).toBe(false);
  expect(await readdir(keys)).toEqual(["scout.json"]);
});

test("undelegate_without_a_delegate_key_says_so", async () => {
  await expect(undelegateAgentCommand(options())).rejects.toThrow(/has no delegate key at/);
  expect(w.log).toEqual([]);
});

test("undelegate_never_deletes_a_full_access_key", async () => {
  const own = JSON.parse(await readFile(join(keys, "scout.json"), "utf8"));
  const file = {
    version: 1,
    kind: "delegate",
    name: "scout",
    network: "sandbox",
    account: ACCOUNT,
    contract: CONTRACT,
  };

  // A file that names the key that signs: it would lock the account.
  await writeFile(
    delegateFile(),
    JSON.stringify({ ...file, publicKey: own.publicKey, privateKey: own.privateKey }),
    { mode: 0o600 },
  );
  await expect(undelegateAgentCommand(options())).rejects.toThrow(/holds the agent's own/);

  // A file for another key that is a full-access key of the account too (a second owner key).
  const other = KeyPair.fromRandom("ed25519");
  w.keys.set(other.getPublicKey().toString(), "FullAccess");
  await writeFile(
    delegateFile(),
    JSON.stringify({
      ...file,
      publicKey: other.getPublicKey().toString(),
      privateKey: other.toString(),
    }),
    { mode: 0o600 },
  );
  await expect(undelegateAgentCommand(options())).rejects.toThrow(/is a full-access key/);

  expect(w.log.filter((line) => line.startsWith("delete_key"))).toEqual([]);
  expect(w.keys.get(agentKey)).toBe("FullAccess");
  expect(w.keys.get(other.getPublicKey().toString())).toBe("FullAccess");
});

test("undelegate_with_a_function_call_key_is_refused_before_anything_is_changed", async () => {
  const { publicKey } = await delegateAgentCommand(options());
  w.log.length = 0;
  w.keys.set(agentKey, {
    FunctionCall: { receiver_id: CONTRACT, method_names: ["commit"], allowance: "1" },
  });

  await expect(undelegateAgentCommand(options())).rejects.toMatchObject({ code: "E_AUTH" });
  expect(w.log).toEqual([]);
  expect(w.keys.has(publicKey)).toBe(true);
});

test("undelegate_on_the_command_line", async () => {
  expect(await cli(["undelegate"])).toBe(1);
  expect(err.join("\n")).toMatch(/has no delegate key at/);

  await delegateAgentCommand(options());
  expect(await cli(["undelegate", "--name", "scout"])).toBe(0);
  expect(w.delegates.size).toBe(0);
  expect([...w.keys.keys()]).toEqual([agentKey]);
});

test("delegate_for_an_agent_with_no_key_says_so_and_writes_nothing", async () => {
  await rm(keys, { recursive: true, force: true });
  await mkdir(join(dir, "empty"));

  await expect(delegateAgentCommand(options({ dir: join(dir, "empty") }))).rejects.toThrow(
    /there is no agent key/,
  );
  expect(await readdir(join(dir, "empty"))).toEqual([]);
});
