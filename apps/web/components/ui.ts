// The app's look, as classes: the landing's (app/page.tsx) near-black ground, bone text, the red of
// sealing wax for an accent, display type for headlines and mono capitals for labels. Every page
// after the landing takes its buttons, cards, fields and labels from here, so that they are one
// product with the landing and with each other.

const PILL =
  "inline-flex min-h-11 w-fit items-center justify-center gap-2 rounded-full px-5 text-center font-mono text-[11px] tracking-[0.12em] uppercase transition-colors motion-reduce:transition-none aria-disabled:cursor-not-allowed aria-disabled:opacity-50";

/** The cream pill: the one thing to do next. */
export const PRIMARY = `${PILL} bg-bone text-ink hover:bg-white aria-disabled:hover:bg-bone`;

/** The dark pill: another thing to do. */
export const SECONDARY = `${PILL} border border-line bg-raised text-bone hover:border-bone/40 aria-disabled:hover:border-line`;

/** A rounded panel on the ground. */
export const CARD = "rounded-2xl border border-line bg-panel";

/** A section of a page: a panel with room inside. */
export const PANEL = `${CARD} grid gap-4 p-5 sm:p-6`;

/** A panel's title. */
export const PANEL_TITLE = "text-lg font-semibold tracking-tight text-bone";

/** The page's headline, in the landing's display type. */
export const H1 =
  "text-[2.1rem] leading-[1.05] font-semibold tracking-[-0.035em] text-bone sm:text-5xl";

/** A label in mono capitals, as the landing's eyebrows are. */
export const EYEBROW = "font-mono text-[11px] tracking-[0.16em] text-muted uppercase";

/** A text field, a select or a text area. */
export const FIELD =
  "min-h-11 w-full rounded-xl border border-line bg-ink px-3 text-bone transition-colors placeholder:text-muted hover:border-bone/30 motion-reduce:transition-none aria-invalid:border-seal";

/** A line a person is told, in a box: what an action came to. */
export const NOTICE = "rounded-xl border border-line bg-raised p-4 text-sm text-bone";

/** A link in running text. */
export const TEXT_LINK =
  "text-bone underline decoration-bone/40 underline-offset-4 transition-colors hover:decoration-bone motion-reduce:transition-none";

/** A tag, as a small pill. */
export const TAG =
  "inline-block rounded-full border border-current/25 px-2.5 py-1 text-[11.5px] leading-none";

/** Facts as label and value: the label in mono capitals, the value in plain text. */
export const FACTS = "grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-6 gap-y-2 text-sm";
export const FACT_LABEL = "font-mono text-[10.5px] tracking-[0.14em] text-muted uppercase";
