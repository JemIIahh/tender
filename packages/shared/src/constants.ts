/** A chain Tender runs on. `sandbox` is a local nearcore node, started for tests and demos. */
export type NetworkId = "sandbox" | "testnet" | "mainnet";

export interface NetworkConfig {
  id: NetworkId;
  rpcUrl: string;
  rpcFallbackUrl?: string;
  /** The neardata block API, where the indexer reads blocks. */
  neardataUrl?: string;
  /** Account id of Circle's USDC token on this network. */
  usdc?: string;
  /** The shortest commit, reveal, pick or fallback window the contract accepts, in seconds. */
  minWindowSecs: number;
}

export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  sandbox: {
    id: "sandbox",
    // The sandbox node picks its port when it starts, so the URL comes from the running chain
    // (`LocalChain.rpcUrl`). The empty string only fills the required field.
    rpcUrl: "",
    minWindowSecs: 5,
  },
  testnet: {
    id: "testnet",
    rpcUrl: "https://rpc.testnet.fastnear.com",
    neardataUrl: "https://testnet.neardata.xyz",
    usdc: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
    minWindowSecs: 60,
  },
  mainnet: {
    id: "mainnet",
    rpcUrl: "https://rpc.mainnet.fastnear.com",
    neardataUrl: "https://mainnet.neardata.xyz",
    usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    minWindowSecs: 300,
  },
};

/** The `standard` field of every event the contract logs. */
export const EVENT_STANDARD = "tender";
/** The `version` field of every event the contract logs. */
export const EVENT_VERSION = "1.0.0";
/** The longest URI the contract accepts, in bytes. */
export const MAX_URI_BYTES = 256;
/** The largest result the result store keeps, in bytes (256 KiB). */
export const MAX_RESULT_BYTES = 262_144;
/** USDC has 6 decimals on every network. */
export const USDC_DECIMALS = 6;
