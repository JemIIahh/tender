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
  /**
   * The account of the Tender Judge, if this build knows it. The API does not say which account the
   * Judge is, and on chain a verifier is an account id, so the post wizard needs it from here: with
   * it, "Tender Judge" is the default verifier, and without it that choice is not offered.
   */
  judgeAccount: string | null;
  /**
   * The email and Google login (Privy), or null when this build has none: no app id, or the sandbox,
   * which has its dev wallet. With it, Connect offers that login first and the NEAR wallets second;
   * without it, Connect opens the NEAR wallets, as it always did. Both ids are public: Privy's
   * dashboard says they are meant for the browser.
   */
  privy: { appId: string; clientId: string | null } | null;
}

/** The variables `readConfig` reads, as `process.env` holds them. */
export interface PublicEnv {
  NEXT_PUBLIC_NETWORK?: string;
  NEXT_PUBLIC_API_URL?: string;
  NEXT_PUBLIC_CONTRACT?: string;
  NEXT_PUBLIC_RPC_URL?: string;
  NEXT_PUBLIC_DEV_WALLET?: string;
  NEXT_PUBLIC_JUDGE_ACCOUNT?: string;
  NEXT_PUBLIC_PRIVY_APP_ID?: string;
  NEXT_PUBLIC_PRIVY_CLIENT_ID?: string;
}

/** What a Privy app id or client id is made of: letters, digits, `-` and `_`. */
const PRIVY_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The id in `value`, or null for none (an empty value is none), or an error that names `name`. */
function privyId(name: string, value: string | undefined): string | null {
  const id = value?.trim() ?? "";
  if (id === "") return null;
  if (!PRIVY_ID.test(id)) {
    throw new Error(`${name} must be the id from Privy's dashboard: letters, digits, - and _`);
  }
  return id;
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

  // Optional. An empty value in a .env file is the same as none; a value that is no account id is
  // a mistake to stop at, not a Judge to leave out without a word.
  const judge = env.NEXT_PUBLIC_JUDGE_ACCOUNT?.trim() ?? "";
  if (judge !== "" && !AccountIdSchema.safeParse(judge).success) {
    throw new Error(
      `NEXT_PUBLIC_JUDGE_ACCOUNT must be a NEAR account id, got ${JSON.stringify(judge)}`,
    );
  }

  // Optional, both. A client id without an app id is no login, and is refused rather than dropped.
  const privyAppId = privyId("NEXT_PUBLIC_PRIVY_APP_ID", env.NEXT_PUBLIC_PRIVY_APP_ID);
  const privyClientId = privyId("NEXT_PUBLIC_PRIVY_CLIENT_ID", env.NEXT_PUBLIC_PRIVY_CLIENT_ID);
  if (privyAppId === null && privyClientId !== null) {
    throw new Error("NEXT_PUBLIC_PRIVY_CLIENT_ID is set without NEXT_PUBLIC_PRIVY_APP_ID");
  }

  return {
    network,
    apiUrl,
    rpcUrl,
    contractId,
    devWallet: network === "sandbox" && env.NEXT_PUBLIC_DEV_WALLET?.trim() === "1",
    judgeAccount: judge === "" ? null : judge,
    // The sandbox has the dev wallet and no gas gift: the login is for testnet and mainnet.
    privy:
      privyAppId === null || network === "sandbox"
        ? null
        : { appId: privyAppId, clientId: privyClientId },
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
  NEXT_PUBLIC_JUDGE_ACCOUNT: process.env.NEXT_PUBLIC_JUDGE_ACCOUNT,
  NEXT_PUBLIC_PRIVY_APP_ID: process.env.NEXT_PUBLIC_PRIVY_APP_ID,
  NEXT_PUBLIC_PRIVY_CLIENT_ID: process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID,
});
