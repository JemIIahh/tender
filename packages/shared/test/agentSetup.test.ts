import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  AGENT_SETUP_WASM_BYTES,
  AGENT_SETUP_WASM_SHA256,
  agentSetupWasm,
  sha256Hex,
} from "../src/index";

// The setup code the page deploys is the build in contract/res, byte for byte: the one the sandbox
// tests run and check-res.sh holds to its sources.

const RES = new URL("../../../contract/res/", import.meta.url);

test("the_embedded_setup_code_is_contract_res_agent_setup_wasm", () => {
  const built = new Uint8Array(readFileSync(fileURLToPath(new URL("agent_setup.wasm", RES))));
  const embedded = agentSetupWasm();
  expect(
    sha256Hex(embedded),
    "after contract/build.sh, paste `base64 -i contract/res/agent_setup.wasm` into packages/shared/src/agentSetup.ts",
  ).toBe(sha256Hex(built));
  expect(embedded).toEqual(built);
  expect(embedded.length).toBe(AGENT_SETUP_WASM_BYTES);
  const sums = readFileSync(fileURLToPath(new URL("SHA256SUMS", RES)), "utf8");
  expect(sums).toContain(`${AGENT_SETUP_WASM_SHA256}  agent_setup.wasm\n`);
});

test("each_copy_is_its_own", () => {
  const first = agentSetupWasm();
  first.fill(0);
  expect(sha256Hex(agentSetupWasm())).toBe(AGENT_SETUP_WASM_SHA256);
});
