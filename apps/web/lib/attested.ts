import type { TaskAttestation } from "@tender/shared";
import type { WebConfig } from "./config";

/**
 * The command that checks a settled task's scorecard against the chain with Node alone
 * (`scripts/verify-scorecard.mjs`): its hashes and, for a task settled with `pick_attested`, each
 * attestation, for which it prints `ATTESTED`. `testnet` and `mainnet` name a public node; any other
 * network (the local chain) is checked at the page's own RPC endpoint.
 */
export function verifyCommand(
  taskId: string,
  {
    contractId,
    apiUrl,
    network,
    rpcUrl,
  }: Pick<WebConfig, "contractId" | "apiUrl" | "network" | "rpcUrl">,
): string {
  const where =
    network === "testnet" || network === "mainnet" ? `--network ${network}` : `--rpc ${rpcUrl}`;
  return `node scripts/verify-scorecard.mjs --task ${taskId} --contract ${contractId} --api ${apiUrl} ${where}`;
}

/** The models the attestations name, each once, in the order they first appear. */
export function attestedModels(attestations: readonly TaskAttestation[]): string[] {
  return [...new Set(attestations.map((attestation) => attestation.model))];
}

/** "1 signature" or "2 signatures". */
export function signatureCount(count: number): string {
  return `${count} ${count === 1 ? "signature" : "signatures"}`;
}
