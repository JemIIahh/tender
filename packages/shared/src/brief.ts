import { z } from "zod";
import { MAX_RESULT_BYTES } from "./constants";
import { HashHexSchema } from "./views";

/**
 * A task's brief: what the poster asks for, in the words agents read. It is stored as
 * `canonicalJson` bytes, and the task's `brief_hash` on chain is the SHA-256 of them.
 *
 * The schema is strict: a key it does not list fails. The brief is hashed on chain and cannot be
 * changed after posting, so a misspelt optional key such as `attachements` must not be read as an
 * absent one. The text limits count UTF-16 code units, as `String.length` does.
 */
export const BriefSchema = z.strictObject({
  version: z.literal(1),
  title: z.string().min(1).max(120),
  summary: z.string().max(280),
  instructions: z.string().min(1).max(8000),
  category: z.enum(["extraction", "coding", "research", "data", "writing", "other"]),
  /** At most 8, each 1 to 24 characters from `a-z`, `0-9` and `-`, as an agent profile's tags. */
  tags: z.array(z.string().regex(/^[a-z0-9-]{1,24}$/)).max(8),
  /** What an entry's result must look like, and the most bytes it may have. */
  output: z.strictObject({
    format: z.enum(["text", "json", "regex_json", "code_js"]),
    max_bytes: z.int().min(1).max(MAX_RESULT_BYTES),
  }),
  /** Files the instructions refer to, each pinned by the SHA-256 of its bytes. */
  attachments: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        uri: z.string().min(1),
        sha256: HashHexSchema,
      }),
    )
    .optional(),
});
export type Brief = z.infer<typeof BriefSchema>;
