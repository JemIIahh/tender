import { z } from "zod";
import { EVENT_STANDARD, EVENT_VERSION } from "./constants";
import {
  AccountIdSchema as account,
  HashHexSchema as hash,
  U8Schema as u8,
  U16Schema as u16,
  U32Schema as u32,
  U64StringSchema as u64,
  U128StringSchema as u128,
} from "./primitives";

/** What NEP-297 puts in front of the JSON of an event log. */
const EVENT_PREFIX = "EVENT_JSON:";

// Field types, as near-sdk writes them into a log, under the short names used below (the
// definitions are in `primitives.ts`, shared with the view schemas):
//   u64, u128      a decimal string (`U64`, `U128`). A nanosecond timestamp or a token amount can
//                  pass 2^53, which a JSON number would corrupt. Canonical and in range: no sign,
//                  no leading zero, at most 2^64 - 1 or 2^128 - 1.
//   u8, u16, u32   a JSON integer in the type's range (`max_winners`; `fee_bps` and `bps`;
//                  `max_entries`)
//   AccountId      a NEAR account id
//   Option<T>      T, or null: the contract writes the key even when the value is None
//   hash           64 lowercase hex characters, a SHA-256
//   uri            `profile_uri`, `brief_uri`, `uri` and `scorecard_uri`, written `z.string()`
//                  below: any UTF-8 text of 1 to 256 bytes, which is all the contract checks of
//                  one (`check_uri`). It need not be a URL, and it can hold a NUL or another
//                  control character. The schema lets these through on purpose: refusing one
//                  makes `parseEventLog` return null, and the event is lost, a real reveal with
//                  it. A consumer that stores a uri must clean it first: neither a `text` column
//                  nor `jsonb` holds a NUL, so the indexer replaces each one with U+FFFD.

/** One event: its name, and the single element of the `data` array that follows it in the log. */
function variant<Name extends string, Data extends z.ZodRawShape>(event: Name, data: Data) {
  return z.object({ event: z.literal(event), data: z.object(data) });
}

/** `withdraw` and `withdraw_failed` carry the same data (`Withdraw` in the contract). */
const withdrawal = { account, token: account, amount: u128, to: account };

/**
 * Every event Tender logs, as a union discriminated on `event`.
 *
 * Fields and their order follow the structs in `contract/tender/src/events.rs`. The deployed
 * contract emits `task_topped_up`, `delegate_added` and `delegate_removed` in these shapes. One event
 * is not emitted yet, `attested_pick`: its shape comes from the text of plan 01 Task 17, and is to
 * be checked against the contract if that task lands.
 *
 * Keys the schema does not name are dropped from the parsed data rather than rejected, so a field
 * added to the contract later cannot make a consumer lose the event.
 */
export const TenderEventSchema = z.discriminatedUnion("event", [
  variant("storage_deposit", { account, amount: u128, total: u128 }),
  variant("deposit", { account, token: account, amount: u128, sender: account }),
  variant("withdraw", withdrawal),
  variant("withdraw_failed", withdrawal),
  // `profile_uri`: arbitrary text from the chain, see "uri" in the legend above.
  variant("agent_registered", {
    account,
    asp: account.nullable(),
    profile_uri: z.string(),
    profile_hash: hash,
    tags: z.array(z.string()),
    updated: z.boolean(),
  }),
  // Task 16b, the agent bond. `agent_bonded` follows the `agent_registered` of a registration that
  // took a bond; `agent_unregistering` and `agent_bond_claimed` are the way out. An agent that
  // registered before the owner set a bond has none to claim: its `agent_bond_claimed` has a null
  // `token` and the amount "0". `claimable_at` is the time (ns) from which the bond can be claimed.
  variant("agent_bonded", { account, token: account, amount: u128 }),
  variant("agent_unregistering", { account, claimable_at: u64 }),
  variant("agent_bond_claimed", { account, token: account.nullable(), amount: u128 }),
  // The new task as `get_task` shows it, so the id is `id` here and `task_id` in the other events.
  // `brief_uri`: arbitrary text from the chain, see "uri" in the legend above.
  variant("task_created", {
    id: u64,
    poster: account,
    token: account,
    reward: u128,
    fee_bps: u16,
    brief_uri: z.string(),
    brief_hash: hash,
    criteria_hash: hash,
    heldout_commitment: hash.nullable(),
    verifier: account,
    created_at: u64,
    commit_deadline: u64,
    reveal_deadline: u64,
    pick_deadline: u64,
    fallback_deadline: u64,
    max_entries: u32,
    max_winners: u8,
    invited: z.array(account),
    parent: u64.nullable(),
  }),
  // `reward` is the task's reward after the top-up, `amount` what this funder added.
  variant("task_topped_up", { task_id: u64, funder: account, amount: u128, reward: u128 }),
  variant("committed", {
    task_id: u64,
    account,
    commitment: hash,
    replaced: z.boolean(),
    block_height: u64,
  }),
  // `uri`: arbitrary text from the chain, which any entrant can fill. See "uri" in the legend.
  variant("revealed", { task_id: u64, account, content_hash: hash, uri: z.string() }),
  // `scorecard_uri`: arbitrary text from the chain, see "uri" in the legend above.
  variant("picked", {
    task_id: u64,
    by: account,
    winners: z.array(z.object({ account, bps: u16, amount: u128 })),
    fee: u128,
    scorecard_hash: hash,
    scorecard_uri: z.string(),
  }),
  // `by` and the scorecard are null when `void_task` voided the task. `scorecard_uri` is arbitrary
  // text from the chain when there is one, see "uri" in the legend above.
  variant("voided", {
    task_id: u64,
    reason: z.enum(["no_reveals", "no_award", "expired"]),
    by: account.nullable(),
    refunds: z.array(z.object({ account, amount: u128 })),
    scorecard_hash: hash.nullable(),
    scorecard_uri: z.string().nullable(),
  }),
  // `public_key` is NEAR's text form of a key, such as `ed25519:<base58>`.
  variant("delegate_added", {
    account,
    public_key: z.string(),
    token: account,
    per_task_cap: u128,
    total_cap: u128,
  }),
  variant("delegate_removed", { account, public_key: z.string() }),
  variant("attested_pick", {
    task_id: u64,
    signer_id: z.string(),
    model: z.string(),
    request_hash: hash,
    response_hash: hash,
  }),
]);

/**
 * A Tender event: its name, and its `data`, the single element of the log's `data` array. Checking
 * `event` narrows `data` to that event's fields.
 */
export type TenderEvent = z.infer<typeof TenderEventSchema>;

/**
 * The outside of a log line: the standard and version are checked, and `data` holds one element.
 *
 * Every line the contract logs carries exactly one event (`emit` in `events.rs` writes a `data`
 * array of one), and a line with any other count is dropped whole, not read for its first element.
 * So the contract must never batch two events into one line: neither would reach a consumer.
 */
const LogEnvelope = z.object({
  standard: z.literal(EVENT_STANDARD),
  version: z.literal(EVENT_VERSION),
  event: z.string(),
  data: z.array(z.unknown()).length(1),
});

/**
 * Parses one log line of the contract. Returns null, and never throws, when the line has no
 * `EVENT_JSON:` prefix, is not valid JSON, is not of standard `tender` and version `1.0.0`, has no
 * single `data` element, names an event we do not know, or has data that does not fit the event.
 */
export function parseEventLog(line: string): TenderEvent | null {
  if (!line.startsWith(EVENT_PREFIX)) return null;
  let json: unknown;
  try {
    json = JSON.parse(line.slice(EVENT_PREFIX.length));
  } catch {
    return null;
  }
  const envelope = LogEnvelope.safeParse(json);
  if (!envelope.success) return null;
  const event = TenderEventSchema.safeParse({
    event: envelope.data.event,
    data: envelope.data.data[0],
  });
  return event.success ? event.data : null;
}

/** The outcome of one receipt: where it ran, whether it succeeded, and what it logged. */
export interface ReceiptOutcome {
  receiptId: string;
  /** The account the receipt ran on. For a function call, the contract. */
  executorId: string;
  /** `success` is a `SuccessValue` or `SuccessReceiptId`; every other status is a `failure`. */
  status: "success" | "failure";
  logs: string[];
}

/**
 * The Tender events in `receipts`, in receipt order and then log order. Only receipts that ran on
 * `contractId` and succeeded count: a failed receipt keeps its logs (seen on mainnet), and any
 * contract can log a line that looks like ours.
 *
 * `logIndex` is the line's position in its receipt's `logs`, lines that are not events included, so
 * (`receiptId`, `logIndex`) is unique and does not change.
 */
export function extractEvents(
  receipts: ReceiptOutcome[],
  contractId: string,
): Array<TenderEvent & { receiptId: string; logIndex: number }> {
  const found: Array<TenderEvent & { receiptId: string; logIndex: number }> = [];
  for (const { receiptId, executorId, status, logs } of receipts) {
    if (executorId !== contractId || status !== "success") continue;
    for (const [logIndex, line] of logs.entries()) {
      const event = parseEventLog(line);
      if (event) found.push({ ...event, receiptId, logIndex });
    }
  }
  return found;
}
