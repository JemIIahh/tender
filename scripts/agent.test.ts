import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type ConnectApi, TenderError } from "@tender/client";
import {
  type AgentView,
  type ConfigView,
  type ConnectLookup,
  connectFingerprint,
} from "@tender/shared";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  type AgentTarget,
  type ClientFactory,
  type CommandOptions,
  claimBondCommand,
  connectAgentCommand,
  initAgent,
  main,
  registerAgentCommand,
  resolveTarget,
  retireAgentCommand,
} from "./agent";

// The agent commands on a client that is a small world, so that every branch is reached without a
// chain; `agent.sandbox.test.ts` runs the same commands against a real one.

const ACCOUNT = "agent.test.near";
const TOKEN = "usdc.test.near";
const BOND = 1_000_000n;
const CLAIMABLE = "1793745956336648000";
/** 2026-11-04T00:00:00Z in nanoseconds: a later date, as when an open task holds the bond. */
const LOCKED = "1793750400000000000";

const CONFIG: ConfigView = {
  owner: "owner.test.near",
  pending_owner: null,
  treasury: "treasury.test.near",
  fee_bps: 500,
  min_window_secs: 5,
  max_window_secs: 1_209_600,
  paused: false,
  version: 1,
  tokens: [],
  agent_bond_token: TOKEN,
  agent_bond_amount: BOND.toString(),
  agent_bond_cooldown_secs: "3600",
};

function agentView(over: Partial<AgentView> = {}): AgentView {
  return {
    account: ACCOUNT,
    asp: null,
    profile_uri: "tender://agent/scout",
    profile_hash: "ab".repeat(32),
    tags: [],
    registered_at: "1793745950569746000",
    entries: 0,
    reveals: 0,
    wins: 0,
    earned: [],
    picks_made: 0,
    voids_after_reveals: 0,
    status: "active",
    bond_token: TOKEN,
    bond_amount: BOND.toString(),
    claimable_at: null,
    locked_until: null,
    ...over,
  };
}

interface World {
  agent: AgentView | null;
  vault: bigint;
  wallet: bigint;
  storageAvailable: string | null;
  /** Set to make `claim_agent_bond` fail as the contract does before the cooldown is over. */
  claimTooSoon: boolean;
  /** Set to make the key a function-call key, which `requireFullAccessKey` refuses. */
  functionCallKey: boolean;
  /** Set to make an open task hold the bond: `unregister_agent` then shows `locked_until`. */
  lockedUntil?: string;
}

/** A client over the world. `calls` records every call that sends something or moves it. */
function fakeClient() {
  const world: World = {
    agent: null,
    vault: 0n,
    wallet: 5n * BOND,
    storageAvailable: "100000000000000000000000",
    claimTooSoon: false,
    functionCallKey: false,
  };
  const calls: string[] = [];
  const tx = { txHash: "TXHASH", events: [], returnValue: undefined, receipts: [] };
  const client = {
    accountId: ACCOUNT,
    getConfig: async () => CONFIG,
    getAgent: async () => world.agent,
    storageBalanceOf: async () =>
      world.storageAvailable === null
        ? null
        : { total: world.storageAvailable, available: world.storageAvailable, used_bytes: "0" },
    balanceOf: async () => world.vault,
    ftStorageBalanceOf: async () => ({ total: "1", available: "0" }),
    ftBalanceOf: async () => world.wallet,
    requireFullAccessKey: async (method: string) => {
      calls.push(`key ${method}`);
      if (world.functionCallKey) {
        throw new TenderError("E_AUTH", `${method} needs a full-access key. Nothing was sent.`);
      }
    },
    storageDeposit: async (amount: bigint) => {
      calls.push(`storage ${amount}`);
      world.storageAvailable = amount.toString();
    },
    deposit: async (token: string, amount: bigint) => {
      calls.push(`deposit ${amount} ${token}`);
      world.wallet -= amount;
      world.vault += amount;
    },
    registerAgent: async (uri: string, _hash: string, tags: string[]) => {
      calls.push(`register ${uri} ${tags.join("+")}`);
      if (world.agent === null || world.agent.status === "retired") world.vault -= BOND;
      world.agent = agentView({ profile_uri: uri, tags });
      return tx;
    },
    unregisterAgent: async () => {
      calls.push("unregister");
      world.agent =
        world.lockedUntil === undefined
          ? agentView({ status: "unregistering", claimable_at: CLAIMABLE })
          : agentView({
              status: "unregistering",
              claimable_at: world.lockedUntil,
              locked_until: world.lockedUntil,
            });
      return tx;
    },
    claimAgentBond: async () => {
      calls.push("claim");
      if (world.claimTooSoon) throw new TenderError("E_PHASE", "the bond is not claimable yet");
      world.vault += BOND;
      world.agent = agentView({ status: "retired", bond_token: null, bond_amount: null });
      return tx;
    },
  };
  return {
    world,
    calls,
    clientFor: (() => client) as unknown as ClientFactory,
    seen: [] as unknown[],
  };
}

let dir: string;
let keys: string;
let out: string[];
let err: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tender-agent-"));
  keys = join(dir, "keys");
  out = [];
  err = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const log = (line: string) => out.push(line);
const everything = () => [...out, ...err].join("\n");

/** The private key of the agent called `name`, read from its file; only the tests read it. */
async function privateKeyOf(name: string): Promise<string> {
  return JSON.parse(await readFile(join(keys, `${name}.json`), "utf8")).privateKey;
}

/** Options for a command on a sandbox chain at a fake address, with the env of a test. */
function options(extra: Partial<CommandOptions> = {}): CommandOptions {
  return {
    dir: keys,
    log,
    env: {
      TENDER_NETWORK: "sandbox",
      TENDER_CONTRACT: "tender.test.near",
      NEAR_RPC_URL: "http://127.0.0.1:1",
    },
    repoDir: dir,
    now: () => 1_793_745_000_000,
    ...extra,
  };
}

async function init(name = "scout", account?: string) {
  return initAgent({ name, network: "sandbox", dir: keys, log, ...(account && { account }) });
}

// ---- init -------------------------------------------------------------------------------------

test("init_writes_a_0600_key_file_and_prints_the_public_key_on_one_line_and_no_secret", async () => {
  const { path, publicKey } = await init();

  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await stat(keys)).mode & 0o777).toBe(0o700);
  const file = JSON.parse(await readFile(path, "utf8"));
  expect(file).toMatchObject({ version: 1, name: "scout", network: "sandbox", publicKey });
  expect(file.privateKey).toMatch(/^ed25519:/);

  // One line names the public key, and it is the only place it appears.
  expect(out.filter((line) => line.startsWith("public key: "))).toEqual([
    `public key: ${publicKey}`,
  ]);
  const secret = file.privateKey as string;
  expect(everything()).not.toContain(secret);
  expect(everything()).not.toContain(secret.slice("ed25519:".length));
});

test("init_never_replaces_a_key_and_says_so", async () => {
  const { path } = await init();
  const before = await readFile(path, "utf8");

  await expect(init()).rejects.toThrow(/never replaces a key/);
  expect(await readFile(path, "utf8")).toBe(before);
});

test("init_takes_a_name_of_lowercase_letters_digits_and_dashes_only", async () => {
  for (const name of ["", "Scout", "../evil", "a b", "1scout", "x".repeat(33)]) {
    await expect(initAgent({ name, network: "sandbox", dir: keys, log }), name).rejects.toThrow(
      /--name/,
    );
  }
  await expect(init("scout-2")).resolves.toBeDefined();
});

// The key directory guard. A key must never be where a `git add` can reach: a directory inside the
// repository is refused unless git says it ignores the key files in it. Each test names a way that
// a path can look like it is somewhere else, and checks that nothing was made on the way.

const REPO = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const NOT_IGNORED = /git does not say it ignores/;

const swapCase = (text: string) =>
  text.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

async function refused(dirPath: string) {
  await expect(
    initAgent({ name: "scout", network: "sandbox", dir: dirPath, log }),
    dirPath,
  ).rejects.toThrow(NOT_IGNORED);
}

test("init_refuses_a_directory_inside_the_repository_that_git_does_not_ignore", async () => {
  await refused(join(REPO, "keys-here"));
  await refused(join(REPO, "scripts"));
  await refused(REPO);
  // A directory that exists nowhere yet is checked as well, and none is made.
  expect(await exists(join(REPO, "keys-here"))).toBe(false);
  // The relative spelling lands in the same place.
  await refused(join("scripts", "keys-here"));
  expect(await exists(join(REPO, "scripts", "keys-here"))).toBe(false);
});

test("init_refuses_a_name_that_only_starts_with_two_dots_inside_the_repository", async () => {
  // `relative(repo, repo/..keys)` is `..keys`, which starts with two dots and is still inside.
  await refused(join(REPO, "..keys"));
  await refused(join(REPO, "..keys", "agents"));
  await refused(join(REPO, "scripts", "..keys"));
  expect(await exists(join(REPO, "..keys"))).toBe(false);
  expect(await exists(join(REPO, "scripts", "..keys"))).toBe(false);
});

test("init_refuses_the_repository_spelled_in_another_case_on_a_file_system_that_ignores_case", async () => {
  const other = swapCase(REPO);
  // Only a file system that takes the two spellings for one place has this way round the check.
  const same = await Promise.all([stat(REPO), stat(other)]).then(
    ([a, b]) => a.ino === b.ino && a.dev === b.dev,
    () => false,
  );
  if (!same) return;
  await refused(join(other, "keys-here"));
  await refused(join(other, "scripts"));
  await refused(join(other, "..keys"));
  expect(await exists(join(REPO, "keys-here"))).toBe(false);
});

test("init_refuses_a_link_that_leads_into_the_repository", async () => {
  const link = join(dir, "link");
  await symlink(join(REPO, "scripts"), link);
  await refused(join(link, "keys"));
  await refused(link);
  // The link, followed, is inside the repository, and nothing was made in it.
  expect(await exists(join(REPO, "scripts", "keys"))).toBe(false);

  // A link to somewhere outside the repository is no way in, and the key is written there.
  const elsewhere = join(dir, "elsewhere");
  await mkdir(elsewhere);
  await symlink(elsewhere, join(dir, "out"));
  const { path } = await initAgent({
    name: "scout",
    network: "sandbox",
    dir: join(dir, "out", "keys"),
    log,
  });
  expect(await exists(join(elsewhere, "keys", "scout.json"))).toBe(true);
  expect(path).toBe(
    join(
      await import("node:fs/promises").then((fs) => fs.realpath(elsewhere)),
      "keys",
      "scout.json",
    ),
  );
});

test("init_takes_a_directory_inside_the_repository_that_git_ignores", async () => {
  // `.tender/` is ignored, which is where the keys go unless `--dir` says otherwise.
  const ignored = join(REPO, ".tender", `guard-test-${process.pid}`);
  try {
    const { path } = await initAgent({ name: "scout", network: "sandbox", dir: ignored, log });
    expect(path.endsWith(join(".tender", `guard-test-${process.pid}`, "scout.json"))).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(ignored, { recursive: true, force: true });
  }
});

test("init_refuses_a_directory_inside_the_repository_when_git_cannot_be_asked", async () => {
  // No git on the PATH: the answer is no, even for the directory that is ignored.
  const ignored = join(REPO, ".tender", `guard-test-${process.pid}`);
  vi.stubEnv("PATH", dir);
  try {
    await refused(ignored);
    expect(await exists(ignored)).toBe(false);
  } finally {
    vi.unstubAllEnvs();
    // Should the guard ever let it through, the key it made does not stay in the repository.
    await rm(ignored, { recursive: true, force: true });
  }
});

test("a_command_refuses_a_key_directory_inside_the_repository_as_init_does", async () => {
  await expect(
    registerAgentCommand(options({ dir: join(REPO, "..keys"), name: "scout", yes: true })),
  ).rejects.toThrow(NOT_IGNORED);
  await expect(retireAgentCommand(options({ dir: join(REPO, "scripts") }))).rejects.toThrow(
    NOT_IGNORED,
  );
  await expect(claimBondCommand(options({ dir: REPO }))).rejects.toThrow(NOT_IGNORED);
});

test("init_leaves_the_mode_of_a_directory_that_was_there_and_refuses_one_others_can_enter", async () => {
  // A directory of the user's own, which only they can enter: used as it is.
  const mine = join(dir, "mine");
  await mkdir(mine, { mode: 0o700 });
  await initAgent({ name: "scout", network: "sandbox", dir: mine, log });
  expect((await stat(mine)).mode & 0o777).toBe(0o700);

  // One that others can enter (a home directory, say): refused, its mode kept, nothing written.
  const shared = join(dir, "shared");
  await mkdir(shared);
  await chmod(shared, 0o755);
  await expect(initAgent({ name: "scout", network: "sandbox", dir: shared, log })).rejects.toThrow(
    /can be entered by other users/,
  );
  expect((await stat(shared)).mode & 0o777).toBe(0o755);
  expect(await exists(join(shared, "scout.json"))).toBe(false);

  // A directory the command makes is 0700.
  const fresh = join(dir, "fresh", "keys");
  await initAgent({ name: "scout", network: "sandbox", dir: fresh, log });
  expect((await stat(fresh)).mode & 0o777).toBe(0o700);
});

test("init_keeps_the_account_when_it_is_given_and_checks_it", async () => {
  await init("scout", ACCOUNT);
  expect(JSON.parse(await readFile(join(keys, "scout.json"), "utf8")).account).toBe(ACCOUNT);
  await expect(init("other", "NOT AN ACCOUNT")).rejects.toThrow(/account id/);
});

// ---- the key file -----------------------------------------------------------------------------

test("a_key_file_that_others_can_read_is_refused", async () => {
  await init();
  await chmod(join(keys, "scout.json"), 0o644);
  const { clientFor } = fakeClient();

  await expect(registerAgentCommand(options({ clientFor, account: ACCOUNT }))).rejects.toThrow(
    /can be read by other users/,
  );
});

test("a_key_file_whose_private_key_is_not_the_public_keys_is_refused_without_either", async () => {
  const { path } = await init();
  const other = JSON.parse(await readFile(join(keys, "scout.json"), "utf8"));
  const second = await init("second");
  const donor = JSON.parse(await readFile(second.path, "utf8"));
  await writeFile(path, JSON.stringify({ ...other, privateKey: donor.privateKey }), {
    mode: 0o600,
  });
  const { clientFor } = fakeClient();

  const error = await registerAgentCommand(
    options({ clientFor, name: "scout", account: ACCOUNT }),
  ).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/not the one its public key names/);
  expect((error as Error).message).not.toContain(donor.privateKey);
});

test("there_is_no_guessing_which_agent_when_there_are_two_keys", async () => {
  await init("alpha");
  await init("beta");
  const { clientFor } = fakeClient();

  await expect(registerAgentCommand(options({ clientFor, account: ACCOUNT }))).rejects.toThrow(
    /alpha, beta.*--name/s,
  );
  // With one key there is nothing to choose.
  await rm(join(keys, "beta.json"));
  await expect(
    registerAgentCommand(options({ clientFor, account: ACCOUNT, yes: true })),
  ).resolves.toBeDefined();
});

test("a_key_made_for_one_network_is_not_used_on_another", async () => {
  await init();
  const { clientFor } = fakeClient();

  await expect(
    registerAgentCommand(
      options({
        clientFor,
        account: ACCOUNT,
        network: "testnet",
        env: { TENDER_CONTRACT: "tender.test.near" },
      }),
    ),
  ).rejects.toThrow(/made for sandbox/);
});

// ---- where ------------------------------------------------------------------------------------

test("the_target_comes_from_the_flag_then_the_environment_then_the_deploy_record", async () => {
  await mkdir(join(dir, "deployments"), { recursive: true });
  const record = {
    network: "testnet",
    contract: "tender.deployed.testnet",
    tokens: { tusdc: "tusdc.deployed.testnet" },
    accounts: { owner: "owner.testnet" },
    wasmSha256: "ab".repeat(32),
    deployHeight: "1",
    deployedAt: "2026-11-01T00:00:00.000Z",
  };
  await writeFile(join(dir, "deployments", "testnet.json"), JSON.stringify(record));
  await writeFile(join(dir, ".env"), "NEAR_RPC_URL=http://from-dotenv.example\n");

  // The record names the contract; the network's own node is used where nothing says otherwise.
  const target = (env: Record<string, string>, flag?: string): Promise<AgentTarget> =>
    resolveTarget(flag, undefined, { repoDir: dir, env });
  expect(await target({}, "testnet")).toEqual({
    network: "testnet",
    contractId: "tender.deployed.testnet",
    rpcUrl: "http://from-dotenv.example",
  });
  // The process environment beats the file.
  expect(
    await target({ NEAR_RPC_URL: "http://env.example", TENDER_CONTRACT: "tender.env.testnet" }),
  ).toMatchObject({
    network: "testnet",
    contractId: "tender.env.testnet",
    rpcUrl: "http://env.example",
  });
  await expect(target({}, "mainnet")).rejects.toThrow(/no Tender contract for mainnet/);
  await expect(target({}, "nonsense")).rejects.toThrow(/--network/);
  await expect(
    target({ TENDER_NETWORK: "sandbox", TENDER_CONTRACT: "t.near" }, "sandbox"),
  ).resolves.toMatchObject({
    rpcUrl: "http://from-dotenv.example",
  });
});

test("with_no_repo_dir_the_target_is_read_from_the_directory_tender_env_dir_names", async () => {
  await mkdir(join(dir, "deployments"), { recursive: true });
  const record = {
    network: "testnet",
    contract: "tender.named.testnet",
    tokens: { tusdc: "tusdc.named.testnet" },
    accounts: { owner: "owner.testnet" },
    wasmSha256: "ab".repeat(32),
    deployHeight: "1",
    deployedAt: "2026-11-01T00:00:00.000Z",
  };
  await writeFile(join(dir, "deployments", "testnet.json"), JSON.stringify(record));
  await writeFile(join(dir, ".env"), "NEAR_RPC_URL=http://from-named-dir.example\n");

  // The environment that the command is given names the directory: its `.env` and its record are
  // read, and the repository's are not.
  expect(await resolveTarget("testnet", undefined, { env: { TENDER_ENV_DIR: dir } })).toEqual({
    network: "testnet",
    contractId: "tender.named.testnet",
    rpcUrl: "http://from-named-dir.example",
  });
});

// ---- register ---------------------------------------------------------------------------------

test("register_says_what_it_would_move_and_moves_nothing_on_a_no", async () => {
  await init("scout", ACCOUNT);
  const { world, calls, clientFor } = fakeClient();
  const confirm = vi.fn(async () => false);

  await expect(registerAgentCommand(options({ clientFor, confirm }))).rejects.toMatchObject({
    code: "E_FUNDS",
  });

  expect(confirm).toHaveBeenCalledOnce();
  expect(out.join("\n")).toContain(`1000000 ${TOKEN} from its wallet into its Tender vault`);
  expect(world).toMatchObject({ vault: 0n, wallet: 5n * BOND, agent: null });
  expect(calls).toEqual(["key register_agent"]);
});

test("register_without_a_terminal_and_without_yes_is_a_no", async () => {
  await init("scout", ACCOUNT);
  const { world, calls, clientFor } = fakeClient();

  // The default question is the terminal's, and a test run has none.
  await expect(registerAgentCommand(options({ clientFor }))).rejects.toMatchObject({
    code: "E_FUNDS",
  });
  expect(world.vault).toBe(0n);
  expect(calls).toEqual(["key register_agent"]);
});

test("register_with_a_yes_deposits_the_bond_registers_and_prints_the_status", async () => {
  await init("scout", ACCOUNT);
  const { world, calls, clientFor } = fakeClient();
  const confirm = vi.fn(async () => true);

  const agent = await registerAgentCommand(
    options({ clientFor, confirm, tags: "regex, json", description: "finds totals" }),
  );

  expect(confirm).toHaveBeenCalledOnce();
  expect(calls).toEqual([
    "key register_agent",
    `deposit ${BOND} ${TOKEN}`,
    "register tender://agent/scout regex+json",
  ]);
  expect(world.vault).toBe(0n);
  expect(agent.status).toBe("active");
  expect(out).toEqual(
    expect.arrayContaining([
      `OK register ${ACCOUNT} as agent scout`,
      `deposited: ${BOND} ${TOKEN} into the vault`,
      "tx: TXHASH",
      `account: ${ACCOUNT}`,
      "status: active",
      `bond: ${BOND} ${TOKEN}`,
    ]),
  );
});

test("register_with_the_yes_flag_does_not_ask_but_still_says_what_it_moves", async () => {
  await init("scout", ACCOUNT);
  const { world, clientFor } = fakeClient();
  const confirm = vi.fn(async () => false);

  await registerAgentCommand(options({ clientFor, confirm, yes: true }));

  expect(confirm).not.toHaveBeenCalled();
  expect(out.join("\n")).toContain("needs funds in place before it can register");
  expect(world.agent?.status).toBe("active");
});

test("register_asks_nothing_when_the_vault_and_the_storage_already_cover_it", async () => {
  await init("scout", ACCOUNT);
  const { world, calls, clientFor } = fakeClient();
  world.vault = BOND;
  const confirm = vi.fn(async () => false);

  await registerAgentCommand(options({ clientFor, confirm }));

  expect(confirm).not.toHaveBeenCalled();
  expect(calls).toEqual(["key register_agent", "register tender://agent/scout "]);
  expect(world.vault).toBe(0n);
});

test("register_checks_the_profile_before_the_chain_is_asked_anything", async () => {
  await init("scout", ACCOUNT);
  const { calls, clientFor } = fakeClient();

  for (const tags of ["Bad_Tag", "a,b,c,d,e,f,g,h,i"]) {
    await expect(
      registerAgentCommand(options({ clientFor, tags, yes: true })),
      tags,
    ).rejects.toThrow(/profile is not valid/);
  }
  await expect(registerAgentCommand(options({ clientFor, uri: "", yes: true }))).rejects.toThrow(
    /--uri/,
  );
  // Not even the key was looked at: the profile is wrong before the chain comes into it.
  expect(calls).toEqual([]);
});

test("register_with_a_function_call_key_is_refused_before_anything_moves", async () => {
  await init("scout", ACCOUNT);
  const { world, calls, clientFor } = fakeClient();
  world.functionCallKey = true;

  await expect(registerAgentCommand(options({ clientFor, yes: true }))).rejects.toMatchObject({
    code: "E_AUTH",
  });
  expect(calls).toEqual(["key register_agent"]);
  expect(world).toMatchObject({ vault: 0n, wallet: 5n * BOND, agent: null });
});

test("register_writes_the_account_into_the_key_file_once_the_chain_took_it", async () => {
  await init();
  const { clientFor } = fakeClient();

  // A failed registration leaves the file as it was...
  const failing = fakeClient();
  failing.world.functionCallKey = true;
  await expect(
    registerAgentCommand(options({ clientFor: failing.clientFor, account: ACCOUNT, yes: true })),
  ).rejects.toBeDefined();
  expect(JSON.parse(await readFile(join(keys, "scout.json"), "utf8")).account).toBeUndefined();

  // ...and a successful one adds the account, in a file that is still 0600, so that retire and
  // claim need no flag.
  await registerAgentCommand(options({ clientFor, account: ACCOUNT, yes: true }));
  expect(JSON.parse(await readFile(join(keys, "scout.json"), "utf8")).account).toBe(ACCOUNT);
  expect((await stat(join(keys, "scout.json"))).mode & 0o777).toBe(0o600);
});

test("an_account_that_is_not_the_key_files_is_refused", async () => {
  await init("scout", ACCOUNT);
  const { clientFor } = fakeClient();

  await expect(
    registerAgentCommand(options({ clientFor, account: "someone.else.near", yes: true })),
  ).rejects.toThrow(/is for agent.test.near, not someone.else.near/);
});

test("register_without_an_account_asks_for_the_flag", async () => {
  await init();
  const { clientFor } = fakeClient();

  // No terminal here, so it cannot be asked.
  await expect(registerAgentCommand(options({ clientFor, yes: true }))).rejects.toThrow(
    /--account/,
  );
});

// ---- retire and claim -------------------------------------------------------------------------

test("retire_asks_then_starts_the_way_out", async () => {
  await init("scout", ACCOUNT);
  const { world, calls, clientFor } = fakeClient();
  world.agent = agentView();

  const no = vi.fn(async () => false);
  await expect(retireAgentCommand(options({ clientFor, confirm: no }))).rejects.toThrow(
    /not retired/,
  );
  expect(calls).toEqual(["key unregister_agent"]);
  expect(world.agent?.status).toBe("active");

  const agent = await retireAgentCommand(options({ clientFor, yes: true }));
  expect(agent.status).toBe("unregistering");
  expect(calls).toContain("unregister");
  expect(out).toEqual(expect.arrayContaining(["status: unregistering"]));
  expect(out.join("\n")).toMatch(/claimable at: 2026-11-03T22:45:56\.336Z \(in 0h 15m\)/);
});

test("the_status_shows_the_open_task_that_holds_the_bond_when_the_contract_says_so", async () => {
  // `locked_until` is the commit deadline of the latest open task the agent entered, and the bond
  // cannot be claimed before it. A contract that does not send it prints no such line.
  await init("scout", ACCOUNT);
  const free = fakeClient();
  free.world.agent = agentView();
  await retireAgentCommand(options({ clientFor: free.clientFor, yes: true }));
  expect(out.join("\n")).not.toMatch(/held by an open task/);

  out.length = 0;
  const held = fakeClient();
  held.world.agent = agentView();
  held.world.lockedUntil = LOCKED;
  const agent = await retireAgentCommand(options({ clientFor: held.clientFor, yes: true }));
  expect(agent).toMatchObject({
    status: "unregistering",
    claimable_at: LOCKED,
    locked_until: LOCKED,
  });
  expect(out.join("\n")).toMatch(/claimable at: 2026-11-04T00:00:00\.000Z/);
  expect(out.join("\n")).toMatch(/held by an open task until: 2026-11-04T00:00:00\.000Z/);
});

test("retire_has_nothing_to_do_for_an_agent_that_is_not_active", async () => {
  await init("scout", ACCOUNT);
  const { world, calls, clientFor } = fakeClient();

  await expect(retireAgentCommand(options({ clientFor, yes: true }))).rejects.toMatchObject({
    code: "E_NOT_REGISTERED",
  });
  world.agent = agentView({ status: "retired", bond_token: null, bond_amount: null });
  await expect(retireAgentCommand(options({ clientFor, yes: true }))).rejects.toMatchObject({
    code: "E_NOT_REGISTERED",
  });
  world.agent = agentView({ status: "unregistering", claimable_at: CLAIMABLE });
  await expect(retireAgentCommand(options({ clientFor, yes: true }))).rejects.toMatchObject({
    code: "E_PHASE",
  });
  expect(calls).toEqual([]);
});

test("claim_says_when_the_bond_is_claimable_if_it_is_too_soon", async () => {
  await init("scout", ACCOUNT);
  const { world, clientFor } = fakeClient();
  world.agent = agentView({ status: "unregistering", claimable_at: CLAIMABLE });
  world.claimTooSoon = true;

  const error = await claimBondCommand(options({ clientFor })).catch((e: unknown) => e);
  expect(error).toMatchObject({ code: "E_PHASE" });
  expect((error as Error).message).toMatch(/claimable from 2026-11-03T22:45:56\.336Z/);
  expect(world.vault).toBe(0n);
});

test("claim_returns_the_bond_to_the_vault_and_retires_the_agent", async () => {
  await init("scout", ACCOUNT);
  const { world, clientFor } = fakeClient();
  world.agent = agentView({ status: "unregistering", claimable_at: CLAIMABLE });

  const agent = await claimBondCommand(options({ clientFor }));

  expect(agent.status).toBe("retired");
  expect(world.vault).toBe(BOND);
  expect(out).toEqual(
    expect.arrayContaining([
      `returned: ${BOND} ${TOKEN} to its vault (withdraw it from there)`,
      "status: retired",
      "bond: none held",
    ]),
  );
});

test("claim_is_only_for_an_agent_that_is_unregistering", async () => {
  await init("scout", ACCOUNT);
  const { world, calls, clientFor } = fakeClient();

  await expect(claimBondCommand(options({ clientFor }))).rejects.toMatchObject({
    code: "E_NOT_REGISTERED",
  });
  world.agent = agentView();
  await expect(claimBondCommand(options({ clientFor }))).rejects.toMatchObject({ code: "E_PHASE" });
  expect(calls).toEqual([]);
});

test("claim_with_a_function_call_key_is_refused_before_it_is_sent", async () => {
  await init("scout", ACCOUNT);
  const { world, calls, clientFor } = fakeClient();
  world.agent = agentView({ status: "unregistering", claimable_at: CLAIMABLE });
  world.functionCallKey = true;

  await expect(claimBondCommand(options({ clientFor }))).rejects.toMatchObject({ code: "E_AUTH" });
  expect(calls).toEqual(["key claim_agent_bond"]);
});

// ---- the command line -------------------------------------------------------------------------

test("the_command_line_returns_0_after_its_work_and_1_with_the_usage_otherwise", async () => {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const io = { out: outLines, err: errLines };
  const run = (args: string[], extra: Partial<Parameters<typeof main>[1]> = {}) =>
    main(args, { ...options(), log: (l) => io.out.push(l), err: (t) => io.err.push(t), ...extra });

  expect(await run(["init", "--name", "scout", "--network", "sandbox", "--dir", keys])).toBe(0);
  expect(outLines.some((l) => l.startsWith("public key: ed25519:"))).toBe(true);

  expect(await run(["init", "--name", "scout", "--network", "sandbox", "--dir", keys])).toBe(1);
  expect(errLines.join("\n")).toMatch(/agent failed: .*never replaces a key/);

  for (const args of [[], ["frobnicate"], ["init"], ["init", "--name"], ["register", "--wat"]]) {
    errLines.length = 0;
    expect(await run(args), JSON.stringify(args)).toBe(1);
    expect(errLines.join("\n"), JSON.stringify(args)).toContain("usage:");
  }

  // The secret is in none of it.
  const secret = await privateKeyOf("scout");
  expect([...outLines, ...errLines].join("\n")).not.toContain(secret.slice("ed25519:".length));
});

test("a_failure_prints_the_code_and_the_transaction_and_no_key", async () => {
  await init("scout", ACCOUNT);
  const failing = fakeClient();
  failing.world.agent = agentView({ status: "unregistering", claimable_at: CLAIMABLE });
  failing.world.claimTooSoon = true;
  const errLines: string[] = [];

  expect(
    await main(["claim-bond"], {
      ...options({ clientFor: failing.clientFor }),
      err: (t) => errLines.push(t),
    }),
  ).toBe(1);
  expect(errLines.join("\n")).toMatch(/^agent failed with E_PHASE\n/);
  expect(errLines.join("\n")).not.toContain((await privateKeyOf("scout")).slice("ed25519:".length));
});

test("no_command_prints_the_private_key_whatever_happens", async () => {
  await init("scout", ACCOUNT);
  const secret = (await privateKeyOf("scout")).slice("ed25519:".length);
  const ok = fakeClient();
  const bad = fakeClient();
  bad.world.functionCallKey = true;

  await registerAgentCommand(options({ clientFor: ok.clientFor, yes: true }));
  await retireAgentCommand(options({ clientFor: ok.clientFor, yes: true }));
  await claimBondCommand(options({ clientFor: ok.clientFor }));
  for (const run of [
    () => registerAgentCommand(options({ clientFor: bad.clientFor, yes: true })),
    () => retireAgentCommand(options({ clientFor: bad.clientFor, yes: true })),
    () => claimBondCommand(options({ clientFor: bad.clientFor })),
  ]) {
    await run().catch((e: unknown) => err.push(e instanceof Error ? e.message : String(e)));
  }

  expect(everything()).not.toContain(secret);
  expect(everything()).not.toContain("privateKey");
});

test("the_script_run_as_a_process_prints_the_public_key_and_never_the_private_one", async () => {
  // The real command line, through the package script: stdout and stderr of a whole process.
  const run = promisify(execFile);
  const first = await run("pnpm", [
    "-s",
    "agent:init",
    "--name",
    "proc",
    "--network",
    "sandbox",
    "--dir",
    keys,
  ]);
  const secret = await privateKeyOf("proc");
  const seen = `${first.stdout}\n${first.stderr}`;
  expect(seen).toMatch(/^public key: ed25519:[1-9A-HJ-NP-Za-km-z]+$/m);
  expect(seen).not.toContain(secret.slice("ed25519:".length));
  expect((await stat(join(keys, "proc.json"))).mode & 0o777).toBe(0o600);

  // A second run fails, and its output has no key either.
  const second = await run("pnpm", [
    "-s",
    "agent:init",
    "--name",
    "proc",
    "--network",
    "sandbox",
    "--dir",
    keys,
  ]).catch((e: { stdout: string; stderr: string; code: number }) => e);
  expect(second).toMatchObject({ code: 1 });
  expect(
    `${(second as { stdout: string }).stdout}${(second as { stderr: string }).stderr}`,
  ).not.toContain(secret.slice("ed25519:".length));
}, 60_000);

// ---- connect ----------------------------------------------------------------------------------

/** An API for `connect` that knows one code, for `writer.alice.testnet` on the sandbox. */
function connectApi(over: Partial<ConnectLookup> = {}) {
  const asked: string[] = [];
  const lookup: ConnectLookup = {
    owner: "alice.testnet",
    name: "writer",
    account_id: "writer.alice.testnet",
    network: "sandbox",
    contract: "tender.test.near",
    state: "waiting",
    expires_at: "2026-11-04T10:30:00.000Z",
    fingerprint: null,
    ...over,
  };
  const api: ConnectApi = {
    async connectLookup() {
      asked.push("lookup");
      return lookup;
    },
    async connectAttach(_code, publicKey) {
      asked.push(`attach ${publicKey}`);
      return { ...lookup, state: "attached", fingerprint: connectFingerprint(publicKey) };
    },
    async connectRegistered() {
      asked.push("registered");
      return {
        account_id: lookup.account_id,
        state: "registered",
        registered_at: lookup.expires_at,
      };
    },
  };
  return { api, asked };
}

const CONNECT_CODE = "tc_abcdefghijklmnopqrstuvwxyz";

test("connect_takes_the_code_first_and_refuses_what_is_not_one_with_the_usage", async () => {
  const errLines: string[] = [];
  const run = (args: string[]) => main(args, { ...options(), log, err: (t) => errLines.push(t) });
  for (const args of [["connect"], ["connect", "--api", "https://api.example"]]) {
    errLines.length = 0;
    expect(await run(args), JSON.stringify(args)).toBe(1);
    expect(errLines.join("\n")).toMatch(/connect needs the code from the Add an agent page/);
  }
  errLines.length = 0;
  expect(await run(["connect", CONNECT_CODE, "--api", "https://api.example", "--wait", "0"])).toBe(
    1,
  );
  expect(errLines.join("\n")).toMatch(/--wait must be a whole number of minutes/);
  errLines.length = 0;
  expect(await run(["connect", "tc_short", "--api", "https://api.example"])).toBe(1);
  expect(errLines.join("\n")).toMatch(/agent connect stopped: that is not a connect code/);
});

test("connect_sends_the_code_only_over_https_or_to_this_machine", async () => {
  const { api } = connectApi();
  const run = (url: string | undefined) =>
    connectAgentCommand({
      ...options(),
      code: CONNECT_CODE,
      ...(url === undefined ? {} : { api: url }),
      apiFor: () => api,
      waitMs: 0,
    });
  await expect(run("http://api.example")).rejects.toThrow(
    /--api must be https, or http to localhost/,
  );
  await expect(run(undefined)).rejects.toThrow(/--api <url> is needed/);
  await expect(run("https://api.example/v1?x=1")).rejects.toThrow(
    /not the address of a Tender API/,
  );
  // TENDER_API_URL stands in for the flag.
  const outcome = await connectAgentCommand({
    ...options({ env: { ...options().env, TENDER_API_URL: "http://127.0.0.1:9" } }),
    code: CONNECT_CODE,
    apiFor: () => api,
    waitMs: 0,
    chainCheck: async () => "missing",
  });
  expect(outcome.status).toBe("waiting_for_account");
});

test("connect_refuses_a_chain_that_is_not_the_codes_before_a_key_is_made", async () => {
  const { api, asked } = connectApi({ contract: "other.test.near" });
  await expect(
    connectAgentCommand({
      ...options(),
      code: CONNECT_CODE,
      api: "https://api.example",
      apiFor: () => api,
      waitMs: 0,
    }),
  ).rejects.toThrow(
    /serves the contract other\.test\.near on sandbox, and this machine names tender\.test\.near/,
  );
  expect(asked).toEqual(["lookup"]);
  await expect(stat(join(keys, "writer.json"))).rejects.toMatchObject({ code: "ENOENT" });

  const network = connectApi();
  await expect(
    connectAgentCommand({
      ...options(),
      network: "testnet",
      code: CONNECT_CODE,
      api: "https://api.example",
      apiFor: () => network.api,
      waitMs: 0,
    }),
  ).rejects.toThrow(/this code is for sandbox, and --network says testnet/);
  expect(network.asked).toEqual(["lookup"]);
});

test("connect_makes_inits_key_attaches_its_public_half_and_uses_it_again_on_the_next_run", async () => {
  const { api, asked } = connectApi();
  const run = () =>
    connectAgentCommand({
      ...options(),
      code: CONNECT_CODE,
      api: "https://api.example",
      apiFor: () => api,
      waitMs: 0,
      chainCheck: async () => "missing",
    });
  const first = await run();
  expect(first.status).toBe("waiting_for_account");
  const file = JSON.parse(await readFile(join(keys, "writer.json"), "utf8"));
  expect(file).toMatchObject({
    version: 1,
    name: "writer",
    network: "sandbox",
    account: "writer.alice.testnet",
  });
  expect((await stat(join(keys, "writer.json"))).mode & 0o777).toBe(0o600);
  expect(asked).toEqual(["lookup", `attach ${file.publicKey}`]);
  expect(out).toContain(`public key: ${file.publicKey}`);
  expect(out).toContain(`fingerprint: ${connectFingerprint(file.publicKey)}`);

  // The second run uses the same key: nothing is made again.
  out.length = 0;
  await run();
  expect(out).toContain(`key: using ${join(await realpath(keys), "writer.json")}`);
  expect(asked.filter((line) => line.startsWith("attach"))).toEqual([
    `attach ${file.publicKey}`,
    `attach ${file.publicKey}`,
  ]);
  expect(everything()).not.toContain(file.privateKey.slice("ed25519:".length));

  // A key file of the same name for another account is not taken.
  await rm(join(keys, "writer.json"));
  await init("writer", "someone.test.near");
  await expect(run()).rejects.toThrow(
    /is for someone\.test\.near, not writer\.alice\.testnet: pass another --name/,
  );
});

test("the_command_line_of_connect_exits_2_when_it_stopped_to_wait", async () => {
  const { api } = connectApi();
  // A clock that moves only when the command sleeps: the minute of `--wait 1` passes at once.
  let clock = 0;
  const code = await main(
    ["connect", CONNECT_CODE, "--api", "https://api.example", "--wait", "1"],
    {
      ...options(),
      log,
      err: (t) => err.push(t),
      connect: {
        apiFor: () => api,
        chainCheck: async () => "missing",
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    },
  );
  expect(code).toBe(2);
  expect(out.at(-1)).toMatch(/stopped waiting: .*Run the same command again to go on\./);
});
