import { canonicalBase, NETWORKS } from "@tender/shared";
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
    judgeAccount: null,
    privy: null,
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
  // A path stays: the API can sit behind one.
  expect(readConfig({ ...BASE, NEXT_PUBLIC_API_URL: "https://tender.example/api/" }).apiUrl).toBe(
    "https://tender.example/api",
  );
});

test("config_api_url_is_the_one_spelling_a_sign_in_is_signed_for", () => {
  // The address the page calls and the recipient it signs for are one string, so the API url is
  // `canonicalBase` of what is written: host in lower case, the scheme's own port left out, and
  // the `/v1` the routes sit under left off.
  for (const [written, canonical] of [
    ["https://API.Tender.example:443/", "https://api.tender.example"],
    ["http://localhost:8787", "http://localhost:8787"],
    ["https://tender.example/api/v1/", "https://tender.example/api"],
  ] as const) {
    const { apiUrl } = readConfig({ ...BASE, NEXT_PUBLIC_API_URL: written });
    expect(apiUrl, written).toBe(canonical);
    expect(canonicalBase(apiUrl), written).toBe(apiUrl);
  }
});

test("config_refuses_an_api_url_that_canonical_base_refuses", () => {
  for (const url of [
    "http://localhost:8787//",
    "https://tender.example/api//v1",
    "https://api.tender.example./",
    "https://api.tender.example/v1/v1",
    "https://api.tender.example?",
    "https://api.tender.example/#",
    "https://user:secret@api.tender.example",
  ]) {
    expect(() => readConfig({ ...BASE, NEXT_PUBLIC_API_URL: url }), url).toThrow(
      /NEXT_PUBLIC_API_URL/,
    );
  }
});

test("config_api_url_error_from_canonical_base_does_not_quote_the_address", () => {
  let message = "";
  try {
    readConfig({ ...BASE, NEXT_PUBLIC_API_URL: "https://user:hunter2@api.tender.example" });
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toMatch(/NEXT_PUBLIC_API_URL/);
  expect(message).not.toContain("hunter2");
});

test("config_api_url_error_for_a_value_that_is_not_http_shows_the_value", () => {
  // `httpUrl` runs first and says what it got, so that the variable can be put right. That is the
  // reason a password does not belong in a NEXT_PUBLIC_* value: it ships in the page all the same.
  for (const value of ["ftp://api.tender.example", "not a url"]) {
    expect(() => readConfig({ ...BASE, NEXT_PUBLIC_API_URL: value }), value).toThrow(
      `NEXT_PUBLIC_API_URL must be an http(s) URL, got ${JSON.stringify(value)}`,
    );
  }
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

test("config_judge_account_is_optional_and_an_account_id", () => {
  // The post wizard offers the Judge as a verifier only when this build knows its account.
  expect(readConfig(BASE).judgeAccount).toBeNull();
  expect(
    readConfig({ ...BASE, NEXT_PUBLIC_JUDGE_ACCOUNT: "judge.tender.testnet" }).judgeAccount,
  ).toBe("judge.tender.testnet");
  // An empty value in a .env file, or one of spaces, is the same as none.
  for (const empty of ["", "  "]) {
    expect(
      readConfig({ ...BASE, NEXT_PUBLIC_JUDGE_ACCOUNT: empty }).judgeAccount,
      empty,
    ).toBeNull();
  }
  expect(
    readConfig({ ...BASE, NEXT_PUBLIC_JUDGE_ACCOUNT: " judge.tender.testnet\n" }).judgeAccount,
  ).toBe("judge.tender.testnet");
});

test("config_refuses_a_judge_account_that_is_not_an_account", () => {
  // A mistake to stop at, not a Judge to leave out without a word.
  for (const judge of ["Judge.testnet", "judge testnet", "j", "judge@testnet"]) {
    expect(() => readConfig({ ...BASE, NEXT_PUBLIC_JUDGE_ACCOUNT: judge }), judge).toThrow(
      `NEXT_PUBLIC_JUDGE_ACCOUNT must be a NEAR account id, got ${JSON.stringify(judge)}`,
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
    judgeAccount: null,
    privy: null,
  });
});

test("config_has_the_email_login_only_with_a_privy_app_id_and_off_the_sandbox", () => {
  // No app id: Connect opens the NEAR wallets, as it did before there was a login.
  expect(readConfig(BASE).privy).toBeNull();
  expect(readConfig({ ...BASE, NEXT_PUBLIC_PRIVY_APP_ID: "" }).privy).toBeNull();
  expect(readConfig({ ...BASE, NEXT_PUBLIC_PRIVY_APP_ID: " cm0app1d " }).privy).toEqual({
    appId: "cm0app1d",
    clientId: null,
  });
  expect(
    readConfig({
      ...BASE,
      NEXT_PUBLIC_NETWORK: "mainnet",
      NEXT_PUBLIC_PRIVY_APP_ID: "cm0app1d",
      NEXT_PUBLIC_PRIVY_CLIENT_ID: "client-WY2abc_9",
    }).privy,
  ).toEqual({ appId: "cm0app1d", clientId: "client-WY2abc_9" });
  // The sandbox has its dev wallet, and Tender sends no NEAR for fees there.
  expect(readConfig({ ...SANDBOX, NEXT_PUBLIC_PRIVY_APP_ID: "cm0app1d" }).privy).toBeNull();
});

test("config_refuses_a_privy_id_that_is_not_one_and_a_client_id_alone", () => {
  expect(() => readConfig({ ...BASE, NEXT_PUBLIC_PRIVY_APP_ID: "app id" })).toThrow(
    /NEXT_PUBLIC_PRIVY_APP_ID/,
  );
  expect(() =>
    readConfig({
      ...BASE,
      NEXT_PUBLIC_PRIVY_APP_ID: "cm0app1d",
      NEXT_PUBLIC_PRIVY_CLIENT_ID: "a/b",
    }),
  ).toThrow(/NEXT_PUBLIC_PRIVY_CLIENT_ID/);
  expect(() => readConfig({ ...BASE, NEXT_PUBLIC_PRIVY_CLIENT_ID: "client-1" })).toThrow(
    /NEXT_PUBLIC_PRIVY_CLIENT_ID is set without NEXT_PUBLIC_PRIVY_APP_ID/,
  );
});
