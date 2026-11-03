// The landing's moving art: scenes drawn as a field of light, then dithered to a few colours with
// an 8x8 Bayer matrix into a small buffer that the page scales up with hard edges. A scene is
// plain arithmetic per pixel (lib/scenes.ts), so this costs a few milliseconds a frame at the
// sizes the landing uses, and nothing here touches the DOM.

/** What a scene says about one point: its light, from 0 to 1, and whether it is the accent. */
export interface Shade {
  l: number;
  /** 1 for the accent (the wax of a seal, the ink of a stamp), 0 for everything else. */
  a: number;
}

export interface Scene {
  /** Sets the scene up for `t` seconds after it began. Called once a frame, before `shade`. */
  frame(t: number): void;
  /**
   * The light at (u, v), in art units: (0, 0) is the middle of the art, one unit is the distance
   * `Focus.scale` gives, and v grows downward. It writes into `out`, so a frame makes no garbage.
   */
  shade(u: number, v: number, out: Shade): void;
}

/** Where the art sits in the buffer: its middle as fractions of the width and height, and its unit. */
export interface Focus {
  x: number;
  y: number;
  /** One art unit, as a fraction of the buffer's shorter side. */
  scale: number;
}

/** The 8x8 Bayer matrix, as thresholds between 0 and 1. */
const BAYER = Float32Array.from(
  [
    0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60,
    28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47,
    7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
  ],
  (n) => (n + 0.5) / 64,
);

type Rgb = readonly [number, number, number];

/** Steps of light in a ramp: a lit pixel is shaded by how bright the point under it is. */
const STEPS = 32;

/** A ramp from `dark` to `light` in `STEPS` steps, as RGBA words for a little-endian ImageData. */
function ramp(dark: Rgb, light: Rgb): Uint32Array {
  const out = new Uint32Array(STEPS);
  for (let i = 0; i < STEPS; i++) {
    const k = i / (STEPS - 1);
    const [r, g, b] = dark.map((d, c) => Math.round(d + ((light[c] ?? d) - d) * k));
    out[i] = (255 << 24) | ((b ?? 0) << 16) | ((g ?? 0) << 8) | (r ?? 0);
  }
  return out;
}

/** The art's two inks: bone, and the red of sealing wax. A pixel that is not lit is clear. */
export const INKS = {
  bone: ramp([58, 58, 56], [240, 237, 230]),
  seal: ramp([116, 22, 18], [255, 96, 80]),
};

/** A small deterministic noise, so a dissolve looks the same from frame to frame. */
function hash(i: number): number {
  let x = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

export interface DrawOptions {
  /** The scene being left, during a change of scene. */
  from?: Scene;
  /** How far the change has gone, from 0 (all `from`) to 1 (all `scene`). */
  mix?: number;
  /** How hard rows are torn sideways, from 0 to 1. */
  tear?: number;
}

/** A buffer of `width` x `height` pixels that scenes are drawn into. */
export class Dither {
  readonly pixels: Uint32Array;
  private readonly noise: Float32Array;
  private readonly shift: Int16Array;
  private readonly out: Shade = { l: 0, a: 0 };
  /** A faint glow around the art, so the dark is not flat: worked out once for each focus. */
  private glow: Float32Array;
  private glowFor: Focus | null = null;

  constructor(
    readonly width: number,
    readonly height: number,
    pixels?: Uint32Array,
  ) {
    this.pixels = pixels ?? new Uint32Array(width * height);
    this.noise = new Float32Array(width * height);
    for (let i = 0; i < this.noise.length; i++) {
      // Blocks of 2x2, so the dissolve reads as grain and not as dust.
      const x = (i % width) >> 1;
      const y = Math.floor(i / width) >> 1;
      this.noise[i] = hash(y * 4099 + x);
    }
    this.shift = new Int16Array(height);
    this.glow = new Float32Array(width * height);
  }

  private glowAround(focus: Focus): Float32Array {
    if (this.glowFor === focus) return this.glow;
    const { width: w, height: h } = this;
    const unit = Math.max(1, Math.min(w, h) * focus.scale);
    for (let y = 0; y < h; y++) {
      const v = (y - h * focus.y) / unit;
      for (let x = 0; x < w; x++) {
        const u = (x - w * focus.x) / unit;
        this.glow[y * w + x] = 0.055 * Math.exp(-(u * u + v * v) * 0.4);
      }
    }
    this.glowFor = focus;
    return this.glow;
  }

  /** Tears a few bands of rows sideways, by up to `amount` of the width; 0 puts them back. */
  private tearRows(amount: number): void {
    this.shift.fill(0);
    if (amount <= 0) return;
    const bands = 3 + Math.floor(Math.random() * 5);
    for (let b = 0; b < bands; b++) {
      const top = Math.floor(Math.random() * this.height);
      const rows = 1 + Math.floor(Math.random() * Math.max(2, this.height / 18));
      const by = Math.round((Math.random() - 0.5) * 2 * amount * this.width);
      for (let y = top; y < Math.min(this.height, top + rows); y++) this.shift[y] = by;
    }
  }

  /** Draws `scene` (and, while scenes change, `from`) with its middle and unit at `focus`. */
  draw(scene: Scene, focus: Focus, { from, mix = 1, tear = 0 }: DrawOptions = {}): void {
    const { width: w, height: h, pixels, noise, shift, out } = this;
    const unit = Math.max(1, Math.min(w, h) * focus.scale);
    const cx = w * focus.x;
    const cy = h * focus.y;
    const glow = this.glowAround(focus);
    this.tearRows(tear);
    const changing = from !== undefined && mix < 1;
    for (let y = 0; y < h; y++) {
      const v = (y - cy) / unit;
      const row = y * w;
      const dy = shift[y] ?? 0;
      const bayerRow = (y & 7) << 3;
      for (let x = 0; x < w; x++) {
        const u = (x + dy - cx) / unit;
        const i = row + x;
        const pick = changing && (noise[i] ?? 0) >= mix ? from : scene;
        pick.shade(u, v, out);
        const l = out.l + (glow[i] ?? 0);
        if (l > (BAYER[bayerRow + (x & 7)] ?? 1)) {
          const step = l >= 1 ? STEPS - 1 : Math.floor(l * STEPS);
          pixels[i] = (out.a === 1 ? INKS.seal : INKS.bone)[step] ?? 0;
        } else {
          pixels[i] = 0;
        }
      }
    }
  }
}

/** Where a looping show of `count` scenes is at `clock` seconds. */
export interface ShowState {
  index: number;
  /** Seconds since the scene at `index` began to come in. */
  time: number;
  /** The scene being left and its time, while one scene changes into the next. */
  from?: { index: number; time: number };
  /** How far the change has gone, from 0 to 1. */
  mix: number;
}

/**
 * The scene of a show at `clock`: each scene holds for `hold` seconds, then the next one comes in
 * over `change` seconds. A scene's own time starts when it begins to come in, so its entrance is
 * part of the change. A show of one scene simply runs. Before 0, from `-change`, the first scene
 * comes in on its own, which is how a show starts.
 */
export function showAt(clock: number, count: number, hold: number, change: number): ShowState {
  if (count <= 1) return { index: 0, time: Math.max(0, clock), mix: 1 };
  if (clock < 0) return { index: 0, time: Math.max(0, clock + change), mix: 1 };
  const slot = hold + change;
  const at = ((clock % (slot * count)) + slot * count) % (slot * count);
  const index = Math.floor(at / slot);
  const local = at - index * slot;
  if (local < hold) return { index, time: local + change, mix: 1 };
  const next = (index + 1) % count;
  const k = (local - hold) / change;
  return {
    index: next,
    time: local - hold,
    from: { index, time: local + change },
    // Eased, so the change starts and ends softly.
    mix: k * k * (3 - 2 * k),
  };
}
