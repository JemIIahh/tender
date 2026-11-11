import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type ApiDeps, type ApiServer, createApp, startApiServer } from "../src/index";
import { testDeps } from "./helpers";

// `startApiServer`, the API's own server over real sockets: what it serves, the URL it reports,
// how it closes with a connection left open, and the client address the limits count by.

let deps: ApiDeps;
const servers: ApiServer[] = [];

beforeAll(async () => {
  deps = await testDeps();
});

afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
  await deps.db.close();
});

async function serve(...args: Parameters<typeof startApiServer>): Promise<ApiServer> {
  const server = await startApiServer(...args);
  servers.push(server);
  return server;
}

/** Whether `url`'s port takes a connection, on the loopback address. */
function takesConnections(url: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: Number(new URL(url).port) });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
  });
}

test("start_api_server_serves_and_closes", async () => {
  // On one address, its URL names it; on every address, the loopback address.
  const one = await serve(createApp(deps), { port: 0, hostname: "127.0.0.1" });
  expect(one.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  const health = await fetch(`${one.url}/v1/health`);
  expect(health.status).toBe(200);
  expect(await health.json()).toMatchObject({ ok: true });

  // An app made from the URL gets the URL the server is bound to, and serves it.
  let given: string | undefined;
  const every = await serve(
    (url) => {
      given = url;
      return createApp({ ...deps, publicUrl: url });
    },
    { port: 0, closeGraceMs: 100 },
  );
  expect(every.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(given).toBe(every.url);

  // An event stream that its client never closes. close() still ends, once the grace is over.
  const stream = await fetch(`${every.url}/v1/events`);
  expect(stream.status).toBe(200);
  const started = Date.now();
  const closing = every.close();
  expect(every.close()).toBe(closing);
  await closing;
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(await takesConnections(every.url)).toBe(false);
  await expect(stream.text()).rejects.toThrow();

  await one.close();
  expect(await takesConnections(one.url)).toBe(false);
});

test("start_api_server_with_no_hostname_listens_on_every_address", async () => {
  // In a container, the host's proxy reaches the port by the container's own address, not by the
  // loopback address: a server bound to the loopback address alone would never be reached.
  const every = await serve(createApp(deps), { port: 0 });
  const bound = every.server.address() as AddressInfo;
  expect(["::", "0.0.0.0"]).toContain(bound.address);

  // So an address of this machine that is not the loopback one is answered. The machine of a run
  // may have none (the check is then left to the address above), as one with no network does.
  const outside = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry !== undefined && !entry.internal && entry.family === "IPv4");
  if (outside === undefined) return;
  const answer = await fetch(`http://${outside.address}:${bound.port}/v1/health`);
  expect(answer.status).toBe(200);

  // A server bound to the loopback address alone refuses the same address.
  const loopback = await serve(createApp(deps), { port: 0, hostname: "127.0.0.1" });
  await expect(
    fetch(`http://${outside.address}:${new URL(loopback.url).port}/v1/health`),
  ).rejects.toThrow();
});

test("start_api_server_rejects_a_port_that_is_taken", async () => {
  const first = await serve(createApp(deps), { port: 0, hostname: "127.0.0.1" });
  const { port } = new URL(first.url);
  await expect(
    startApiServer(createApp(deps), { port: Number(port), hostname: "127.0.0.1" }),
  ).rejects.toMatchObject({ code: "EADDRINUSE" });
  // The first server is untouched.
  expect((await fetch(`${first.url}/v1/health`)).status).toBe(200);
});

test("limits_count_each_client_address_over_real_connections", async () => {
  // One proxy in front: the client is the last entry of X-Forwarded-For.
  const server = await serve(
    createApp({
      ...deps,
      trustedProxyHops: 1,
      rateLimits: { challenge: { limit: 1, windowMs: 60_000 } },
    }),
    { port: 0, hostname: "127.0.0.1" },
  );
  const challenge = (forwardedFor: string) =>
    fetch(`${server.url}/v1/auth/challenge`, {
      method: "POST",
      headers: { "x-forwarded-for": forwardedFor },
    });

  expect((await challenge("1.1.1.1")).status).toBe(200);
  expect((await challenge("1.1.1.1")).status).toBe(429);
  // A spoofed first entry does not make another client of it.
  expect((await challenge("9.9.9.9, 1.1.1.1")).status).toBe(429);
  // Another client, as the proxy saw it, has a count of its own.
  expect((await challenge("2.2.2.2")).status).toBe(200);
});
