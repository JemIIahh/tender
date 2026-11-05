import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ApiClient,
  bondTermsOf,
  type LocalChain,
  type Signer,
  startLocalChain,
  TenderClient,
} from "@tender/client";
import {
  type AgentAccountAction,
  ConnectCodeCreatedSchema,
  type ConnectCodeState,
  ConnectCodeStateSchema,
  ConnectImplicitAgentsSchema,
  connectFingerprint,
  fundAgentCalls,
  implicitAccountActions,
  implicitAccountOf,
  subAccountActions,
} from "@tender/shared";
import { Account, actions, JsonRpcProvider, type KeyPairString } from "near-api-js";
import { afterAll, beforeAll, expect, test } from "vitest";
import { connectAgentCommand } from "../../../scripts/agent";
import { type Services, startServices } from "../../../scripts/serve";
import { createConnectServer } from "../src/server";

// "Connect your agent" end to end, on a local chain with the bond set and the services
// (`pnpm serve`'s, with the index in an in-memory PGlite): the owner signs in and makes a code, the
// agent attaches its public key, the owner's wallet batch is sent with the actions the page sends
// (`subAccountActions` or `implicitAccountActions` of `@tender/shared`, signed here with the owner's
// key, as a wallet would: the account and its NEAR, then its storage with Tender and its bond into
// its vault), the agent registers itself with its own key, and the index shows it active. By the
// sub-account (its setup code adds the agent's key; no AddKey is sent) from a terminal
// (`pnpm agent:connect`'s command) and from an MCP client (`connect_to_tender`); by the implicit
// account, which the owner chooses on the API while the agent waits, and on a later run; and with a
// code that someone else used first. Every line either agent prints is searched for its private key,
// which must not be in it.

let chain: LocalChain;
let services: Services;
let reader: TenderClient;
let provider: JsonRpcProvider;
let work: string;
let owner: Signer;
let ownerApi: ApiClient;
let token: string;
const serviceLines: string[] = [];

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "tender-connect-"));
  chain = await startLocalChain();
  reader = new TenderClient({
    network: chain.network,
    contractId: chain.contractId,
    rpcUrl: chain.rpcUrl,
  });
  provider = new JsonRpcProvider({ url: chain.rpcUrl });
  services = await startServices(
    {
      TENDER_NETWORK: chain.network,
      TENDER_CONTRACT: chain.contractId,
      NEAR_RPC_URL: chain.rpcUrl,
      DATABASE_URL: "pglite:memory",
      API_PORT: "0",
      INDEXER_POLL_MS: "100",
    },
    { deploymentsDir: join(work, "deployments"), log: (line) => serviceLines.push(line) },
  );
  // The owner is alice: she holds the bond's token in her own wallet, as an agent provider would.
  owner = chain.accounts.alice;
  ownerApi = new ApiClient({ baseUrl: services.publicUrl, signer: owner });
  token = await ownerApi.signIn();
});

afterAll(async () => {
  await services?.stop();
  await chain?.stop();
  if (work) await rm(work, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(what: string, check: () => Promise<boolean>, ms: number): Promise<void> {
  const giveUpAt = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > giveUpAt) throw new Error(`timed out waiting until ${what}`);
    await sleep(200);
  }
}

/** What the owner's page sends: `POST /v1/connect/codes`, signed in. */
async function makeCode(name: string) {
  const res = await fetch(`${services.publicUrl}/v1/connect/codes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(200);
  return ConnectCodeCreatedSchema.parse(await res.json());
}

/** What the owner's page reads every 2 seconds. */
async function stateOf(id: string): Promise<ConnectCodeState> {
  const res = await fetch(`${services.publicUrl}/v1/connect/codes/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return ConnectCodeStateSchema.parse(await res.json());
}

/** A wallet connector's action, as near-api-js signs it. */
function signable(action: AgentAccountAction) {
  switch (action.type) {
    case "CreateAccount":
      return actions.createAccount();
    case "Transfer":
      return actions.transfer(BigInt(action.params.deposit));
    case "DeployContract":
      return actions.deployContract(action.params.code);
    case "FunctionCall":
      return actions.functionCall(
        action.params.methodName,
        action.params.args,
        BigInt(action.params.gas),
        BigInt(action.params.deposit),
      );
  }
}

/**
 * The owner's one approval, as the page builds it (`createAgentBatch` and `implicitAgentBatch` in
 * apps/web/lib/connect.ts): the transaction to the agent's account with the actions of
 * `@tender/shared`, then `fundAgentCalls`. Signed here with the owner's own key, as the wallet would,
 * one transaction after the other.
 */
async function ownerBatch(accountId: string, accountActions: AgentAccountAction[]): Promise<void> {
  const account = new Account(owner.accountId, provider, owner.privateKey as KeyPairString);
  const sent = await account.signAndSendTransaction({
    receiverId: accountId,
    actions: accountActions.map(signable),
    waitUntil: "FINAL",
  });
  // No action of it, nor any receipt it made, failed.
  for (const outcome of [sent.transaction_outcome, ...sent.receipts_outcome]) {
    expect(JSON.stringify(outcome.outcome.status)).not.toMatch(/Failure/);
  }
  const terms = bondTermsOf(await reader.getConfig());
  for (const call of fundAgentCalls({
    contractId: chain.contractId,
    accountId,
    storage: true,
    bond: terms === null ? null : { token: terms.token, amount: terms.amount },
  })) {
    await account.signAndSendTransaction({
      receiverId: call.receiverId,
      actions: [actions.functionCall(call.methodName, call.args, call.gas, call.deposit)],
      waitUntil: "FINAL",
    });
  }
}

/** The full-access keys of `accountId`. */
async function fullAccessKeys(accountId: string): Promise<string[]> {
  const list = await provider.viewAccessKeyList({
    accountId,
    finalityQuery: { finality: "final" },
  });
  return list.keys
    .filter((entry) => entry.access_key.permission === "FullAccess")
    .map((entry) => String(entry.public_key));
}

/** What the owner's page sends on "Use a separate account instead": `POST /v1/connect/codes/:id/implicit`. */
async function chooseImplicit(id: string): Promise<ConnectCodeState> {
  const res = await fetch(`${services.publicUrl}/v1/connect/codes/${id}/implicit`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return ConnectCodeStateSchema.parse(await res.json());
}

/** The private key in an agent's key file, and its body alone. */
async function secretsIn(path: string): Promise<string[]> {
  const { privateKey } = JSON.parse(await readFile(path, "utf8")) as { privateKey: string };
  return [privateKey, privateKey.slice("ed25519:".length)];
}

test("from_a_terminal_a_code_becomes_an_active_agent_with_one_batch_of_the_owner", async () => {
  const keys = join(work, "keys-cli");
  const repo = join(work, "repo-cli");
  const code = await makeCode("writer");
  const accountId = `writer.${owner.accountId}`;
  expect(code.account_id).toBe(accountId);

  const lines: string[] = [];
  const connecting = connectAgentCommand({
    code: code.code,
    api: services.publicUrl,
    dir: keys,
    repoDir: repo,
    env: { NEAR_RPC_URL: chain.rpcUrl },
    log: (line) => lines.push(line),
    pollMs: 300,
    waitMs: 120_000,
  });

  // The page sees the key the agent attached, with the fingerprint the agent printed.
  await until(
    "the agent attaches its key",
    async () => (await stateOf(code.id)).state === "attached",
    60_000,
  );
  const attached = await stateOf(code.id);
  if (attached.public_key === null) throw new Error("no key attached");
  expect(attached.fingerprint).toBe(connectFingerprint(attached.public_key));
  await until(
    "the agent prints the fingerprint",
    async () => lines.some((l) => l.startsWith("fingerprint: ")),
    10_000,
  );
  expect(lines).toContain(`fingerprint: ${attached.fingerprint}`);
  expect(lines).toContain(`public key: ${attached.public_key}`);
  // Nothing on the chain yet: the agent waits for the owner.
  expect(await reader.getAgent(accountId)).toBeNull();

  await ownerBatch(accountId, subAccountActions(attached.public_key));

  const outcome = await connecting;
  expect(outcome).toMatchObject({
    status: "registered",
    accountId,
    accountKind: "sub_account",
    confirmed: true,
  });
  const agent = await reader.getAgent(accountId);
  expect(agent?.status).toBe("active");
  expect(agent?.bond_amount).not.toBeNull();
  // Its provider is the owner, and its one full-access key is the agent's, which the setup code
  // added: the setup cannot run again.
  expect(agent?.asp).toBe(owner.accountId);
  expect(await fullAccessKeys(accountId)).toEqual([attached.public_key]);
  await until(
    "the index shows the agent",
    async () => (await stateOf(code.id)).agent !== null,
    30_000,
  );
  expect(await stateOf(code.id)).toMatchObject({
    state: "registered",
    agent: { status: "active" },
  });

  // The key is in its file, mode 600, and in no line the agent printed.
  const file = join(keys, "writer.json");
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
    account: accountId,
    publicKey: attached.public_key,
  });
  const secrets = await secretsIn(file);
  for (const line of lines) for (const secret of secrets) expect(line).not.toContain(secret);
  expect(lines.at(-1)).toBe(
    `done: ${accountId} is an active agent, and the page of ${owner.accountId} says so`,
  );
});

test("from_an_mcp_client_connect_to_tender_goes_on_from_where_it_stopped", async () => {
  const keys = join(work, "keys-mcp");
  const server = createConnectServer({
    network: chain.network,
    contractId: chain.contractId,
    api: new ApiClient({ baseUrl: services.publicUrl }),
    rpcUrl: chain.rpcUrl,
    keysDir: keys,
    pollMs: 300,
  });
  const mcp = new Client({ name: "test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), mcp.connect(clientSide)]);
  const call = async (args: Record<string, unknown>) => {
    const result = await mcp.callTool({ name: "connect_to_tender", arguments: args });
    const [first] = result.content as Array<{ type: string; text: string }>;
    if (result.isError) throw new Error(first?.text);
    return JSON.parse(first?.text ?? "{}") as Record<string, unknown>;
  };

  try {
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).toEqual(["connect_to_tender"]);
    const code = await makeCode("reader");
    const accountId = `reader.${owner.accountId}`;
    // The key directory as the guard settles it: with its links followed (macOS's /var is one).
    const keyFile = join(await realpath(work), "keys-mcp", "reader.json");

    // The first call attaches the key and stops: the owner has not created the account.
    const first = await call({ code: code.code, wait_seconds: 0 });
    const attached = await stateOf(code.id);
    expect(first).toMatchObject({
      status: "waiting_for_account",
      account: accountId,
      owner: owner.accountId,
      fingerprint: attached.fingerprint,
      key_file: keyFile,
    });
    expect(String(first.next)).toMatch(/press Create agent\. Then call connect_to_tender again/);
    if (attached.public_key === null) throw new Error("no key attached");

    await ownerBatch(accountId, subAccountActions(attached.public_key));

    // The next call uses the same key, finds the account and the bond, and registers.
    const second = await call({ code: code.code, wait_seconds: 60 });
    expect(second).toMatchObject({
      status: "registered",
      account: accountId,
      confirmed_by_api: true,
    });
    expect((second.progress as string[]).some((line) => line === `key: using ${keyFile}`)).toBe(
      true,
    );
    // A delegate key spends, within its caps: the answer says so, and never that it cannot.
    expect(String(second.next)).toMatch(/delegate key, whose spending is capped: it can post/);
    expect(String(second.next)).not.toMatch(/cannot spend/);
    expect((await reader.getAgent(accountId))?.status).toBe("active");
    const secrets = await secretsIn(join(keys, "reader.json"));
    for (const answer of [first, second]) {
      for (const secret of secrets) expect(JSON.stringify(answer)).not.toContain(secret);
    }
  } finally {
    await mcp.close();
    await server.close();
  }
});

test("when_the_wallet_refuses_the_sub_account_the_agent_goes_by_its_implicit_account", async () => {
  const keys = join(work, "keys-solo");
  const code = await makeCode("solo");
  const lines: string[] = [];
  const connecting = connectAgentCommand({
    code: code.code,
    api: services.publicUrl,
    dir: keys,
    repoDir: join(work, "repo-solo"),
    env: { NEAR_RPC_URL: chain.rpcUrl },
    log: (line) => lines.push(line),
    pollMs: 300,
    lookupMs: 600,
    waitMs: 120_000,
  });
  await until(
    "the agent attaches its key",
    async () => (await stateOf(code.id)).state === "attached",
    60_000,
  );
  const attached = await stateOf(code.id);
  if (attached.public_key === null) throw new Error("no key attached");
  const implicit = implicitAccountOf(attached.public_key);
  if (implicit === null) throw new Error("no implicit account");

  // The owner's wallet refused the sub-account's transaction (nothing was sent), and the owner
  // chose the separate account: the API works it out from the key, and the agent moves its wait.
  const moved = await chooseImplicit(code.id);
  expect(moved).toMatchObject({ account_kind: "implicit", account_id: implicit });
  await until(
    "the agent waits for the implicit account",
    async () =>
      lines.some((l) => l.includes(`chose a separate account for this agent: ${implicit}`)),
    30_000,
  );
  await ownerBatch(implicit, implicitAccountActions());

  const outcome = await connecting;
  expect(outcome).toMatchObject({
    status: "registered",
    accountId: implicit,
    accountKind: "implicit",
    confirmed: true,
  });
  // The chain made it with the agent's key alone, and the contract gives it no provider.
  expect(await fullAccessKeys(implicit)).toEqual([attached.public_key]);
  const agent = await reader.getAgent(implicit);
  expect(agent).toMatchObject({ status: "active", asp: null });
  expect(await reader.getAgent(`solo.${owner.accountId}`)).toBeNull();
  // The key file names the account it is for now.
  expect(JSON.parse(await readFile(join(keys, "solo.json"), "utf8"))).toMatchObject({
    account: implicit,
    publicKey: attached.public_key,
  });
  // The owner's record lists it: "set up by you, not linked on chain".
  await until(
    "the index shows the agent",
    async () => (await stateOf(code.id)).agent !== null,
    30_000,
  );
  const res = await fetch(`${services.publicUrl}/v1/connect/implicit`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(ConnectImplicitAgentsSchema.parse(await res.json()).agents).toContainEqual(
    expect.objectContaining({
      account_id: implicit,
      name: "solo",
      agent: expect.objectContaining({ status: "active" }),
    }),
  );
  const secrets = await secretsIn(join(keys, "solo.json"));
  for (const line of lines) for (const secret of secrets) expect(line).not.toContain(secret);
});

test("connect_to_tender_goes_on_at_the_implicit_account_the_owner_chose_between_calls", async () => {
  const keys = join(work, "keys-mcp-solo");
  const server = createConnectServer({
    network: chain.network,
    contractId: chain.contractId,
    api: new ApiClient({ baseUrl: services.publicUrl }),
    rpcUrl: chain.rpcUrl,
    keysDir: keys,
    pollMs: 300,
  });
  const mcp = new Client({ name: "test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), mcp.connect(clientSide)]);
  const call = async (args: Record<string, unknown>) => {
    const result = await mcp.callTool({ name: "connect_to_tender", arguments: args });
    const [first] = result.content as Array<{ type: string; text: string }>;
    if (result.isError) throw new Error(first?.text);
    return JSON.parse(first?.text ?? "{}") as Record<string, unknown>;
  };
  try {
    const code = await makeCode("lone");
    const first = await call({ code: code.code, wait_seconds: 0 });
    expect(first).toMatchObject({ status: "waiting_for_account", account_kind: "sub_account" });
    const attached = await stateOf(code.id);
    if (attached.public_key === null) throw new Error("no key attached");
    const implicit = implicitAccountOf(attached.public_key);
    if (implicit === null) throw new Error("no implicit account");

    await chooseImplicit(code.id);
    await ownerBatch(implicit, implicitAccountActions());

    const second = await call({ code: code.code, wait_seconds: 60 });
    expect(second).toMatchObject({
      status: "registered",
      account: implicit,
      account_kind: "implicit",
      confirmed_by_api: true,
    });
    expect(String(second.next)).toMatch(/won't list it under .* as its provider/);
    expect(String(second.next)).toMatch(/pnpm agent:delegate --name lone/);
    expect(await reader.getAgent(implicit)).toMatchObject({ status: "active", asp: null });
    const secrets = await secretsIn(join(keys, "lone.json"));
    for (const answer of [first, second]) {
      for (const secret of secrets) expect(JSON.stringify(answer)).not.toContain(secret);
    }
  } finally {
    await mcp.close();
    await server.close();
  }
});

test("a_code_someone_else_used_first_is_refused_contested_and_nothing_is_created", async () => {
  const code = await makeCode("victim");
  const accountId = `victim.${owner.accountId}`;
  // Someone who learned the code attaches a key of their own before the agent runs.
  const thief = new ApiClient({ baseUrl: services.publicUrl });
  const stolen = await thief.connectAttach(
    code.code,
    "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp",
  );
  expect(stolen.state).toBe("attached");

  const lines: string[] = [];
  await expect(
    connectAgentCommand({
      code: code.code,
      api: services.publicUrl,
      dir: join(work, "keys-victim"),
      repoDir: join(work, "repo-victim"),
      env: { NEAR_RPC_URL: chain.rpcUrl },
      log: (line) => lines.push(line),
      waitMs: 1_000,
    }),
  ).rejects.toThrow(/another key attached already.*NOT to press Create agent/);
  // The agent told the API: the owner's page now reads the code as contested, and refuses it. The
  // fingerprint it shows is the stolen key's, and nothing was created.
  const after = await stateOf(code.id);
  expect(after.state).toBe("contested");
  expect(after.contested_at).not.toBeNull();
  expect(after.fingerprint).toBe(stolen.fingerprint);
  expect(await reader.getAgent(accountId)).toBeNull();
  expect(lines.some((line) => line.startsWith("fingerprint: "))).toBe(false);
});
