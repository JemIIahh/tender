import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SIGN_IN_MESSAGE } from "@tender/shared";

// A stand-in for the Tender API, on a port the system picks on the loopback address, with the
// routes an agent's client needs to be seen at work: `health`, and the two requests of a sign-in.
// The challenge is the real shape (the message, a nonce, and the base as the recipient), and what
// is signed is refused with a 401, so a test reads what the client sent without the API knowing any
// account. Every request is recorded. No test of the agents calls a real API.

/** One request as the fake received it. */
export interface RecordedApiRequest {
  method: string;
  path: string;
  /** The JSON body, as parsed; undefined when there was none. */
  body: unknown;
}

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
};

/** 32 bytes in base64, which is what the client accepts as a nonce. */
const NONCE = Buffer.alloc(32, 7).toString("base64");

/** Starts the fake with its routes under `prefix` (a path such as `/tender`, or none). */
export async function startFakeApi(prefix = ""): Promise<FakeApi> {
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
      let payload: unknown = { error: "not_found" };
      if (method === "GET" && path === `${prefix}/v1/health`) {
        status = 200;
        payload = HEALTH;
      } else if (method === "POST" && path === `${prefix}/v1/auth/challenge`) {
        status = 200;
        payload = {
          nonce: NONCE,
          message: SIGN_IN_MESSAGE,
          recipient: base,
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        };
      } else if (method === "POST" && path === `${prefix}/v1/auth/verify`) {
        status = 401;
        payload = { error: "unauthorized" };
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
