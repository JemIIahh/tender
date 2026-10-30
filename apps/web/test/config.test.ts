import { NETWORKS } from "@tender/shared";
import { expect, test } from "vitest";
import { config, readConfig } from "../lib/config";

const BASE = {
  NEXT_PUBLIC_NETWORK: "testnet",
  NEXT_PUBLIC_API_URL: "https://api.tender.example",
  NEXT_PUBLIC_CONTRACT: "tender.testnet",
};

const SANDBOX = {
  ...BASE,
  NEXT_PUBLIC_NETWORK: "sandbox",
  NEXT_PUBLIC_CONTRACT: "tender.sandbox",
  NEXT_PUBLIC_RPC_URL: "http://127.0.0.1:41201",
};

test("config_reads_the_public_values", () => {
  expect(readConfig(BASE)).toEqual({
    network: "testnet",
    apiUrl: "https://api.tender.example",
    rpcUrl: NETWORKS.testnet.rpcUrl,
    contractId: "tender.testnet",
    devWallet: false,
  });
});

test("config_rpc_url_defaults_per_network_and_can_be_set", () => {
  expect(readConfig({ ...BASE, NEXT_PUBLIC_NETWORK: "mainnet" }).rpcUrl).toBe(
    NETWORKS.mainnet.rpcUrl,
  );
  expect(readConfig({ ...BASE, NEXT_PUBLIC_RPC_URL: "https://rpc.example/key" }).rpcUrl).toBe(
    "https://rpc.example/key",
  );
  // An empty value in a .env file is the same as none.
  expect(readConfig({ ...BASE, NEXT_PUBLIC_RPC_URL: "" }).rpcUrl).toBe(NETWORKS.testnet.rpcUrl);
});

test("config_sandbox_takes_its_rpc_url_from_the_environment", () => {
  expect(readConfig(SANDBOX).rpcUrl).toBe("http://127.0.0.1:41201");
  // A local node picks its port when it starts, so the network has no URL to fall back on.
  expect(() => readConfig({ ...SANDBOX, NEXT_PUBLIC_RPC_URL: undefined })).toThrow(
    /NEXT_PUBLIC_RPC_URL/,
  );
});

test("config_drops_the_trailing_slash_of_the_api_url", () => {
  expect(readConfig({ ...BASE, NEXT_PUBLIC_API_URL: "https://api.tender.example/" }).apiUrl).toBe(
    "https://api.tender.example",
  );
  expect(readConfig({ ...BASE, NEXT_PUBLIC_API_URL: "http://localhost:8787//" }).apiUrl).toBe(
    "http://localhost:8787",
  );
  // A path stays: the API can sit behind one.
  expect(readConfig({ ...BASE, NEXT_PUBLIC_API_URL: "https://tender.example/api/" }).apiUrl).toBe(
    "https://tender.example/api",
  );
});

test("config_keeps_the_rpc_url_as_it_is_written", () => {
  // Some providers take a key in the query. It ships in the page, so it has to be a key issued for
  // browsers, never the FASTNEAR_API_KEY of the services.
  const rpc = "https://rpc.example/?apiKey=browser-key";
  expect(readConfig({ ...BASE, NEXT_PUBLIC_RPC_URL: rpc }).rpcUrl).toBe(rpc);
});

test("config_ignores_spaces_around_a_value", () => {
  expect(
    readConfig({
      NEXT_PUBLIC_NETWORK: " testnet\n",
      NEXT_PUBLIC_API_URL: " https://api.tender.example ",
      NEXT_PUBLIC_CONTRACT: "tender.testnet ",
      NEXT_PUBLIC_RPC_URL: "  ",
    }),
  ).toMatchObject({
    network: "testnet",
    apiUrl: "https://api.tender.example",
    contractId: "tender.testnet",
    rpcUrl: NETWORKS.testnet.rpcUrl,
  });
});

test("config_refuses_a_network_it_does_not_know", () => {
  for (const network of [undefined, "", "devnet", "Mainnet", "toString", "__proto__"]) {
    expect(() => readConfig({ ...BASE, NEXT_PUBLIC_NETWORK: network }), String(network)).toThrow(
      /NEXT_PUBLIC_NETWORK/,
    );
  }
});

test("config_refuses_an_api_url_that_is_not_http", () => {
  for (const url of [undefined, "", "api.tender.example", "ftp://api.tender.example", "http://"]) {
    expect(() => readConfig({ ...BASE, NEXT_PUBLIC_API_URL: url }), String(url)).toThrow(
      /NEXT_PUBLIC_API_URL/,
    );
  }
  expect(() => readConfig({ ...BASE, NEXT_PUBLIC_RPC_URL: "not a url" })).toThrow(
    /NEXT_PUBLIC_RPC_URL/,
  );
  // The API's paths are added to the URL, so it can carry no query of its own.
  for (const url of ["https://api.tender.example?x=1", "https://api.tender.example/#top"]) {
    expect(() => readConfig({ ...BASE, NEXT_PUBLIC_API_URL: url }), url).toThrow(
      /NEXT_PUBLIC_API_URL/,
    );
  }
});

test("config_refuses_a_contract_that_is_not_an_account", () => {
  for (const contract of [undefined, "", "Tender.testnet", "tender testnet", "t"]) {
    expect(() => readConfig({ ...BASE, NEXT_PUBLIC_CONTRACT: contract }), String(contract)).toThrow(
      /NEXT_PUBLIC_CONTRACT/,
    );
  }
});

test("dev_wallet_forced_off_outside_sandbox", () => {
  const on = { NEXT_PUBLIC_DEV_WALLET: "1" };
  expect(readConfig({ ...SANDBOX, ...on }).devWallet).toBe(true);
  expect(readConfig({ ...BASE, ...on }).devWallet).toBe(false);
  expect(readConfig({ ...BASE, ...on, NEXT_PUBLIC_NETWORK: "mainnet" }).devWallet).toBe(false);
});

test("dev_wallet_needs_the_value_one", () => {
  for (const value of [undefined, "", "0", "true", "yes", "01"]) {
    expect(readConfig({ ...SANDBOX, NEXT_PUBLIC_DEV_WALLET: value }).devWallet, String(value)).toBe(
      false,
    );
  }
});

test("config_of_this_module_comes_from_the_environment", () => {
  // vitest.config.ts sets these.
  expect(config).toEqual({
    network: "testnet",
    apiUrl: "http://api.test",
    rpcUrl: "http://rpc.test",
    contractId: "tender.testnet",
    devWallet: false,
  });
});
