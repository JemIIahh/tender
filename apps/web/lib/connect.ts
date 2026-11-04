import {
  AGENT_ACCOUNT_DEPOSIT,
  type AgentBondTerms,
  fundAgentCalls,
  StorageViewSchema,
  U128StringSchema,
} from "@tender/shared";
import type { BondTerms } from "./account";
import { config } from "./config";
import { accountKeyState, RpcError, view } from "./rpc";
import { describeNear } from "./vault";
import { type AccountAction, groupCalls, type MixedTransaction } from "./wallet";

// What "Add an agent" reads and sends for "Connect your agent" (`@tender/shared`'s `connect.ts` has
// the flow). The page never makes, sees or keeps the agent's private key: the agent attaches its
// PUBLIC key to the code, the page reads it back from the API, and the wallet adds it to the
// account it creates. What the page shows as done it reads from the chain and from the index, and
// never takes from the wallet's word.

/** How often the page asks how the code stands, and what the chain holds, while it waits. */
export const CONNECT_POLL_MS = 2000;

/** The same transaction as the wallet's, for near-cli (near-cli-rs), signed with the person's key. */
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

/** The actions of the one transaction that makes the agent's account. */
export function createAccountActions(publicKey: string): AccountAction[] {
  return [
    { type: "CreateAccount" },
    { type: "Transfer", params: { deposit: AGENT_ACCOUNT_DEPOSIT.toString() } },
    { type: "AddKey", params: { publicKey, accessKey: { permission: "FullAccess" } } },
  ];
}

/** The bond in the contract's terms, or null when registering takes none. */
export function bondOfTerms(terms: BondTerms): AgentBondTerms | null {
  return terms.state === "set" ? { token: terms.token, amount: BigInt(terms.amount) } : null;
}

/**
 * The one approval "Create agent" asks for: the transaction that creates the account with the
 * agent's key and sends it its NEAR, then the calls that pay its storage with Tender and its bond
 * into its vault (`fundAgentCalls`), grouped into transactions as every send of the app is.
 */
export function createAgentBatch(plan: {
  accountId: string;
  publicKey: string;
  bond: AgentBondTerms | null;
}): MixedTransaction[] {
  return [
    { receiverId: plan.accountId, actions: createAccountActions(plan.publicKey) },
    ...groupCalls(
      fundAgentCalls({
        contractId: config.contractId,
        accountId: plan.accountId,
        storage: true,
        bond: plan.bond,
      }),
    ),
  ];
}

/** Where the agent's account stands on the chain: the four ticks of the page, but the last two. */
export interface AgentOnChain {
  /** Whether the account exists, and with the attached key as a full-access key. */
  key: "missing" | "other-keys" | "has-key";
  /** Whether it has a storage balance with Tender. */
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

/** Reads `accountId` with `publicKey` on the chain: the account, its storage, its vault. */
export async function readAgentOnChain(
  accountId: string,
  publicKey: string,
  bond: AgentBondTerms | null,
): Promise<AgentOnChain> {
  const key = await accountKeyState(accountId, publicKey);
  if (key !== "has-key") return { key, storage: false, vault: 0n };
  const [storage, vault] = await Promise.all([
    view<unknown>(config.contractId, "storage_balance_of", { account_id: accountId }),
    bond === null ? Promise.resolve(0n) : vaultOf(accountId, bond.token),
  ]);
  // Whether there is a balance is all the page needs: its two NEP-145 fields are enough.
  const parsed = StorageViewSchema.pick({ total: true, available: true })
    .nullable()
    .safeParse(storage);
  if (!parsed.success) throw new RpcError("storage_balance_of returned something unexpected");
  return { key, storage: parsed.data !== null, vault };
}

/** Whether the account is paid for: storage with Tender, and the bond in its vault (or held). */
export function isFunded(
  chain: AgentOnChain | null,
  bond: AgentBondTerms | null,
  registered: boolean,
): boolean {
  if (chain === null || chain.key !== "has-key") return false;
  // Registering moves the bond from the vault into the agent's record.
  if (registered) return true;
  return chain.storage && (bond === null || chain.vault >= bond.amount);
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
  chain: AgentOnChain,
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
