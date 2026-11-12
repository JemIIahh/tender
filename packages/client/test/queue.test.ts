import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { KeyPair } from "near-api-js";
import { InvalidNonceError, InvalidNonceIndexError } from "near-api-js/rpc-errors";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { KeyQueue, type Signer, TenderClient, TenderError, toTxResult } from "../src/index";

const CONTRACT = "tender.test.near";

/** A promise and the functions that settle it. */
function deferred<T = void>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every callback of a settled promise run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A nonce collision exactly as near-api-js 7.4.0 throws it when the RPC turns a transaction down:
 * an `InvalidNonceError` from `near-api-js/rpc-errors`, built from the RPC's
 * `InvalidTxError.InvalidNonce` with empty hashes. These nonces are the ones four of five clients
 * of one key got on the local chain, when all five sent their first transaction at once.
 */
const nearApiCollision = () => new InvalidNonceError(42000004, 42000004, "", "");

/** The same error from another copy of near-api-js, which `instanceof` does not know. */
const otherCopyCollision = () =>
  Object.assign(new Error("Invalid nonce (ak: 8, tx: 8)"), { name: "InvalidNonceError" });

/** The `TenderError` that `send` throws for a final outcome that failed with `InvalidNonce`. */
function outcomeCollision(): TenderError {
  const failure = { InvalidTxError: { InvalidNonce: { ak_nonce: 8, tx_nonce: 8 } } };
  try {
    toTxResult(
      { status: { Failure: failure }, transaction: { hash: "TX" }, receipts_outcome: [] },
      CONTRACT,
    );
  } catch (error) {
    if (error instanceof TenderError) return error;
    throw error;
  }
  throw new Error("toTxResult did not throw");
}

describe("KeyQueue", () => {
  test("serializes_per_key", async () => {
    const queue = new KeyQueue();
    const log: string[] = [];
    const gates = [deferred(), deferred(), deferred()];
    const runs = gates.map((gate, i) =>
      queue.run("alice", async () => {
        log.push(`start ${i}`);
        await gate.promise;
        log.push(`end ${i}`);
        return i;
      }),
    );
    // The second call fails, and the third still runs after it.
    const failed = expect(runs[1]).rejects.toThrow("boom");

    await flush();
    expect(log).toEqual(["start 0"]);
    gates[0]?.resolve();
    expect(await runs[0]).toBe(0);
    await flush();
    expect(log).toEqual(["start 0", "end 0", "start 1"]);
    gates[1]?.reject(new Error("boom"));
    await failed;
    await flush();
    expect(log).toEqual(["start 0", "end 0", "start 1", "start 2"]);
    gates[2]?.resolve();
    expect(await runs[2]).toBe(2);
    expect(log).toEqual(["start 0", "end 0", "start 1", "start 2", "end 2"]);
  });

  test("parallel_across_keys", async () => {
    const queue = new KeyQueue();
    const started: string[] = [];
    const gates = { alice: deferred<string>(), bob: deferred<string>() };
    const runs = (["alice", "bob"] as const).map((key) =>
      queue.run(key, () => {
        started.push(key);
        return gates[key].promise;
      }),
    );
    await flush();
    // Both run while neither has finished, and bob finishes first.
    expect(started).toEqual(["alice", "bob"]);
    gates.bob.resolve("b");
    expect(await runs[1]).toBe("b");
    gates.alice.resolve("a");
    expect(await runs[0]).toBe("a");
  });

  test("near_api_js_names_the_collision_in_the_class_not_the_message", () => {
    const error = nearApiCollision();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("InvalidNonceError");
    expect(error.message).toBe("Invalid nonce (ak: 42000004, tx: 42000004)");
    // So a queue that looked only for `InvalidNonce` in the message would never retry it.
    expect(error.message).not.toContain("InvalidNonce");
  });

  describe("on a nonce collision", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    test("retries_once_on_invalid_nonce", async () => {
      const queue = new KeyQueue();
      const fn = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(nearApiCollision())
        .mockResolvedValueOnce("landed");
      const result = queue.run("alice", fn);
      await vi.advanceTimersByTimeAsync(499);
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fn).toHaveBeenCalledTimes(2);
      await expect(result).resolves.toBe("landed");
    });

    test("a_second_collision_is_thrown", async () => {
      const queue = new KeyQueue();
      const second = nearApiCollision();
      const fn = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(nearApiCollision())
        .mockRejectedValueOnce(second)
        .mockResolvedValue("too late");
      const result = queue.run("alice", fn);
      const thrown = expect(result).rejects.toBe(second);
      await vi.advanceTimersByTimeAsync(5_000);
      await thrown;
      expect(fn).toHaveBeenCalledTimes(2);
    });

    test("the_retry_keeps_the_key", async () => {
      const queue = new KeyQueue();
      const order: string[] = [];
      const first = vi
        .fn<() => Promise<string>>()
        .mockImplementationOnce(async () => {
          order.push("first");
          throw nearApiCollision();
        })
        .mockImplementationOnce(async () => {
          order.push("first again");
          return "first";
        });
      const results = [
        queue.run("alice", first),
        queue.run("alice", async () => {
          order.push("second");
          return "second";
        }),
      ];
      await vi.advanceTimersByTimeAsync(499);
      expect(order).toEqual(["first"]);
      await vi.advanceTimersByTimeAsync(1);
      await expect(Promise.all(results)).resolves.toEqual(["first", "second"]);
      expect(order).toEqual(["first", "first again", "second"]);
    });

    test("with_retry_on_nonce_off_a_collision_is_thrown_at_once_and_the_key_goes_on", async () => {
      // For a send that must never be signed twice: `TenderClient.transfer`.
      const queue = new KeyQueue();
      const collision = nearApiCollision();
      const fn = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(collision)
        .mockResolvedValue("a second transfer");
      const result = queue.run("alice", fn, { retryOnNonce: false });
      const thrown = expect(result).rejects.toBe(collision);
      await vi.advanceTimersByTimeAsync(5_000);
      await thrown;
      expect(fn).toHaveBeenCalledTimes(1);
      // The key is free for the next call, which keeps the default.
      await expect(queue.run("alice", fn)).resolves.toBe("a second transfer");
    });

    test.each([
      ["InvalidNonceError of another near-api-js copy", otherCopyCollision],
      ["final outcome whose failure is InvalidNonce", outcomeCollision],
    ])("also_retries_an_%s", async (_, collision) => {
      const queue = new KeyQueue();
      const fn = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(collision())
        .mockResolvedValueOnce("landed");
      const result = queue.run("alice", fn);
      await vi.advanceTimersByTimeAsync(500);
      await expect(result).resolves.toBe("landed");
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  test.each([
    ["a contract error", () => new TenderError("E_AUTH", "E_AUTH: not the verifier")],
    // A gas key's nonce lane, whose name and text are close to a collision's.
    ["an InvalidNonceIndexError", () => new InvalidNonceIndexError(1, 3, "", "")],
    ["any other error", () => new Error("connection reset")],
  ])("does_not_retry_other_errors: %s", async (_, make) => {
    const queue = new KeyQueue();
    const error = make();
    const fn = vi.fn<() => Promise<string>>().mockRejectedValueOnce(error).mockResolvedValue("x");
    await expect(queue.run("alice", fn)).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
    // The key is free again.
    await expect(queue.run("alice", fn)).resolves.toBe("x");
  });
});

describe("TenderClient.send", () => {
  interface RpcRequest {
    id: string;
    method: string;
    params: Record<string, unknown>;
  }
  const BLOCK = { block_hash: "6kSpdaiEGudXLa4p43ALXFHCu96ozdEJ3c8KsCuajXyj", block_height: 34 };
  const servers: Array<{ server: ReturnType<typeof createServer>; releaseAll: () => void }> = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(({ server, releaseAll }) => {
        // A failed test can leave requests held, and the server would wait for them.
        releaseAll();
        return new Promise((resolve) => server.close(() => resolve(undefined)));
      }),
    );
  });

  /** The account that signed a `send_tx`: the borsh string that leads the transaction. */
  function signerOf(request: RpcRequest): string {
    const bytes = Buffer.from(String(request.params.signed_tx_base64), "base64");
    return bytes.subarray(4, 4 + bytes.readUInt32LE(0)).toString("utf8");
  }

  /**
   * A JSON-RPC endpoint on localhost that answers the nonce and block reads of near-api-js at once
   * and holds every `send_tx` until the test releases it with a successful final outcome.
   */
  async function holdingRpc() {
    const held: Array<{ signer: string; release: () => void }> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const request = JSON.parse(body) as RpcRequest;
        const reply = (result: object) => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
        };
        if (request.method === "query") reply({ ...BLOCK, nonce: 7, permission: "FullAccess" });
        else if (request.method === "block") reply({ header: { hash: BLOCK.block_hash } });
        else {
          let released = false;
          held.push({
            signer: signerOf(request),
            release: () => {
              if (released) return;
              released = true;
              reply({
                status: { SuccessValue: "" },
                transaction: { hash: "TX" },
                transaction_outcome: { id: "TX", block_hash: BLOCK.block_hash },
                receipts_outcome: [],
              });
            },
          });
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const releaseAll = () => {
      for (const h of held) h.release();
    };
    servers.push({ server, releaseAll });
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, held };
  }

  async function until(condition: () => boolean) {
    for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(condition()).toBe(true);
  }

  test("send_queues_by_signer_account", async () => {
    const rpc = await holdingRpc();
    const signer = (accountId: string): Signer => ({
      accountId,
      privateKey: KeyPair.fromRandom("ed25519").toString(),
    });
    const alice = signer("alice.test.near");
    const bob = signer("bob.test.near");
    const client = (s: Signer) =>
      new TenderClient({ network: "testnet", contractId: CONTRACT, rpcUrl: rpc.url, signer: s });
    const heldBy = (account: string) => rpc.held.filter((h) => h.signer === account);

    // Two clients of alice's account and one of bob's send at once.
    const sends = [
      client(alice).voidTask(1n),
      client(alice).voidTask(2n),
      client(bob).voidTask(3n),
    ];
    await until(() => heldBy(bob.accountId).length === 1);
    // Time enough for alice's second transaction to arrive, were it not queued behind her first.
    await new Promise((r) => setTimeout(r, 100));
    expect(heldBy(alice.accountId)).toHaveLength(1);

    heldBy(alice.accountId)[0]?.release();
    await until(() => heldBy(alice.accountId).length === 2);
    for (const h of rpc.held) h.release();
    const results = await Promise.all(sends);
    expect(results.map((r) => r.events)).toEqual([[], [], []]);
  });
});
