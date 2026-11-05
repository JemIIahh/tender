"use client";

import { type RefObject, useEffect } from "react";
import { Dither, type Focus } from "../lib/dither";
import { ARTS, type ArtName } from "../lib/scenes";

/**
 * What draws StillArt's one frame on its canvas: the scene and the dither. It draws nothing of its
 * own, and comes in a chunk of its own after the page is drawn (components/StillArt.tsx loads it
 * with `next/dynamic`).
 *
 * The frame is drawn when the art first comes on screen, and again when its box changes size. A
 * browser that cannot say when that is (no IntersectionObserver) is left without the picture,
 * which is decoration and says nothing the page does not.
 */
export function StillPainter({
  canvas: canvasRef,
  art,
  focus,
  at,
  cell,
}: {
  canvas: RefObject<HTMLCanvasElement | null>;
  art: ArtName;
  focus: Focus;
  at: number;
  cell: number;
}) {
  const { x, y, scale } = focus;

  useEffect(() => {
    const canvas = canvasRef.current;
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
  }, [canvasRef, art, at, cell, x, y, scale]);

  return null;
}
