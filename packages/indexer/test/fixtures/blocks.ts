import { readFileSync } from "node:fs";
import { type Db, putBlob } from "@tender/db";
import {
  type Brief,
  canonicalJson,
  type Profile,
  type ReceiptOutcome,
  sha256Hex,
} from "@tender/shared";
import { type ApplyOptions, applyBlock } from "../../src/apply";
import type { IndexedBlock } from "../../src/types";

// Fixtures for the indexer's own tests, and for the tests of the packages that read what it writes
// (the API, the Telegram notifier). Import them as `@tender/indexer/testing`.
//
// Every event line comes from packages/shared/test/fixtures/events/<event>.log: real logs of the
// wasm contract, captured on a sandbox, except four that the contract did not emit yet when they
// were written (task_topped_up, attested_pick, delegate_added and delegate_removed; see
// packages/shared/test/events.test.ts). A line is used as it is, or as a copy in which only the
// `data` fields named in a patch differ (`eventLine` refuses a field the fixture does not have).
// Nothing is written from scratch. The lifecycle below patches these fields and no others:
//
//   agent_registered   alice  profile_hash -> the hash of FIXTURE_PROFILE, so her name resolves
//                      bob    account
//                      judge  account
//   task_created              brief_hash   -> the hash of FIXTURE_BRIEF, so the brief resolves
//   committed          bob    account, commitment, block_height
//   revealed           bob    account, content_hash, uri
//   picked                    none
//
// bob's and the judge's profile blobs are not stored, so their names stay null: the lifecycle has
// one agent whose profile resolves and two whose profile does not.

/** The account whose receipts the fixtures log. */
export const FIXTURE_CONTRACT = "tender.test.near";

/** The accounts of the captured logs. Everyone but the judge is also a possible agent. */
export const FIXTURE_ACCOUNTS = {
  poster: "poster.test.near",
  /** The verifier of the captured task, and the account that picks and voids. */
  judge: "judge.test.near",
  alice: "alice.test.near",
  bob: "bob.test.near",
  carol: "carol.test.near",
} as const;

/** The token of the captured task. */
export const FIXTURE_TOKEN = "token.test.near";

/** The id of the task in `lifecycleBlocks`, as the captured `task_created` has it. */
export const LIFECYCLE_TASK_ID = "1";

/** `applyBlock` options for the fixtures: the fixture contract, no team accounts. */
export const FIXTURE_OPTIONS: ApplyOptions = {
  contractId: FIXTURE_CONTRACT,
  cursorSource: "fixture",
  teamAccounts: [],
};

/** A brief that passes `BriefSchema`. The lifecycle's task points at it by hash. */
export const FIXTURE_BRIEF: Brief = {
  version: 1,
  title: "Extract invoice totals",
  summary: "Pull the total and the currency out of each invoice.",
  instructions: "For every invoice, return a JSON object with its total and its currency code.",
  category: "extraction",
  tags: ["extraction", "regex", "json"],
  output: { format: "regex_json", max_bytes: 4096 },
};
export const FIXTURE_BRIEF_HASH = sha256Hex(canonicalJson(FIXTURE_BRIEF));

/** A profile that passes `ProfileSchema`. The lifecycle's alice points at it by hash. */
export const FIXTURE_PROFILE: Profile = {
  name: "Alice Extractor",
  description: "Extracts structured data from text with regular expressions.",
  tags: ["extraction", "regex", "json"],
};
export const FIXTURE_PROFILE_HASH = sha256Hex(canonicalJson(FIXTURE_PROFILE));

/** What bob's captured-copy commit and reveal carry that alice's do not. */
export const BOB_ENTRY = {
  commitment: sha256Hex("bob commitment"),
  contentHash: sha256Hex("bob work"),
  uri: "ipfs://bob-work",
} as const;

const EVENT_PREFIX = "EVENT_JSON:";
const EVENT_FIXTURES = new URL("../../../shared/test/fixtures/events/", import.meta.url);

interface Envelope {
  standard: string;
  version: string;
  event: string;
  data: [Record<string, unknown>];
}

function capturedEnvelope(event: string): Envelope {
  const line = readFileSync(new URL(`${event}.log`, EVENT_FIXTURES), "utf8").trim();
  return JSON.parse(line.slice(EVENT_PREFIX.length)) as Envelope;
}

/** The `data` of the captured `event`, as the contract logged it. */
export function fixtureData(event: string): Record<string, unknown> {
  return capturedEnvelope(event).data[0];
}

/**
 * The log line of the captured `event`, with the `data` fields named in `patch` replaced. A patch
 * key that the fixture has no field for throws, so a misspelt key cannot pass for a patch.
 */
export function eventLine(event: string, patch: Record<string, unknown> = {}): string {
  const envelope = capturedEnvelope(event);
  const [data] = envelope.data;
  for (const key of Object.keys(patch)) {
    if (!(key in data)) throw new Error(`the ${event} fixture has no field "${key}" to patch`);
  }
  envelope.data = [{ ...data, ...patch }];
  return EVENT_PREFIX + JSON.stringify(envelope);
}

/** A successful receipt on the fixture contract that logs `logs`. */
export function receipt(
  receiptId: string,
  logs: string[],
  over: Partial<ReceiptOutcome> = {},
): ReceiptOutcome {
  return { receiptId, executorId: FIXTURE_CONTRACT, status: "success", logs, ...over };
}

const NS_PER_SECOND = 1_000_000_000n;
// A little before the captured task's created_at (1793307169820229000).
const EPOCH_NS = 1_793_307_000_000_000_000n;

/**
 * The block at `height` in which each of `lines` is logged by a receipt of its own, as when each
 * is one call. The receipt ids are unique to the height. Without `timestampNs`, the block's time is
 * one second per height from a fixed epoch.
 */
export function blockOf(
  height: number | bigint,
  lines: string[],
  timestampNs?: bigint,
): IndexedBlock {
  const h = BigInt(height);
  return {
    height: h,
    timestampNs: timestampNs ?? EPOCH_NS + h * NS_PER_SECOND,
    receipts: lines.map((line, i) => receipt(`receipt-${h}-${i}`, [line])),
  };
}

/**
 * Task 1 from start to finish, one event per block, in the order of the chain:
 *
 * | height | event                                  | block time (from the captured deadlines) |
 * | ------ | -------------------------------------- | ---------------------------------------- |
 * | 60-62  | alice, bob and the judge register      | before the task                          |
 * | 64     | the poster creates task 1              | `created_at`                             |
 * | 65, 66 | alice, then bob, commit                | in the commit window                     |
 * | 80, 81 | alice, then bob, reveal                | in the reveal window                     |
 * | 90     | the judge picks alice (70%) and bob    | in the judge's pick window               |
 *
 * Alice and bob register before they commit, so each has an `earned` slot for the task's token.
 * Afterwards task 1 has 2 commits and 2 reveals and is settled at height 90: alice won 665003 and
 * bob 285000 of the 1000003 reward, and the judge has made one pick. The brief and alice's
 * profile are blobs, which `putFixtureBlobs` stores; apply the blocks without them and the title
 * and alice's name stay null.
 */
export function lifecycleBlocks(): IndexedBlock[] {
  const task = fixtureData("task_created");
  const at = (field: string, seconds: bigint) =>
    BigInt(String(task[field])) + seconds * NS_PER_SECOND;
  const { bob, judge } = FIXTURE_ACCOUNTS;
  return [
    blockOf(
      60,
      [eventLine("agent_registered", { profile_hash: FIXTURE_PROFILE_HASH })],
      at("created_at", -30n),
    ),
    blockOf(61, [eventLine("agent_registered", { account: bob })], at("created_at", -20n)),
    blockOf(62, [eventLine("agent_registered", { account: judge })], at("created_at", -10n)),
    blockOf(
      64,
      [eventLine("task_created", { brief_hash: FIXTURE_BRIEF_HASH })],
      at("created_at", 0n),
    ),
    blockOf(65, [eventLine("committed")], at("created_at", 10n)),
    blockOf(
      66,
      [
        eventLine("committed", {
          account: bob,
          commitment: BOB_ENTRY.commitment,
          block_height: "66",
        }),
      ],
      at("created_at", 11n),
    ),
    blockOf(80, [eventLine("revealed")], at("commit_deadline", 10n)),
    blockOf(
      81,
      [
        eventLine("revealed", {
          account: bob,
          content_hash: BOB_ENTRY.contentHash,
          uri: BOB_ENTRY.uri,
        }),
      ],
      at("commit_deadline", 11n),
    ),
    blockOf(90, [eventLine("picked")], at("reveal_deadline", 10n)),
  ];
}

/**
 * Stores the blobs the lifecycle points at: the brief of task 1, as a public blob of kind `brief`,
 * and alice's profile, as a public blob of kind `profile`. The indexer reads no others.
 */
export async function putFixtureBlobs(db: Db): Promise<void> {
  await putBlob(db, {
    kind: "brief",
    contentType: "application/json",
    bytes: canonicalJson(FIXTURE_BRIEF),
    isPublic: true,
  });
  await putBlob(db, {
    kind: "profile",
    contentType: "application/json",
    bytes: canonicalJson(FIXTURE_PROFILE),
    isPublic: true,
  });
}

/**
 * Fills a migrated `db` with `lifecycleBlocks`: stores the blobs first, so the title, the
 * category, the tags and alice's name resolve, then applies every block in order. `options`
 * overrides `FIXTURE_OPTIONS`, such as `teamAccounts`.
 */
export async function seedLifecycle(db: Db, options: Partial<ApplyOptions> = {}): Promise<void> {
  await putFixtureBlobs(db);
  for (const block of lifecycleBlocks()) {
    await applyBlock(db, block, { ...FIXTURE_OPTIONS, ...options });
  }
}
