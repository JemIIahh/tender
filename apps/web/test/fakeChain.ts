import { baseEncode, decodeSignedTransaction } from "near-api-js";

// An in-memory model of the Tender contract and its tokens, as far as the wallet page uses them:
// the storage balance, the vault, a token's own balances and registrations, and the five calls
// that change them. It answers the views the page reads and runs the calls a wallet sends, and it
// writes what the contract writes: the same panics, the same events, the same receipts. The unit
// tests and the e2e specs share it, so a spec that fails has found a bug in the page, not in a
// double that two files describe differently. It is not a chain: one call runs to its end before
// the next starts, and there are no blocks.

const YOCTO = 10n ** 24n;
/** `STORAGE_MIN_DEPOSIT` in the contract: the least a first `storage_deposit` may attach. */
const MIN_STORAGE_DEPOSIT = 10n ** 22n;
/** What one byte of contract state costs (`STORAGE_BYTE_COST`), and what a new account uses. */
const BYTE_COST = 10n ** 19n;
const REGISTRATION_BYTES = 133n;
/** What NEP-145 `registration_only` keeps at a token, in yoctoNEAR. */
const TOKEN_REGISTRATION_COST = 1_250_000_000_000_000_000_000n;

export const NEAR = (whole: number): bigint =>
  BigInt(Math.round(whole * 1e6)) * (YOCTO / 10n ** 6n);

/** One line of the contract's event log, as `emit` in contract/tender/src/events.rs writes it. */
export function eventLine(event: string, data: Record<string, unknown>): string {
  return `EVENT_JSON:${JSON.stringify({ standard: "tender", version: "1.0.0", event, data: [data] })}`;
}

/** A receipt of a transaction, as the RPC lists it. */
export interface ReceiptOutcome {
  id: string;
  outcome: { executor_id: string; logs: string[]; status: unknown };
}

/** A final transaction outcome, as far as the app reads one (and `FinalExecutionOutcome` has it). */
export interface Outcome {
  final_execution_status: "FINAL";
  status: { SuccessValue: string } | { Failure: unknown };
  transaction: { hash: string; signer_id: string; receiver_id: string };
  transaction_outcome: { id: string };
  receipts_outcome: ReceiptOutcome[];
}

/** A function call as a wallet is asked to make it: gas and deposit are decimal strings. */
export interface WalletAction {
  type: "FunctionCall";
  params: { methodName: string; args: object; gas: string; deposit: string };
}

/** One call the chain has run, in the order it ran. */
export interface AppliedCall {
  signer: string;
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  gas: bigint;
  deposit: bigint;
  /** Whether it ran to its end. A panic leaves the state as it was. */
  ok: boolean;
}

/** A panic of the contract, such as `E_FUNDS`. It fails the transaction and changes nothing. */
class Panic extends Error {}

const panic = (code: string, detail: string) => new Panic(`${code}: ${detail}`);

function failure(message: string): { Failure: unknown } {
  return {
    Failure: {
      ActionError: {
        index: 0,
        kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${message}` } },
      },
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export interface TokenSetup {
  token: string;
  enabled?: boolean;
}

export class FakeChain {
  /** Every call that ran, a failed one included. */
  readonly calls: AppliedCall[] = [];
  /** The allowlisted tokens and whether each is enabled. */
  readonly tokens = new Map<string, boolean>();
  /** Tender's storage balance of each account: what it deposited, and the bytes it uses. */
  readonly storage = new Map<string, { total: bigint; usedBytes: bigint }>();
  /** The vault: an account's balance of a token. A slot exists once a key is there. */
  readonly vault = new Map<string, Map<string, bigint>>();
  /** What each account holds of each token itself, outside Tender. */
  readonly ftBalances = new Map<string, Map<string, bigint>>();
  /** The accounts each token has registered (NEP-145). */
  readonly ftRegistered = new Map<string, Set<string>>();
  /** NEAR each account has paid out of its own balance, which a test can read back. */
  readonly nearSpent = new Map<string, bigint>();
  private counter = 0;

  constructor(
    readonly contractId: string,
    tokens: TokenSetup[],
  ) {
    for (const { token, enabled = true } of tokens) {
      this.tokens.set(token, enabled);
      this.ftBalances.set(token, new Map());
      this.ftRegistered.set(token, new Set());
    }
  }

  // ---- Set-up for a test ------------------------------------------------------------------------

  /** Gives `account` `amount` of `token`, and registers it with the token unless told not to. */
  give(token: string, account: string, amount: bigint, registered = true): void {
    this.balances(token).set(account, (this.balances(token).get(account) ?? 0n) + amount);
    if (registered) this.registered(token).add(account);
  }

  /** Gives `account` a storage balance with Tender and a vault balance of `token`. */
  fundVault(account: string, token: string, amount: bigint): void {
    this.storage.set(account, { total: NEAR(0.05), usedBytes: REGISTRATION_BYTES + 40n });
    this.slots(account).set(token, amount);
  }

  // ---- Views --------------------------------------------------------------------------------------

  /** The JSON a view returns. A method the contract does not have is an error. */
  view(contractId: string, method: string, args: Record<string, unknown>): unknown {
    const account = typeof args.account_id === "string" ? args.account_id : "";
    if (contractId === this.contractId) {
      switch (method) {
        case "get_config":
          return {
            owner: this.contractId,
            pending_owner: null,
            treasury: this.contractId,
            fee_bps: 500,
            min_window_secs: 60,
            max_window_secs: 1_209_600,
            paused: false,
            version: 1,
            tokens: [...this.tokens].map(([token, enabled]) => ({
              token,
              min_reward: "1",
              max_reward: "340282366920938463463374607431768211455",
              enabled,
            })),
          };
        case "storage_balance_of":
          return this.storageView(account);
        case "balances_of":
          return [...(this.vault.get(account) ?? [])].map(([token, amount]) => ({
            token,
            amount: amount.toString(),
          }));
        default:
          throw new Error(`MethodNotFound: ${method}`);
      }
    }
    if (this.tokens.has(contractId)) {
      switch (method) {
        case "ft_balance_of":
          return (this.balances(contractId).get(account) ?? 0n).toString();
        case "storage_balance_of":
          return this.registered(contractId).has(account)
            ? { total: TOKEN_REGISTRATION_COST.toString(), available: "0" }
            : null;
        default:
          throw new Error(`MethodNotFound: ${method}`);
      }
    }
    throw new Error(`CodeDoesNotExist: ${contractId}`);
  }

  private storageView(account: string) {
    const record = this.storage.get(account);
    if (record === undefined) return null;
    const free = record.total - record.usedBytes * BYTE_COST;
    return {
      total: record.total.toString(),
      available: (free < 0n ? 0n : free).toString(),
      used_bytes: record.usedBytes.toString(),
    };
  }

  // ---- Calls --------------------------------------------------------------------------------------

  /**
   * What a wallet does with a batch: signs each transaction as `signer` and runs it, one after the
   * other, and stops at the first that fails (the outcomes so far are returned with it, last).
   */
  send(
    signer: string,
    transactions: ReadonlyArray<{ receiverId: string; actions: readonly WalletAction[] }>,
  ): Outcome[] {
    const outcomes: Outcome[] = [];
    for (const { receiverId, actions } of transactions) {
      const outcome = this.runTransaction(signer, receiverId, actions);
      outcomes.push(outcome);
      if ("Failure" in outcome.status) break;
    }
    return outcomes;
  }

  /** Runs the actions of one transaction as a block of its own, all or none. */
  private runTransaction(
    signer: string,
    receiverId: string,
    actions: readonly WalletAction[],
  ): Outcome {
    const hash = `tx${++this.counter}`;
    const receipts: ReceiptOutcome[] = [];
    let status: Outcome["status"] = { SuccessValue: "" };
    const before = this.snapshot();
    for (const { params } of actions) {
      const call: AppliedCall = {
        signer,
        receiverId,
        methodName: params.methodName,
        args: asRecord(params.args),
        gas: BigInt(params.gas),
        deposit: BigInt(params.deposit),
        ok: true,
      };
      this.calls.push(call);
      try {
        receipts.push(...this.run(call));
      } catch (error) {
        if (!(error instanceof Panic)) throw error;
        call.ok = false;
        this.restore(before);
        status = failure(error.message);
        receipts.push(this.receipt(receiverId, [], failure(error.message)));
        break;
      }
    }
    return {
      final_execution_status: "FINAL",
      status,
      transaction: { hash, signer_id: signer, receiver_id: receiverId },
      transaction_outcome: { id: hash },
      receipts_outcome: receipts,
    };
  }

  private run(call: AppliedCall): ReceiptOutcome[] {
    const { signer, receiverId, methodName, args, deposit, gas } = call;
    this.nearSpent.set(signer, (this.nearSpent.get(signer) ?? 0n) + deposit);
    if (receiverId === this.contractId) {
      switch (methodName) {
        case "storage_deposit":
          return this.storageDeposit(signer, args, deposit);
        case "withdraw":
          return this.withdraw(signer, args, deposit, gas);
        case "storage_withdraw":
          return this.storageWithdraw(signer, args, deposit);
        default:
          throw panic("E_ARGS", `no such method ${methodName}`);
      }
    }
    if (this.tokens.has(receiverId)) {
      switch (methodName) {
        case "storage_deposit":
          this.registered(receiverId).add(String(args.account_id ?? signer));
          return [this.receipt(receiverId, [])];
        case "ft_transfer_call":
          return this.ftTransferCall(receiverId, signer, args, deposit);
        default:
          throw panic("E_ARGS", `no such method ${methodName}`);
      }
    }
    throw panic("E_ARGS", `no contract at ${receiverId}`);
  }

  private storageDeposit(signer: string, args: Record<string, unknown>, deposit: bigint) {
    const account = typeof args.account_id === "string" ? args.account_id : signer;
    const record = this.storage.get(account);
    if (record === undefined && deposit < MIN_STORAGE_DEPOSIT) {
      throw panic("E_MIN_DEPOSIT", "the first deposit must be at least 0.01 NEAR");
    }
    const next = {
      total: (record?.total ?? 0n) + deposit,
      usedBytes: record?.usedBytes ?? REGISTRATION_BYTES + 40n,
    };
    this.storage.set(account, next);
    return [
      this.receipt(this.contractId, [
        eventLine("storage_deposit", {
          account,
          amount: deposit.toString(),
          total: next.total.toString(),
        }),
      ]),
    ];
  }

  private storageWithdraw(signer: string, args: Record<string, unknown>, deposit: bigint) {
    if (deposit !== 1n) throw panic("E_YOCTO", "requires exactly 1 yoctoNEAR");
    const record = this.storage.get(signer);
    if (record === undefined) throw panic("E_STORAGE", "no storage balance");
    const free = record.total - record.usedBytes * BYTE_COST;
    const available = free < 0n ? 0n : free;
    const amount = typeof args.amount === "string" ? BigInt(args.amount) : available;
    if (amount > available) throw panic("E_STORAGE", "more than the unused storage balance");
    this.storage.set(signer, { ...record, total: record.total - amount });
    return [this.receipt(this.contractId, [])];
  }

  private withdraw(signer: string, args: Record<string, unknown>, deposit: bigint, gas: bigint) {
    if (deposit !== 1n) throw panic("E_YOCTO", "requires exactly 1 yoctoNEAR");
    if (gas < 35_000_000_000_000n) throw panic("E_GAS", "withdraw needs at least 35 Tgas");
    const token = String(args.token);
    const amount = BigInt(String(args.amount));
    const to = typeof args.to === "string" ? args.to : signer;
    if (amount === 0n) throw panic("E_FUNDS", "amount must be positive");
    const balance = this.slots(signer).get(token);
    if (balance === undefined || balance < amount) {
      throw panic("E_FUNDS", "insufficient vault balance");
    }
    // Debit first; the token pays; a callback restores the balance if it could not.
    this.slots(signer).set(token, balance - amount);
    const data = { account: signer, token, amount: amount.toString(), to };
    const held = this.balances(token).get(this.contractId) ?? 0n;
    if (this.registered(token).has(to) && held >= amount) {
      this.balances(token).set(this.contractId, held - amount);
      this.balances(token).set(to, (this.balances(token).get(to) ?? 0n) + amount);
      return [
        this.receipt(this.contractId, []),
        this.receipt(token, []),
        this.receipt(this.contractId, [eventLine("withdraw", data)]),
      ];
    }
    this.slots(signer).set(token, balance);
    return [
      this.receipt(this.contractId, []),
      this.receipt(token, [], failure("The account is not registered")),
      this.receipt(this.contractId, [eventLine("withdraw_failed", data)]),
    ];
  }

  private ftTransferCall(
    token: string,
    signer: string,
    args: Record<string, unknown>,
    deposit: bigint,
  ) {
    if (deposit !== 1n) throw panic("E_YOCTO", "requires exactly 1 yoctoNEAR");
    const amount = BigInt(String(args.amount));
    const held = this.balances(token).get(signer) ?? 0n;
    if (!this.registered(token).has(signer)) throw panic("E_TOKEN", "the sender is not registered");
    if (held < amount) throw panic("E_TOKEN", "not enough balance");
    if (args.receiver_id !== this.contractId) throw panic("E_TOKEN", "unsupported receiver");

    // ft_on_transfer never panics: it credits the deposit or hands all of it back.
    const msg = typeof args.msg === "string" ? args.msg : "";
    let beneficiary = signer;
    let accepted = this.tokens.get(token) === true && amount > 0n;
    if (msg !== "") {
      const named = asRecord(JSON.parse(msg)).for;
      if (typeof named === "string") beneficiary = named;
      else accepted = false;
    }
    if (!this.storage.has(beneficiary)) accepted = false;

    const logs: string[] = [];
    if (accepted) {
      this.balances(token).set(signer, held - amount);
      this.balances(token).set(
        this.contractId,
        (this.balances(token).get(this.contractId) ?? 0n) + amount,
      );
      const slots = this.slots(beneficiary);
      slots.set(token, (slots.get(token) ?? 0n) + amount);
      logs.push(
        eventLine("deposit", {
          account: beneficiary,
          token,
          amount: amount.toString(),
          sender: signer,
        }),
      );
    }
    return [this.receipt(token, []), this.receipt(this.contractId, logs), this.receipt(token, [])];
  }

  // ---- Bookkeeping --------------------------------------------------------------------------------

  private receipt(executor: string, logs: string[], status: unknown = { SuccessValue: "" }) {
    return { id: `r${++this.counter}`, outcome: { executor_id: executor, logs, status } };
  }

  private balances(token: string): Map<string, bigint> {
    const map = this.ftBalances.get(token);
    if (map === undefined) throw new Error(`no such token: ${token}`);
    return map;
  }

  private registered(token: string): Set<string> {
    const set = this.ftRegistered.get(token);
    if (set === undefined) throw new Error(`no such token: ${token}`);
    return set;
  }

  private slots(account: string): Map<string, bigint> {
    let slots = this.vault.get(account);
    if (slots === undefined) {
      slots = new Map();
      this.vault.set(account, slots);
    }
    return slots;
  }

  private snapshot() {
    const copy = <K, V>(map: Map<K, V>) => new Map(map);
    return {
      storage: copy(this.storage),
      vault: new Map([...this.vault].map(([account, slots]) => [account, copy(slots)])),
      ftBalances: new Map([...this.ftBalances].map(([token, held]) => [token, copy(held)])),
      ftRegistered: new Map([...this.ftRegistered].map(([token, set]) => [token, new Set(set)])),
      nearSpent: copy(this.nearSpent),
    };
  }

  private restore(saved: ReturnType<FakeChain["snapshot"]>): void {
    for (const key of ["storage", "vault", "ftBalances", "ftRegistered", "nearSpent"] as const) {
      const live = this[key] as Map<unknown, unknown>;
      live.clear();
      for (const [k, v] of saved[key] as Map<unknown, unknown>) live.set(k, v);
    }
  }
}

// ---- The node: JSON-RPC ------------------------------------------------------------------------

/** What an RPC node answers: a result, or an error. */
export type RpcAnswer = { result: unknown } | { error: unknown };

const BLOCK_HASH = baseEncode(new Uint8Array(32).fill(7));

/**
 * The JSON-RPC calls `lib/rpc.ts` makes (`query` / `call_function`) and the ones near-api-js makes
 * to send a transaction as the dev wallet: an access key's nonce, a recent block, and `send_tx`,
 * which decodes the signed transaction, checks it came from `key`, and runs it on `chain`.
 */
export class FakeNode {
  /** The signed transactions the node has been sent, decoded. */
  readonly received: Array<{
    signerId: string;
    publicKey: string;
    receiverId: string;
    nonce: bigint;
    actions: Array<{ methodName: string; args: unknown; gas: bigint; deposit: bigint }>;
  }> = [];
  private nonce = 0n;

  constructor(
    readonly chain: FakeChain,
    /** The key the node knows for `account`: `ed25519:<base58>`. Without one it has no accounts. */
    private readonly known?: { account: string; publicKey: string },
  ) {}

  /** Answers one JSON-RPC request the way a node does. */
  handle(request: { method: string; params: unknown }): RpcAnswer {
    const params = asRecord(request.params);
    switch (request.method) {
      case "query":
        return this.query(params);
      case "block":
        return { result: { header: { hash: BLOCK_HASH, height: 100, timestamp_nanosec: "1" } } };
      case "send_tx":
        return this.sendTx(String(params.signed_tx_base64));
      default:
        return { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_METHOD" } } };
    }
  }

  private query(params: Record<string, unknown>): RpcAnswer {
    if (params.request_type === "call_function") {
      const args = JSON.parse(atob(String(params.args_base64)) || "{}");
      try {
        const value = this.chain.view(String(params.account_id), String(params.method_name), args);
        const bytes = new TextEncoder().encode(JSON.stringify(value));
        return {
          result: { result: [...bytes], logs: [], block_height: 100, block_hash: BLOCK_HASH },
        };
      } catch (error) {
        const message = (error as Error).message;
        return { result: { error: message, logs: [], block_height: 100, block_hash: BLOCK_HASH } };
      }
    }
    if (params.request_type === "view_access_key") {
      return {
        result: {
          nonce: Number(this.nonce),
          permission: "FullAccess",
          block_height: 100,
          block_hash: BLOCK_HASH,
        },
      };
    }
    return { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_QUERY" } } };
  }

  private sendTx(base64: string): RpcAnswer {
    const signed = decodeSignedTransaction(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
    const { transaction } = signed;
    const publicKey = transaction.publicKey.toString();
    if (
      this.known === undefined ||
      transaction.signerId !== this.known.account ||
      publicKey !== this.known.publicKey
    ) {
      return { error: { name: "HANDLER_ERROR", cause: { name: "INVALID_TRANSACTION" } } };
    }
    const actions = transaction.actions.map((action) => {
      const call = action.functionCall;
      if (call === undefined) throw new Error("the fake node runs function calls only");
      return {
        methodName: call.methodName,
        // `Uint8Array.from`: the bytes come from another realm than jsdom's, which its decoder refuses.
        args: JSON.parse(new TextDecoder().decode(Uint8Array.from(call.args))),
        gas: BigInt(call.gas),
        deposit: BigInt(call.deposit),
      };
    });
    this.nonce = BigInt(transaction.nonce);
    this.received.push({
      signerId: transaction.signerId,
      publicKey,
      receiverId: transaction.receiverId,
      nonce: this.nonce,
      actions,
    });
    const [outcome] = this.chain.send(transaction.signerId, [
      {
        receiverId: transaction.receiverId,
        actions: actions.map(({ methodName, args, gas, deposit }) => ({
          type: "FunctionCall" as const,
          params: {
            methodName,
            args: args as object,
            gas: gas.toString(),
            deposit: deposit.toString(),
          },
        })),
      },
    ]);
    return { result: outcome };
  }
}

/**
 * A `fetch` for a test that routes by address: JSON-RPC posts to `rpcUrl` go to `node`, anything
 * else to `others`, and a path nobody serves is a 404 in the API's own words.
 */
export function fakeFetch(
  rpcUrl: string,
  node: FakeNode,
  others: (url: URL, init?: RequestInit) => Response | Promise<Response> = () =>
    new Response(JSON.stringify({ error: "not_found", message: "no such route" }), { status: 404 }),
): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (String(input).startsWith(rpcUrl)) {
      const request = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, ...node.handle(request) }),
      );
    }
    return others(url, init);
  };
}
