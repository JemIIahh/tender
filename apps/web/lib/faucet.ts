import {
  mintCall,
  type NetworkId,
  type TenderCall,
  tokenMeta,
  tokenStorageDepositCall,
} from "@tender/shared";

// The test-token faucet of the wallet page. The test token (contract/test-token) has a `mint` that
// anyone may call for any account, so there is nothing to run and nothing to pay for: one press
// sends a mint to the connected account. It is offered on testnet only. On mainnet there is no
// test token (its tokens are worth money), and the sandbox has the dev wallet and its own seeding.

/**
 * What one press mints: 20 tUSDC, in the token's smallest unit (tUSDC has 6 decimals). Enough for
 * the agent bond (0.01 tUSDC on testnet since 2026-11-12, unless the owner sets another) and for a
 * small task, with room to try again. The same figure is in the wallet page's words and in docs/MCP.md.
 */
export const FAUCET_AMOUNT = 20_000_000n;

/** Whether `network` has the faucet. Only testnet does. */
export function faucetOffered(network: NetworkId): boolean {
  return network === "testnet";
}

/**
 * The test token to mint: the first token Tender lists, and takes deposits of, that the app knows
 * as tUSDC on `network`, or null if there is none. It is found among the tokens of Tender's own
 * list (the wallet page's rows), and not named in the build: a redeploy of the test token is a
 * different account id.
 */
export function faucetToken(
  tokens: ReadonlyArray<{ token: string; enabled: boolean }>,
  network: NetworkId,
): string | null {
  return (
    tokens.find((row) => row.enabled && tokenMeta(row.token, network).symbol === "tUSDC")?.token ??
    null
  );
}

/**
 * The calls that give `account` `amount` of the test `token`. The token panics on a mint for an
 * account it has not registered, so when `registered` is false the registration (NEP-145) goes
 * first, in the same batch: both calls are to the token, so they are one transaction and one
 * approval.
 */
export function planFaucet(plan: {
  token: string;
  account: string;
  registered: boolean;
  amount?: bigint;
}): TenderCall[] {
  const mint = mintCall(plan.token, plan.account, plan.amount ?? FAUCET_AMOUNT);
  return plan.registered ? [mint] : [tokenStorageDepositCall(plan.token, plan.account), mint];
}
