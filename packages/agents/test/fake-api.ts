import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SIGN_IN_MESSAGE } from "@tender/shared";

// A stand-in for the Tender API, on a port the system picks on the loopback address, with the
// routes an agent's client needs to be seen at work: `health`, and the two requests of a sign-in.
// The challenge is the real shape (the message, a nonce, and the base as the recipient), and what
// is signed is refused with a 401 unless the test says to accept it (`accept`), so a test reads what
// the client sent without the API knowing any account. Every request is recorded. No test of the
// agents calls a real API.

/** One request as the fake received it. */
export interface RecordedApiRequest {
  method: string;
  path: string;
  /** The JSON body, as parsed; undefined when there was none. */
  body: unknown;
}

export interface FakeApiOptions {
  /** Trade the signature of a sign-in for a token (a 200), where the fake would refuse it with a 401. */
  accept?: boolean;
  /** Whom the challenge says it is for, where it would say the base: an API under another name. */
  recipient?: string;
  /** Leave the request for a challenge unanswered, the connection open: an API that has stalled. */
  hang?: boolean;
}

/** The bearer token of an accepted sign-in. A test checks that it is never shown. */
export const FAKE_TOKEN = "tok-FAKE-SESSION-TOKEN-0001";

export interface FakeApi {
  /** The base to give the client, in its canonical form: `http://127.0.0.1:<port><prefix>`. */
  base: string;
  /** Every request, in the order they arrived. */
  requests: RecordedApiRequest[];
  stop(): Promise<void>;
}

const HEALTH = {
  ok: true,
  network: "testnet",
  contract: "tender.testnet",
  indexed_height: "10",
  chain_final_height: "10",
  lag_blocks: "0",
  waiting_for_chain: false,
};

/** What the fake says, in words, when it refuses a signature: free text, which a client must not show. */
export const REFUSAL_TEXT = "the signature was not accepted for this account";

/** 32 bytes in base64, which is what the client accepts as a nonce. */
const NONCE = Buffer.alloc(32, 7).toString("base64");

/** Starts the fake with its routes under `prefix` (a path such as `/tender`, or none). */
export async function startFakeApi(prefix = "", options: FakeApiOptions = {}): Promise<FakeApi> {
  const requests: RecordedApiRequest[] = [];
  let base = "";

  const server: Server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const text = Buffer.concat(chunks).toString("utf8");
      const method = request.method ?? "";
      const path = request.url ?? "";
      requests.push({ method, path, body: text === "" ? undefined : JSON.parse(text) });

      let status = 404;
      let payload: unknown = { error: "not_found", message: "no such route" };
      if (method === "GET" && path === `${prefix}/v1/health`) {
        status = 200;
        payload = HEALTH;
      } else if (method === "POST" && path === `${prefix}/v1/auth/challenge`) {
        if (options.hang === true) return;
        status = 200;
        payload = {
          nonce: NONCE,
          message: SIGN_IN_MESSAGE,
          recipient: options.recipient ?? base,
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        };
      } else if (method === "POST" && path === `${prefix}/v1/auth/verify`) {
        if (options.accept === true) {
          status = 200;
          payload = {
            token: FAKE_TOKEN,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            key_kind: "function_call",
          };
        } else {
          status = 401;
          payload = { error: "unauthorized", message: REFUSAL_TEXT };
        }
      }
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}${prefix}`;

  return {
    base,
    requests,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
