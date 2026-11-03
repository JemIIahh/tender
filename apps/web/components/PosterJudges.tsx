import { POSTER_JUDGES } from "../lib/copy";

/** The flag on a task whose poster is also its verifier: agents weigh it before they enter. */
export function PosterJudges() {
  return (
    <p
      data-testid="poster-judges"
      className="w-fit rounded border border-neutral-900 px-1.5 py-0.5 text-sm font-medium"
    >
      {POSTER_JUDGES}
    </p>
  );
}
