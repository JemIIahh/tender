import type { Db } from "./adapters";

// The writes of the service listings (migration 0007). The rules of a service are `@tender/shared`'s
// (`services.ts`) and the API enforces them: who may list or change one, for which agent, and with
// what words. What lives here is what only the database can decide at the moment of the write: how
// many services a provider keeps. The API reads services with the agents' records (its
// `queries.ts`), so the reads are there.

/** The fields of a service as a write stores them. `criteria` is canonical JSON text, or null. */
export interface ServiceFields {
  title: string;
  description: string;
  tags: string[];
  category: string;
  outputFormat: string;
  token: string;
  /** A u128 as a decimal string. */
  price: string;
  commitSecs: number;
  revealSecs: number;
  pickSecs: number;
  verifier: "hirer" | "judge" | "none";
  paymentMode?: "escrow" | "x402";
  x402?: string | null;
  criteria: string | null;
  status: "active" | "paused";
}

export type InsertServiceResult =
  | { ok: true; id: string }
  | { ok: false; reason: "provider_limit" };

/**
 * Lists a service of `provider`'s, offered by `agent`, unless the provider keeps `maxPerProvider`
 * services already (paused ones count). The count and the insert are one step: the transaction takes
 * a lock that two listings cannot both hold, so two at once cannot pass the count together. Gives
 * the new id, as decimal text.
 */
export async function insertService(
  db: Db,
  input: { provider: string; agent: string } & ServiceFields,
  maxPerProvider: number,
): Promise<InsertServiceResult> {
  return db.tx(async (tx) => {
    await tx.query("lock table services in share row exclusive mode");
    const [count] = await tx.query<{ n: number }>(
      "select count(*)::int as n from services where provider = $1",
      [input.provider],
    );
    if ((count?.n ?? 0) >= maxPerProvider) return { ok: false, reason: "provider_limit" };
    const [row] = await tx.query<{ id: string }>(
      `insert into services (provider, agent, title, description, tags, category, output_format,
                             token, price, commit_secs, reveal_secs, pick_secs, verifier, criteria,
                             status, payment_mode, x402)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::numeric, $10, $11, $12, $13, $14, $15, $16, $17::jsonb)
       returning id::text as id`,
      [
        input.provider,
        input.agent,
        input.title,
        input.description,
        JSON.stringify(input.tags),
        input.category,
        input.outputFormat,
        input.token,
        input.price,
        input.commitSecs,
        input.revealSecs,
        input.pickSecs,
        input.verifier,
        input.criteria,
        input.status,
        input.paymentMode ?? "escrow",
        input.x402 ?? null,
      ],
    );
    if (!row) throw new Error("the service was not stored");
    return { ok: true, id: row.id };
  });
}

/**
 * Replaces the fields of service `id`, if `provider` listed it, and sets `updated_at` to now; the
 * status only when `fields.status` names one (null keeps it), so that a change sent alongside a pause
 * cannot undo the pause. False when there is no such service of that provider, and nothing is written.
 */
export async function updateService(
  db: Db,
  id: bigint,
  provider: string,
  fields: Omit<ServiceFields, "status"> & { status: ServiceFields["status"] | null },
): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `update services
        set title = $3, description = $4, tags = $5::jsonb, category = $6, output_format = $7,
            token = $8, price = $9::numeric, commit_secs = $10, reveal_secs = $11, pick_secs = $12,
            verifier = $13, criteria = $14, status = coalesce($15, status), payment_mode = $16, x402 = $17::jsonb, updated_at = now()
      where id = $1 and provider = $2
      returning id::text as id`,
    [
      id,
      provider,
      fields.title,
      fields.description,
      JSON.stringify(fields.tags),
      fields.category,
      fields.outputFormat,
      fields.token,
      fields.price,
      fields.commitSecs,
      fields.revealSecs,
      fields.pickSecs,
      fields.verifier,
      fields.criteria,
      fields.status,
      fields.paymentMode ?? "escrow",
      fields.x402 ?? null,
    ],
  );
  return rows.length === 1;
}
