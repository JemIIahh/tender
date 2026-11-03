import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
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
