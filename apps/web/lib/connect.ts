import {
  AGENT_ACCOUNT_DEPOSIT,
  type AgentBondTerms,
  fundAgentCalls,
  implicitAccountActions,
  StorageViewSchema,
  subAccountActions,
  U128StringSchema,
} from "@tender/shared";
import type { BondTerms } from "./account";
import { config } from "./config";
import { accountKeyState, RpcError, view } from "./rpc";
import { describeNear } from "./vault";
import { type AccountAction, groupCalls, type MixedTransaction } from "./wallet";

// What "Add an agent" reads and sends for "Connect your agent" (`@tender/shared`'s `connect.ts` has
// the flow). The page never makes, sees or keeps the agent's private key: the agent attaches its
// PUBLIC key to the code, the page reads it back from the API, and the wallet makes the account
// with it: `<name>.<you>`, whose setup code adds the key (no AddKey action, which some wallets
// refuse), or, when the person chooses it, the implicit account of the key, which a plain transfer
// creates. What the page shows as done it reads from the chain and from the index, and never takes
// from the wallet's word.

/** How often the page asks how the code stands, and what the chain holds, while it waits. */
export const CONNECT_POLL_MS = 2000;

/**
 * The account with the agent's key, for near-cli (near-cli-rs), signed with the person's key from
 * their own keychain: near-cli adds the key itself (an AddKey action), which no wallet sees.
 */
export function createAccountCommand(plan: {
  accountId: string;
  parent: string;
  publicKey: string;
  network: string;
}): string {
  return [
    "near account create-account fund-myself",
    plan.accountId,
    `'${describeNear(AGENT_ACCOUNT_DEPOSIT)}'`,
    "use-manually-provided-public-key",
    plan.publicKey,
    "sign-as",
    plan.parent,
    "network-config",
    plan.network,
    "sign-with-keychain send",
  ].join(" ");
}

/**
 * The actions of the one transaction that makes the agent's sub-account: CreateAccount, its NEAR,
 * the setup code and the call that adds `publicKey` from inside it (`subAccountActions`).
 */
export function createAccountActions(publicKey: string): AccountAction[] {
  return subAccountActions(publicKey);
}

/** The bond in the contract's terms, or null when registering takes none. */
export function bondOfTerms(terms: BondTerms): AgentBondTerms | null {
  return terms.state === "set" ? { token: terms.token, amount: BigInt(terms.amount) } : null;
}

/**
 * The one approval "Create agent" asks for: the transaction that creates the account with the
 * agent's key and sends it its NEAR, then the calls that pay what it still lacks (`fundCallsFor`:
 * its storage with Tender, its bond into its vault), grouped into transactions as every send of the
 * app is. What is in place already is not paid again: Tender takes a storage deposit and a bond for
 * an account that does not exist yet, so an earlier try whose account failed may have paid both.
 * For an account that exists already (`has-key`), only the calls.
 */
export function createAgentBatch(plan: {
  accountId: string;
  publicKey: string;
  chain: AgentOnChain;
  bond: AgentBondTerms | null;
}): MixedTransaction[] {
  return [
    ...(plan.chain.key === "has-key"
      ? []
      : [{ receiverId: plan.accountId, actions: createAccountActions(plan.publicKey) }]),
    ...groupCalls(fundCallsFor(plan.accountId, plan.chain, plan.bond)),
  ];
}

/**
 * The one approval of "Use a separate account instead": NEAR to the agent's implicit account
 * (`accountId`, which the page worked out from the key), which the chain creates with the agent's
 * key, then the same calls as `createAgentBatch`. A transfer is what every wallet sends. For an
 * account that exists already, only the calls.
 */
export function implicitAgentBatch(plan: {
  accountId: string;
  chain: AgentOnChain;
  bond: AgentBondTerms | null;
}): MixedTransaction[] {
  return [
    ...(plan.chain.key === "has-key"
      ? []
      : [{ receiverId: plan.accountId, actions: implicitAccountActions() }]),
    ...groupCalls(fundCallsFor(plan.accountId, plan.chain, plan.bond)),
  ];
}

/** Where the agent's account stands on the chain: the four ticks of the page, but the last two. */
export interface AgentOnChain {
  /** Whether the account exists, and with the attached key as a full-access key. */
  key: "missing" | "other-keys" | "has-key";
  /**
   * Whether it has a storage balance with Tender. Read whether or not the account exists: Tender
   * keeps one for any account id it is paid for.
   */
  storage: boolean;
  /** What its vault holds of the bond's token (0 when there is no bond, or no slot). */
  vault: bigint;
}

/** `account`'s vault balance of `token`, from `balance_of` (0 when it has no slot). */
async function vaultOf(account: string, token: string): Promise<bigint> {
  const value = await view<unknown>(config.contractId, "balance_of", {
    account_id: account,
    token,
  });
  const parsed = U128StringSchema.safeParse(value);
  if (!parsed.success) throw new RpcError("balance_of returned something other than an amount");
  return BigInt(parsed.data);
}

/**
 * What Tender holds for `accountId`, which need not exist: whether it has a storage balance, and
 * its vault's balance of the bond's token. Both are views of the contract.
 */
export async function readAgentFunding(
  accountId: string,
  bond: AgentBondTerms | null,
): Promise<{ storage: boolean; vault: bigint }> {
  const [storage, vault] = await Promise.all([
    view<unknown>(config.contractId, "storage_balance_of", { account_id: accountId }),
    bond === null ? Promise.resolve(0n) : vaultOf(accountId, bond.token),
  ]);
  // Whether there is a balance is all the page needs: its two NEP-145 fields are enough.
  const parsed = StorageViewSchema.pick({ total: true, available: true })
    .nullable()
    .safeParse(storage);
  if (!parsed.success) throw new RpcError("storage_balance_of returned something unexpected");
  return { storage: parsed.data !== null, vault };
}

/**
 * Reads `accountId` with `publicKey` on the chain: the account and the key, and what Tender holds
 * for it (its storage and its vault), always: an earlier try may have paid them for an account
 * that does not exist yet.
 */
export async function readAgentOnChain(
  accountId: string,
  publicKey: string,
  bond: AgentBondTerms | null,
): Promise<AgentOnChain> {
  const [key, funding] = await Promise.all([
    accountKeyState(accountId, publicKey),
    readAgentFunding(accountId, bond),
  ]);
  return { key, ...funding };
}

/** Whether Tender holds everything the agent needs: storage, and the bond in its vault. */
export function isPaid(
  chain: Pick<AgentOnChain, "storage" | "vault">,
  bond: AgentBondTerms | null,
) {
  return chain.storage && (bond === null || chain.vault >= bond.amount);
}

/**
 * What landed of an approval that failed, in words, from what the chain holds after it: whether
 * the account was made, and what Tender holds for it. `wallet`: the wallet refused, or stopped,
 * rather than the network failing a transaction.
 */
export function whatLanded(
  after: AgentOnChain | null,
  bond: AgentBondTerms | null,
  wallet: boolean,
): string {
  if (after === null) {
    return "The page couldn't read the network to see what landed. Check again in a moment before you press anything.";
  }
  const paid = isPaid(after, bond);
  const bondIn = bond !== null && after.vault >= bond.amount;
  if (after.key === "has-key") {
    if (paid) return "The account was created and its storage and bond are in place.";
    const done = after.storage
      ? "The account was created and its storage paid"
      : "The account was created";
    const failed = after.storage ? "its bond" : bondIn ? "its storage" : "its storage and bond";
    return wallet
      ? `${done}, and your wallet didn't send ${failed}. Press Fund agent to send what is missing.`
      : `${done}, and paying ${failed} failed on the network. Check that your wallet holds the bond, then press Fund agent.`;
  }
  const head = wallet
    ? "Your wallet didn't create the account."
    : "The account was not created: that transaction failed on the network.";
  const landed =
    after.storage && (bond === null || bondIn)
      ? " Its storage and its bond did reach Tender, so pressing Create agent again creates the account only."
      : after.storage
        ? " Its storage did reach Tender; pressing Create agent again sends the account and the bond only."
        : bondIn
          ? " Its bond did reach Tender; pressing Create agent again sends the account and the storage only."
          : " Nothing was paid.";
  return `${head}${landed} Press Create agent to try again.`;
}

/** Whether the account is made and paid for: storage with Tender, and the bond in its vault (or held). */
export function isFunded(
  chain: AgentOnChain | null,
  bond: AgentBondTerms | null,
  registered: boolean,
): boolean {
  if (chain === null || chain.key !== "has-key") return false;
  // Registering moves the bond from the vault into the agent's record.
  if (registered) return true;
  return isPaid(chain, bond);
}

/** What the owner holds of `token` in their own wallet, outside Tender. */
export async function readWalletBalance(account: string, token: string): Promise<bigint> {
  const value = await view<unknown>(token, "ft_balance_of", { account_id: account });
  const parsed = U128StringSchema.safeParse(value);
  if (!parsed.success) throw new RpcError("ft_balance_of returned something other than an amount");
  return BigInt(parsed.data);
}

/** The calls of "Fund agent": what the account still lacks, for a wallet that sends only calls. */
export function fundCallsFor(
  accountId: string,
  chain: Pick<AgentOnChain, "storage" | "vault">,
  bond: AgentBondTerms | null,
): ReturnType<typeof fundAgentCalls> {
  const short = bond === null ? 0n : bond.amount - chain.vault;
  return fundAgentCalls({
    contractId: config.contractId,
    accountId,
    storage: !chain.storage,
    bond: bond !== null && short > 0n ? { token: bond.token, amount: short } : null,
  });
}

// ---- Keeping the code's id across a reload -------------------------------------------------------

/**
 * What the page keeps of a code in this tab, so that a reload finds it again: its id (which is no
 * credential: only its owner, signed in, can read a code by it), its name, its account and when it
 * stops taking a key. The code itself is never kept.
 */
export interface KeptCode {
  id: string;
  name: string;
  account_id: string;
  expires_at: string;
}

const keptKey = (owner: string) => `tender.connect.${owner}`;

/** The code kept for `owner` in this tab, or null. Storage that can't be read is no code. */
export function readKeptCode(owner: string): KeptCode | null {
  try {
    const text = sessionStorage.getItem(keptKey(owner));
    if (text === null) return null;
    const value = JSON.parse(text) as Partial<KeptCode>;
    if (
      typeof value.id === "string" &&
      /^[A-Za-z0-9_-]{22}$/.test(value.id) &&
      typeof value.name === "string" &&
      typeof value.account_id === "string" &&
      typeof value.expires_at === "string"
    ) {
      return {
        id: value.id,
        name: value.name,
        account_id: value.account_id,
        expires_at: value.expires_at,
      };
    }
  } catch {
    // Storage that is off, or full, keeps nothing: the page works without it.
  }
  return null;
}

/** Keeps `code` for `owner` in this tab, or forgets it with null. */
export function keepCode(owner: string, code: KeptCode | null): void {
  try {
    if (code === null) sessionStorage.removeItem(keptKey(owner));
    else
      sessionStorage.setItem(
        keptKey(owner),
        JSON.stringify({
          id: code.id,
          name: code.name,
          account_id: code.account_id,
          expires_at: code.expires_at,
        }),
      );
  } catch {
    // As above: nothing is kept, and nothing fails.
  }
}
