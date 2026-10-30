import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAdaptorServer, type HttpBindings } from "@hono/node-server";
import type { ErrorBody } from "./format";
import { RETRY_SOON } from "./limits";

/** What the server hands each request to: a Hono app, or anything else with its `fetch`. */
export interface FetchHandler {
  fetch(request: Request, env: HttpBindings): Response | Promise<Response>;
}

export interface ApiServerOptions {
  /** The port to listen on. 0 picks a free one. */
  port: number;
  /** The address to listen on. Default: every address of the host, IPv6 and IPv4. */
  hostname?: string;
  /**
   * How long `close` lets the requests in flight finish before it cuts their connections, in
   * milliseconds. Default: 2 s.
   */
  closeGraceMs?: number;
}

export interface ApiServer {
  /**
   * The URL the server is bound to, with no trailing slash: `http://127.0.0.1:<port>` when it
   * listens on every address, never `0.0.0.0` or `[::]`, which no client can call.
   */
  url: string;
  server: Server;
  /**
   * Stops taking connections and closes the idle ones, lets the requests in flight finish for
   * `closeGraceMs`, then cuts every connection that is left, and resolves once the server is
   * closed. Without the cut, an open event stream would hold it open for as long as its client
   * stays. Calling it again returns the same promise.
   */
  close(): Promise<void>;
}

const CLOSE_GRACE_MS = 2_000;

/**
 * `address` as a URL. On every address of the host, the URL names the loopback address, which
 * the server takes on IPv4 as on IPv6.
 */
function urlOf({ address, family, port }: AddressInfo): string {
  if (address === "::" || address === "0.0.0.0") return `http://127.0.0.1:${port}`;
  return family === "IPv6" ? `http://[${address}]:${port}` : `http://${address}:${port}`;
}

/**
 * Serves `app` over HTTP with `@hono/node-server`, and resolves once the server listens. It
 * rejects, with nothing left open, when the server cannot listen (the port is taken) or when
 * making the app fails.
 *
 * `app` may be a function of the server's URL, called once the server is bound: with port 0 the
 * URL is not known before, and an app can serve it, as the API does in its blob URIs. It is
 * called before any request is handled. A request that came first all the same would get a 503
 * with `Retry-After`.
 */
export async function startApiServer(
  app: FetchHandler | ((url: string) => FetchHandler),
  options: ApiServerOptions,
): Promise<ApiServer> {
  let handler = typeof app === "function" ? undefined : app;
  const server = createAdaptorServer({
    fetch: (request, env) => {
      if (handler !== undefined) return handler.fetch(request, env as HttpBindings);
      const body: ErrorBody = { error: "unavailable", message: "the API is starting" };
      return Response.json(body, { status: 503, headers: RETRY_SOON });
    },
    hostname: options.hostname,
  }) as Server;

  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => {
      server.off("listening", listening);
      reject(error);
    };
    const listening = () => {
      server.off("error", failed);
      resolve();
    };
    server.once("error", failed);
    server.once("listening", listening);
    server.listen(options.port, options.hostname);
  });

  const url = urlOf(server.address() as AddressInfo);
  if (handler === undefined) {
    try {
      handler = (app as (url: string) => FetchHandler)(url);
    } catch (error) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    }
  }

  const graceMs = options.closeGraceMs ?? CLOSE_GRACE_MS;
  let closed: Promise<void> | undefined;
  return {
    url,
    server,
    close() {
      closed ??= new Promise<void>((resolve, reject) => {
        const cut = setTimeout(() => server.closeAllConnections(), graceMs);
        // Node's close() also closes the idle keep-alive connections at once.
        server.close((error) => {
          clearTimeout(cut);
          if (error) reject(error);
          else resolve();
        });
      });
      return closed;
    },
  };
}
