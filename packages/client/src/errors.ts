/**
 * A transaction that failed on chain, or a call to the node that ran out of time. `code` says why,
 * in the contract's terms:
 *
 * - a code the contract panicked with, such as `E_AUTH` or `E_PHASE` (the full list is `err` in
 *   `contract/tender/src/types.rs`);
 * - or one of four codes of the client's own, which the contract never emits. `E_ARGS` and
 *   `E_INITIALIZED` name panics of the wrappers near-sdk generates around a method, `E_UNKNOWN` is
 *   every failure the client cannot name (see `errorCodeOf`), and `E_TIMEOUT` is a call to the node
 *   that was not answered in time (see `TenderClient`). `E_TIMEOUT` says nothing of the contract: a
 *   send that timed out may have run all the same, so it is a failure to look into and not a
 *   refusal to give up on.
 *
 * `message` is the failure as the chain reported it, and `txHash` the transaction's hash. `cause`
 * holds the raw failure from the RPC. An `E_TIMEOUT` has neither a `txHash` nor a `cause`: its
 * message names the call and the time it had, and nothing of the node. That of a send adds that the
 * transaction may still land, and to read the chain before sending it again.
 */
export class TenderError extends Error {
  readonly code: string;
  readonly txHash?: string;

  constructor(code: string, message: string, options: { txHash?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TenderError";
    this.code = code;
    this.txHash = options.txHash;
  }
}

/**
 * The contract's error code in `msg`: the first `E_<NAME>:` in it, without the colon, or null.
 * Every panic of the contract starts with its code, as `"<CODE>: <detail>"`. This searches the
 * whole text, so it also finds a code that is not the contract's, such as one near-sdk echoes from
 * the caller's arguments; `errorCodeOf` takes only a code the panic starts with.
 */
export function parseContractError(msg: string): string | null {
  return /(E_[A-Z_]+):/.exec(msg)?.[1] ?? null;
}

/**
 * A code at the start of a panic's text: the contract's own, since all its panics start with one.
 * The chain reports the text after `Smart contract panicked: `.
 */
const LEADING_CODE = /^(?:Smart contract panicked: )?(E_[A-Z_]+):/;

/**
 * The texts of the panics that near-sdk 5.29.1's generated wrappers raise before a method's own
 * code runs, and the client code each maps to (ruling P02-R16). `E_ARGS` and `E_INITIALIZED` are
 * client codes: the contract has no such error.
 */
const SDK_PANICS: ReadonlyArray<readonly [RegExp, string]> = [
  // assert_one_yocto: an owner setter, withdraw or storage_withdraw without exactly 1 yoctoNEAR.
  [/Requires attached deposit of exactly 1 yoctoNEAR/, "E_AUTH"],
  // #[private]: `new`, `migrate` or a callback, called by anyone but the contract itself.
  [/Method \w+ is private/, "E_AUTH"],
  // Arguments that do not parse, a misspelled or unknown key among them.
  [/Failed to deserialize input from JSON/, "E_ARGS"],
  // NEAR attached to a method that is not #[payable].
  [/Method \w+ doesn't accept deposit/, "E_ARGS"],
  // A second `new`.
  [/The contract has already been initialized/, "E_INITIALIZED"],
];

/**
 * The code `TenderError` carries for a failure whose text is `message`: the contract's code if the
 * panic starts with one (after the chain's `Smart contract panicked: `), else the code of the
 * near-sdk panic it names (`E_AUTH`, `E_ARGS` or `E_INITIALIZED`), else `E_UNKNOWN`. A code further
 * into the text is not the contract's: near-sdk's `Failed to deserialize input from JSON` panic
 * quotes an unknown key, and a caller can write `E_AUTH:` as one.
 */
export function errorCodeOf(message: string): string {
  const code = LEADING_CODE.exec(message)?.[1];
  if (code !== undefined) return code;
  for (const [pattern, sdkCode] of SDK_PANICS) {
    if (pattern.test(message)) return sdkCode;
  }
  return "E_UNKNOWN";
}
