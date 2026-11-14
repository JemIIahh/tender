import { expect, test } from "vitest";
import { attestedModels, signatureCount, verifyCommand } from "../lib/attested";

const NETWORK = {
  contractId: "tender.example.testnet",
  apiUrl: "https://api.example.test",
  rpcUrl: "http://127.0.0.1:3030",
};

test("the_check_command_names_the_task_the_contract_and_the_api", () => {
  expect(verifyCommand("12", { ...NETWORK, network: "testnet" })).toBe(
    "node scripts/verify-scorecard.mjs --task 12 --contract tender.example.testnet --api https://api.example.test --network testnet",
  );
});

test("the_check_command_for_a_local_chain_points_at_its_node", () => {
  // The script has a public node for testnet and mainnet only.
  expect(verifyCommand("3", { ...NETWORK, network: "sandbox" })).toBe(
    "node scripts/verify-scorecard.mjs --task 3 --contract tender.example.testnet --api https://api.example.test --rpc http://127.0.0.1:3030",
  );
});

test("models_are_listed_once_in_the_order_they_first_appear", () => {
  const row = (model: string) => ({
    signer_id: "s",
    model,
    request_hash: "a".repeat(64),
    response_hash: "b".repeat(64),
  });
  expect(attestedModels([row("m-1"), row("m-2"), row("m-1")])).toEqual(["m-1", "m-2"]);
});

test("a_count_of_signatures_is_singular_for_one", () => {
  expect(signatureCount(1)).toBe("1 signature");
  expect(signatureCount(2)).toBe("2 signatures");
});
