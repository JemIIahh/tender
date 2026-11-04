import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { MIN_NODE_VERSION, nodeVersionProblem } from "../src/index";

// The one Node check every command makes first (`requireNodeVersion`), held to the root
// `package.json`, which says the same to pnpm.

test("the_minimum_is_the_one_package_json_names", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { engines: { node: string } };
  expect(manifest.engines.node).toBe(`>=${MIN_NODE_VERSION}`);
});

test("node_24_21_and_newer_pass", () => {
  for (const version of ["v24.21.0", "v24.21.1", "v24.22.0", "v25.0.0", "v26.1.2", "24.21.0"]) {
    expect(nodeVersionProblem(version), version).toBeUndefined();
  }
  // The Node that runs these tests is one of them.
  expect(nodeVersionProblem()).toBeUndefined();
});

test("an_older_node_is_named_in_one_line", () => {
  expect(nodeVersionProblem("v22.22.2")).toBe("Tender needs Node 24.21 or newer; this is v22.22.2");
  for (const version of ["v24.20.9", "v24.0.0", "v20.20.2", "v18.0.0"]) {
    expect(nodeVersionProblem(version), version).toBe(
      `Tender needs Node 24.21 or newer; this is ${version}`,
    );
  }
});
