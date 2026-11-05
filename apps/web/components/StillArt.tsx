"use client";

import dynamic from "next/dynamic";
import { useRef } from "react";
import type { Focus } from "../lib/dither";
import type { ArtName } from "../lib/scenes";

/**
 * What draws the frame (the scene and the dither), in a chunk of its own: the art is decoration, and
 * its code is not needed to draw the page. Until it is in, the canvas is clear; its box is there
 * from the first paint, so nothing moves when the frame comes.
 */
const StillPainter = dynamic(() => import("./StillPainter").then((module) => module.StillPainter), {
  ssr: false,
});

/**
 * One frame of one of the landing's arts (lib/scenes.ts), dithered as the landing draws it, and
 * never moving: the app is calm, and the art there is only a picture at the head of a page or in an
 * empty state. The landing's own art moves (components/landing/DitherArt.tsx).
 *
 * The frame is drawn when the art first comes on screen, and again when its box changes size
 * (components/StillPainter.tsx, which comes after the page).
 */
export function StillArt({
  art,
  focus,
  at = 3.2,
  cell = 3,
  className,
}: {
  art: ArtName;
  /** Where the art sits in its box. */
  focus: Focus;
  /** The moment of the scene that is drawn, in seconds. */
  at?: number;
  /** CSS pixels a pixel of the art takes. */
  cell?: number;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  return (
    <div aria-hidden="true" className={className}>
      <canvas
        ref={ref}
        data-testid={`still-art-${art}`}
        className="block size-full"
        style={{ imageRendering: "pixelated" }}
      />
      <StillPainter canvas={ref} art={art} focus={focus} at={at} cell={cell} />
    </div>
  );
}
