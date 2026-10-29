/**
 * A transaction that failed on chain. `code` says why, in the contract's terms:
 *
 * - a code the contract panicked with, such as `E_AUTH` or `E_PHASE` (the full list is `err` in
 *   `contract/tender/src/types.rs`);
 * - or one of three codes of the client's own, which the contract never emits. `E_ARGS` and
 *   `E_INITIALIZED` name panics of the wrappers near-sdk generates around a method, and
 *   `E_UNKNOWN` is every failure the client cannot name (see `errorCodeOf`).
 *
 * `message` is the failure as the chain reported it, and `txHash` the transaction's hash. `cause`
 * holds the raw failure from the RPC.
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
 * Every panic of the contract starts with its code, as `"<CODE>: <detail>"`.
 */
export function parseContractError(msg: string): string | null {
  return /(E_[A-Z_]+):/.exec(msg)?.[1] ?? null;
}

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
 * text has one (`parseContractError`), else the code of the near-sdk panic it names (`E_AUTH`,
 * `E_ARGS` or `E_INITIALIZED`), else `E_UNKNOWN`.
 */
export function errorCodeOf(message: string): string {
  const code = parseContractError(message);
  if (code !== null) return code;
  for (const [pattern, sdkCode] of SDK_PANICS) {
    if (pattern.test(message)) return sdkCode;
  }
  return "E_UNKNOWN";
}
