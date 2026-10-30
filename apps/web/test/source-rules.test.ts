import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Rules about the web app's source that a reviewer would otherwise have to remember.

const ROOT = resolve(import.meta.dirname, "../../..");
const WEB = join(ROOT, "apps/web");

// ---- The client root stays out of the browser (P06-P3) ----------------------------------------

// The check runs Biome with the repo's own `linter` and `overrides`, on a probe file placed where a
// file of the app would be, in a directory of its own: the real tree has no file that breaks the
// rule, and one should not have to be added to see that the rule is there.
const BIOME = join(ROOT, "node_modules/.bin/biome");
let probes: string;

beforeAll(() => {
  const repo = JSON.parse(readFileSync(join(ROOT, "biome.json"), "utf8"));
  probes = mkdtempSync(join(tmpdir(), "tender-biome-"));
  writeFileSync(
    join(probes, "biome.json"),
    JSON.stringify({ linter: repo.linter, overrides: repo.overrides }),
  );
});

afterAll(() => {
  rmSync(probes, { recursive: true, force: true });
});

/** Lints a file with `source` at `path` in the probe directory. */
function lint(path: string, source: string) {
  const file = join(probes, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  const run = spawnSync(BIOME, ["lint", path], { cwd: probes, encoding: "utf8" });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

const ROOT_IMPORT = 'export { createClient } from "@tender/client";\n';

test("lint_fails_on_an_import_of_the_client_root_in_the_web_app", () => {
  const result = lint("apps/web/lib/probe.ts", ROOT_IMPORT);

  expect(result.status).toBe(1);
  expect(result.output).toContain("noRestrictedImports");
  // The message says what to import instead.
  expect(result.output).toContain("@tender/client/outcome");
});

test("lint_fails_on_every_way_of_importing_the_client_root", () => {
  const sources: Record<string, string> = {
    "an import": 'import { createClient } from "@tender/client";\nexport const x = createClient;\n',
    "a type import": 'import type { Client } from "@tender/client";\nexport type X = Client;\n',
    "an export all": 'export * from "@tender/client";\n',
    "a dynamic import": 'export const load = () => import("@tender/client");\n',
  };

  for (const [way, source] of Object.entries(sources)) {
    const result = lint("apps/web/components/probe.tsx", source);

    expect(result.output, way).toContain("noRestrictedImports");
    expect(result.status, way).toBe(1);
  }
});

test("lint_passes_the_one_client_module_the_web_app_may_import", () => {
  const result = lint(
    "apps/web/lib/probe.ts",
    'export { receiptsFromTx } from "@tender/client/outcome";\n',
  );

  expect(result.output).not.toContain("noRestrictedImports");
  expect(result.status).toBe(0);
});

test("lint_leaves_the_client_root_to_the_code_that_runs_in_node", () => {
  // The rule is for the app that is bundled for the browser. Its specs and its tests run in Node,
  // and 06-T1b's specs start a chain with the client.
  for (const path of [
    "packages/agents/probe.ts",
    "apps/web/e2e/probe.ts",
    "apps/web/test/probe.ts",
  ]) {
    const result = lint(path, ROOT_IMPORT);

    expect(result.output, path).not.toContain("noRestrictedImports");
    expect(result.status, path).toBe(0);
  }
});

// ---- Text from a document is text -------------------------------------------------------------

/** Every source file of the app that ships to the browser. */
function appSources(): string[] {
  return ["app", "components", "lib"].flatMap((folder) =>
    readdirSync(join(WEB, folder), { recursive: true, encoding: "utf8" })
      .filter((name) => /\.tsx?$/.test(name))
      .map((name) => join(WEB, folder, name)),
  );
}

test("no_page_sets_inner_html", () => {
  const files = appSources();
  expect(files.length).toBeGreaterThan(20);

  // Briefs, criteria, reasons, scorecards, entry addresses and the Judge's words are written by
  // other people. React shows them as text; this is the one way to make it show them as markup.
  const offenders = files.filter((file) =>
    /dangerouslySetInnerHTML|\.innerHTML\s*=/.test(readFileSync(file, "utf8")),
  );

  expect(offenders).toEqual([]);
});
