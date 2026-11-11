import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { migrate, openDb } from "../src/index";

test("existing escrow listings survive the payment-mode migration and cannot mix settlement modes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tender-service-upgrade-"));
  const db = await openDb("pglite:memory");
  try {
    const source = fileURLToPath(new URL("../migrations/", import.meta.url));
    for (const name of await readdir(source)) {
      if (name.endsWith(".sql") && name < "0011_")
        await copyFile(join(source, name), join(dir, name));
    }
    await migrate(db, dir);
    await db.query(`insert into services
      (provider, agent, title, description, tags, category, output_format, token, price,
       commit_secs, reveal_secs, pick_secs, verifier)
      values ('provider.testnet', 'writer.provider.testnet', 'Existing work', 'Existing listing',
        '[]', 'other', 'json', 'token.testnet', 1000, 60, 60, 60, 'hirer')`);
    expect(await migrate(db)).toContain("0011_service_payments.sql");
    expect(
      await db.query("select payment_mode, x402, price::text, verifier, commit_secs from services"),
    ).toEqual([
      { payment_mode: "escrow", x402: null, price: "1000", verifier: "hirer", commit_secs: 60 },
    ]);
    await expect(
      db.query("update services set payment_mode = 'x402' where id = 1"),
    ).rejects.toThrow();
    expect(await migrate(db)).toEqual([]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
