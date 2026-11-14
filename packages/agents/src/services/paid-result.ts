import type { TenderClient } from "@tender/client";
import {
  BriefSchema,
  canonicalJson,
  ScorecardSchema,
  sha256Hex,
  type TenderApi,
} from "@tender/shared";
import { utilityRequest } from "./escrow";

/** Read an already-paid service after the contract has cleaned its entry records. */
export async function readPaidEscrowResult(options: {
  chain: Pick<TenderClient, "getTask">;
  api: Pick<TenderApi, "getBlob">;
  taskId: bigint;
  parent: string;
  poster: string;
  agent: string;
  token: string;
  price: string;
  request: unknown;
  validate(result: unknown): boolean;
}) {
  const { chain, api } = options;
  const task = await chain.getTask(options.taskId);
  if (
    !task ||
    task.parent !== options.parent ||
    task.poster !== options.poster ||
    task.verifier !== options.poster ||
    task.token !== options.token ||
    task.reward !== options.price ||
    task.outcome?.kind !== "picked" ||
    task.outcome.winners.length !== 1 ||
    task.outcome.winners[0]?.account !== options.agent ||
    task.outcome.winners[0]?.bps !== 10000 ||
    task.invited.length !== 1 ||
    task.invited[0] !== options.agent
  )
    throw new Error("Paid service task does not match the approved purchase.");
  const read = async (hash: string) => {
    const bytes = await api.getBlob(hash);
    if (!bytes || bytes.length > 262144 || sha256Hex(bytes) !== hash)
      throw new Error("Paid service document is missing or has the wrong hash.");
    return bytes;
  };
  const brief = BriefSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await read(task.brief_hash))),
  );
  const request = utilityRequest(brief.instructions);
  if (!request || sha256Hex(canonicalJson(request)) !== sha256Hex(canonicalJson(options.request)))
    throw new Error("Paid service input differs from the requested input.");
  const card = ScorecardSchema.parse(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await read(task.outcome.scorecard_hash)),
    ),
  );
  const entry = card.entries.find((entry) => entry.account === options.agent);
  if (
    card.task_id !== String(options.taskId) ||
    card.verifier !== options.poster ||
    card.criteria_hash !== task.criteria_hash ||
    card.winners.length !== 1 ||
    card.winners[0]?.account !== options.agent ||
    card.winners[0]?.bps !== 10000 ||
    !entry?.passed ||
    entry.score !== 100
  )
    throw new Error("Paid service scorecard does not match its on-chain outcome.");
  const bytes = await read(entry.content_hash);
  if (bytes.length > brief.output.max_bytes)
    throw new Error("Paid service answer exceeds its size limit.");
  const result: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!options.validate(result))
    throw new Error("Paid service result failed the configured content check.");
  return {
    result,
    contentHash: entry.content_hash,
    scorecardHash: task.outcome.scorecard_hash,
    taskId: String(options.taskId),
  };
}
