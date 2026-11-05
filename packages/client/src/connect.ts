import {
  ApiError,
  CONNECT_CODE_PATTERN,
  type ConnectAccountKind,
  type ConnectLookup,
  type ConnectRegistered,
  connectFingerprint,
  formatTokenAmount,
  implicitAccountOf,
  tokenMeta,
} from "@tender/shared";
import { JsonRpcProvider } from "near-api-js";
import { AccessKeyDoesNotExistError, AccountDoesNotExistError } from "near-api-js/rpc-errors";
import type { RegistrationPlan } from "./bond";
import { AGENT_NAME } from "./keyfile";

// The agent's side of "Connect your agent" (`@tender/shared`'s `connect.ts` has the whole flow):
// `pnpm agent:connect <code>` (scripts/agent.ts) and the MCP server's `connect_to_tender` both run
// `connectAgent`, each with its own way to keep the key and to register, so that the two say the
// same things in the same order.
//
//   1. look the code up: the account it is for, on which network and contract;
//   2. the agent's key for that account: the one its key file holds, or a new one made now (the
//      caller's `key`, which never shows the private half);
//   3. attach the PUBLIC key to the code, and print its fingerprint, which the owner's page shows
//      too, for the owner to match before pressing Create agent;
//   4. wait for the account to exist with this key as a full-access key: `<name>.<owner>`, or, if
//      the owner chose it on the page (the API's `account_kind` is `implicit`), the agent's own
//      implicit account, which the agent works out from its key and never takes from the API. While
//      it waits it asks the API now and then which one the owner chose;
//   5. wait for the bond to be in the agent's vault (the owner's batch pays it there);
//   6. register (the caller's `register`, with the agent's own key), and tell the API.
//
// Every wait has an end (`waitMs`). One that ends before the step is done returns where it stopped,
// and running the same thing again with the same code goes on from there: the key file is used
// again, and attaching the same key twice is answered as the first time.

/** What the agent asks the API: the four routes that the code alone opens. */
export interface ConnectApi {
  connectLookup(code: string): Promise<ConnectLookup>;
  connectAttach(code: string, publicKey: string): Promise<ConnectLookup>;
  /** Says the key attached to the code is not this agent's, so that the owner's page refuses it. */
  connectContest(code: string): Promise<ConnectLookup>;
  connectRegistered(code: string): Promise<ConnectRegistered>;
}

/** What the chain says of an account and a key. */
export type ConnectKeyState = "missing" | "other-keys" | "has-key";

/** What the agent reads of the chain while it waits. */
export interface ConnectChain {
  /** Whether `accountId` exists, and has `publicKey` as a full-access key. */
  keyState(accountId: string, publicKey: string): Promise<ConnectKeyState>;
  /** What registering `accountId` takes now (`planRegistration`). */
  plan(accountId: string): Promise<RegistrationPlan>;
  /** The full-access keys of `accountId` (`view_access_key_list`), as `ed25519:<base58>`. */
  fullAccessKeys(accountId: string): Promise<string[]>;
  /** Whether `accountId` exists (`view_account`). */
  accountExists(accountId: string): Promise<boolean>;
}

/** The agent's key, as the caller keeps it: its PUBLIC half and where the file is. */
export interface ConnectKey {
  publicKey: string;
  path: string;
  /** Whether it was made now, and not read from a file made before. */
  made: boolean;
}

export interface ConnectAgentOptions {
  code: string;
  /** The agent's name, for its key file and profile. Default: the name the code was made for. */
  name?: string;
  api: ConnectApi;
  /**
   * The chain the code's lookup names, made once the lookup has said which, and before any key is
   * made: a caller whose settings name another network or contract throws here.
   */
  chainFor(lookup: ConnectLookup): ConnectChain;
  /**
   * The key of agent `name` for the account the code was made for, `<lookup.name>.<lookup.owner>`
   * (`agentKeyFor`): read from its file, or made now if `mayMake`. A file moved already to the
   * implicit account the code's record names counts too, when the record says the owner chose it.
   * Null when there is no file and it may not make one: a code that has a key attached already can
   * only be this agent's if its key is on this machine.
   */
  key(lookup: ConnectLookup, name: string, mayMake: boolean): Promise<ConnectKey | null>;
  /**
   * Moves agent `name`'s key file from `<lookup.name>.<lookup.owner>` to the implicit account the
   * code's record names (`lookup.account_id`), once the record says the owner chose it
   * (`moveAgentKeyToImplicit`): only a file that names that sub-account, only to its own key's
   * implicit account, and only when `exists` says the sub-account is not on the chain. It throws
   * otherwise, and the file is left as it was.
   */
  moveKey(
    lookup: ConnectLookup,
    name: string,
    exists: (accountId: string) => Promise<boolean>,
  ): Promise<ConnectKey>;
  /** Registers the agent with its own key, once its vault holds the bond. */
  register(lookup: ConnectLookup, name: string, key: ConnectKey): Promise<void>;
  log: (line: string) => void;
  /** How long to wait for the owner, and then for the bond, before stopping where it is. */
  waitMs: number;
  /** How often to look while waiting. Default: 3 s. */
  pollMs?: number;
  /** How often, at most, to ask the API which account the owner chose, while waiting for it. Default: 20 s. */
  lookupMs?: number;
  /** How long to keep asking the API to take the agent's word, once registered. Default: 60 s. */
  confirmMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Where `connectAgent` stopped. */
export interface ConnectOutcome {
  status: "registered" | "waiting_for_account" | "waiting_for_bond";
  accountId: string;
  /** Whether the account is `<name>.<owner>`, or the implicit account of the agent's key. */
  accountKind: ConnectAccountKind;
  /** The agent's name: its key file's. */
  name: string;
  owner: string;
  fingerprint: string;
  keyPath: string;
  /** Whether the API took the agent's word that it registered (null while it has not registered). */
  confirmed: boolean | null;
}

/** A failure the person can act on, in words of ours: no text a server chose is in it. */
export class ConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectError";
  }
}

/** The code of an `ApiError`'s body, if it has one: what the API's refusal is, to branch on. */
function apiCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body as { error?: unknown } | null | undefined;
  return typeof body?.error === "string" ? body.error : null;
}

/** What a refusal of the API means for the agent, in words of ours. Anything else is thrown as it is. */
function explain(error: unknown): never {
  switch (apiCode(error)) {
    case "not_found":
      throw new ConnectError(
        "the API knows no such connect code (it was mistyped, or is more than a day old): ask the " +
          "owner for a new code on the Add an agent page",
      );
    case "code_expired":
      throw new ConnectError(
        "this connect code took no key in its 30 minutes and has expired: ask the owner for a new " +
          "code on the Add an agent page",
      );
    case "already_attached":
      throw new ConnectError(
        "this connect code has another key attached already, which is not this agent's: someone " +
          "else has the code. Its page now says two different keys tried it and refuses to create " +
          "the account. Tell the owner NOT to press Create agent, and to start over with a new code",
      );
    case "contested":
      throw new ConnectError(
        "two different keys tried this connect code, so someone else has it and the owner's page " +
          "refuses it: tell the owner to start over with a new code",
      );
    case "rate_limited":
      throw new ConnectError("the API has had too many requests from here: try again in a minute");
    case "bad_request":
      throw new ConnectError("the API did not take the code or the key: copy the command again");
    default:
      throw error;
  }
}

/**
 * The agent's name, which names its key file: `wanted` (`--name`, or the MCP tool's `name`), else
 * the name the code was made for if it can name a key file. Nothing else names one: an existing key
 * file is used again only under one of these two names, and never under one made from an account id.
 */
function nameFor(lookup: ConnectLookup, wanted: string | undefined): string {
  const name = wanted ?? lookup.name;
  if (!AGENT_NAME.test(name)) {
    throw new ConnectError(
      wanted === undefined
        ? `the account name ${lookup.name} cannot name a key file (lower-case letters, digits and ` +
            "dashes, starting with a letter, 32 at most): pass --name <name> for the agent"
        : "--name must be lowercase letters, digits and dashes, starting with a letter, 32 at most",
    );
  }
  return name;
}

/**
 * The chain's `keyState` through an RPC node: a view of the key, and of the account when the key is
 * not there, at the last final block.
 */
export function rpcKeyState(rpcUrl: string): ConnectChain["keyState"] {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  return async (accountId, publicKey) => {
    try {
      const { permission } = await provider.viewAccessKey({
        accountId,
        publicKey,
        finalityQuery: { finality: "final" },
      });
      return permission === "FullAccess" ? "has-key" : "other-keys";
    } catch (error) {
      if (error instanceof AccountDoesNotExistError) return "missing";
      if (!(error instanceof AccessKeyDoesNotExistError)) throw error;
    }
    // A node answers a key of an account that does not exist as a key that does not: the account
    // is asked about on its own.
    try {
      await provider.viewAccount({ accountId, blockQuery: { finality: "final" } });
      return "other-keys";
    } catch (error) {
      if (error instanceof AccountDoesNotExistError) return "missing";
      throw error;
    }
  };
}

/**
 * The chain's `accountExists` through an RPC node (`view_account`), at the newest block
 * (`optimistic`), not the last final one: a "no" lets the key file move off `<name>.<owner>`, so it
 * is read where an account made a block or two ago is already seen. A block that is later dropped
 * can only make the answer "yes" wrongly, which refuses the move: the safe way to be wrong.
 */
export function rpcAccountExists(rpcUrl: string): ConnectChain["accountExists"] {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  return async (accountId) => {
    try {
      await provider.viewAccount({ accountId, blockQuery: { finality: "optimistic" } });
      return true;
    } catch (error) {
      if (error instanceof AccountDoesNotExistError) return false;
      throw error;
    }
  };
}

/** The chain's `fullAccessKeys` through an RPC node (`view_access_key_list`), at the last final block. */
export function rpcFullAccessKeys(rpcUrl: string): ConnectChain["fullAccessKeys"] {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  return async (accountId) => {
    const list = await provider.viewAccessKeyList({
      accountId,
      finalityQuery: { finality: "final" },
    });
    return list.keys
      .filter((entry) => entry.access_key.permission === "FullAccess")
      .map((entry) => String(entry.public_key));
  };
}

/** A span of milliseconds in words: `29m`, `45s`. */
function span(ms: number): string {
  return ms >= 60_000 ? `${Math.ceil(ms / 60_000)}m` : `${Math.max(1, Math.ceil(ms / 1000))}s`;
}

/**
 * Where the owner finds Fund agent, for an agent that waits on its bond: on the owner's Add an agent
 * page, which shows it for the code it made, and for an account typed in step 1 ("Finish an agent
 * you started"), after a reload or in another browser. An implicit account is not `<name>.<owner>`,
 * so only the page that made the code (in its browser tab) finishes it.
 */
export const FUND_AGENT_WHERE = (
  owner: string,
  name: string,
  kind: ConnectAccountKind = "sub_account",
): string =>
  kind === "implicit"
    ? `${owner} presses Fund agent in step 4 of the Add an agent page of the web app, in the ` +
      "browser tab that made the code."
    : `${owner} presses Fund agent on the Add an agent page of the web app: in step 4 if the page ` +
      `that made the code is still open, or else after typing ${name} in step 1 and pressing ` +
      "Finish this agent.";

/** What the agent says once the owner chose its implicit account. */
export const IMPLICIT_ACCOUNT_WORDS = (owner: string, account: string): string =>
  `${owner} chose a separate account for this agent: ${account}, the implicit account of its ` +
  `key. It is its own account, so Tender's directory won't list it under ${owner} as its provider.`;

/**
 * How often, at most, the agent asks the API which account the owner chose while it waits for one,
 * unless told otherwise: every 20 s, within the API's limit of 60 requests per client in 10 minutes.
 */
const LOOKUP_EVERY_MS = 20_000;

/** What the agent says of a contested code whose first key was its own. */
export const CONTESTED_AFTER_YOURS =
  "Another key tried this code after your agent's. To be safe, start over with a new code.";

/** How often a wait says it is still waiting. */
const HEARTBEAT_MS = 30_000;

/**
 * Connects the agent: see the top of this file. Logs one plain line for each step and nothing
 * secret: the public key, its fingerprint and where the key file is. Throws a `ConnectError` with
 * what to do for a refusal it understands; returns where it stopped otherwise.
 */
export async function connectAgent(opts: ConnectAgentOptions): Promise<ConnectOutcome> {
  const { api, log } = opts;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? 3_000;
  const lookupMs = opts.lookupMs ?? LOOKUP_EVERY_MS;
  const code = opts.code.trim();
  if (!CONNECT_CODE_PATTERN.test(code)) {
    throw new ConnectError(
      "that is not a connect code: it starts with tc_ and has 26 letters and digits after it. Copy " +
        "it again from the Add an agent page",
    );
  }

  const lookup = await api.connectLookup(code).catch(explain);
  if (lookup.state === "expired") explain(new ApiError(410, { error: "code_expired" }));
  // The account is the name under the owner, as the owner asked for it, or, once the code's record
  // says the owner chose it, the implicit account of the key attached, which is checked once the key
  // is read. An answer that says otherwise is not one to act on.
  const subAccount = `${lookup.name}.${lookup.owner}`;
  const doesNotAddUp = () =>
    new ConnectError(
      "the API's answer does not add up (its account is not the name under the owner, nor the " +
        "implicit account of this agent's key): nothing was made or sent. Ask the owner for a new " +
        "code",
    );
  if (lookup.account_kind === "sub_account" && lookup.account_id !== subAccount) {
    throw doesNotAddUp();
  }
  log(`connect code for ${lookup.account_id}, made by ${lookup.owner}, on ${lookup.network}`);
  // Before a key is made or attached: a chain that is not the code's is refused here.
  const chain = opts.chainFor(lookup);

  const name = nameFor(lookup, opts.name);
  // A contested code is refused, and never created. Its words say whether this agent's key was the
  // first, when the key file says so; no key is made to find out.
  if (lookup.state === "contested") {
    const own = await opts.key(lookup, name, false).catch(() => null);
    if (own !== null && lookup.fingerprint === connectFingerprint(own.publicKey)) {
      throw new ConnectError(CONTESTED_AFTER_YOURS);
    }
    explain(new ApiError(409, { error: "contested" }));
  }
  // A code that has a key already, and not this one, is someone else's: the API is told (so the
  // owner's page refuses the code), and nothing is attached, and no key is made for nothing. What
  // the agent says depends on whether the API took the word.
  const key = await opts.key(lookup, name, lookup.fingerprint === null);
  if (
    key === null ||
    (lookup.fingerprint !== null && lookup.fingerprint !== connectFingerprint(key.publicKey))
  ) {
    const recorded = await api.connectContest(code).then(
      () => true,
      () => false,
    );
    if (!recorded) {
      throw new ConnectError(
        "Tell the owner NOT to press Create agent: someone else's key is on this code (this " +
          "agent could not record it on the page).",
      );
    }
    explain(new ApiError(409, { error: "already_attached" }));
  }
  /**
   * Whether an answer adds up for this agent's key: its owner is the code's, and its account is the
   * sub-account, or, only when the record says the owner chose it, the implicit account of this
   * agent's own key. It throws otherwise.
   */
  const check = (answer: ConnectLookup): void => {
    const expected =
      answer.account_kind === "implicit" ? implicitAccountOf(key.publicKey) : subAccount;
    if (expected === null || answer.account_id !== expected || answer.owner !== lookup.owner) {
      throw doesNotAddUp();
    }
  };
  /**
   * The account an answer names, once it adds up. For the implicit account, the key file is moved
   * to it first (`moveKey`), which the chain must allow: the sub-account must not exist.
   */
  const accountOf = async (answer: ConnectLookup): Promise<string> => {
    check(answer);
    if (answer.account_kind === "sub_account") return subAccount;
    const moved = await opts.moveKey(answer, name, (id) => chain.accountExists(id));
    if (moved.publicKey !== key.publicKey) throw doesNotAddUp();
    return answer.account_id;
  };
  check(lookup);
  const fingerprint = connectFingerprint(key.publicKey);
  log(
    key.made
      ? `key: made ${key.path} (mode 600; the private key is in it and is never printed)`
      : `key: using ${key.path}`,
  );
  log(`public key: ${key.publicKey}`);
  // The latest answer: which account the owner chose, as of now.
  let current = await api.connectAttach(code, key.publicKey).catch(explain);
  let account = await accountOf(current);
  log(`fingerprint: ${fingerprint}`);
  if (current.account_kind === "implicit") {
    log(IMPLICIT_ACCOUNT_WORDS(lookup.owner, account));
  } else {
    log(
      `attached. On the page of ${lookup.owner}, check that the fingerprint is ${fingerprint}, then ` +
        "press Create agent.",
    );
  }

  const outcome = (status: ConnectOutcome["status"], confirmed: boolean | null = null) => ({
    status,
    accountId: account,
    accountKind: current.account_kind,
    name,
    owner: lookup.owner,
    fingerprint,
    keyPath: key.path,
    confirmed,
  });

  /** Looks every `pollMs` until `ready` says so, or `waitMs` is out. */
  const waitFor = async (
    what: string,
    ready: () => Promise<boolean>,
    giveUpAt: number,
  ): Promise<boolean> => {
    let said = now();
    for (;;) {
      if (await ready()) return true;
      const left = giveUpAt - now();
      if (left <= 0) return false;
      if (now() - said >= HEARTBEAT_MS) {
        log(`still waiting for ${what} (${span(left)} more, then this stops)`);
        said = now();
      }
      await sleep(Math.min(pollMs, left));
    }
  };

  /**
   * Asks the API which account the owner chose, at most every `lookupMs`: a code moved to the
   * implicit account of this agent's key moves the wait there, and the key file with it
   * (`accountOf`). A code contested meanwhile stops the agent. An API that can't be reached now is
   * asked again later: the chain is what the wait goes by.
   */
  let askedAt = now();
  const askWhichAccount = async (): Promise<void> => {
    if (current.account_kind === "implicit" || now() - askedAt < lookupMs) return;
    askedAt = now();
    const answer = await api.connectLookup(code).catch((error: unknown) => {
      if (apiCode(error) === null || apiCode(error) === "rate_limited") return null;
      return explain(error);
    });
    if (answer === null) return;
    if (answer.state === "contested") explain(new ApiError(409, { error: "contested" }));
    // The key attached never changes: an answer with another one is not one to act on.
    if (answer.fingerprint !== fingerprint) throw doesNotAddUp();
    if (answer.account_kind !== "implicit") return;
    account = await accountOf(answer);
    current = answer;
    log(IMPLICIT_ACCOUNT_WORDS(lookup.owner, account));
    log(`waiting for ${lookup.owner} to send ${account} its NEAR…`);
  };

  const giveUpAt = now() + opts.waitMs;
  log(
    current.account_kind === "implicit"
      ? `waiting for ${lookup.owner} to send ${account} its NEAR…`
      : `waiting for ${lookup.owner} to create ${account}…`,
  );
  const created = await waitFor(
    `${lookup.owner} to create the account`,
    async () => {
      await askWhichAccount();
      const state = await chain.keyState(account, key.publicKey);
      if (state === "other-keys") {
        // The account exists and this key is not on it yet. The setup code adds it in a receipt of
        // its own, a block after the account is made: an account with no full-access key yet is
        // still being set up.
        if ((await chain.fullAccessKeys(account)).length === 0) return false;
        throw new ConnectError(
          `${account} exists, and not with this agent's key as a full-access key: it was made ` +
            "another way. Ask the owner for a new code with another name",
        );
      }
      return state === "has-key";
    },
    giveUpAt,
  );
  if (!created) {
    log(`stopped waiting: ${account} does not exist yet. Run the same command again to go on.`);
    return outcome("waiting_for_account");
  }
  log(`created: ${account} exists, with this key as its full-access key`);

  // The bond: in the vault (the owner's batch puts it there), or held already by a registration.
  let plan = await chain.plan(account);
  // An active agent that holds its bond pays none: it registered on an earlier run.
  if (!(plan.agent?.status === "active" && !plan.takesBond)) {
    const bondIn = () => !plan.takesBond || plan.terms === null || plan.shortfall === 0n;
    if (!bondIn() && plan.terms !== null) {
      const { symbol, decimals } = tokenMeta(plan.terms.token, lookup.network);
      log(
        `waiting for the bond: ${formatTokenAmount(plan.terms.amount, decimals)} ${symbol} into ` +
          `the agent's vault (it holds ${formatTokenAmount(plan.vault, decimals)} ${symbol})…`,
      );
    }
    const funded =
      bondIn() ||
      (await waitFor(
        "the bond",
        async () => {
          plan = await chain.plan(account);
          return bondIn();
        },
        Math.max(giveUpAt, now() + pollMs),
      ));
    if (!funded) {
      log(
        `stopped waiting: the bond is not in the agent's vault yet. ${FUND_AGENT_WHERE(lookup.owner, lookup.name, current.account_kind)} ` +
          "Then run the same command again.",
      );
      return outcome("waiting_for_bond");
    }
    log("funded: the bond is in the agent's vault");
    // The account must be this agent's alone before it locks a bond in its name: its one full-access
    // key is the agent's own.
    const keys = await chain.fullAccessKeys(account);
    if (keys.length !== 1 || keys[0] !== key.publicKey) {
      throw new ConnectError(
        `${account} has ${keys.length === 1 ? "another" : `${keys.length}`} full-access ` +
          `${keys.length === 1 ? "key" : "keys"} besides or instead of this agent's, so it is not ` +
          "the agent's alone: nothing was registered. Ask the owner",
      );
    }
    await opts.register(current, name, key);
    log(`registered: ${account} is an agent`);
  } else {
    log(`registered: ${account} is an agent already`);
  }

  // The API takes the agent's word once its index shows it, a few blocks after the chain does.
  const confirmUntil = now() + (opts.confirmMs ?? 60_000);
  for (;;) {
    try {
      await api.connectRegistered(code);
      log(`done: ${account} is an active agent, and the page of ${lookup.owner} says so`);
      return outcome("registered", true);
    } catch (error) {
      // The chain has the registration whatever the API says, so nothing here fails the command.
      if (apiCode(error) === "contested") {
        log(
          `done: ${account} is registered on the chain with this agent's key. Another key tried ` +
            "this code after your agent's, so the owner's page shows the code as refused; the " +
            "agent is registered all the same.",
        );
        return outcome("registered", false);
      }
      if (apiCode(error) !== "not_registered" || now() >= confirmUntil) {
        log(
          `done: ${account} is registered on the chain. The API has not listed it yet; the page ` +
            "ticks Registered once it does.",
        );
        return outcome("registered", false);
      }
      await sleep(Math.min(2_000, Math.max(1, confirmUntil - now())));
    }
  }
}
