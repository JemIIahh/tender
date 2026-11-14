import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  describeEvidence,
  examineReport,
  main,
  registerSigner,
  type SignerChain,
} from "./register-signer";

// The signer script, against a report built from the real S1 fixture's key and address, and a fake
// chain. Nothing reaches NEAR AI Cloud or a node.

const FIXTURE = JSON.parse(
  readFileSync(new URL("../docs/research/S1-fixture.json", import.meta.url), "utf8"),
) as { model: string; signing_address: string; report_signing_public_key: string };
const MODEL = FIXTURE.model;
const ADDRESS = FIXTURE.signing_address;
const NONCE = "13ddede564903ce01ca41ae32e0c0c391196bd120286cc00eb1873704642f4a1";

/** A TDX quote whose report_data (bytes 568 to 632) is the address, 12 zero bytes and the nonce. */
function quoteFor(address: string, nonce: string): string {
  return `${"00".repeat(568)}${address.slice(2)}${"00".repeat(12)}${nonce}${"00".repeat(100)}`;
}

function reportOf(over: Record<string, unknown> = {}, nonce = NONCE) {
  return {
    gateway_attestation: { signing_address: "0xb98a789cdc4817275f5155593ba73ef2a957e779" },
    model_attestations: [
      {
        model_name: MODEL,
        signing_address: ADDRESS,
        signing_algo: "ecdsa",
        signing_public_key: FIXTURE.report_signing_public_key,
        request_nonce: nonce,
        intel_quote: quoteFor(ADDRESS, nonce),
        nvidia_payload: JSON.stringify({ nonce, evidence_list: [] }),
        ...over,
      },
    ],
  };
}

function fakeChain(chainId = "testnet") {
  const stored = new Map<string, { address: string; model: string; enabled: boolean }>();
  const chain = {
    chainId: vi.fn(async () => chainId),
    setAttestedSigner: vi.fn(async (input: Parameters<SignerChain["setAttestedSigner"]>[0]) => {
      stored.set(input.signerId, input);
      return { txHash: "FakeTxHash111" };
    }),
    getAttestedSigner: vi.fn(async (signerId: string) => {
      const found = stored.get(signerId);
      return found === undefined ? null : { signer_id: signerId, algo: "ecdsa", ...found };
    }),
  } satisfies SignerChain;
  return chain;
}

test("the_report_is_examined_and_the_signer_registered_and_read_back", async () => {
  const chain = fakeChain();
  const lines: string[] = [];
  const evidence = await registerSigner({
    signerId: "nearai-qwen3.8",
    model: MODEL,
    report: reportOf(),
    sentNonce: NONCE,
    chain,
    out: (line) => lines.push(line),
  });
  expect(evidence).toStrictEqual({
    model: MODEL,
    signingAddress: ADDRESS,
    addressFromPublicKey: true,
    intelQuoteBytes: 568 + 64 + 100,
    nvidiaPayloadBytes: JSON.stringify({ nonce: NONCE, evidence_list: [] }).length,
    requestNonce: NONCE,
    nonceIsOurs: true,
    quoteBindsAddress: true,
    quoteBindsNonce: true,
    nvidiaNonceMatches: true,
  });
  expect(chain.setAttestedSigner).toHaveBeenCalledWith({
    signerId: "nearai-qwen3.8",
    address: ADDRESS,
    model: MODEL,
    enabled: true,
  });
  expect(lines).toContain(
    `OK set_attested_signer nearai-qwen3.8 ecdsa ${ADDRESS} ${MODEL} (transaction FakeTxHash111)`,
  );
  // What is and is not verified here is always said.
  expect(lines.join("\n")).toContain("NOT verified here: the TDX quote's signature chain to Intel");
});

test("a_report_that_does_not_hold_together_is_refused_before_the_chain_is_asked", async () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ model_name: "other/model" }, `the report has no attestation for model ${MODEL}`],
    [{ signing_algo: "ed25519" }, `the report's key for ${MODEL} is not ecdsa`],
    [
      { signing_address: "0x0000000000000000000000000000000000000001" },
      "the report's signing_address is not the address of its signing_public_key",
    ],
    [
      { signing_public_key: "abcd" },
      "the report's signing_public_key is not a 64-byte secp256k1 key",
    ],
    [{ intel_quote: "" }, `the report has no intel_quote for ${MODEL}`],
    [{ nvidia_payload: undefined }, `the report has no nvidia_payload for ${MODEL}`],
  ];
  for (const [over, message] of cases) {
    const chain = fakeChain();
    await expect(
      registerSigner({
        signerId: "s",
        model: MODEL,
        report: reportOf(over),
        chain,
        out: () => undefined,
      }),
    ).rejects.toThrow(message);
    expect(chain.setAttestedSigner).not.toHaveBeenCalled();
  }
  expect(() => examineReport({}, MODEL)).toThrow("the report has no model_attestations");
});

test("evidence_that_does_not_bind_is_shown_as_such", () => {
  const evidence = examineReport(
    reportOf({ intel_quote: quoteFor(ADDRESS, "ff".repeat(32)), nvidia_payload: "{}" }),
    MODEL,
    "aa".repeat(32),
  );
  expect(evidence).toMatchObject({
    nonceIsOurs: false,
    quoteBindsAddress: true,
    quoteBindsNonce: false,
    nvidiaNonceMatches: false,
  });
  const text = describeEvidence(evidence).join("\n");
  expect(text).toContain("address yes, nonce NO");
  expect(text).toContain("chosen by the server");
});

test("mainnet_is_refused_by_name_and_by_chain_id_and_a_dry_run_calls_nothing", async () => {
  const errors: string[] = [];
  expect(
    await main(["--network", "mainnet", "--signer-id", "s", "--model", MODEL], {
      err: (text) => errors.push(text),
    }),
  ).toBe(1);
  expect(errors[0]).toContain("mainnet is not handled by this script");

  const chain = fakeChain("mainnet");
  await expect(
    registerSigner({
      signerId: "s",
      model: MODEL,
      report: reportOf(),
      chain,
      out: () => undefined,
    }),
  ).rejects.toThrow("mainnet is not handled by this script");
  expect(chain.setAttestedSigner).not.toHaveBeenCalled();

  const dry = fakeChain();
  const lines: string[] = [];
  await registerSigner({
    signerId: "s",
    model: MODEL,
    report: reportOf(),
    chain: dry,
    dryRun: true,
    out: (line) => lines.push(line),
  });
  expect(dry.chainId).not.toHaveBeenCalled();
  expect(lines.at(-1)).toBe("dry run: set_attested_signer was not called");
});

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

test("the_command_line_fetches_a_fresh_report_and_registers_as_the_owner", async () => {
  dir = await mkdtemp(join(tmpdir(), "register-signer-"));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    join(dir, ".env.deploy.sandbox"),
    [
      "DEPLOY_PARENT_ACCOUNT=owner.test.near",
      "DEPLOY_PARENT_PRIVATE_KEY=ed25519:not-a-real-key",
      "NEAR_RPC_URL=http://127.0.0.1:3030",
      "TENDER_CONTRACT=tender.owner.test.near",
      "LLM_API_KEY=key-for-tests",
    ].join("\n"),
  );
  const chain = fakeChain("sandbox");
  const targets: unknown[] = [];
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push(String(input));
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer key-for-tests");
    const nonce = new URL(String(input)).searchParams.get("nonce") ?? "";
    return new Response(JSON.stringify(reportOf({}, nonce)));
  }) as typeof fetch;
  const lines: string[] = [];
  const code = await main(
    ["--network", "sandbox", "--signer-id", "nearai-qwen3.8", "--model", MODEL],
    {
      dir,
      out: (line) => lines.push(line),
      err: (text) => lines.push(`ERR ${text}`),
      fetchImpl,
      makeChain: (target) => {
        targets.push(target);
        return chain;
      },
    },
  );
  expect(code).toBe(0);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatch(
    /^https:\/\/cloud-api\.near\.ai\/v1\/attestation\/report\?model=Qwen%2FQwen3\.8-27B&signing_algo=ecdsa&nonce=[0-9a-f]{64}$/,
  );
  expect(targets).toEqual([
    {
      network: "sandbox",
      rpcUrl: "http://127.0.0.1:3030",
      contractId: "tender.owner.test.near",
      owner: { accountId: "owner.test.near", privateKey: "ed25519:not-a-real-key" },
    },
  ]);
  expect(lines.join("\n")).toContain("(the one sent: a fresh report)");
  expect(lines.join("\n")).not.toContain("not-a-real-key");
  expect(chain.setAttestedSigner).toHaveBeenCalledTimes(1);
});
