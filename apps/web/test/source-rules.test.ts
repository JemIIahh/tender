import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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

// ---- The dev wallet and the token stay where they belong (06-T3) -------------------------------

const read = (path: string) => readFileSync(join(WEB, path), "utf8");

test("the_dev_wallet_is_imported_by_one_line_of_the_app_and_it_is_behind_the_sandbox_test", () => {
  // A line that imports the module, as a value: not a comment, not a type.
  const importers = appSources()
    .filter((file) => !file.endsWith("lib/devWallet.ts"))
    .flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter(
          (line) =>
            /["']\.{1,2}\/(?:lib\/)?devWallet["']/.test(line) &&
            !/^\s*(?:\*|\/\/)/.test(line) &&
            !/\bimport type\b|typeof import/.test(line),
        )
        .map(() => relative(WEB, file)),
    );
  expect(importers).toEqual(["lib/wallet.ts"]);

  // Next puts a build's network into the code where `process.env.NEXT_PUBLIC_NETWORK` is spelled
  // out, and drops the branch that can't run. The import must be in the branch that runs in the
  // sandbox only; `config.devWallet` is worked out at run time and can't do that.
  const wallet = read("lib/wallet.ts");
  const loader = wallet.slice(wallet.indexOf("export function loadDevWallet"));
  expect(loader).toMatch(
    /process\.env\.NEXT_PUBLIC_NETWORK !== "sandbox"\s*\?\s*Promise\.resolve\(null\)\s*:/,
  );
  // (The type in the signature also says `import("./devWallet")`; the value is after a `?`.)
  expect(loader.search(/\?\s*import\("\.\/devWallet"\)/)).toBeGreaterThan(
    loader.indexOf('NEXT_PUBLIC_NETWORK !== "sandbox"'),
  );
});

test("the_dev_wallet_key_and_account_are_read_in_one_module_and_only_under_the_sandbox_test", () => {
  const holders = appSources()
    .filter((file) => /NEXT_PUBLIC_DEV_WALLET_(?:KEY|ACCOUNT)/.test(readFileSync(file, "utf8")))
    .map((file) => relative(WEB, file));
  expect(holders).toEqual(["lib/devWallet.ts"]);

  const dev = read("lib/devWallet.ts");
  // Two reads, both in the sandbox's branch of a condition Next can settle at build time: a build
  // for another network holds neither value.
  expect(dev.match(/process\.env\.NEXT_PUBLIC_DEV_WALLET_(?:KEY|ACCOUNT)/g)).toHaveLength(2);
  expect(dev).toMatch(
    /process\.env\.NEXT_PUBLIC_NETWORK === "sandbox"\s*\?\s*\{[^}]*process\.env\.NEXT_PUBLIC_DEV_WALLET_ACCOUNT[^}]*process\.env\.NEXT_PUBLIC_DEV_WALLET_KEY[^}]*\}\s*:\s*\{/,
  );
  // And the module makes no wallet for any other network, whatever is in the environment.
  expect(dev).toMatch(
    /if \(process\.env\.NEXT_PUBLIC_NETWORK !== "sandbox"\) \{\s*throw new Error/,
  );
});

test("the_app_never_writes_to_local_storage_and_the_token_module_never_logs", () => {
  // Local storage is read by every later visit to the page, and the API token is a secret.
  const offenders = appSources()
    .filter((file) => /\blocalStorage\s*[.[]/.test(readFileSync(file, "utf8")))
    .map((file) => relative(WEB, file));
  expect(offenders).toEqual([]);

  // The token is signed in for by lib/auth.ts and kept by lib/apiToken.ts: neither logs.
  for (const file of ["lib/auth.ts", "lib/apiToken.ts"]) {
    expect(read(file), file).not.toMatch(/\bconsole\./);
  }
});

// ---- The tabs of a browser hear each other through one line (06-T3) ----------------------------

test("the_page_store_has_the_line_to_the_other_tabs_and_nothing_else_opens_a_channel", () => {
  // A store has no line to the other tabs unless it is given one, and the page's store is. A second
  // store built anywhere else would be a tab the others can't reach, so only lib/wallet.ts builds
  // one.
  expect(read("lib/wallet.ts")).toMatch(
    /export const walletStore: WalletStore = createWalletStore\(createProvider, linkTabs\);/,
  );
  const sourcesWith = (pattern: RegExp) =>
    appSources()
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .map((file) => relative(WEB, file));
  expect(sourcesWith(/\bcreateWalletStore\(/)).toEqual(["lib/wallet.ts"]);

  // The channel is opened in one module, which logs nothing; and what near-connect keeps in
  // `localStorage` is its own, which this app does not read or listen to.
  expect(sourcesWith(/\bBroadcastChannel\b/)).toEqual(["lib/walletTabs.ts"]);
  expect(read("lib/walletTabs.ts")).not.toMatch(/\bconsole\./);
  expect(sourcesWith(/selected-wallet/)).toEqual([]);
});
