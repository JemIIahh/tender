"use client";

import { useEffect, useRef } from "react";
import { Dither, type Focus } from "../lib/dither";
import { ARTS, type ArtName } from "../lib/scenes";

/**
 * One frame of one of the landing's arts (lib/scenes.ts), dithered as the landing draws it, and
 * never moving: the app is calm, and the art there is only a picture at the head of a page or in an
 * empty state. The landing's own art moves (components/landing/DitherArt.tsx).
 *
 * The frame is drawn when the art first comes on screen, and again when its box changes size. A
 * browser that cannot say when that is (no IntersectionObserver) is left without the picture,
 * which is decoration and says nothing the page does not.
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
  const { x, y, scale } = focus;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || typeof IntersectionObserver === "undefined") return;
    let drawn = "";
    const draw = () => {
      const { width, height } = canvas.getBoundingClientRect();
      const w = Math.max(16, Math.round(width / cell));
      const h = Math.max(16, Math.round(height / cell));
      if (drawn === `${w}x${h}`) return;
      const context = canvas.getContext("2d");
      const scene = ARTS[art]()[0];
      if (!context || !scene) return;
      drawn = `${w}x${h}`;
      canvas.width = w;
      canvas.height = h;
      const image = context.createImageData(w, h);
      scene.frame(at);
      new Dither(w, h, new Uint32Array(image.data.buffer)).draw(scene, { x, y, scale });
      context.putImageData(image, 0, 0);
    };
    let seen = false;
    const sized =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (seen) draw();
          });
    const shown = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && !seen) {
        seen = true;
        draw();
        sized?.observe(canvas);
      }
    });
    shown.observe(canvas);
    return () => {
      shown.disconnect();
      sized?.disconnect();
    };
  }, [art, at, cell, x, y, scale]);

  return (
    <div aria-hidden="true" className={className}>
      <canvas
        ref={ref}
        data-testid={`still-art-${art}`}
        className="block size-full"
        style={{ imageRendering: "pixelated" }}
      />
    </div>
  );
}
