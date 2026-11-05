import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ConnectApi } from "@tender/client";
import { ApiError, type ConnectLookup } from "@tender/shared";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ConfigError, readConnectConfig } from "../src/config";
import { createConnectServer } from "../src/server";
import type { ConnectToolDeps } from "../src/tools/connect";

// `connect_to_tender` and the server's connect mode (`tender-mcp --connect`), without a chain: what
// connect mode reads, that it offers the one tool, and the tool's refusals, each before a key is
// made or anything sent. The whole flow, with a chain, is connect.sandbox.test.ts.

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BIN = join(ROOT, "packages/mcp/bin/tender-mcp.ts");
const CODE = "tc_abcdefghijklmnopqrstuvwxyz";

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "tender-mcp-connect-"));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

const lookupOf = (over: Partial<ConnectLookup> = {}): ConnectLookup => ({
  owner: "alice.testnet",
  name: "writer",
  account_id: "writer.alice.testnet",
  account_kind: "sub_account",
  network: "testnet",
  contract: "tender.testnet",
  state: "waiting",
  expires_at: "2026-11-04T10:30:00.000Z",
  fingerprint: null,
  ...over,
});

function fakeApi(lookup: () => Promise<ConnectLookup>) {
  const asked: string[] = [];
  const api: ConnectApi = {
    async connectLookup() {
      asked.push("lookup");
      return lookup();
    },
    async connectAttach() {
      asked.push("attach");
      throw new Error("not in these tests");
    },
    async connectContest() {
      asked.push("contest");
      throw new Error("not in these tests");
    },
    async connectRegistered() {
      asked.push("registered");
      throw new Error("not in these tests");
    },
  };
  return { api, asked };
}

async function serverWith(deps: Partial<ConnectToolDeps> & { api: ConnectApi }) {
  const server = createConnectServer({
    network: "testnet",
    contractId: "tender.testnet",
    rpcUrl: "http://127.0.0.1:1",
    keysDir: join(work, "keys"),
    ...deps,
  });
  const mcp = new Client({ name: "test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), mcp.connect(clientSide)]);
  return {
    mcp,
    async call(args: Record<string, unknown>) {
      const result = await mcp.callTool({ name: "connect_to_tender", arguments: args });
      const texts = (result.content as Array<{ text: string }>).map((block) => block.text);
      return { isError: result.isError === true, text: texts.join("\n") };
    },
  };
}

test("connect_mode_reads_the_network_the_contract_and_the_api_and_no_key", () => {
  expect(
    readConnectConfig({
      TENDER_NETWORK: "testnet",
      TENDER_CONTRACT: "tender.testnet",
      TENDER_API_URL: "https://api.tender.example/",
      // Not read in connect mode: the tool makes the agent's key.
      TENDER_ACCOUNT: "",
      TENDER_PRIVATE_KEY: "",
    }),
  ).toEqual({
    network: "testnet",
    contractId: "tender.testnet",
    apiUrl: "https://api.tender.example",
    rpcUrl: "https://rpc.testnet.fastnear.com",
  });
  const fault = (env: Record<string, string>) => {
    try {
      readConnectConfig(env);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return (error as Error).message;
    }
    throw new Error("no fault");
  };
  expect(fault({})).toBe(
    "missing environment variables: TENDER_NETWORK, TENDER_CONTRACT, TENDER_API_URL",
  );
  expect(
    fault({
      TENDER_NETWORK: "sandbox",
      TENDER_CONTRACT: "tender.test.near",
      TENDER_API_URL: "http://127.0.0.1:3030",
    }),
  ).toBe("missing environment variable: NEAR_RPC_URL");
  expect(
    fault({
      TENDER_NETWORK: "testnet",
      TENDER_CONTRACT: "tender.testnet",
      TENDER_API_URL: "http://api.example",
    }),
  ).toMatch(/^TENDER_API_URL must be an https URL/);
});

test("the_connect_server_offers_connect_to_tender_alone", async () => {
  const { mcp } = await serverWith(fakeApi(async () => lookupOf()));
  const { tools } = await mcp.listTools();
  expect(tools.map((tool) => tool.name)).toEqual(["connect_to_tender"]);
  const [tool] = tools;
  expect(tool?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
  expect(tool?.description).toMatch(/sends only the PUBLIC key to Tender/);
  await mcp.close();
});

test("a_code_for_another_deployment_is_refused_before_a_key_is_made", async () => {
  const { api, asked } = fakeApi(async () => lookupOf({ contract: "other.testnet" }));
  const { call, mcp } = await serverWith({ api });
  const answer = await call({ code: CODE });
  expect(answer.isError).toBe(true);
  expect(answer.text).toMatch(
    /^WRONG_DEPLOYMENT: this code is for the contract other\.testnet on testnet, and this server is set for tender\.testnet on testnet/,
  );
  expect(asked).toEqual(["lookup"]);
  await expect(stat(join(work, "keys"))).rejects.toMatchObject({ code: "ENOENT" });
  await mcp.close();
});

test("the_apis_refusal_is_told_in_words_of_ours_and_a_bad_code_never_leaves", async () => {
  const { api } = fakeApi(async () => {
    throw new ApiError(404, { error: "not_found", message: "a server's own words" });
  });
  const { call, mcp } = await serverWith({ api });
  const answer = await call({ code: CODE });
  expect(answer).toMatchObject({ isError: true });
  expect(answer.text).toMatch(/^CONNECT_STOPPED: the API knows no such connect code/);
  expect(answer.text).not.toContain("a server's own words");
  // A code of the wrong shape is refused by the tool's schema, and nothing is asked.
  const bad = await call({ code: "tc_short" });
  expect(bad.isError).toBe(true);
  await mcp.close();
});

test("a_key_directory_inside_the_repository_that_git_does_not_ignore_is_refused", async () => {
  const { api } = fakeApi(async () => lookupOf());
  const { call, mcp } = await serverWith({
    api,
    keysDir: join(ROOT, "packages/mcp/not-ignored-keys"),
  });
  const answer = await call({ code: CODE });
  expect(answer.isError).toBe(true);
  expect(answer.text).toMatch(
    /^KEY_DIR: a key directory inside the repository must be one that git ignores/,
  );
  await expect(stat(join(ROOT, "packages/mcp/not-ignored-keys"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await mcp.close();
});

test("the_bin_with_connect_serves_connect_to_tender_alone_without_an_account", {
  timeout: 120_000,
}, async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", BIN, "--connect"],
    cwd: ROOT,
    // An API that does not answer: the bin says the check was skipped, and starts.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: work,
      TENDER_NETWORK: "testnet",
      TENDER_CONTRACT: "tender.testnet",
      TENDER_API_URL: "http://127.0.0.1:1",
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const mcp = new Client({ name: "test", version: "0.0.0" });
  try {
    await mcp.connect(transport);
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).toEqual(["connect_to_tender"]);
    expect(stderr).toContain("tender-mcp: connect mode on testnet: connect_to_tender only");
  } finally {
    await mcp.close();
  }
});
