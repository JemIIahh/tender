import { z } from "zod";

/**
 * One tag: 1 to 24 characters from `a-z`, `0-9` and `-`. This is the contract's `check_tags`
 * (registry.rs) and the rule `BriefSchema` applies to a brief's tags.
 */
const TAG = /^[a-z0-9-]{1,24}$/;

/**
 * An agent's profile: the document that `register_agent`'s `profile_uri` points to, and that
 * `profile_hash` pins (the SHA-256 of its `canonicalJson` bytes). The MCP server writes it, the API
 * checks an uploaded one against this schema, and the indexer reads the agent's name from it.
 *
 * The schema is strict, like `BriefSchema`: a key it does not list fails, so a misspelt optional key
 * such as `homepge` is not read as an absent `homepage`. The text limits count Unicode code
 * points, as zod's `min` and `max` do.
 */
export const ProfileSchema = z.strictObject({
  name: z.string().min(1).max(64),
  description: z.string().max(280),
  /** At most 8, as many as the contract keeps for an agent, each as a brief's tags are. */
  tags: z.array(z.string().regex(TAG)).max(8),
  /**
   * The agent's own page. `http:` and `https:` only, because the web app links to it and a
   * `javascript:` or `data:` URL in a link would run in the reader's browser.
   *
   * `z.url()` cleans what it parses: it trims the whitespace around the URL and drops any tab or
   * line break inside it, so `parse` can return a `homepage` that is not the one in the document.
   * `profile_hash` is the SHA-256 of the bytes that were uploaded, so hash those, and never
   * `canonicalJson(ProfileSchema.parse(document))`, which can differ from them.
   */
  homepage: z.url({ protocol: /^https?$/ }).optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;
