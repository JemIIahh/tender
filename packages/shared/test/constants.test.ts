import { expect, test } from "vitest";
import { NETWORKS } from "../src/index";

test("networks_are_read_only", () => {
  expect(Object.isFrozen(NETWORKS)).toBe(true);
  for (const config of Object.values(NETWORKS)) {
    expect(Object.isFrozen(config)).toBe(true);
  }

  // The directives also make `pnpm typecheck` fail if these assignments ever compile again.
  expect(() => {
    // @ts-expect-error a network's settings are read only
    NETWORKS.sandbox.rpcUrl = "http://127.0.0.1:3030";
  }).toThrow(TypeError);
  expect(() => {
    // @ts-expect-error the table of networks is read only
    NETWORKS.testnet = NETWORKS.mainnet;
  }).toThrow(TypeError);

  expect(NETWORKS.sandbox.rpcUrl).toBe("");
  expect(NETWORKS.testnet.id).toBe("testnet");
});
