import type { ReactNode } from "react";
import type { Focus } from "../lib/dither";
import type { ArtName } from "../lib/scenes";
import { StillArt } from "./StillArt";
import { EYEBROW, H1 } from "./ui";

/**
 * The head of a page: a label in mono capitals, the headline in the landing's display type (in two
 * tones when it has a second part, `muted`), and a line under it. A page that has a picture shows
 * one of the landing's arts, still, at the right of the head from tablet width up, fading into the
 * ground.
 */
export function PageHead({
  eyebrow,
  title,
  muted,
  art,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  muted?: ReactNode;
  art?: { name: ArtName; focus: Focus };
  children?: ReactNode;
}) {
  return (
    <header
      className={`relative isolate grid content-center gap-3 ${art === undefined ? "" : "md:min-h-44 md:pr-[38%]"}`}
    >
      {art === undefined ? null : (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 -z-10 hidden w-[44%] overflow-hidden rounded-2xl md:block"
        >
          <StillArt art={art.name} focus={art.focus} className="absolute inset-0 size-full" />
          <div className="scanlines absolute inset-0" />
          <div className="absolute inset-0 bg-linear-to-r from-ink via-ink/50 to-transparent" />
          <div className="absolute inset-0 bg-linear-to-t from-ink via-transparent to-ink/40" />
        </div>
      )}
      <p className={EYEBROW}>
        {eyebrow} <span className="text-seal">&gt;</span>
      </p>
      <h1 className={`${H1} wrap-anywhere`}>
        {title}
        {muted === undefined ? null : (
          <>
            {" "}
            <span className="text-muted">{muted}</span>
          </>
        )}
      </h1>
      {children === undefined ? null : (
        <div className="max-w-2xl text-[15px] leading-relaxed text-muted">{children}</div>
      )}
    </header>
  );
}
