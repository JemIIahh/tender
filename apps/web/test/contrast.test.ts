import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { STEP_LOOK } from "../components/account/AddAgentView";
import { FIELD } from "../components/ui";

// The app's colours against WCAG 2.2 AA, worked out from the theme (app/globals.css): a control's
// edge needs 3:1 against what it sits on (1.4.11), and small text 4.5:1 (1.4.3).

const css = readFileSync(join(import.meta.dirname, "../app/globals.css"), "utf8");
const COLORS: Record<string, string> = Object.fromEntries(
  [...css.matchAll(/--color-([a-z]+):\s*(#[0-9a-f]{6});/g)].map((m) => [m[1], m[2]]),
);

/** The relative luminance of `hex`, as WCAG defines it. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/** The contrast ratio of two colours. */
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The contrast ratio of two colours of the theme, by name. */
function ratio(a: string, b: string): number {
  const [x, y] = [a, b].map((name) => {
    const hex = COLORS[name];
    if (hex === undefined) throw new Error(`the theme has no colour ${name}`);
    return hex;
  }) as [string, string];
  return contrast(x, y);
}

test("the_contrast_is_worked_out_as_wcag_does_it", () => {
  expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
  // The grey that is known to be the lightest to pass 4.5:1 on white.
  expect(contrast("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  expect(Object.keys(COLORS)).toEqual(
    expect.arrayContaining(["ink", "panel", "raised", "line", "bone", "muted", "dim", "seal"]),
  );
  // A card's hairline is decoration and is far below 3:1, which is why a field does not use it.
  expect(ratio("line", "panel")).toBeLessThan(3);
});

test("field_edges_reach_3_to_1_on_the_grounds_fields_sit_on", () => {
  // The edge at rest, and when the field holds a problem: not the hover, which only adds to it.
  const rest = /(?:^|\s)border-([a-z]+)(?=\s|$)/.exec(FIELD)?.[1];
  const invalid = /(?:^|\s)aria-invalid:border-([a-z]+)(?=\s|$)/.exec(FIELD)?.[1];
  expect(rest).toBeDefined();
  expect(invalid).toBeDefined();
  // The board's tag field is on the ink; the wizard's, the wallet's and the reward's on a panel.
  for (const ground of ["ink", "panel"]) {
    expect(ratio(rest ?? "", ground), `${rest} on ${ground}`).toBeGreaterThanOrEqual(3);
    expect(ratio(invalid ?? "", ground), `${invalid} on ${ground}`).toBeGreaterThanOrEqual(3);
  }
});

test("small_text_reaches_4_5_to_1_on_every_ground", () => {
  for (const text of ["bone", "muted", "seal"]) {
    for (const ground of ["ink", "panel", "raised"]) {
      expect(ratio(text, ground), `${text} on ${ground}`).toBeGreaterThanOrEqual(4.5);
    }
  }
  // Ink on the light card, for the featured card's text.
  expect(ratio("ink", "paper")).toBeGreaterThanOrEqual(4.5);
});

test("task_page_board_and_swarm_tree_write_only_in_colours_that_reach_4_5_to_1", () => {
  // The question board and the swarm tree sit on a panel, with raised boxes inside it (an answer, a
  // clarification, the page's own node, a margin) and the failure box's faint seal wash, which
  // reads as the panel. Every text colour they use has to reach 4.5:1 on every one of those grounds,
  // and none is faded with an opacity, which would take it under.
  for (const file of ["components/Questions.tsx", "components/SwarmTree.tsx"]) {
    const source = readFileSync(join(import.meta.dirname, "..", file), "utf8");
    const texts = new Set(
      [...source.matchAll(/(?:^|[\s"`])text-([a-z]+)(?=[\s"`])/g)]
        .map((m) => m[1] ?? "")
        .filter((name) => name in COLORS),
    );
    const grounds = new Set(
      [...source.matchAll(/(?:^|[\s"`])bg-([a-z]+)(?=[\s"`])/g)]
        .map((m) => m[1] ?? "")
        .filter((name) => name in COLORS && name !== "seal"),
    );
    grounds.add("panel");
    expect(texts.size, file).toBeGreaterThan(0);
    for (const text of texts) {
      for (const ground of grounds) {
        expect(ratio(text, ground), `${file}: ${text} on ${ground}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(source, file).not.toMatch(/(?:^|[\s"`])text-[a-z]+\/\S+/);
    // The seal dots are a colour of their own, not text; the only seal ground is the faint wash.
    expect(source.match(/bg-seal\/\[[^\]]+\]/g) ?? [], file).toEqual(
      file.endsWith("Questions.tsx") ? ["bg-seal/[0.06]"] : [],
    );
  }
});

test("add_agent_steps_keep_their_words_at_4_5_to_1_whether_open_or_not_yet", () => {
  // A step that is not open yet is told apart by its edge and its ground, never by fading: muted
  // text at 60% on the panel was 3.14:1.
  for (const [name, look] of Object.entries(STEP_LOOK)) {
    expect(Object.values(look).join(" "), name).not.toMatch(/(?:^|\s)opacity-/);
    const ground = /(?:^|\s)bg-([a-z]+)(?=\s|$)/.exec(look.card)?.[1] ?? "";
    for (const [part, classes] of [
      ["title", look.title],
      ["why", look.why],
    ] as const) {
      const text = /(?:^|\s)text-([a-z]+)(?=\s|$)/.exec(classes)?.[1] ?? "";
      expect(ratio(text, ground), `${name} ${part}: ${text} on ${ground}`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  }
});
