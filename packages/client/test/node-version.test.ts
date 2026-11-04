import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { NODE_ENGINES, nodeVersionOk, nodeVersionProblem } from "../src/index";

// The one Node check every command makes first (`requireNodeVersion`), held to the root
// `package.json`, which says the same to pnpm: Node 24 from 24.21 on, or Node 26 and newer.

test("the_rule_is_the_one_package_json_names", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { engines: { node: string } };
  expect(manifest.engines.node).toBe(NODE_ENGINES);
});

test("node_24_from_24_21_and_node_26_and_newer_pass", () => {
  for (const version of [
    "v24.21.0",
    "v24.21.1",
    "v24.22.0",
    "v24.99.9",
    "v26.0.0",
    "v26.1.2",
    "v27.0.0",
    "24.21.0",
  ]) {
    expect(nodeVersionOk(version), version).toBe(true);
    expect(nodeVersionProblem(version), version).toBeUndefined();
  }
  // The Node that runs these tests is one of them.
  expect(nodeVersionProblem()).toBeUndefined();
});

test("an_older_node_and_node_25_are_named_in_one_line", () => {
  expect(nodeVersionProblem("v22.22.2")).toBe(
    "Tender needs Node 24.21 or a later 24, or Node 26 and newer; this is v22.22.2",
  );
  for (const version of [
    "v24.20.9",
    "v24.20.0",
    "v24.0.0",
    "v25.0.0",
    "v25.1.0",
    "v25.99.0",
    "v20.20.2",
    "v18.0.0",
  ]) {
    expect(nodeVersionOk(version), version).toBe(false);
    expect(nodeVersionProblem(version), version).toBe(
      `Tender needs Node 24.21 or a later 24, or Node 26 and newer; this is ${version}`,
    );
  }
});
