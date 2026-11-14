import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { ServiceSchema } from "@tender/shared";
import { importReadiness } from "../src/services/data-quality";

export async function dataQualityMain(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      csv: { type: "string" },
      required: { type: "string" },
      key: { type: "string" },
      out: { type: "string" },
      manifest: { type: "string" },
      "state-dir": { type: "string" },
      port: { type: "string" },
      "browser-origin": { type: "string", multiple: true },
    },
  });
  if (values.csv) {
    if (!values.key) throw new Error("Supply --key <column[,column]> for the import's unique key.");
    const csv = await readFile(values.csv, "utf8");
    const report = importReadiness(csv, values.required?.split(",") ?? [], values.key.split(","));
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (values.out) await writeFile(values.out, output, { mode: 0o600 });
    else process.stdout.write(output);
    return;
  }
  if (!values.manifest || !values["state-dir"])
    throw new Error(
      "Supply --csv <file> --key <columns>, or --manifest <file> --state-dir <private directory> to serve paid APIs.",
    );
  const raw = JSON.parse(await readFile(values.manifest, "utf8")) as Record<string, unknown>;
  const listings = Object.fromEntries(
    Object.entries(raw).map(([slug, listing]) => [slug, ServiceSchema.parse(listing)]),
  );
  const key = process.env.X402_FACILITATOR_API_KEY;
  if (!key) throw new Error("The paid host needs X402_FACILITATOR_API_KEY in its environment.");
  const port = Number(values.port ?? "8096");
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
    throw new Error("Choose a port from 1024 to 65535.");
  const { serve } = await import("@hono/node-server");
  const { createReferenceTestnetFacilitator } = await import("@tender/payments");
  const { createDataQualityHandler } = await import("../src/services/data-quality-http");
  const handler = createDataQualityHandler({
    services: listings,
    stateDirectory: values["state-dir"],
    facilitator: createReferenceTestnetFacilitator(key),
    allowedBrowserOrigins: values["browser-origin"],
  });
  const endpoints = Object.values(listings)
    .map((listing) => listing.x402?.endpoint)
    .filter((value): value is string => !!value);
  if (endpoints.some((endpoint) => !endpoint.startsWith("https://")))
    throw new Error("Hosted endpoints must use HTTPS.");
  // TLS terminates at the owner's proxy. Map only the exact configured path and query, never Host.
  const server = serve({
    hostname: "127.0.0.1",
    port,
    fetch(request) {
      const url = new URL(request.url);
      const endpoint = endpoints.find((value) => {
        const listed = new URL(value);
        return listed.pathname === url.pathname && listed.search === url.search;
      });
      return endpoint
        ? handler(new Request(endpoint, request))
        : new Response(null, { status: 404 });
    },
  });
  const stop = () => server.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log(`Tender team Data Quality services listening on 127.0.0.1:${port}.`);
}
