import { expect, test } from "vitest";
import type { ZodType } from "zod";
import { BriefSchema, canonicalJson, type Profile, ProfileSchema, sha256Hex } from "../src/index";

/** What zod reports for `value` as `"<dotted path>:<code>"`, and nothing when it parses. */
function problems(schema: ZodType, value: unknown): string[] {
  const result = schema.safeParse(value);
  return result.success
    ? []
    : result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}:${issue.code}`);
}

const profile: Profile = {
  name: "Regex Ranger",
  description: "Writes the shortest regular expression that passes every case.",
  tags: ["extraction", "regex", "json"],
  homepage: "https://regex-ranger.example/agent",
};

/** The full profile with `changes` laid over it. */
const changed = (changes: Record<string, unknown>) => ({ ...profile, ...changes });

test("profile_accepts_a_full_document", () => {
  expect(ProfileSchema.parse(profile)).toEqual(profile);
});

test("profile_accepts_the_smallest_document", () => {
  // Only `homepage` is optional. An empty description and no tags are allowed.
  const smallest = { name: "a", description: "", tags: [] };
  expect(ProfileSchema.parse(smallest)).toEqual(smallest);
  // An explicit `undefined` counts as absent, as it does in `canonicalJson`.
  expect(problems(ProfileSchema, { ...smallest, homepage: undefined })).toEqual([]);
});

test("profile_requires_name_description_and_tags", () => {
  for (const field of ["name", "description", "tags"]) {
    const without = Object.fromEntries(Object.entries(profile).filter(([key]) => key !== field));
    expect(problems(ProfileSchema, without), field).toEqual([`${field}:invalid_type`]);
  }
  expect(problems(ProfileSchema, changed({ name: 7 }))).toEqual(["name:invalid_type"]);
  // `homepage` is optional, not nullable.
  expect(problems(ProfileSchema, changed({ homepage: null }))).toEqual(["homepage:invalid_type"]);
});

test("profile_rejects_unknown_keys", () => {
  // A strict document: a misspelt optional key is an error, not a missing `homepage`.
  const misspelt = {
    name: profile.name,
    description: profile.description,
    tags: profile.tags,
    homepge: "https://example.com",
  };
  const result = ProfileSchema.safeParse(misspelt);
  expect(result.success).toBe(false);
  expect(result.error?.issues).toMatchObject([{ code: "unrecognized_keys", keys: ["homepge"] }]);

  // And a key that is simply not part of a profile.
  expect(problems(ProfileSchema, changed({ avatar: "ipfs://x" }))).toEqual([
    "(root):unrecognized_keys",
  ]);
});

test("profile_limits_name_and_description", () => {
  expect(problems(ProfileSchema, changed({ name: "" }))).toEqual(["name:too_small"]);
  expect(problems(ProfileSchema, changed({ name: "n".repeat(64) }))).toEqual([]);
  expect(problems(ProfileSchema, changed({ name: "n".repeat(65) }))).toEqual(["name:too_big"]);

  expect(problems(ProfileSchema, changed({ description: "d".repeat(280) }))).toEqual([]);
  expect(problems(ProfileSchema, changed({ description: "d".repeat(281) }))).toEqual([
    "description:too_big",
  ]);
});

test("profile_rejects_a_bad_tag", () => {
  const bad = [
    "",
    "Regex",
    "has space",
    "snake_case",
    "dotted.tag",
    "café",
    "tag!",
    "line\n",
    "a".repeat(25),
  ];
  for (const tag of bad) {
    expect(problems(ProfileSchema, changed({ tags: ["ok", tag] })), JSON.stringify(tag)).toEqual([
      "tags.1:invalid_format",
    ]);
  }
  // The edges of the rule are fine.
  for (const tag of ["a", "0", "-", "a-b-c", "a".repeat(24), "9-".repeat(12)]) {
    expect(problems(ProfileSchema, changed({ tags: [tag] })), tag).toEqual([]);
  }
});

test("profile_rejects_too_many_tags", () => {
  const eight = Array.from({ length: 8 }, (_, i) => `tag-${i}`);
  expect(problems(ProfileSchema, changed({ tags: eight }))).toEqual([]);
  expect(problems(ProfileSchema, changed({ tags: [...eight, "tag-8"] }))).toEqual(["tags:too_big"]);
});

test("profile_tags_follow_the_brief_rule", () => {
  // The profile and the brief use the same tag rule, which is the contract's. If either schema's
  // copy of it changes, this fails.
  const accepted = (schema: ZodType, tags: string[]) => schema.safeParse(tags).success;
  const samples = [
    "",
    "a",
    "a-b",
    "-",
    "0",
    "A",
    "a_b",
    "a b",
    "a.b",
    "é",
    "a\n",
    "a ",
    " a",
    "a".repeat(24),
    "a".repeat(25),
  ];
  for (const tag of samples) {
    const inProfile = accepted(ProfileSchema.shape.tags, [tag]);
    expect(inProfile, JSON.stringify(tag)).toBe(accepted(BriefSchema.shape.tags, [tag]));
  }
  // The cap on how many, on both sides of it.
  for (const count of [8, 9]) {
    const tags = Array.from({ length: count }, () => "x");
    const inProfile = accepted(ProfileSchema.shape.tags, tags);
    expect(inProfile, `${count} tags`).toBe(accepted(BriefSchema.shape.tags, tags));
  }
});

test("profile_homepage_must_be_http_or_https", () => {
  const fine = [
    "https://example.com",
    "http://example.com/agent?id=1#top",
    "HTTPS://EXAMPLE.COM",
    "http://localhost:3000",
    "https://[::1]:8443/",
  ];
  for (const homepage of fine) {
    expect(problems(ProfileSchema, changed({ homepage })), homepage).toEqual([]);
  }

  const refused = [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "ftp://example.com",
    "mailto:agent@example.com",
    "example.com",
    "//example.com",
    "/agent",
    "https:example.com",
    "https://",
    "",
  ];
  for (const homepage of refused) {
    expect(problems(ProfileSchema, changed({ homepage })), JSON.stringify(homepage)).toEqual([
      "homepage:invalid_format",
    ]);
  }
});

test("profile_hash_does_not_change_through_the_schema", () => {
  // The schema adds, drops and rewrites nothing in a document it accepts, so hashing what it
  // returns gives the hash of what went in.
  const parsed = ProfileSchema.parse(profile);
  expect(sha256Hex(canonicalJson(parsed))).toBe(sha256Hex(canonicalJson(profile)));
});
