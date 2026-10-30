import { AccountIdSchema, NETWORKS, type NetworkId } from "@tender/shared";

/** What the web app is built for. Every value comes from a `NEXT_PUBLIC_*` variable (.env.example). */
export interface WebConfig {
  network: NetworkId;
  /** The origin of the Tender API, with no trailing slash and no `/v1`. */
  apiUrl: string;
  /** The NEAR JSON-RPC endpoint the browser reads views from. It ships in the page: it is public. */
  rpcUrl: string;
  /** The account id of the Tender contract. */
  contractId: string;
  /** Whether the in-page dev wallet is on. It is on only for the sandbox. */
  devWallet: boolean;
}

/** The variables `readConfig` reads, as `process.env` holds them. */
export interface PublicEnv {
  NEXT_PUBLIC_NETWORK?: string;
  NEXT_PUBLIC_API_URL?: string;
  NEXT_PUBLIC_CONTRACT?: string;
  NEXT_PUBLIC_RPC_URL?: string;
  NEXT_PUBLIC_DEV_WALLET?: string;
}

function isNetworkId(value: string): value is NetworkId {
  return Object.hasOwn(NETWORKS, value);
}

/** `value` if it is an http(s) URL, else an error that names the variable. */
function httpUrl(name: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an http(s) URL, got ${JSON.stringify(value)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be an http(s) URL, got ${JSON.stringify(value)}`);
  }
  return url;
}

/**
 * The config for `env`, or an error that names the variable that is missing or wrong. A build or a
 * page that has no usable value fails here, loudly, instead of running against the wrong chain.
 */
export function readConfig(env: PublicEnv): WebConfig {
  const network = env.NEXT_PUBLIC_NETWORK?.trim() ?? "";
  if (!isNetworkId(network)) {
    throw new Error(
      `NEXT_PUBLIC_NETWORK must be one of ${Object.keys(NETWORKS).join(", ")}, got ${JSON.stringify(network)}`,
    );
  }

  const api = env.NEXT_PUBLIC_API_URL?.trim() ?? "";
  const apiUrl = httpUrl("NEXT_PUBLIC_API_URL", api);
  if (apiUrl.search !== "" || apiUrl.hash !== "") {
    throw new Error(
      `NEXT_PUBLIC_API_URL must have no query or fragment, got ${JSON.stringify(api)}`,
    );
  }

  const contractId = env.NEXT_PUBLIC_CONTRACT?.trim() ?? "";
  if (!AccountIdSchema.safeParse(contractId).success) {
    throw new Error(
      `NEXT_PUBLIC_CONTRACT must be a NEAR account id, got ${JSON.stringify(contractId)}`,
    );
  }

  // Used as it is written, because a provider may want a key in the query. Everything in this
  // variable ships in the page, so such a key is public by construction: use one issued for
  // browsers (limited to this site), never the FASTNEAR_API_KEY the services use.
  const rpc = env.NEXT_PUBLIC_RPC_URL?.trim() ?? "";
  if (rpc !== "") httpUrl("NEXT_PUBLIC_RPC_URL", rpc);
  const rpcUrl = rpc === "" ? NETWORKS[network].rpcUrl : rpc;
  if (rpcUrl === "") {
    throw new Error(
      "NEXT_PUBLIC_RPC_URL is required on the sandbox: a local node picks its port when it starts",
    );
  }

  return {
    network,
    apiUrl: api.replace(/\/+$/, ""),
    rpcUrl,
    contractId,
    devWallet: network === "sandbox" && env.NEXT_PUBLIC_DEV_WALLET?.trim() === "1",
  };
}

export const config: WebConfig = readConfig({
  // Each name is written out in full. Next puts a value into the browser's code only where it
  // finds `process.env.NEXT_PUBLIC_…` spelled out, so a lookup by a computed name is empty there.
  NEXT_PUBLIC_NETWORK: process.env.NEXT_PUBLIC_NETWORK,
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_CONTRACT: process.env.NEXT_PUBLIC_CONTRACT,
  NEXT_PUBLIC_RPC_URL: process.env.NEXT_PUBLIC_RPC_URL,
  NEXT_PUBLIC_DEV_WALLET: process.env.NEXT_PUBLIC_DEV_WALLET,
});
