// The app's look, as classes: the landing's (app/page.tsx) near-black ground, bone text, the red of
// sealing wax for an accent, and plain sentence-case words in the sans type for buttons and labels.
// Mono is for what is copied or compared as it is written (accounts, hashes, figures in a table);
// small capitals are for one tiny badge on a card (a task's phase), and nothing else. Every page
// after the landing takes its buttons, cards, fields and labels from here, so that they are one
// product with each other.

const PILL =
  "inline-flex min-h-11 w-fit items-center justify-center gap-2 rounded-full px-5 text-center text-[14px] leading-tight font-medium transition-colors motion-reduce:transition-none aria-disabled:cursor-not-allowed aria-disabled:opacity-50";

/** The cream pill: the one thing to do next. */
export const PRIMARY = `${PILL} bg-bone text-ink hover:bg-white aria-disabled:hover:bg-bone`;

/** The outlined pill: another thing to do. */
export const SECONDARY = `${PILL} border border-line bg-transparent text-bone hover:border-bone/40 hover:bg-raised/60 aria-disabled:hover:border-line aria-disabled:hover:bg-transparent`;

/**
 * The round arrow at the foot of a card: the card's way on. It takes the colours of a primary pill,
 * and turns them around on the one light card (`on-paper`).
 */
export const ICON_ROUND =
  "grid size-11 shrink-0 place-items-center rounded-full bg-bone text-ink transition-transform motion-reduce:transition-none [.on-paper_&]:bg-ink [.on-paper_&]:text-bone";

/** A rounded panel on the ground. */
export const CARD = "rounded-2xl border border-line bg-panel";

/**
 * A card of a grid that is a link as a whole: its border lifts on hover, and while its link has the
 * keyboard's focus.
 */
export const LINK_CARD = `${CARD} relative transition-colors hover:border-bone/30 has-[a:focus-visible]:border-bone/50 motion-reduce:transition-none`;

/** A section of a page: a panel with room inside. */
export const PANEL = `${CARD} grid gap-4 p-5 sm:p-6`;

/** A panel's title. */
export const PANEL_TITLE = "text-lg font-semibold tracking-tight text-bone";

/** The page's headline, in the landing's display type. */
export const H1 =
  "text-[2.1rem] leading-[1.05] font-semibold tracking-[-0.035em] text-bone sm:text-5xl";

/** A small label over or beside what it names: muted words in the sans type, as they are written. */
export const EYEBROW = "text-[13px] font-medium text-muted";

/**
 * A text field, a select or a text area. Its edge is the only thing that shows where to type, so
 * it is the dim grey, which is 3:1 or more on the ink and the panel it sits on (WCAG 1.4.11; the
 * hairline of a card is not); test/contrast.test.ts holds it to that.
 */
export const FIELD =
  "min-h-11 w-full rounded-xl border border-dim bg-ink px-3 text-bone transition-colors placeholder:text-muted hover:border-bone/60 motion-reduce:transition-none aria-invalid:border-seal";

/** A line a person is told, in a box: what an action came to. */
export const NOTICE = "rounded-xl border border-line bg-raised p-4 text-sm text-bone";

/** A link in running text. */
export const TEXT_LINK =
  "text-bone underline decoration-bone/40 underline-offset-4 transition-colors hover:decoration-bone motion-reduce:transition-none";

/**
 * A row that scrolls sideways when it is wider than its place (tabs, filters, a long figure): while
 * there is more of it past its right edge, the edge fades out, so it shows as more to come. The
 * element takes `scrollCue` (lib/scrollCue.ts) as its ref, which says when there is more.
 */
export const SCROLL_CUE =
  "data-[more=true]:[mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)]";

/** A tag, as a small pill. */
export const TAG =
  "inline-block rounded-full border border-current/25 px-2.5 py-1 text-[12px] leading-none";

/** Facts as label and value: the label in muted words, the value in plain text. */
export const FACTS = "grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-6 gap-y-2 text-sm";
export const FACT_LABEL = "text-[13px] text-muted";

/**
 * A segmented control: a row of choices in one rounded track, the chosen one filled. Each choice is
 * a button with `aria-pressed`, or a link with `aria-current`.
 */
export const SEGMENTS =
  "inline-flex max-w-full items-center gap-1 rounded-full border border-line bg-panel p-1";
export const SEGMENT =
  "inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[14px] whitespace-nowrap text-muted transition-colors hover:text-bone motion-reduce:transition-none aria-pressed:bg-bone aria-pressed:font-medium aria-pressed:text-ink aria-[current=page]:bg-bone aria-[current=page]:font-medium aria-[current=page]:text-ink";
