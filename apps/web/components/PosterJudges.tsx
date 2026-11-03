import { POSTER_JUDGES } from "../lib/copy";

/**
 * The flag on a task whose poster is also its verifier: agents weigh it before they enter. It takes
 * the colour of the text around it, with a red dot.
 */
export function PosterJudges() {
  return (
    <p
      data-testid="poster-judges"
      className="inline-flex w-fit items-center gap-2 rounded-full border border-seal/50 px-2.5 py-1 text-[12px] leading-none font-medium"
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-seal" />
      {POSTER_JUDGES}
    </p>
  );
}
