import { type DelegateView, DelegateViewSchema } from "@tender/shared";
import { type BondTerms, readBondTerms } from "./account";
import { config } from "./config";
import { type AccessKey, accessKeysOf, view } from "./rpc";

// What an agent's Safety section reads from the chain, beside what the API sends: the keys on its
// account; the delegate records of the keys among them that could spend (the contract has no view
// that lists an account's delegate keys, but a delegate key has to be one of the account's own keys
// to sign anything); and the bond terms in force, for how long an active agent's bond stays after
// it leaves. Each read stands alone: one that fails leaves the others, and the line it was for says
// it could not be read.

/** Who holds an agent to a line of its Safety section. */
export type Enforcer = "contract" | "near" | "runner";

/** The tag of a line: who holds the agent to it. */
export const ENFORCER_WORDS: Readonly<Record<Enforcer, string>> = {
  contract: "Enforced by the contract",
  near: "Enforced by NEAR",
  runner: "Default of the team’s runner",
};

/** The most of an account's keys the page asks `get_delegate` about, one request each. */
export const DELEGATE_CHECKS = 10;

/** The methods through which a delegate key spends (auth.rs, `authorize_spend`). */
const SPENDING_METHODS: readonly string[] = ["post_task", "top_up_task"];

/**
 * Whether `key` could spend through the delegate path of `contractId`: a function-call key for the
 * contract that may call `post_task` or `top_up_task` (an empty list allows every method). A
 * full-access key spends by attaching 1 yoctoNEAR, with no cap, and is not a delegate's.
 */
export function couldSpendAsDelegate(key: AccessKey, contractId: string): boolean {
  return (
    key.kind === "function_call" &&
    key.receiver === contractId &&
    (key.methods.length === 0 || key.methods.some((method) => SPENDING_METHODS.includes(method)))
  );
}

/** The delegate keys of an account, as the chain says. */
export interface DelegateCheck {
  /** Each key checked that the contract has a delegate record for, with that record. */
  found: Array<{ publicKey: string; view: DelegateView }>;
  /** How many more keys could spend as a delegate's, past `DELEGATE_CHECKS`, and were not asked about. */
  unchecked: number;
}

/** A read of the chain: what it answered, or that it could not be read just now. */
export type ChainRead<T> = { ok: true; value: T } | { ok: false };

export interface ChainFacts {
  /** The account's keys; null when the chain has no such account. */
  keys: ChainRead<AccessKey[] | null>;
  /** The delegate keys among them. Not read when the keys could not be. */
  delegates: ChainRead<DelegateCheck>;
  /** The bond terms in force. Read for an active agent only; null when not read. */
  terms: ChainRead<BondTerms> | null;
}

async function settled<T>(read: Promise<T>): Promise<ChainRead<T>> {
  try {
    return { ok: true, value: await read };
  } catch (error) {
    console.error(error);
    return { ok: false };
  }
}

/** The contract's record of `account`'s delegate key `publicKey` (`get_delegate`), or null. */
async function readDelegate(account: string, publicKey: string): Promise<DelegateView | null> {
  const found = await view<unknown>(config.contractId, "get_delegate", {
    account_id: account,
    public_key: publicKey,
  });
  return DelegateViewSchema.nullable().parse(found ?? null);
}

/**
 * The delegate records of the first `DELEGATE_CHECKS` of `keys` that could spend as a delegate's
 * (`couldSpendAsDelegate`), and how many more there are. One read that fails fails it all: "none"
 * has to be true of every key that was checked.
 */
async function checkDelegates(account: string, keys: readonly AccessKey[]): Promise<DelegateCheck> {
  const candidates = keys.filter((key) => couldSpendAsDelegate(key, config.contractId));
  const checked = candidates.slice(0, DELEGATE_CHECKS);
  const views = await Promise.all(checked.map((key) => readDelegate(account, key.publicKey)));
  return {
    found: checked.flatMap((key, index) => {
      const found = views[index];
      return found === null || found === undefined
        ? []
        : [{ publicKey: key.publicKey, view: found }];
    }),
    unchecked: candidates.length - checked.length,
  };
}

/**
 * The chain's side of `account`'s Safety section: its keys and the delegate records among them,
 * and the bond terms (when `active`), the terms beside the keys. It never throws: a read that fails
 * is `{ ok: false }`, and the error goes to the console.
 */
export async function readChainFacts(account: string, active: boolean): Promise<ChainFacts> {
  const keysAndDelegates = (async () => {
    const keys = await settled(accessKeysOf(account));
    if (!keys.ok) return { keys, delegates: { ok: false } as const };
    // An account the chain does not have has no key, so no delegate key.
    const delegates =
      keys.value === null
        ? { ok: true as const, value: { found: [], unchecked: 0 } }
        : await settled(checkDelegates(account, keys.value));
    return { keys, delegates };
  })();
  const [{ keys, delegates }, terms] = await Promise.all([
    keysAndDelegates,
    active ? settled(readBondTerms()) : Promise.resolve(null),
  ]);
  return { keys, delegates, terms };
}

// ---- In words ------------------------------------------------------------------------------------

/** How many keys of each kind an account has: full-access, limited to Tender, or to another account. */
export interface KeyCounts {
  full: number;
  tender: number;
  other: number;
}

export function countKeys(keys: readonly AccessKey[], contractId: string): KeyCounts {
  const counts: KeyCounts = { full: 0, tender: 0, other: 0 };
  for (const key of keys) {
    if (key.kind === "full_access") counts.full += 1;
    else if (key.receiver === contractId) counts.tender += 1;
    else counts.other += 1;
  }
  return counts;
}

/** The keys of an account in a line: `1 full-access key · 2 limited to Tender`. */
export function keysText({ full, tender, other }: KeyCounts): string {
  const parts = [
    full === 0 ? "No full-access key" : `${full} full-access ${full === 1 ? "key" : "keys"}`,
  ];
  if (tender > 0) parts.push(`${tender} limited to Tender`);
  if (other > 0) parts.push(`${other} for ${other === 1 ? "another contract" : "other contracts"}`);
  return parts.join(" · ");
}

/** A span of seconds in the largest whole unit that fits it: `14 days`, `1 hour`, `90 seconds`. */
export function durationText(secs: number): string {
  const units: Array<[seconds: number, one: string]> = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
  ];
  for (const [size, one] of units) {
    if (secs >= size && secs % size === 0) {
      const n = secs / size;
      return `${n} ${one}${n === 1 ? "" : "s"}`;
    }
  }
  return `${secs} second${secs === 1 ? "" : "s"}`;
}

/** A chain time in nanoseconds, in the reader's own time, with its ISO form for `<time>`. */
export function chainTimeText(ns: bigint): { iso: string; text: string } {
  const date = new Date(Number(ns / 1_000_000n));
  return {
    iso: date.toISOString(),
    text: date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
  };
}

/** A public key cut to its kind, its first four and its last four characters. */
export function shortKey(publicKey: string): string {
  const [kind, body] = publicKey.includes(":") ? publicKey.split(":", 2) : ["", publicKey];
  if (body === undefined || body.length <= 12) return publicKey;
  return `${kind === "" ? "" : `${kind}:`}${body.slice(0, 4)}…${body.slice(-4)}`;
}
