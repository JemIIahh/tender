import {
  type AgentView,
  type ConfigView,
  canonicalJson,
  sha256Hex,
  storageShortfall,
} from "@tender/shared";
import type { TenderClient, TxResult } from "./client";
import { TenderError } from "./errors";

// Registering an agent costs a refundable bond (contract Task 16b): the owner sets a token and an
// amount, and `register_agent` takes it out of the agent's vault. So an agent that has not got the
// bond in its vault cannot register, and getting it there takes steps of its own: NEAR for the
// storage of the account, then the token from the wallet into the vault. This module is those
// steps in one place, for the command line (`pnpm agent:register`), the scripts, the demos and the
// tests, so that none of them has its own idea of what registering takes.

/** The bond a contract takes at registration, as its `get_config` says. */
export interface BondTerms {
  /** The token the bond is in. */
  token: string;
  /** The amount, in the token's smallest unit. */
  amount: bigint;
  /** How long an agent waits from `unregister_agent` until it can claim the bond, in seconds. */
  cooldownSecs: bigint;
}

/**
 * The bond in a config view, or null while the owner has set none: registering then takes
 * nothing. The cooldown is always in the view, so it is read whether or not there is a bond.
 */
export function bondTermsOf(config: ConfigView): BondTerms | null {
  if (config.agent_bond_token === null || config.agent_bond_amount === null) return null;
  return {
    token: config.agent_bond_token,
    amount: BigInt(config.agent_bond_amount),
    cooldownSecs: BigInt(config.agent_bond_cooldown_secs),
  };
}

/** What registering an account would take right now, and what it lacks for it. */
export interface RegistrationPlan {
  account: string;
  /** The account's agent record on the chain, if it has one. */
  agent: AgentView | null;
  /** The bond in force, or null if the owner has set none. */
  terms: BondTerms | null;
  /**
   * Whether this registration pays the bond: a new agent does, and a retired one coming back. An
   * active agent updating its profile pays nothing. An unregistering one is refused (it claims its
   * bond first), which `registerWithBond` says before it moves anything.
   */
  takesBond: boolean;
  /** What the account's vault holds of the bond token (0 when there is no bond). */
  vault: bigint;
  /** What the vault lacks of the bond, in the token's smallest unit: 0 when it has enough. */
  shortfall: bigint;
  /** What the account holds of the bond token itself, outside Tender; null when not read. */
  wallet: bigint | null;
  /** The yoctoNEAR the account's storage balance with Tender lacks to register: 0 if none. */
  storageShortfall: bigint;
}

/**
 * Reads the chain for what registering `account` takes: its agent record, the bond in force, its
 * vault, its wallet if the vault is short, and its storage balance. It sends nothing.
 */
export async function planRegistration(
  client: TenderClient,
  account: string | undefined = client.accountId,
): Promise<RegistrationPlan> {
  if (account === undefined) throw new Error("planRegistration needs an account");
  const [config, agent, storage] = await Promise.all([
    client.getConfig(),
    client.getAgent(account),
    client.storageBalanceOf(account),
  ]);
  const terms = bondTermsOf(config);
  const takesBond = terms !== null && (agent === null || agent.status === "retired");
  let vault = 0n;
  let shortfall = 0n;
  let wallet: bigint | null = null;
  if (terms !== null) {
    vault = await client.balanceOf(account, terms.token);
    if (takesBond && vault < terms.amount) {
      shortfall = terms.amount - vault;
      wallet = await walletBalance(client, terms.token, account);
    }
  }
  return {
    account,
    agent,
    terms,
    takesBond,
    vault,
    shortfall,
    wallet,
    storageShortfall: storageShortfall(storage),
  };
}

/** What `account` holds of `token` outside Tender: 0 when the token has never registered it. */
async function walletBalance(client: TenderClient, token: string, account: string) {
  return (await client.ftStorageBalanceOf(token, account)) === null
    ? 0n
    : await client.ftBalanceOf(token, account);
}

/** The profile an agent registers: where its document is, the SHA-256 of it, and its tags. */
export interface AgentProfile {
  uri: string;
  /** 64 lowercase hex characters. */
  hash: string;
  tags: readonly string[];
}

/**
 * A profile for an agent that has no published document: the profile of `name` as the registry
 * pins one (`ProfileSchema`), a URI that names the agent, and the SHA-256 of the document's
 * canonical bytes. Nothing is uploaded, so the index shows the agent with no name until a document
 * with that hash is stored (the MCP server's `register_agent` uploads one).
 */
export function scriptedProfile(
  name: string,
  tags: readonly string[] = [],
  description = "",
): AgentProfile & { document: { name: string; description: string; tags: string[] } } {
  const document = { name, description, tags: [...tags] };
  return {
    uri: `tender://agent/${name}`.slice(0, 256),
    hash: sha256Hex(canonicalJson(document)),
    tags: document.tags,
    document,
  };
}

export interface RegisterWithBondOptions {
  /**
   * Called when the account is short of what registering takes (the bond in its vault, or NEAR in
   * its storage balance), with the plan that shows how much. Return true to have the shortfall
   * moved in: the token from the wallet into the vault, and NEAR into the storage balance. Without
   * it, or when it returns false, nothing moves and the call throws.
   */
  approve?: (plan: RegistrationPlan) => boolean | Promise<boolean>;
  /** NEAR added to the storage deposit beyond the shortfall, in yoctoNEAR. 0 by default. */
  storageMargin?: bigint;
}

export interface Registration {
  /** The `register_agent` transaction. */
  tx: TxResult;
  /** The bond token moved from the wallet into the vault first, 0 if none had to be. */
  deposited: bigint;
  /** The NEAR added to the storage deposit first, in yoctoNEAR, 0 if none had to be. */
  storageAdded: bigint;
  /** The plan the registration was made from. */
  plan: RegistrationPlan;
  /** The agent as the chain shows it afterwards. */
  agent: AgentView;
}

/**
 * Registers the client's account as an agent with `profile`, paying the bond. In order:
 *
 * 1. checks that the key is a full-access one (`E_AUTH` if not), and reads what registering takes
 *    (`planRegistration`). An agent that is unregistering is refused (`E_PHASE`: claim the bond
 *    first). Nothing has moved yet;
 * 2. if the account's storage balance or its vault lacks anything, asks `opts.approve`; when it
 *    does not say yes, throws `E_FUNDS` (or `E_STORAGE`) with what is missing and moves nothing;
 * 3. adds the NEAR to the storage deposit, then moves the shortfall of the bond token from the
 *    wallet into the vault, and checks that the vault holds the bond (Tender refunds a deposit it
 *    refuses and does not fail, so the check is the only sign);
 * 4. sends `register_agent` with 1 yoctoNEAR, which only a full-access key can (the client refuses
 *    any other, as `TenderClient.registerAgent` does), and reads the agent back.
 *
 * An active agent updating its profile pays no bond, so only the storage can be short for it.
 */
export async function registerWithBond(
  client: TenderClient,
  profile: AgentProfile,
  opts: RegisterWithBondOptions = {},
): Promise<Registration> {
  const account = client.accountId;
  if (account === undefined) throw new Error("this TenderClient has no signer");
  // Before anything moves: a function-call key cannot register, and the bond would be left in the
  // vault of an account that could not use it.
  await client.requireFullAccessKey("register_agent");
  const plan = await planRegistration(client, account);
  if (plan.agent?.status === "unregistering") {
    throw new TenderError(
      "E_PHASE",
      `${account} is unregistering: claim its bond (claimAgentBond) once the cooldown is over, then register again`,
    );
  }

  const short = plan.shortfall > 0n || plan.storageShortfall > 0n;
  if (short && !((await opts.approve?.(plan)) ?? false)) {
    throw new TenderError(plan.shortfall > 0n ? "E_FUNDS" : "E_STORAGE", shortfallMessage(plan));
  }

  // The wallet is checked before anything moves, so a registration that cannot be paid for leaves
  // no storage top-up behind it.
  if (plan.terms !== null && plan.shortfall > 0n && (plan.wallet ?? 0n) < plan.shortfall) {
    throw new TenderError(
      "E_FUNDS",
      `${account} holds ${plan.wallet ?? 0n} of ${plan.terms.token} and needs ${plan.shortfall} more ` +
        `to fill the bond of ${plan.terms.amount}; nothing was moved`,
    );
  }

  let storageAdded = 0n;
  if (plan.storageShortfall > 0n) {
    storageAdded = plan.storageShortfall + (opts.storageMargin ?? 0n);
    await client.storageDeposit(storageAdded);
  }
  let deposited = 0n;
  if (plan.terms !== null && plan.shortfall > 0n) {
    const { token, amount } = plan.terms;
    await client.deposit(token, plan.shortfall);
    const vault = await client.balanceOf(account, token);
    if (vault < amount) {
      throw new TenderError(
        "E_FUNDS",
        `Tender did not take the deposit of ${plan.shortfall} ${token}: the vault of ${account} holds ` +
          `${vault}, short of the bond of ${amount}. Is the account registered with the token?`,
      );
    }
    deposited = plan.shortfall;
  }

  const tx = await client.registerAgent(profile.uri, profile.hash, profile.tags);
  const agent = await client.getAgent(account);
  if (agent === null) throw new Error(`${account} is not an agent after registering`);
  return { tx, deposited, storageAdded, plan, agent };
}

/** What the plan lacks, in words, for the error of a registration that is not approved. */
function shortfallMessage(plan: RegistrationPlan): string {
  const parts: string[] = [];
  if (plan.shortfall > 0n && plan.terms !== null) {
    parts.push(
      `its vault holds ${plan.vault} of ${plan.terms.token} and the bond is ${plan.terms.amount}: ` +
        `${plan.shortfall} more has to be deposited`,
    );
  }
  if (plan.storageShortfall > 0n) {
    parts.push(`${plan.storageShortfall} yoctoNEAR more has to go into its storage deposit`);
  }
  return `${plan.account} cannot register yet: ${parts.join(", and ")}. Nothing was moved.`;
}
