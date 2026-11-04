import { describe, expect, test } from "vitest";
import { writeFileAtomic } from "../src/agents/lead";
import { PowerCut, PowerFs } from "./power-fs";

// N2 (swarm review, fix round 1): the lead writes down a post before it sends it, and a restart
// that finds that note asks the chain whether the post landed. A note that a power cut can lose is
// no note: the part is posted again. So a write that has returned must be on the disk, and a write
// that was cut short must leave the file as it was or as it is meant to be, never half of it.

const DIR = "/journal";
const FILE = `${DIR}/10.json`;
const OLD = '{"status":"hiring","hires":[]}\n';
const NEW = '{"status":"hiring","hires":[{"slug":"01","id":"11"}]}\n';

/** A disk that already holds `OLD` for good, as a journal that has been in use for a while does. */
async function withOld(): Promise<PowerFs> {
  const fs = new PowerFs();
  await writeFileAtomic(fs, FILE, OLD);
  fs.settle();
  return fs;
}

/** The number of operations an overwrite takes. */
async function stepsOfAnOverwrite(): Promise<number> {
  const fs = await withOld();
  const before = fs.ops.length;
  await writeFileAtomic(fs, FILE, NEW);
  return fs.ops.length - before;
}

describe("the lead's journal under a power cut", () => {
  test("N2_a_write_that_has_returned_survives_a_power_cut", async () => {
    const fs = new PowerFs();
    await writeFileAtomic(fs, FILE, NEW);
    fs.powerCut();
    expect(fs.peek(FILE)).toBe(NEW);
  });

  test("N2_an_overwrite_that_has_returned_survives_a_power_cut", async () => {
    const fs = await withOld();
    await writeFileAtomic(fs, FILE, NEW);
    fs.powerCut();
    expect(fs.peek(FILE)).toBe(NEW);
  });

  test("N2_a_journal_folder_made_by_the_write_survives_a_power_cut_with_it", async () => {
    const fs = new PowerFs();
    const nested = "/state/lead/journal/10.json";
    await writeFileAtomic(fs, nested, NEW);
    fs.powerCut();
    expect(fs.peek(nested)).toBe(NEW);
  });

  test("N2_a_power_cut_at_any_step_of_an_overwrite_leaves_the_old_file_or_the_new_one", async () => {
    const steps = await stepsOfAnOverwrite();
    expect(steps).toBeGreaterThan(5);
    let cuts = 0;
    for (let after = 0; after <= steps; after++) {
      const fs = await withOld();
      fs.cutAfter(after);
      let returned = false;
      try {
        await writeFileAtomic(fs, FILE, NEW);
        returned = true;
      } catch (error) {
        if (!(error instanceof PowerCut)) throw error;
        cuts += 1;
      }
      // Whether it was cut or not, the next thing that happens is a reboot.
      fs.powerCut();
      const found = fs.peek(FILE);
      expect([OLD, NEW], `cut after ${after} of ${steps} steps`).toContain(found);
      if (returned) expect(found, `returned after ${after} steps`).toBe(NEW);
    }
    expect(cuts).toBeGreaterThan(0);
  });

  test("N2_a_power_cut_at_any_step_of_a_first_write_leaves_no_file_or_the_whole_one", async () => {
    const probe = new PowerFs();
    await writeFileAtomic(probe, FILE, NEW);
    const steps = probe.ops.length;
    for (let after = 0; after <= steps; after++) {
      const fs = new PowerFs();
      fs.cutAfter(after);
      let returned = false;
      try {
        await writeFileAtomic(fs, FILE, NEW);
        returned = true;
      } catch (error) {
        if (!(error instanceof PowerCut)) throw error;
      }
      fs.powerCut();
      const found = fs.peek(FILE);
      expect([null, NEW], `cut after ${after} of ${steps} steps`).toContain(found);
      if (returned) expect(found, `returned after ${after} steps`).toBe(NEW);
    }
  });

  test("N2_a_folder_that_cannot_be_synced_fails_the_write_and_is_not_taken_as_written", async () => {
    // A note that may not be on the disk must not be taken for one: the post that follows it
    // would be a post the lead might repeat after a power cut. So the write fails, and the lead's
    // pass is tried again.
    const fs = await withOld();
    fs.failDirSync = Object.assign(new Error("EIO: input/output error"), { code: "EIO" });
    await expect(writeFileAtomic(fs, FILE, NEW)).rejects.toThrow(/EIO/);
  });
});
