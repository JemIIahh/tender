import { join } from "node:path";
import type { TenderClient } from "@tender/client";
import { AccountIdSchema } from "@tender/shared";
import { KeyPair } from "near-api-js";
import type { McpConfig } from "./config";
import type { McpDeps } from "./server";

/**
 * The payer's private key, as the texts a failure must not carry: the whole key and its part after
 * `ed25519:`, as `secretsOf` lists the agent's. None when it is not set.
 */
export function x402SecretsOf(env: Record<string, string | undefined>): string[] {
  const key = env.TENDER_X402_PAYER_PRIVATE_KEY?.trim() ?? "";
  if (key === "") return [];
  const bare = key.slice(key.indexOf(":") + 1);
  return bare === key || bare === "" ? [key] : [key, bare];
}

/**
 * Opt-in only, for the local stdio agent. Hosted Tender services never load this signer.
 *
 * Before anything is loaded it checks the payer: a dedicated account (neither the agent's own nor
 * an account the agent is under, such as its parent, unless the owner sets
 * `TENDER_X402_ALLOW_AGENT_PAYER=1`), whose key the chain lists as a full-access key of it. An RPC
 * failure rejects: a server that cannot tell what the payer's key is should not start.
 */
export async function x402BuyerOf(
  env: Record<string, string | undefined>,
  config: Pick<McpConfig, "network" | "signer" | "stateDir" | "rpcUrl">,
  chain: Pick<TenderClient, "viewAccessKey">,
  /** Loads the payment package; a test passes one that fails. */
  loadPayments: () => Promise<
    Pick<typeof import("@tender/payments"), "createClientNearSigner">
  > = () => import("@tender/payments"),
): Promise<McpDeps["x402Buyer"]> {
  const enabled = env.TENDER_X402_ENABLED?.trim();
  if (!enabled || enabled === "0") return undefined;
  if (enabled !== "1") throw new Error("TENDER_X402_ENABLED must be 0 or 1");
  if (config.network !== "testnet") throw new Error("x402 stdio purchases require testnet");
  const payer = AccountIdSchema.safeParse(env.TENDER_X402_PAYER_ACCOUNT);
  const payerKey = env.TENDER_X402_PAYER_PRIVATE_KEY ?? "";
  if (!payer.success || !payerKey.startsWith("ed25519:"))
    throw new Error(
      "Configure a dedicated TENDER_X402_PAYER_ACCOUNT and its full-access ed25519 key in TENDER_X402_PAYER_PRIVATE_KEY",
    );
  let payerPublicKey: string;
  try {
    payerPublicKey = KeyPair.fromString(payerKey as `ed25519:${string}`)
      .getPublicKey()
      .toString();
  } catch {
    throw new Error("TENDER_X402_PAYER_PRIVATE_KEY is not a valid ed25519 key");
  }
  const allowAgent = env.TENDER_X402_ALLOW_AGENT_PAYER?.trim();
  if (allowAgent && allowAgent !== "0" && allowAgent !== "1")
    throw new Error("TENDER_X402_ALLOW_AGENT_PAYER must be 0 or 1");
  const agent = config.signer.accountId;
  // `acme.testnet` is above `worker.acme.testnet`: it made that account and usually holds more.
  const agentsOwn = payer.data === agent || agent.endsWith(`.${payer.data}`);
  if (agentsOwn && allowAgent !== "1")
    throw new Error(
      "The payment payer must be separate from the agent account and from the accounts it is under, such as its parent; an owner must explicitly opt in with TENDER_X402_ALLOW_AGENT_PAYER=1",
    );
  const asset = AccountIdSchema.safeParse(env.TENDER_X402_TOKEN);
  if (!asset.success)
    throw new Error("TENDER_X402_TOKEN must name the approved NEP-141 token account");
  const maxPerCall = env.TENDER_X402_MAX_PRICE ?? "";
  const totalBudget = env.TENDER_X402_TOTAL_BUDGET ?? "";
  if (
    !/^[1-9][0-9]{0,37}$/.test(maxPerCall) ||
    !/^[1-9][0-9]{0,37}$/.test(totalBudget) ||
    BigInt(maxPerCall) > BigInt(totalBudget)
  ) {
    throw new Error(
      "Set TENDER_X402_MAX_PRICE and TENDER_X402_TOTAL_BUDGET to positive atomic amounts; per-call must not exceed total",
    );
  }
  const allowedOrigins = (env.TENDER_X402_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  if (
    allowedOrigins.length === 0 ||
    allowedOrigins.some((origin) => {
      try {
        const url = new URL(origin);
        return url.protocol !== "https:" || url.origin !== origin;
      } catch {
        return true;
      }
    })
  )
    throw new Error(
      "TENDER_X402_ALLOWED_ORIGINS needs explicit HTTPS origins, separated by commas",
    );
  // The chain, last: a key that is not the payer's full-access key would sign authorizations that
  // the facilitator refuses only after the budget has reserved them.
  const access = await chain.viewAccessKey(payer.data, payerPublicKey);
  if (access === null)
    throw new Error(
      "TENDER_X402_PAYER_PRIVATE_KEY is not a key of TENDER_X402_PAYER_ACCOUNT on the chain",
    );
  if (access.permission !== "FullAccess")
    throw new Error(
      "TENDER_X402_PAYER_PRIVATE_KEY must be a full-access key of TENDER_X402_PAYER_ACCOUNT; the chain lists it as another kind of key",
    );
  const { createClientNearSigner } = await loadPayments().catch((cause: unknown) => {
    const why = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `x402 needs the optional payment package @tender/payments, which did not load: ${why}`,
      {
        cause,
      },
    );
  });
  return {
    payer: payer.data,
    asset: asset.data,
    signer: createClientNearSigner({
      accountId: payer.data,
      secretKey: payerKey as `ed25519:${string}`,
      ...(config.rpcUrl ? { rpcUrls: { "near:testnet": config.rpcUrl } } : {}),
    }),
    budgetFile: join(config.stateDir, "x402-budget.json"),
    maxPerCall,
    totalBudget,
    allowedOrigins,
  };
}
