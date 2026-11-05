"use client";

import dynamic from "next/dynamic";
import { useRef } from "react";
import type { Focus } from "../../lib/dither";
import type { ArtName } from "../../lib/scenes";

/**
 * What plays the art (the scenes, the dither and the frames), in a chunk of its own: the art is
 * decoration, and its code is not needed to draw the page. Until it is in, the canvas is clear and
 * the ground shows through it; its box is there from the first paint, so nothing moves when it
 * comes.
 */
const DitherPlayer = dynamic(() => import("./DitherPlayer").then((module) => module.DitherPlayer), {
  ssr: false,
});

/**
 * A canvas that plays one of the landing's arts (lib/scenes.ts), dithered. The canvas holds one
 * pixel per `cell` CSS pixels and the browser scales it up with hard edges, so a frame is small.
 *
 * It runs only while it is on screen and the tab is in view. With reduced motion asked for, it
 * draws one frame, `still` seconds into the show, and stops there (components/landing/
 * DitherPlayer.tsx, which comes after the page).
 */
export function DitherArt({
  art,
  cell = 4,
  wide,
  narrow = wide,
  hold = 5.5,
  change = 1.3,
  still = 3.2,
  className,
}: {
  art: ArtName;
  /** CSS pixels a pixel of the art takes; one less on a box narrower than 640. */
  cell?: number;
  /** Where the art sits in a box wider than it is tall. */
  wide: Focus;
  /** Where it sits in any other box. */
  narrow?: Focus;
  /** Seconds each scene holds, and seconds a change of scene takes. */
  hold?: number;
  change?: number;
  /** The moment of the show that reduced motion shows. */
  still?: number;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  return (
    <div aria-hidden="true" className={className}>
      <canvas
        ref={ref}
        data-testid={`art-${art}`}
        className="block size-full"
        style={{ imageRendering: "pixelated" }}
      />
      <DitherPlayer
        canvas={ref}
        art={art}
        cell={cell}
        wide={wide}
        narrow={narrow}
        hold={hold}
        change={change}
        still={still}
      />
    </div>
  );
}
