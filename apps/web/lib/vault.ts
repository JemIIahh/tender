import {
  AccountIdSchema,
  ConfigViewSchema,
  formatTokenAmount,
  parseTokenAmount,
  StorageViewSchema,
  type TenderCall,
  tokenMeta,
  tokenStorageDepositCall,
  U128StringSchema,
  withdrawCall,
} from "@tender/shared";
import { config } from "./config";
import { RpcError, view } from "./rpc";

// What the wallet page reads from the chain, and what it sends. The reads are views of the Tender
// contract and of its tokens, called through the browser's own RPC node (lib/rpc.ts), so that the
// balances shown are the chain's and not an index's. The sends are call builders of @tender/shared.

/** 0.05 NEAR in yoctoNEAR: what "Set up account" attaches. It buys storage for some 5,000 bytes. */
export const SETUP_DEPOSIT_YOCTO = 5n * 10n ** 22n;

/** The account's storage balance with Tender, in yoctoNEAR. */
export interface StorageBalance {
  /** Everything deposited and not withdrawn. */
  total: bigint;
  /** What can be withdrawn now. */
  available: bigint;
}

/** One token as the wallet page lists it. */
export interface TokenRow {
  token: string;
  /** Whether Tender takes deposits of it now. */
  enabled: boolean;
  /** What the account has in its vault, in the token's smallest unit. 0 if it has no slot. */
  vault: bigint;
  /** What the account holds of the token itself. Null if the token would not say. */
  wallet: bigint | null;
}

export interface VaultData {
  /** Null if the account has never set up its storage with Tender. */
  storage: StorageBalance | null;
  rows: TokenRow[];
}

const TokenStorageSchema = StorageViewSchema.pick({ total: true, available: true }).nullable();

function malformed(method: string): RpcError {
  return new RpcError(`${method} returned something other than what the contract promises`);
}

/** The vault balances `balances_of` listed, or an `RpcError` for an answer that is not a list. */
function readBalances(value: unknown): Map<string, bigint> {
  if (!Array.isArray(value)) throw malformed("balances_of");
  const balances = new Map<string, bigint>();
  for (const entry of value) {
    const { token, amount } = (entry ?? {}) as { token?: unknown; amount?: unknown };
    if (!AccountIdSchema.safeParse(token).success || !U128StringSchema.safeParse(amount).success) {
      throw malformed("balances_of");
    }
    balances.set(token as string, BigInt(amount as string));
  }
  return balances;
}

/** What `token` says `account` holds of it, or null if it would not say. */
async function tokenBalance(token: string, account: string): Promise<bigint | null> {
  try {
    const amount = await view<unknown>(token, "ft_balance_of", { account_id: account });
    if (!U128StringSchema.safeParse(amount).success) throw malformed("ft_balance_of");
    return BigInt(amount as string);
  } catch (error) {
    // One token that won't answer does not take the page down: its balance shows as unknown.
    console.error(error);
    return null;
  }
}

/**
 * Everything the wallet page shows about `account`: its storage balance, and for each token that
 * Tender lists, or that the account has a vault balance of, the vault balance and the balance of
 * the token itself. Throws an `RpcError` or a request failure if the contract can't be read; a
 * token that can't be read gives a row with an unknown wallet balance.
 */
export async function readVault(account: string): Promise<VaultData> {
  const [configView, storageView, balancesView] = await Promise.all([
    view<unknown>(config.contractId, "get_config"),
    view<unknown>(config.contractId, "storage_balance_of", { account_id: account }),
    view<unknown>(config.contractId, "balances_of", { account_id: account }),
  ]);

  const parsedConfig = ConfigViewSchema.safeParse(configView);
  if (!parsedConfig.success) throw malformed("get_config");
  const parsedStorage = StorageViewSchema.nullable().safeParse(storageView);
  if (!parsedStorage.success) throw malformed("storage_balance_of");
  const vault = readBalances(balancesView);

  // The tokens Tender lists, in its order, then any other with a balance in the vault.
  const tokens = new Map<string, boolean>();
  for (const { token, enabled } of parsedConfig.data.tokens) tokens.set(token, enabled);
  for (const token of vault.keys()) if (!tokens.has(token)) tokens.set(token, false);

  const rows = await Promise.all(
    [...tokens].map(
      async ([token, enabled]): Promise<TokenRow> => ({
        token,
        enabled,
        vault: vault.get(token) ?? 0n,
        wallet: await tokenBalance(token, account),
      }),
    ),
  );

  const storage = parsedStorage.data;
  return {
    storage:
      storage === null
        ? null
        : { total: BigInt(storage.total), available: BigInt(storage.available) },
    rows,
  };
}

/**
 * Whether `account` is registered at `token` (NEP-145), so that the token can hold its balance and
 * pay it out. Read afresh, at the moment of a withdrawal.
 */
export async function isRegisteredAtToken(token: string, account: string): Promise<boolean> {
  const answer = await view<unknown>(token, "storage_balance_of", { account_id: account });
  const parsed = TokenStorageSchema.safeParse(answer);
  if (!parsed.success) throw malformed("storage_balance_of");
  return parsed.data !== null;
}

/**
 * The calls that withdraw `amount` of `token` from the vault of `account` to the account itself.
 * The token pays only an account it has registered, and otherwise the withdrawal comes back to the
 * vault (`withdraw_failed`). So when `registered` is false, the registration goes first, in the
 * same batch: one approval for both.
 */
export function planWithdraw(plan: {
  contractId: string;
  token: string;
  account: string;
  amount: bigint;
  registered: boolean;
}): TenderCall[] {
  const withdraw = withdrawCall(plan.contractId, plan.token, plan.amount);
  return plan.registered
    ? [withdraw]
    : [tokenStorageDepositCall(plan.token, plan.account), withdraw];
}

/** `value` of `token` in whole units with its symbol, for a sentence: `1.25 tUSDC`. */
export function describeAmount(value: bigint, token: string): string {
  // A token the app doesn't know has no symbol and no decimals: its account id stands in, as in
  // `Amount`, and the count is of its smallest unit.
  const { symbol, decimals } = tokenMeta(token, config.network);
  return `${formatTokenAmount(value, decimals)} ${symbol}`;
}

/** `yocto` yoctoNEAR as NEAR, for a sentence: `0.05 NEAR`. */
export function describeNear(yocto: bigint): string {
  return `${formatTokenAmount(yocto, 24)} NEAR`;
}

export type AmountReading = { ok: true; amount: bigint } | { ok: false; message: string };

/**
 * The amount a person typed for `token`: whole units with a point, as `1.25`. A refusal says what
 * to change, in words. `max` is the most there is to move, or null if it isn't known (the token's
 * own contract will refuse an amount that is too large); `source` says where it is, for the
 * message.
 */
export function readAmount(
  text: string,
  token: string,
  max: bigint | null,
  source: "vault" | "wallet",
): AmountReading {
  const typed = text.trim();
  if (typed === "") return { ok: false, message: "Enter an amount." };
  const { decimals } = tokenMeta(token, config.network);
  let amount: bigint;
  try {
    amount = parseTokenAmount(typed, decimals);
  } catch (error) {
    if (typed.startsWith("-")) return { ok: false, message: "An amount can't be negative." };
    if (error instanceof RangeError) {
      return {
        ok: false,
        message:
          decimals === 0
            ? "This token has no decimal places. Use a whole number."
            : `This token has ${decimals} decimal places at most.`,
      };
    }
    return { ok: false, message: "Use digits and one point, like 12.5." };
  }
  if (amount === 0n) return { ok: false, message: "Enter more than 0." };
  if (max !== null && amount > max) {
    return {
      ok: false,
      message:
        source === "vault"
          ? "That's more than you have in the vault."
          : "That's more than you have in your wallet.",
    };
  }
  return { ok: true, amount };
}
