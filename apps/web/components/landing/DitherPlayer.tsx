"use client";

import { type RefObject, useEffect } from "react";
import { Dither, type Focus, showAt } from "../../lib/dither";
import { ARTS, type ArtName } from "../../lib/scenes";

/** Frames a second at most: the art is coarse, and more would only cost battery. */
const FPS = 24;

export interface DitherShow {
  art: ArtName;
  /** CSS pixels a pixel of the art takes; one less on a box narrower than 640. */
  cell: number;
  /** Where the art sits in a box wider than it is tall. */
  wide: Focus;
  /** Where it sits in any other box. */
  narrow: Focus;
  /** Seconds each scene holds, and seconds a change of scene takes. */
  hold: number;
  change: number;
  /** The moment of the show that reduced motion shows. */
  still: number;
}

/**
 * What plays the art on DitherArt's canvas: the scenes, the dither and the frames. It draws nothing
 * of its own, and comes in a chunk of its own after the page is drawn (components/landing/
 * DitherArt.tsx loads it with `next/dynamic`), so that the art's code does not hold up the page.
 *
 * It runs only while the canvas is on screen and the tab is in view. With reduced motion asked for,
 * it draws one frame, `still` seconds into the show, and stops there.
 */
export function DitherPlayer({
  canvas: canvasRef,
  art,
  cell,
  wide,
  narrow,
  hold,
  change,
  still,
}: DitherShow & { canvas: RefObject<HTMLCanvasElement | null> }) {
  // Numbers, so that a new object with the same values does not start the show again.
  const { x: wx, y: wy, scale: ws } = wide;
  const { x: nx, y: ny, scale: ns } = narrow;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const scenes = ARTS[art]();
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const wideFocus = { x: wx, y: wy, scale: ws };
    const narrowFocus = { x: nx, y: ny, scale: ns };

    let buffer: { dither: Dither; image: ImageData; focus: Focus } | null = null;
    // A show of several scenes starts with the first one coming in.
    let clock = scenes.length > 1 ? -change : 0;
    let frame = 0;
    let last = 0;
    let onScreen = true;
    // A small tear now and then, while no change of scene is under way.
    let nextTear = 3;

    const draw = () => {
      if (!buffer) return;
      const at = reduce?.matches ? still : clock;
      const show = showAt(at, scenes.length, hold, change);
      const scene = scenes[show.index];
      if (!scene) return;
      scene.frame(show.time);
      const from = show.from === undefined ? undefined : scenes[show.from.index];
      from?.frame(show.from?.time ?? 0);
      let tear = from ? 0.12 * Math.sin(Math.PI * show.mix) : 0;
      if (!from && at > nextTear) {
        tear = 0.03;
        if (at > nextTear + 0.12) nextTear = at + 2.5 + Math.random() * 3;
      }
      if (reduce?.matches) tear = 0;
      buffer.dither.draw(scene, buffer.focus, { from, mix: show.mix, tear });
      context.putImageData(buffer.image, 0, 0);
    };

    const size = () => {
      const { width, height } = canvas.getBoundingClientRect();
      const pixel = width < 640 ? Math.max(2, cell - 1) : cell;
      const w = Math.max(16, Math.round(width / pixel));
      const h = Math.max(16, Math.round(height / pixel));
      const focus = width > height * 1.25 ? wideFocus : narrowFocus;
      if (buffer?.dither.width === w && buffer.dither.height === h && buffer.focus === focus)
        return;
      canvas.width = w;
      canvas.height = h;
      const image = context.createImageData(w, h);
      buffer = { dither: new Dither(w, h, new Uint32Array(image.data.buffer)), image, focus };
      draw();
    };

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const elapsed = now - last;
      if (elapsed < 1000 / FPS - 2) return;
      last = now;
      // A long gap (a frame the browser held back) moves the show on by one frame, not by the gap.
      clock += Math.min(elapsed, 100) / 1000;
      draw();
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
    };
    const run = () => {
      if (reduce?.matches || !onScreen || document.visibilityState !== "visible") {
        stop();
        draw();
        return;
      }
      if (frame === 0) {
        last = performance.now();
        frame = requestAnimationFrame(tick);
      }
    };

    size();
    const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(size);
    resized?.observe(canvas);
    const seen =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(([entry]) => {
            onScreen = entry?.isIntersecting ?? true;
            run();
          });
    seen?.observe(canvas);
    document.addEventListener("visibilitychange", run);
    reduce?.addEventListener?.("change", run);
    run();

    return () => {
      stop();
      resized?.disconnect();
      seen?.disconnect();
      document.removeEventListener("visibilitychange", run);
      reduce?.removeEventListener?.("change", run);
    };
  }, [canvasRef, art, cell, wx, wy, ws, nx, ny, ns, hold, change, still]);

  return null;
}
