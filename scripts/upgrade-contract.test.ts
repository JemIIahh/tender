import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NETWORKS } from "@tender/shared";
import { KeyPair } from "near-api-js";
import { afterEach, expect, test } from "vitest";
import { loadTarget, main, type UpgradeTarget, upgradeContract } from "./upgrade-contract";

// Everything here runs without a chain and without the network, in a temporary directory in place
// of the repository root, so that a real `.env.deploy.testnet` on this machine can never make a
// test upgrade for real. The upgrade itself runs on a real node in
// contract/sandbox/tests/upgrade.rs.

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function envDirWith(network: string, lines: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tender-upgrade-"));
  dirs.push(dir);
  await writeFile(join(dir, `.env.deploy.${network}`), `${lines.join("\n")}\n`, { mode: 0o600 });
  return dir;
}

const key = KeyPair.fromRandom("ed25519").toString();
const contractLines = [
  "TENDER_CONTRACT=tender.tender-dev-1104.testnet",
  `TENDER_CONTRACT_FULL_ACCESS_KEY=${key}`,
];

test("loadTarget refuses mainnet, other networks, and a sandbox without its RPC URL", async () => {
  const dir = await envDirWith("sandbox", contractLines);
  expect(() => loadTarget(undefined, undefined, { dir })).toThrow(/usage/);
  expect(() => loadTarget("mainnet", undefined, { dir })).toThrow(/mainnet is not upgraded/);
  expect(() => loadTarget("devnet", undefined, { dir })).toThrow(/unknown network "devnet"/);
  expect(() => loadTarget("sandbox", undefined, { dir })).toThrow(/pass --rpc-url/);
  const target = loadTarget("sandbox", "http://127.0.0.1:3030", { dir });
  expect(target).toEqual({
    network: "sandbox",
    rpcUrl: "http://127.0.0.1:3030",
    contract: { accountId: "tender.tender-dev-1104.testnet", privateKey: key },
  });
});

test("loadTarget reads the contract account and its key from .env.deploy.<network>", async () => {
  const dir = await envDirWith("testnet", contractLines);
  expect(loadTarget("testnet", undefined, { dir })).toEqual({
    network: "testnet",
    rpcUrl: NETWORKS.testnet.rpcUrl,
    contract: { accountId: "tender.tender-dev-1104.testnet", privateKey: key },
  });

  const missing = await envDirWith("testnet", ["TENDER_CONTRACT=tender.x.testnet"]);
  expect(() => loadTarget("testnet", undefined, { dir: missing })).toThrow(
    /TENDER_CONTRACT_FULL_ACCESS_KEY/,
  );
  const badKey = await envDirWith("testnet", [
    "TENDER_CONTRACT=tender.x.testnet",
    "TENDER_CONTRACT_FULL_ACCESS_KEY=not-a-key",
  ]);
  let message = "";
  try {
    loadTarget("testnet", undefined, { dir: badKey });
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toMatch(/TENDER_CONTRACT_FULL_ACCESS_KEY is not a valid private key/);
  expect(message).not.toContain("not-a-key");
});

test("the command line passes the target to the upgrade, and reports a refusal", async () => {
  const dir = await envDirWith("testnet", contractLines);
  const seen: UpgradeTarget[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(["--network", "testnet"], {
    dir,
    out: (line) => out.push(line),
    err: (text) => err.push(text),
    upgrade: async (target) => {
      seen.push(target);
      return { before: "a", after: "b", upgrade: null, record: null };
    },
  });
  expect(code).toBe(0);
  expect(seen.map((t) => t.contract.accountId)).toEqual(["tender.tender-dev-1104.testnet"]);
  expect(err).toEqual([]);

  const refused = await main(["--network", "mainnet"], {
    dir,
    err: (text) => err.push(text),
    upgrade: async () => {
      throw new Error("must not run");
    },
  });
  expect(refused).toBe(1);
  expect(err.join("\n")).toMatch(/mainnet is not upgraded/);
});

test("upgradeContract refuses mainnet before it reads anything", async () => {
  await expect(
    upgradeContract({
      network: "mainnet",
      rpcUrl: "http://127.0.0.1:1",
      contract: { accountId: "tender.near", privateKey: key },
    }),
  ).rejects.toThrow(/mainnet is not upgraded/);
});
