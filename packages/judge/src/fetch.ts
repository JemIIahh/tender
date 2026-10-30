import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";
import { type Db, getBlob } from "@tender/db";
import { MAX_RESULT_BYTES } from "@tender/shared";
import type { FetchIo, JudgeDeps, TransportInit } from "./types";

/** How long fetching an entry from another host may take, every redirect and the body included. */
const TIMEOUT_MS = 10_000;
/**
 * How long connecting to one address may take, TLS included, before the next address is tried.
 * It counts against `TIMEOUT_MS` like the rest.
 */
const CONNECT_TIMEOUT_MS = 3_000;
/** How many redirects are followed. */
const MAX_REDIRECTS = 3;
/** The statuses that send a client to the `Location` of the response. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** What follows `/v1/blobs/` in one of our own blob URIs. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The content an entry revealed at `uri`, or why there is none. The error is one of a few fixed
 * phrases, so a reason built from it never repeats what a server sent.
 *
 * - One of our own blob URIs, `{publicUrl}/v1/blobs/{sha256}`, is read from the database with
 *   `getBlob`, whatever the blob's visibility: a result stays private until its task's reveals
 *   close, which is when the Judge reads it. Only a `result` blob is an entry's content; any other
 *   kind is `not found`. Under that path, anything but a hash in lowercase hex is an `unsupported
 *   uri`.
 * - Anything else must be an http(s) URL with no login in it. Its host is resolved first, and
 *   every address it resolves to must be a public unicast address (`isPublicAddress`), or it is
 *   `address not allowed`. The request then goes to an address that was checked, not to the name,
 *   so the name cannot be made to point somewhere else in between (DNS rebinding). The first
 *   address of each family is tried, at most one IPv6 and one IPv4: when the request to one fails
 *   with an error, the other is tried. An address that does not take the connection within 3 s
 *   (with TLS set up, for https) is given up as failed. One that takes it and then hangs uses up
 *   the time limit.
 * - Redirects are followed at most 3 times, and each is resolved and checked like the first
 *   request. The whole of it has 10 s, and the body at most 262_144 bytes: the limits are kept
 *   while the body streams, and a body that is too large is not read to its end.
 *
 * The bytes are what the store or the server holds, not parsed or decoded: the caller hashes
 * exactly these. `io` defaults to `deps.fetchIo`, and that to the network. A database error is
 * thrown, not returned: it says nothing about the entry, and the caller should try again.
 */
export async function fetchEntryContent(
  deps: Pick<JudgeDeps, "db" | "publicUrl" | "fetchIo">,
  uri: string,
  io: FetchIo = deps.fetchIo ?? NETWORK,
): Promise<Uint8Array | { error: string }> {
  const own = ownBlobHash(deps.publicUrl, uri);
  if (own !== undefined) {
    return own === null ? { error: "unsupported uri" } : readOwnBlob(deps.db, own);
  }
  const url = URL.parse(uri);
  if (url === null || !isPlainHttp(url)) return { error: "unsupported uri" };

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), TIMEOUT_MS);
  try {
    return await fetchFrom(url, io, deadline.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The hash in `uri` when it is one of our own blob URIs; `null` when it is under our blob path
 * but names no hash; `undefined` when it is not ours.
 */
export function ownBlobHash(publicUrl: string, uri: string): string | null | undefined {
  const prefix = `${publicUrl.replace(/\/+$/, "")}/v1/blobs/`;
  if (!uri.startsWith(prefix)) return undefined;
  const sha256 = uri.slice(prefix.length);
  return SHA256_HEX.test(sha256) ? sha256 : null;
}

async function readOwnBlob(db: Db, sha256: string): Promise<Uint8Array | { error: string }> {
  const blob = await getBlob(db, sha256);
  // The store also holds the private held-out checks of tasks still open, and their hashes are on
  // chain for anyone to name. An entry that names one must not have it scored: its score would
  // tell its poster how those checks look.
  if (blob === null || blob.kind !== "result") return { error: "not found" };
  if (blob.bytes.byteLength > MAX_RESULT_BYTES) return { error: "too large" };
  return blob.bytes;
}

/** Whether `url` is http(s) with no username or password, which nobody's entry needs. */
function isPlainHttp(url: URL): boolean {
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username === "" &&
    url.password === ""
  );
}

/** Requests `start`, and the redirects after it, until a body is read or `signal` aborts. */
async function fetchFrom(
  start: URL,
  io: FetchIo,
  signal: AbortSignal,
): Promise<Uint8Array | { error: string }> {
  let url = start;
  for (let redirects = 0; ; redirects++) {
    const host = hostOf(url);
    let addresses: string[];
    if (isIP(host) !== 0) {
      addresses = [host];
    } else {
      try {
        addresses = await beforeAbort(io.lookup(host), signal);
      } catch {
        return { error: signal.aborted ? "timed out" : "host not found" };
      }
    }
    if (addresses.length === 0) return { error: "host not found" };
    if (!addresses.every(isPublicAddress)) return { error: "address not allowed" };

    const response = await requestFromAny(url, onePerFamily(addresses), io, signal);
    if ("error" in response) return response;

    if (REDIRECT_STATUSES.has(response.status)) {
      discard(response);
      if (redirects === MAX_REDIRECTS) return { error: "too many redirects" };
      const location = response.headers.get("location");
      const next = location === null ? null : URL.parse(location, url);
      if (next === null) return { error: "bad redirect" };
      if (!isPlainHttp(next)) return { error: "unsupported uri" };
      url = next;
      continue;
    }
    if (!response.ok) {
      discard(response);
      // The status, never the body: what a server writes there is its own.
      return { error: `http status ${response.status}` };
    }
    return readBody(response, signal);
  }
}

/**
 * The first address of each family in `addresses`, in the order they come: one IPv6 and one IPv4
 * at most. A name can resolve to any number of addresses, and each try is a connection the Judge
 * makes; one of each family is all the fallback needs.
 */
function onePerFamily(addresses: readonly string[]): string[] {
  const first = new Map<number, string>();
  for (const address of addresses) {
    const family = isIP(address);
    if (!first.has(family)) first.set(family, address);
  }
  return [...first.values()];
}

/**
 * The response to `url` from the first of `addresses` that answers, all of them checked. While a
 * request fails, with an error and not a status, the next address is tried, within the same
 * deadline: a request sent to an address gives up the fallback between IPv6 and IPv4 that one
 * sent to a name has, so a host with both whose IPv6 cannot be reached from here still answers. A
 * status is an answer, and no other address is asked.
 *
 * Each request has 3 s to connect (`connectSignal`): an address that drops the connection
 * attempt, as an unreachable one often does, would use up the whole deadline otherwise, and the
 * next address would never be tried.
 */
async function requestFromAny(
  url: URL,
  addresses: readonly string[],
  io: FetchIo,
  signal: AbortSignal,
): Promise<Response | { error: string }> {
  for (const address of addresses) {
    const connect = new AbortController();
    const timer = setTimeout(() => connect.abort(), CONNECT_TIMEOUT_MS);
    try {
      const request = io.fetchImpl(pinned(url, address), {
        headers: { host: url.host },
        redirect: "manual",
        signal,
        connectSignal: connect.signal,
      });
      return await beforeAbort(request, signal);
    } catch {
      if (signal.aborted) return { error: "timed out" };
    } finally {
      clearTimeout(timer);
    }
  }
  return { error: "fetch failed" };
}

/** The host of `url` as a resolver or a socket takes it: an IPv6 address without its brackets. */
function hostOf(url: URL): string {
  return url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
}

/** `url` with its host replaced by `address`, the checked address the request is sent to. */
function pinned(url: URL, address: string): URL {
  const target = new URL(url);
  target.hostname = isIP(address) === 6 ? `[${address}]` : address;
  return target;
}

/** The body of `response`, read until it ends, passes 262_144 bytes, or `signal` aborts. */
async function readBody(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array | { error: string }> {
  // A length that says the body is too large is believed; one that says it is small is not, and
  // one that is not a number (`NaN`) says nothing.
  if (Number(response.headers.get("content-length")) > MAX_RESULT_BYTES) {
    discard(response);
    return { error: "too large" };
  }
  if (response.body === null) return new Uint8Array(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let ended = false;
  try {
    for (;;) {
      const { done, value } = await beforeAbort(reader.read(), signal);
      if (done) {
        ended = true;
        break;
      }
      // The cap counts bytes, so a stream must give bytes.
      if (!(value instanceof Uint8Array)) return { error: "fetch failed" };
      size += value.byteLength;
      if (size > MAX_RESULT_BYTES) return { error: "too large" };
      chunks.push(value);
    }
  } catch {
    return { error: signal.aborted ? "timed out" : "fetch failed" };
  } finally {
    // A body left unread is closed, so the server stops sending it.
    if (!ended) reader.cancel().catch(() => undefined);
  }

  const content = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

/** Closes a body that will not be read. Nothing waits for it. */
function discard(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

/**
 * `promise`, or a rejection once `signal` aborts, whichever comes first. A lookup cannot be
 * cancelled, and a stream or a transport may not heed its signal, so the time limit does not
 * depend on them: what is left running is no longer waited for.
 */
function beforeAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// ---- which addresses an entry may come from ---------------------------------------------------

/**
 * The IPv4 blocks no entry is fetched from: this network, private networks (RFC 1918), shared
 * address space (RFC 6598), loopback, link-local (the cloud metadata address 169.254.169.254 among
 * them), IETF protocol assignments, the documentation and benchmarking blocks, the old 6to4 relay,
 * multicast, and the reserved block up to the broadcast address. Two of them hold other clouds'
 * metadata services: 100.100.100.200 and 192.0.0.192.
 */
const REFUSED_V4 = blockList("ipv4", [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]);
/** IPv4-mapped IPv6 addresses, `::ffff:a.b.c.d`, which are checked as the IPv4 address in them. */
const MAPPED_V6 = blockList("ipv6", [["::ffff:0:0", 96]]);
/**
 * Global unicast, 2000::/3: the only IPv6 an entry is fetched from. That leaves out loopback,
 * the unspecified address, unique local (RFC 4193) and link-local addresses, multicast, NAT64 and
 * the IPv4-compatible block, which all lie outside it.
 */
const GLOBAL_V6 = blockList("ipv6", [["2000::", 3]]);
/**
 * Inside global unicast: IETF protocol assignments (Teredo among them, which carries an IPv4
 * address), the two documentation blocks, and 6to4, which carries one too.
 */
const REFUSED_V6 = blockList("ipv6", [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
]);

function blockList(type: "ipv4" | "ipv6", subnets: [network: string, prefix: number][]) {
  const list = new BlockList();
  for (const [network, prefix] of subnets) list.addSubnet(network, prefix, type);
  return list;
}

/**
 * Whether an entry may be fetched from `address`: an IPv4 address outside `REFUSED_V4`, the same
 * written as IPv4-mapped IPv6, or a global unicast IPv6 address outside `REFUSED_V6`. Anything
 * else is refused, text that is not an address and an address with a zone index included.
 */
function isPublicAddress(address: string): boolean {
  try {
    // `BlockList` compares IPv4 and IPv4-mapped IPv6 as the same addresses, whichever way round,
    // so each list holds one family, and IPv6 is asked whether it is mapped first.
    switch (isIP(address)) {
      case 4:
        return !REFUSED_V4.check(address, "ipv4");
      case 6:
        if (address.includes("%")) return false;
        if (MAPPED_V6.check(address, "ipv6")) return !REFUSED_V4.check(address, "ipv6");
        return GLOBAL_V6.check(address, "ipv6") && !REFUSED_V6.check(address, "ipv6");
      default:
        return false;
    }
  } catch {
    return false;
  }
}

// ---- the default network -----------------------------------------------------------------------

/** The statuses whose response has no body. */
const NO_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** The system resolver, and `pinnedFetch`. */
const NETWORK: FetchIo = {
  lookup: async (host) => (await lookup(host, { all: true })).map(({ address }) => address),
  fetchImpl: pinnedFetch,
};

/**
 * The default transport: one GET to the address in the host of `input`, with the server named by
 * the `host` header. That header is the request's Host, and for https it is also the name sent to
 * the server (SNI) and the name its certificate is checked against. The socket goes to the address
 * and nowhere else, whatever the name resolves to by then.
 *
 * Node's own `fetch` cannot do this: it drops a `host` header, and checks a certificate against
 * the address in the URL. Only what `fetchFrom` uses is supported: the headers, the signal and
 * `connectSignal`, which ends the request when it aborts before the connection is made (with TLS
 * set up, for https). It never follows a redirect, and it asks for the body as it is
 * (`accept-encoding: identity`), so the bytes read are the bytes the server holds and nothing is
 * decompressed past the size cap.
 *
 * Exported for its own test; the Judge uses it through the default `FetchIo`.
 */
export async function pinnedFetch(input: string | URL | Request, init: TransportInit = {}) {
  const url = new URL(input instanceof Request ? input.url : input);
  const headers = new Headers(init.headers);
  const host = headers.get("host") ?? url.host;
  headers.delete("host");
  headers.set("accept-encoding", "identity");
  const secure = url.protocol === "https:";

  return new Promise<Response>((resolve, reject) => {
    const request = (secure ? httpsRequest : httpRequest)({
      host: hostOf(url),
      port: url.port === "" ? undefined : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { ...Object.fromEntries(headers), host },
      servername: secure ? serverName(host) : undefined,
      signal: init.signal ?? undefined,
      // A connection of its own, closed after the response, so none is left open to be reused.
      agent: false,
    });
    const connect = init.connectSignal;
    if (connect?.aborted === true) {
      request.destroy(new Error("connect timed out"));
    } else if (connect !== undefined) {
      const giveUp = () => request.destroy(new Error("connect timed out"));
      const connected = () => connect.removeEventListener("abort", giveUp);
      connect.addEventListener("abort", giveUp, { once: true });
      // With an agent of its own, the socket comes before it connects.
      request.once("socket", (socket) =>
        socket.once(secure ? "secureConnect" : "connect", connected),
      );
      request.once("close", connected);
    }
    request.on("error", reject);
    request.on("response", (message) => {
      try {
        const status = message.statusCode ?? 0;
        const body = NO_BODY_STATUSES.has(status)
          ? null
          : (Readable.toWeb(message) as unknown as ReadableStream<Uint8Array>);
        if (body === null) message.resume();
        resolve(new Response(body, { status, headers: headersOf(message.rawHeaders) }));
      } catch (error) {
        // A status that a `Response` cannot have, or a header that `Headers` refuses.
        message.destroy();
        reject(error);
      }
    });
    request.end();
  });
}

/** The name in a Host header, for TLS: with no port or brackets, and none when it is an address. */
function serverName(host: string): string | undefined {
  const name = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.replace(/:\d*$/, "");
  return isIP(name) === 0 ? name : undefined;
}

function headersOf(raw: string[]): Headers {
  const headers = new Headers();
  for (let i = 0; i + 1 < raw.length; i += 2) headers.append(raw[i] ?? "", raw[i + 1] ?? "");
  return headers;
}
