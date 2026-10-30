import { AccountIdSchema, canonicalBase, NETWORKS, type NetworkId } from "@tender/shared";

/** What the web app is built for. Every value comes from a `NEXT_PUBLIC_*` variable (.env.example). */
export interface WebConfig {
  network: NetworkId;
  /**
   * The base of the Tender API, in the one spelling `canonicalBase` gives: where its routes are
   * (`<apiUrl>/v1/...`) and whom a sign-in is signed for. It has no trailing slash and no `/v1`.
   */
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
  httpUrl("NEXT_PUBLIC_API_URL", api);
  // The address the page calls and the recipient it has a wallet sign (lib/auth.ts) are one string,
  // so a spelling that `canonicalBase` refuses is refused here, and one it rewrites is used
  // rewritten. The messages of `canonicalBase` quote nothing; those of `httpUrl` above quote the
  // whole value, whatever it holds, when it does not parse or is not http(s). A password does not
  // belong in a NEXT_PUBLIC_* value in any case: it ships in the page.
  let apiUrl: string;
  try {
    apiUrl = canonicalBase(api);
  } catch (error) {
    throw new Error(`NEXT_PUBLIC_API_URL: ${(error as Error).message}`);
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
    apiUrl,
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
