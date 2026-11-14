import { join } from "node:path";
import { createX402ServiceHandler, type PaidServiceOptions } from "@tender/payments";
import type { Service } from "@tender/shared";
import { DATA_LIMIT_BYTES, DATA_QUALITY_SERVICES, DataInputError } from "./data-quality";

export interface DataQualityHostOptions {
  services: Record<string, Service>;
  stateDirectory: string;
  facilitator: PaidServiceOptions["facilitator"];
  allowLocalHttp?: boolean;
  allowedBrowserOrigins?: readonly string[];
}

/** The host holds no agent, payer or relayer key. The facilitator settles authorized payments. */
export function createDataQualityHandler(options: DataQualityHostOptions) {
  const routes = DATA_QUALITY_SERVICES.map((definition) => {
    const service = options.services[definition.slug];
    if (!service?.x402 || service.payment_mode !== "x402")
      throw new Error("Both utility services need x402 listings.");
    return {
      endpoint: service.x402.endpoint,
      run: definition.run,
      handler: createX402ServiceHandler({
        service,
        stateFile: join(options.stateDirectory, `${definition.slug}.json`),
        facilitator: options.facilitator,
        allowLocalHttp: options.allowLocalHttp,
        allowedBrowserOrigins: options.allowedBrowserOrigins,
        respond: async (input) => definition.run(input),
      }),
    };
  });
  if (new Set(routes.map((route) => route.endpoint)).size !== routes.length)
    throw new Error("Utility service URLs must be distinct.");
  return async (request: Request): Promise<Response> => {
    const json = (body: unknown, status: number) => {
      const response = Response.json(body, { status });
      const origin = request.headers.get("origin");
      if (origin && options.allowedBrowserOrigins?.includes(origin)) {
        response.headers.set("access-control-allow-origin", origin);
        response.headers.set("vary", "Origin");
        response.headers.set("cache-control", "no-store");
      }
      return response;
    };
    const route = routes.find((route) => route.endpoint === request.url);
    if (!route) return json({ error: "not_found" }, 404);
    // Let the payment handler supply its challenge and CORS without reading an unpaid body.
    if (request.method !== "POST" || !request.headers.has("PAYMENT-SIGNATURE"))
      return route.handler(request);
    try {
      const reader = request.body?.getReader();
      if (!reader) throw new DataInputError("Expected JSON input.");
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          // The CSV's JSON escaping needs room beyond the CSV's own 64 KiB bound.
          if (length > DATA_LIMIT_BYTES * 2) {
            await reader.cancel();
            return json({ error: "input_too_large" }, 413);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      const input: unknown = JSON.parse(text);
      // Validate before verification/settlement. The paid handler computes again before charging.
      route.run(input);
      return route.handler(
        new Request(request.url, { method: "POST", headers: request.headers, body: text }),
      );
    } catch (error) {
      if (
        error instanceof DataInputError ||
        error instanceof SyntaxError ||
        error instanceof TypeError
      )
        return json(
          {
            error: "invalid_input",
            message: error instanceof DataInputError ? error.message : "Expected valid UTF-8 JSON.",
          },
          400,
        );
      throw error;
    }
  };
}
