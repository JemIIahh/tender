import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { KeyPair } from "near-api-js";
import { afterEach, expect, test } from "vitest";
import { ApiClient } from "../src/index";

// What a redirect comes to. A server at `baseUrl` answers a request with a 307 to a plain-http
// address of another server. `fetch` follows a redirect unless it is told not to, and a 307 keeps
// the method and the body, so the other server would be sent what the request holds: the
// signature of a sign-in, a brief. Both servers here are real, on the loopback interface, and the
// second counts what reaches it. (That every request of the client says not to follow is held in
// api.test.ts; this is what that does.)

const ACCOUNT = "alice.test.near";
const HASH = "ab".repeat(32);
const HOUR = 3_600_000;

interface Hit {
  method: string;
  /** The path and the query. */
  url: string;
  body: string;
}

/** Where a server is, which it learns once it listens. `url` is whom a sign-in to it is for. */
interface Address {
  url: string;
}

interface Served extends Address {
  /** Every request that reached it, in order. */
  hits: Hit[];
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(stop));
});

function stop(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

/** A server on an ephemeral port of the loopback interface, which `answer` speaks for. */
async function serve(
  answer: (hit: Hit, res: ServerResponse, self: Address) => void,
): Promise<Served> {
  const hits: Hit[] = [];
  const self: Served = { url: "", hits };
  const server = createServer(async (req, res) => {
    const hit = { method: req.method ?? "", url: req.url ?? "", body: await bodyOf(req) };
    hits.push(hit);
    answer(hit, res, self);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  self.url = `http://127.0.0.1:${port}`;
  return self;
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

/** What a call rejected with: the test fails if it resolved. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject, and it resolved");
}

test("a_redirect_fails_the_call_and_nothing_follows_it", async () => {
  // The server a redirect points at, on plain http. It answers anything, and notes it.
  const elsewhere = await serve((_hit, res) => json(res, {}));

  // The API: a small one that a client can sign in to. A route in `redirected` is answered with a
  // 307 to the same path on `elsewhere`, whatever its method.
  const redirected = new Set<string>();
  const api = await serve((hit, res, self) => {
    const route = `${hit.method} ${hit.url.split("?")[0]}`;
    if (redirected.has(route)) {
      res.writeHead(307, { Location: `${elsewhere.url}${hit.url}` }).end();
    } else if (route === "POST /v1/auth/challenge") {
      json(res, {
        nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
        message: "Sign in to Tender",
        recipient: self.url,
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      });
    } else if (route === "POST /v1/auth/verify") {
      json(res, {
        token: "token-1",
        expires_at: new Date(Date.now() + 12 * HOUR).toISOString(),
        key_kind: "full_access",
      });
    } else if (route === "GET /v1/health") {
      json(res, {
        ok: true,
        network: "sandbox",
        contract: "tender.test.near",
        indexed_height: "90",
        chain_final_height: "100",
        lag_blocks: "10",
        waiting_for_chain: false,
      });
    } else if (route === "POST /v1/blobs") {
      json(res, { sha256: HASH, uri: `${self.url}/v1/blobs/${HASH}` });
    } else {
      res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"not_found"}');
    }
  });
  const clientOf = () =>
    new ApiClient({
      baseUrl: api.url,
      signer: { accountId: ACCOUNT, privateKey: KeyPair.fromRandom("ed25519").toString() },
    });

  // The control. With nothing redirected the client works, signing in included, so what follows is
  // not a client that was never going to get through. And `fetch` as it comes does follow the
  // redirect, and the other server is reached: the test would see a leak.
  expect((await clientOf().health()).ok).toBe(true);
  expect(await clientOf().signIn()).toBe("token-1");
  redirected.add("GET /v1/health");
  await fetch(`${api.url}/v1/health`);
  expect(elsewhere.hits.map((hit) => `${hit.method} ${hit.url}`)).toEqual(["GET /v1/health"]);

  const brief = new TextEncoder().encode("a brief that is for the API alone");
  const cases: Array<[string, string, (client: ApiClient) => Promise<unknown>]> = [
    ["a read", "GET /v1/health", (client) => client.health()],
    ["a blob", `GET /v1/blobs/${HASH}`, (client) => client.getBlob(HASH)],
    ["the challenge", "POST /v1/auth/challenge", (client) => client.signIn()],
    // The signature of the sign-in is in the body of this one.
    ["the verify", "POST /v1/auth/verify", (client) => client.signIn()],
    // A call with a brief in it, after a sign-in that went through.
    [
      "an upload",
      "POST /v1/blobs",
      (client) => client.uploadBlob({ kind: "brief", contentType: "text/plain", bytes: brief }),
    ],
  ];
  for (const [name, route, call] of cases) {
    redirected.clear();
    redirected.add(route);
    elsewhere.hits.length = 0;
    api.hits.length = 0;

    const error = await rejection(call(clientOf()));

    // The call failed, with the error `fetch` gives for a redirect, and not with an answer ...
    expect(error, name).toBeInstanceOf(TypeError);
    expect(String((error as Error).cause), name).toMatch(/redirect/);
    // ... the API was asked, and the request it redirected is the last it saw ...
    const last = api.hits.at(-1);
    expect(`${last?.method} ${last?.url.split("?")[0]}`, name).toBe(route);
    // ... and nothing was sent on.
    expect(elsewhere.hits, name).toEqual([]);
  }

  // The verify did hold the signature, and it went to the API alone.
  redirected.clear();
  redirected.add("POST /v1/auth/verify");
  api.hits.length = 0;
  await rejection(clientOf().signIn());
  expect(JSON.parse(api.hits.at(-1)?.body ?? "null")).toHaveProperty("signature");
  expect(elsewhere.hits).toEqual([]);
});
