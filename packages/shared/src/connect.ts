import { z } from "zod";
import { agentSetupWasm } from "./agentSetup";
import { plainTextFault } from "./board";
import { depositCall, storageDepositCall, type TenderCall } from "./calls";
import { NETWORKS } from "./constants";
import { sha256Hex } from "./hash";
import { AccountIdSchema, U128StringSchema } from "./primitives";

// "Connect your agent" (owner decision of 2026-11-04): an agent provider adds an agent with one
// paste and one wallet approval, and Tender never holds the agent's key.
//
//   1. The owner, signed in, asks the API for a connect code for a name (`POST /v1/connect/codes`).
//      The code is bound to the owner and to the account `<name>.<owner>`, is good for 30 minutes
//      (`CONNECT_CODE_TTL_MS`), and attaches one public key, once.
//   2. The agent, where it runs, makes its own key and posts the PUBLIC half with the code
//      (`POST /v1/connect/attach`). The code is the post's only credential.
//   3. The owner's page shows the account and the key's fingerprint (`connectFingerprint`), which the
//      agent prints too, and one button. The owner's wallet makes the agent's account, sends it NEAR,
//      and pays its storage and its bond into its vault (`fundAgentCalls`), in one approval.
//   4. The agent registers itself with its own key, and says so (`POST /v1/connect/registered`).
//
// THE AGENT'S ACCOUNT (owner decision of 2026-11-05, after a wallet refused to add a full-access
// key). There are two ways, and the code's record says which one the owner took (`account_kind`):
//
//   - `sub_account` (the first try): `<name>.<owner>`, which the owner's transaction creates with
//     CreateAccount, Transfer, DeployContract (the setup code, `agentSetupWasm`) and a call of
//     `setup({"public_key": …})`, which adds the agent's key from inside the account
//     (contract/agent-setup). The wallet sees no AddKey action. Tender's directory lists the agent
//     under the owner as its provider (ASP), because only a parent can create a sub-account.
//   - `implicit` (when the wallet refuses that, or the owner chooses it): the agent's own implicit
//     account, the 64 hex characters of its public key (`implicitAccountOf`). The owner's
//     transaction is a plain Transfer to it, which every wallet sends; the chain creates the account
//     with that key. The contract gives such an account no provider, so the directory does not list
//     it under the owner. The API records the choice (`POST /v1/connect/codes/:id/implicit`) and the
//     agent waits for that account instead.
//
// A code reveals nothing secret and can only attach a public key. Whoever learns it before the
// agent can attach a key of their own, which is why the page shows the fingerprint to match with
// what the agent printed before anything is signed. And when a second, different key tries the code
// (the agent's, after someone else's), the API marks the code contested and the page refuses it. The
// rules on text are the question board's: a stranger's string is refused if it holds an invisible or
// control character (`plainTextFault`).

/** How long a code takes a key, from when it was made. */
export const CONNECT_CODE_TTL_MS = 30 * 60 * 1000;

/**
 * How long a code is kept after its 30 minutes, so that the owner's page can still read it and the
 * agent can still say it registered. Then the row is deleted.
 */
export const CONNECT_KEEP_MS = 24 * 60 * 60 * 1000;

/** What every code starts with, so that it is told apart from a key or a token at a glance. */
export const CONNECT_CODE_PREFIX = "tc_";

/** The 32 characters a code is written in: lower-case letters and the digits 2 to 7 (RFC 4648). */
export const CONNECT_CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** How many characters follow the prefix: 26, each of 5 random bits, 130 bits in all. */
export const CONNECT_CODE_CHARS = 26;

/** A connect code as the API makes one. */
export const CONNECT_CODE_PATTERN = /^tc_[a-z2-7]{26}$/;

/**
 * NEAR the owner's wallet sends the agent's new account: 0.1 NEAR, for its own storage on the chain
 * and its gas. It is the agent's from then on.
 *
 * An implicit account (182 bytes) locks none of it for storage, and `<name>.<owner>` with its setup
 * code (2,187 bytes) about 0.022 NEAR. The rest pays the agent's fees. Registering burnt 0.00026
 * NEAR in the sandbox (scripts/serve.sandbox.test.ts prints it); a commit or a reveal burns at most
 * about 3 Tgas, 0.0003 NEAR at the least gas price (2.99 and 2.73 Tgas at the worst, in the
 * contract's gas report, docs/research/S2-toolchain.md). So 0.1 NEAR pays for about 330 commits
 * and reveals on an implicit account, some 160 tasks entered and revealed, and about 260 on a
 * sub-account, some 130 tasks.
 */
export const AGENT_ACCOUNT_DEPOSIT = 10n ** 23n;

/**
 * The gas the owner's wallet attaches to the call of `setup` on the new account: 30 Tgas. The
 * transaction that creates the account burns about 10.5 Tgas in all, its receipts included
 * (contract/sandbox's agent_setup test prints it: 10.54), and what is not burnt is refunded.
 */
export const AGENT_SETUP_GAS = 30n * 10n ** 12n;

/**
 * NEAR the owner's wallet puts into the agent's storage balance with Tender: 0.02 NEAR, 2,000 bytes.
 * The account's record (at most 133 bytes), its vault slot for the bond's token (at most 200) and
 * the 1,024 bytes that registering asks to have free (`storageShortfall`) fit in it. What is left
 * stays the agent's, and it can take it back with `storage_withdraw`.
 */
export const AGENT_STORAGE_DEPOSIT = 2n * 10n ** 22n;

// ---- Keys and names -----------------------------------------------------------------------------

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** The bytes of `text` in Bitcoin's base58, as NEAR writes keys; null if it has a character base58 doesn't. */
export function base58Decode(text: string): Uint8Array | null {
  let value = 0n;
  for (const char of text) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  // Each leading "1" is a leading zero byte.
  for (const char of text) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** `bytes` in Bitcoin's base58, as NEAR writes keys. */
export function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let text = "";
  while (value > 0n) {
    text = BASE58[Number(value % 58n)] + text;
    value /= 58n;
  }
  // Each leading zero byte is a leading "1".
  for (const byte of bytes) {
    if (byte !== 0) break;
    text = `1${text}`;
  }
  return text;
}

const KEY_PREFIX = "ed25519:";

/**
 * Whether `text` is an ed25519 public key as NEAR writes one: `ed25519:` and the 32 bytes of the
 * key in base58, in its one spelling (base58 of fixed bytes has only one). A private key is 64 bytes
 * and is not one.
 */
export function isEd25519PublicKey(text: string): boolean {
  if (!text.startsWith(KEY_PREFIX)) return false;
  const body = text.slice(KEY_PREFIX.length);
  // 32 bytes are at most 44 characters; a longer run is no public key, and is not decoded.
  if (body.length === 0 || body.length > 44) return false;
  const bytes = base58Decode(body);
  return bytes !== null && bytes.length === 32 && base58Encode(bytes) === body;
}

/**
 * The fingerprint of a public key, which the owner's page and the agent both show so that a person
 * can see they name the same key: the first 64 bits of the SHA-256 of the key as it is written
 * (`ed25519:<base58>`), in four groups of four capital hex digits, such as `3F2A-91C0-77DE-0B14`.
 * Matching two fingerprints by eye is not a strong check on its own: someone who knows the agent's
 * fingerprint (from an earlier code, when the agent's key file is used again) could grind a key whose
 * first and last groups match it, which is 32 bits of work. All four groups (64 bits) are out of
 * reach. So the API also marks a code that two different keys tried (`contested`), and the page
 * then refuses to create the account whatever the fingerprints look like.
 */
export function connectFingerprint(publicKey: string): string {
  const hex = sha256Hex(publicKey).slice(0, 16).toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

/**
 * The implicit account of an ed25519 public key: the 64 lower-case hex characters of its 32 bytes.
 * The key controls it, and the chain creates it, with that key as its one full-access key, on the
 * first transfer to it. Null for anything that is not an ed25519 public key.
 */
export function implicitAccountOf(publicKey: string): string | null {
  if (!isEd25519PublicKey(publicKey)) return null;
  const bytes = base58Decode(publicKey.slice(KEY_PREFIX.length));
  if (bytes === null) return null;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** One part of an account id: lower-case letters and digits, joined by single `-` or `_`. */
const PART = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/** An implicit account: 64 hex characters, which has no room for a sub-account under it. */
const IMPLICIT = /^[0-9a-f]{64}$/;

/** The longest account id NEAR takes. */
export const MAX_ACCOUNT_LENGTH = 64;

export type NameReading = { ok: true; accountId: string } | { ok: false; message: string };

/**
 * The account an agent called `name` gets under `parent`: `<name>.<parent>`, a direct sub-account,
 * which `parent` alone can create. The name is one part of an account id, and the whole id is at
 * most 64 characters. The words of a refusal say what to change: the web page shows them, and the
 * API answers with them.
 */
export function readAgentName(name: string, parent: string): NameReading {
  if (IMPLICIT.test(parent) || parent.length + 2 > MAX_ACCOUNT_LENGTH) {
    return {
      ok: false,
      message: `${parent} is too long to have accounts under it. Connect a named account, such as you.testnet.`,
    };
  }
  const typed = name.trim();
  if (typed === "") return { ok: false, message: "Choose a name for the agent's account." };
  if (typed !== typed.toLowerCase()) {
    return { ok: false, message: "Use lower case: an account id has no capitals." };
  }
  if (typed.includes(".")) {
    return {
      ok: false,
      message: `One part only, with no dots: the account will be <name>.${parent}.`,
    };
  }
  if (!PART.test(typed)) {
    return {
      ok: false,
      message: "Use a to z and 0 to 9, with a single - or _ between them.",
    };
  }
  const accountId = `${typed}.${parent}`;
  if (accountId.length > MAX_ACCOUNT_LENGTH) {
    return {
      ok: false,
      message: `Too long: ${accountId} is ${accountId.length} characters, and an account id is ${MAX_ACCOUNT_LENGTH} at most.`,
    };
  }
  if (!AccountIdSchema.safeParse(accountId).success) {
    return { ok: false, message: "That doesn't make a valid account id." };
  }
  return { ok: true, accountId };
}

// ---- What to paste ------------------------------------------------------------------------------

/**
 * The command the owner pastes where the agent runs: the code, and the API it was made by, so that
 * nothing else has to be set first.
 */
export function connectCommand(code: string, apiUrl: string): string {
  return `pnpm agent:connect ${code} --api ${apiUrl}`;
}

/** What the owner tells an agent that has Tender's MCP server (its `connect_to_tender` tool). */
export function connectSentence(code: string): string {
  return `Connect to Tender with code ${code}`;
}

// ---- What the owner's wallet sends ---------------------------------------------------------------

/** The bond a contract takes at registration, in the token's smallest unit. */
export interface AgentBondTerms {
  token: string;
  amount: bigint;
}

/**
 * The calls that pay for the agent once its account exists, in the batch the owner's wallet signs
 * after the transaction that creates it: storage with Tender for the agent (`storage_deposit` with
 * `account_id`), and the bond, sent from the owner's own balance of the token straight into the
 * agent's vault (`ft_transfer_call` to Tender with `{"for":"<agent>"}`, which `ft_on_transfer`
 * credits to the account it names, once that account has a storage balance). `storage` is false
 * when the agent has a storage balance already, and `bond` is null when there is none to pay (no
 * bond is set, or its vault holds it). The bond token must have Tender registered, as every token
 * Tender takes does.
 *
 * If the deposit reaches Tender before the storage does, `ft_on_transfer` refuses it and the token
 * gives it back to the owner: nothing is lost, and the page offers to send it again.
 */
export function fundAgentCalls(plan: {
  contractId: string;
  accountId: string;
  storage: boolean;
  bond: AgentBondTerms | null;
}): TenderCall[] {
  const calls: TenderCall[] = [];
  if (plan.storage) {
    calls.push(storageDepositCall(plan.contractId, AGENT_STORAGE_DEPOSIT, plan.accountId));
  }
  if (plan.bond !== null && plan.bond.amount > 0n) {
    calls.push(depositCall(plan.bond.token, plan.contractId, plan.bond.amount, plan.accountId));
  }
  return calls;
}

/**
 * An action of the transaction that makes the agent's account, in a wallet connector's shape
 * (@hot-labs/near-connect 0.12.0). There is no AddKey among them: the sub-account gets the agent's
 * key from its setup code, and the implicit account from the chain.
 */
export type AgentAccountAction =
  | { type: "CreateAccount" }
  | { type: "Transfer"; params: { deposit: string } }
  | { type: "DeployContract"; params: { code: Uint8Array } }
  | {
      type: "FunctionCall";
      params: { methodName: string; args: { public_key: string }; gas: string; deposit: string };
    };

/**
 * The one transaction to `<name>.<owner>` that makes the agent's sub-account: CreateAccount, its
 * NEAR (`AGENT_ACCOUNT_DEPOSIT`), the setup code (`agentSetupWasm`, about 2 KB, which the account
 * keeps and pays storage for out of that NEAR) and the call of `setup` that adds `publicKey` as its
 * full-access key. Every action is undone if one fails.
 */
export function subAccountActions(publicKey: string): AgentAccountAction[] {
  return [
    { type: "CreateAccount" },
    { type: "Transfer", params: { deposit: AGENT_ACCOUNT_DEPOSIT.toString() } },
    { type: "DeployContract", params: { code: agentSetupWasm() } },
    {
      type: "FunctionCall",
      params: {
        methodName: "setup",
        args: { public_key: publicKey },
        gas: AGENT_SETUP_GAS.toString(),
        deposit: "0",
      },
    },
  ];
}

/**
 * The one transaction to the agent's implicit account (`implicitAccountOf`): its NEAR, which
 * creates it with the agent's key as its one full-access key. Every wallet sends a transfer.
 */
export function implicitAccountActions(): AgentAccountAction[] {
  return [{ type: "Transfer", params: { deposit: AGENT_ACCOUNT_DEPOSIT.toString() } }];
}

// ---- Requests ---------------------------------------------------------------------------------

/**
 * A string field of a connect request: plain text by the question board's rules (`plainTextFault`),
 * then `check`, whose fault is the message. The first fault is the only one reported.
 */
function field(check: (text: string) => string | null) {
  return z.string().superRefine((text, ctx) => {
    const fault = plainTextFault(text) ?? check(text);
    if (fault !== null) ctx.addIssue({ code: "custom", message: fault });
  });
}

/** One part of an account id, which the route then checks whole under the owner's account. */
const AgentNameField = field((name) =>
  name.length >= 1 && name.length <= MAX_ACCOUNT_LENGTH && PART.test(name)
    ? null
    : "expected one part of an account id: a to z and 0 to 9, with a single - or _ between them",
);

const CodeField = field((code) =>
  CONNECT_CODE_PATTERN.test(code)
    ? null
    : `expected a connect code: ${CONNECT_CODE_PREFIX} and ${CONNECT_CODE_CHARS} of a to z and 2 to 7`,
);

const PublicKeyField = field((key) =>
  isEd25519PublicKey(key) ? null : "expected a public key: ed25519: and 32 bytes in base58",
);

/** `POST /v1/connect/codes` (signed in): the name of the agent's account under the owner's. */
export const CreateConnectCodeRequestSchema = z.strictObject({ name: AgentNameField });
export type CreateConnectCodeRequest = z.infer<typeof CreateConnectCodeRequestSchema>;

/**
 * `POST /v1/connect/lookup`, `POST /v1/connect/contest` and `POST /v1/connect/registered`: the code,
 * in the body.
 */
export const ConnectCodeRequestSchema = z.strictObject({ code: CodeField });
export type ConnectCodeRequest = z.infer<typeof ConnectCodeRequestSchema>;

/** `POST /v1/connect/attach`: the code and the agent's public key. */
export const AttachConnectKeyRequestSchema = z.strictObject({
  code: CodeField,
  public_key: PublicKeyField,
});
export type AttachConnectKeyRequest = z.infer<typeof AttachConnectKeyRequestSchema>;

// ---- Responses --------------------------------------------------------------------------------

/**
 * Where a code stands, by the time of the request:
 * - `waiting`: no key yet, and the 30 minutes are not over;
 * - `expired`: no key came in the 30 minutes, and none can now;
 * - `attached`: a key is attached, so the owner can create the account;
 * - `registered`: the agent said it registered, and the index showed it active when it did;
 * - `contested`: a second, different key tried the code after one was attached (`contested_at`),
 *   so someone else has it. This wins over every other state: the page creates nothing for it.
 */
export const ConnectStateSchema = z.enum([
  "waiting",
  "expired",
  "attached",
  "registered",
  "contested",
]);
export type ConnectState = z.infer<typeof ConnectStateSchema>;

/**
 * The name of a code's account, as an answer carries it: one part of an account id, by the same
 * rule a request is held to. An answer that carries anything else fails to parse, so no text a
 * server chose reaches an agent or a page through it.
 */
const AgentNameAnswer = z
  .string()
  .refine(
    (name) => name.length >= 1 && name.length <= MAX_ACCOUNT_LENGTH && PART.test(name),
    "expected one part of an account id",
  );

/**
 * Which account the agent gets (see the top of this file): `<name>.<owner>`, or the implicit
 * account of its key. An answer from an API older than the choice has no field, which means the
 * sub-account, the only way there was.
 */
export const ConnectAccountKindSchema = z.enum(["sub_account", "implicit"]);
export type ConnectAccountKind = z.infer<typeof ConnectAccountKindSchema>;

const AccountKindAnswer = ConnectAccountKindSchema.default("sub_account");

/** A public key in an answer: `ed25519:` and 32 bytes, or the answer fails to parse. */
const PublicKeyAnswer = z
  .string()
  .refine(isEd25519PublicKey, "expected a public key: ed25519: and 32 bytes in base58");

/** A fingerprint as `connectFingerprint` writes one. */
export const ConnectFingerprintSchema = z
  .string()
  .regex(/^[0-9A-F]{4}(?:-[0-9A-F]{4}){3}$/, "expected a key fingerprint");

/** `POST /v1/connect/codes`. The code is shown once: the API keeps only its hash. */
export const ConnectCodeCreatedSchema = z.object({
  /** The handle the owner's page reads the code's state by. It is no credential. */
  id: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  code: z.string().regex(CONNECT_CODE_PATTERN),
  owner: AccountIdSchema,
  name: AgentNameAnswer,
  account_id: AccountIdSchema,
  /** ISO 8601 in UTC to the millisecond: when the code stops taking a key. */
  expires_at: z.iso.datetime(),
});
export type ConnectCodeCreated = z.infer<typeof ConnectCodeCreatedSchema>;

/** The agent as the index holds it, or null while the index does not. */
export const ConnectAgentSchema = z
  .object({
    status: z.enum(["active", "unregistering", "retired"]),
    bond_token: AccountIdSchema.nullable(),
    bond_amount: U128StringSchema.nullable(),
  })
  .nullable();

/**
 * `GET /v1/connect/codes/:id` (signed in as the code's owner), and `POST
 * /v1/connect/codes/:id/implicit`. `account_id` is the account the agent gets: `<name>.<owner>`, or,
 * once `account_kind` is `implicit`, the implicit account of `public_key`.
 */
export const ConnectCodeStateSchema = z.object({
  id: z.string(),
  owner: AccountIdSchema,
  name: AgentNameAnswer,
  account_id: AccountIdSchema,
  account_kind: AccountKindAnswer,
  state: ConnectStateSchema,
  created_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  /** The key the agent attached, and its fingerprint; null until one is. */
  public_key: PublicKeyAnswer.nullable(),
  fingerprint: ConnectFingerprintSchema.nullable(),
  attached_at: z.iso.datetime().nullable(),
  registered_at: z.iso.datetime().nullable(),
  /** When a second, different key tried the code: someone else has it. Null while none has. */
  contested_at: z.iso.datetime().nullable(),
  /** The account as the index holds it: null until it registers. */
  agent: ConnectAgentSchema,
});
export type ConnectCodeState = z.infer<typeof ConnectCodeStateSchema>;

const NetworkSchema = z.enum(Object.keys(NETWORKS) as ["sandbox", "testnet", "mainnet"]);

/**
 * `POST /v1/connect/lookup`, `POST /v1/connect/attach` and `POST /v1/connect/contest`: what the
 * code is for, as the agent needs it: the account it will be (`<name>.<owner>`, or the implicit
 * account of the key attached once the owner chose it), on which network and contract.
 * `fingerprint` is that of the key attached, null while none is.
 */
export const ConnectLookupSchema = z.object({
  owner: AccountIdSchema,
  name: AgentNameAnswer,
  account_id: AccountIdSchema,
  account_kind: AccountKindAnswer,
  network: NetworkSchema,
  contract: AccountIdSchema,
  state: ConnectStateSchema,
  expires_at: z.iso.datetime(),
  fingerprint: ConnectFingerprintSchema.nullable(),
});
export type ConnectLookup = z.infer<typeof ConnectLookupSchema>;

/** `POST /v1/connect/registered`. */
export const ConnectRegisteredSchema = z.object({
  account_id: AccountIdSchema,
  state: z.literal("registered"),
  registered_at: z.iso.datetime(),
});
export type ConnectRegistered = z.infer<typeof ConnectRegisteredSchema>;

/**
 * `GET /v1/connect/implicit` (signed in): the agents the owner set up as implicit accounts, which
 * the directory does not list under them, newest first. The record is the owner's own word, kept by
 * the API: nothing on the chain links the two. `agent` is the account as the index holds it.
 */
export const ConnectImplicitAgentsSchema = z.object({
  agents: z.array(
    z.object({
      /** The code's id, by which its owner dismisses an agent that never registered. */
      id: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
      account_id: AccountIdSchema,
      name: AgentNameAnswer,
      created_at: z.iso.datetime(),
      agent: ConnectAgentSchema,
    }),
  ),
});
export type ConnectImplicitAgents = z.infer<typeof ConnectImplicitAgentsSchema>;

/** `POST /v1/connect/codes/:id/dismiss`: the implicit agent's record is gone. */
export const ConnectDismissedSchema = z.object({ dismissed: z.literal(true) });
export type ConnectDismissed = z.infer<typeof ConnectDismissedSchema>;
