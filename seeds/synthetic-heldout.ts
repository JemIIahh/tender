import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Stand-ins for the seeds' held-out checks, for the tests that run where the real ones are not.
// The real checks are secret until a task is judged and are kept outside the repository
// (seeds/README.md), so a clean checkout, CI included, has none. A test that only needs a task to
// *have* checks, to upload them, hash them and post them, can use these: each is a valid held-out
// document of its seed's kind, different for every seed. They score nothing in earnest, and no test
// that scores a seed's answers may use them.

/** A held-out document of `kind` for `slug`: valid for its schema, and unlike any other seed's. */
export function syntheticHeldout(kind: string, slug: string): object {
  switch (kind) {
    case "exact":
      return { exact: { expected: [`stand-in answer for ${slug}`] } };
    case "json_schema":
      return { json_schema: { assertions: [{ path: "$.stand_in", equals: slug }] } };
    case "regex_cases":
      return { regex_cases: { match: [`${slug}-yes`], no_match: [`${slug}-no`] } };
    case "tests":
      return { tests: { cases: [{ input: slug, output: slug }] } };
    default:
      throw new Error(`a "${kind}" seed has no held-out document`);
  }
}

/**
 * Writes `<into>/<slug>/heldout.json` for every folder of `seedsDir` whose `criteria.json` says
 * `has_heldout`, as a stand-in of the criteria's kind, and gives the slugs it wrote. `into` has to
 * exist. A folder without a `criteria.json` is left alone, for the caller's own checks to find.
 */
export function writeSyntheticHeldouts(seedsDir: string, into: string): string[] {
  const written: string[] = [];
  const slugs = readdirSync(seedsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const slug of slugs) {
    const file = join(seedsDir, slug, "criteria.json");
    if (!existsSync(file)) continue;
    const criteria = JSON.parse(readFileSync(file, "utf8")) as {
      kind: string;
      has_heldout: boolean;
    };
    if (!criteria.has_heldout) continue;
    mkdirSync(join(into, slug), { recursive: true });
    writeFileSync(
      join(into, slug, "heldout.json"),
      JSON.stringify(syntheticHeldout(criteria.kind, slug), null, 2),
    );
    written.push(slug);
  }
  return written;
}
