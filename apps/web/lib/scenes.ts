import type { Scene, Shade } from "./dither";
import { FLEET } from "./fleet";

// The landing's scenes, from Tender's own world: an envelope handed in and sealed, a scale that
// weighs the entries, coins paid onto a stack, a vault, a scorecard being ticked, and a signal
// going out. Each is a few distance functions lit from the top left. A point inside a shape is lit
// by its place on it, a thin band along the edge is brighter, and outside there is a faint halo.

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** The length of (x, y). Math.hypot is several times slower, and this runs for every pixel. */
const len = (x: number, y: number) => Math.sqrt(x * x + y * y);
const easeOut = (x: number) => 1 - (1 - clamp01(x)) ** 3;
function easeOutBack(x: number): number {
  const k = clamp01(x) - 1;
  return 1 + 2.4 * k * k * k + 1.4 * k * k;
}

/** Distance to a box of half-size (hx, hy) with corners rounded by r, centred on the origin. */
function box(x: number, y: number, hx: number, hy: number, r: number): number {
  const qx = Math.abs(x) - hx + r;
  const qy = Math.abs(y) - hy + r;
  return len(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Distance to the segment from (ax, ay) to (bx, by). */
function segment(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const px = x - ax;
  const py = y - ay;
  const dx = bx - ax;
  const dy = by - ay;
  const h = clamp01((px * dx + py * dy) / (dx * dx + dy * dy));
  return len(px - dx * h, py - dy * h);
}

/** A rough distance to an ellipse of radii (rx, ry): good enough to light by. */
function ellipse(x: number, y: number, rx: number, ry: number): number {
  return (len(x / rx, y / ry) - 1) * Math.min(rx, ry);
}

/** Light from the top left, for a point (x, y) of a shape about `size` across. */
const lit = (x: number, y: number, size: number) => clamp01(0.6 - (0.55 * x + 0.75 * y) / size);

/** The light of a solid at distance d: its body, a bright rim, or the halo around it. */
function solid(d: number, light: number, rim = 0.03): number {
  if (d < 0) return clamp01(0.26 + 0.5 * light + (d > -rim ? 0.3 : 0));
  return 0.2 * Math.exp(-d * 11);
}

function set(out: Shade, l: number, a = 0): void {
  out.l = l;
  out.a = a;
}

// ---- Sealed: an envelope is handed in from the right, and a wax seal is pressed on it ----------

/** `settled`: start with the envelope in place and sealed, for a still or a small card. */
export function sealedScene({ settled = false }: { settled?: boolean } = {}): Scene {
  const HX = 0.8;
  const HY = 0.52;
  const TIP = 0.1;
  let ex = 0;
  let ey = 0;
  let cos = 1;
  let sin = 0;
  let speed = 0;
  let seal = 0;
  let sweep = 0;
  let pulse = 0;
  return {
    frame(t0) {
      const t = settled ? t0 + 4 : t0;
      const k = easeOut(t / 1.7);
      ex = (1 - k) * 2.7;
      speed = 1 - k;
      ey = 0.035 * Math.sin(t * 1.3);
      const angle = -0.1 + 0.08 * (1 - k) + 0.02 * Math.sin(t * 0.8);
      cos = Math.cos(angle);
      sin = Math.sin(angle);
      seal = easeOutBack((t - 1.8) / 0.45);
      sweep = ((t * 0.5) % 2.8) - 1.4;
      pulse = 0.5 + 0.5 * Math.sin(t * 2.2);
    },
    shade(u, v, out) {
      const px = u - ex;
      const py = v - ey;
      // Far from the envelope (and its trail, while it moves) there is nothing to light.
      if (Math.abs(py) > 1 || px < -1.25 || (px > 1.25 && speed <= 0.02)) return set(out, 0);
      const x = cos * px + sin * py;
      const y = -sin * px + cos * py;

      if (seal > 0) {
        const r = len(x, y - TIP);
        const d = r - 0.19 * seal;
        if (d < 0) {
          // Wax: a raised ring near the edge and a pressed mark in the middle.
          let l = 0.42 + 0.5 * lit(x, y - TIP, 0.2) + (d > -0.03 ? 0.22 : 0);
          if (Math.abs(r - 0.12 * seal) < 0.016) l -= 0.32;
          if (r < 0.05 * seal) l -= 0.18;
          return set(out, clamp01(l), 1);
        }
        // The seal's glow on the paper around it.
        if (d < 0.12 && Math.abs(x) < HX && Math.abs(y) < HY) {
          const glow = 0.18 * pulse * (1 - d / 0.12);
          if (glow > 0.05 && box(x, y, HX, HY, 0.05) > 0) return set(out, glow, 1);
        }
      }

      const d = box(x, y, HX, HY, 0.05);
      if (d < 0) {
        const flap = -HY + (HY + TIP) * (1 - Math.abs(x) / HX);
        let l = 0.24 + 0.46 * lit(x, y, 1.6);
        if (y < flap) l += 0.1;
        if (Math.abs(y - flap) < 0.022) l -= 0.34;
        // The two folds that meet under the flap.
        const fold = HY - (HY - 0.18) * (1 - Math.abs(x) / HX);
        if (y > 0.18 && Math.abs(y - fold) < 0.016) l -= 0.18;
        const s = x * 0.7 + y * 0.7 - sweep;
        l += 0.24 * Math.exp(-s * s * 30);
        if (d > -0.035) l += 0.3;
        return set(out, clamp01(l));
      }

      // The trail it leaves while it moves: streaks behind it, to the right.
      let l = 0.2 * Math.exp(-d * 10);
      if (speed > 0.02 && x > HX && Math.abs(y) < HY) {
        const streak = Math.sin(y * 70) > 0.2 ? 1 : 0.2;
        l += 0.75 * speed * streak * Math.exp(-(x - HX) * 1.4);
      }
      set(out, l);
    },
  };
}

// ---- Judged: a balance weighs a sealed entry against the checks ---------------------------------

/** Distance to a pan of half-width `pan`: the lower half of a flat ellipse. */
function bowl(x: number, y: number, pan: number): number {
  return Math.max(ellipse(x, y, pan, 0.1), -y);
}

export function scaleScene(): Scene {
  const PIVOT = -0.62;
  const ARM = 0.7;
  const DROP = 0.58;
  const PAN = 0.27;
  let lx = 0;
  let ly = 0;
  let rx = 0;
  let ry = 0;
  return {
    frame(t) {
      const angle = 0.09 * Math.sin(t * 0.9) + 0.05 * Math.sin(t * 2.3) * Math.exp(-t * 0.6);
      lx = -ARM * Math.cos(angle);
      ly = PIVOT - ARM * Math.sin(angle);
      rx = ARM * Math.cos(angle);
      ry = PIVOT + ARM * Math.sin(angle);
    },
    shade(u, v, out) {
      // Outside the balance's box, give or take its halo, there is nothing to light.
      if (Math.abs(u) > ARM + PAN + 0.3 || v < PIVOT - 0.45 || v > 1.2) return set(out, 0);
      const lpy = ly + DROP;
      const rpy = ry + DROP;
      // The pans, their strings and what is on them are worked out only near the pans.
      const nearPans =
        (Math.abs(u - lx) < PAN + 0.35 || Math.abs(u - rx) < PAN + 0.35) &&
        v > Math.min(ly, ry) - 0.35 &&
        v < Math.max(lpy, rpy) + 0.4;
      let items = Number.POSITIVE_INFINITY;
      let strings = Number.POSITIVE_INFINITY;
      let pans = Number.POSITIVE_INFINITY;
      if (nearPans) {
        // The entry on the left pan: a small envelope with a dot of wax.
        const ex = u - lx;
        const ey = v - (lpy - 0.11);
        if (len(ex, ey - 0.01) < 0.045) return set(out, 0.85, 1);
        const env = box(ex, ey, 0.17, 0.11, 0.02);
        // The checks on the right pan: two weights.
        const w1 = box(u - rx + 0.07, v - (rpy - 0.1), 0.065, 0.1, 0.02);
        const w2 = box(u - rx - 0.09, v - (rpy - 0.07), 0.055, 0.07, 0.02);
        items = Math.min(env, w1, w2);
        if (items < 0) {
          const l = 0.42 + 0.45 * lit(u - lx, v - lpy, 0.4) + (items > -0.025 ? 0.25 : 0);
          // The envelope's flap: a V from its top corners.
          const flap = -0.11 + 0.12 * (1 - Math.abs(ex) / 0.17);
          return set(out, clamp01(env < 0 && Math.abs(ey - flap) < 0.018 ? l - 0.35 : l));
        }
        strings = Math.min(
          segment(u, v, lx, ly, lx - PAN + 0.02, lpy),
          segment(u, v, lx, ly, lx + PAN - 0.02, lpy),
          segment(u, v, rx, ry, rx - PAN + 0.02, rpy),
          segment(u, v, rx, ry, rx + PAN - 0.02, rpy),
        );
        pans = Math.min(bowl(u - lx, v - lpy, PAN), bowl(u - rx, v - rpy, PAN));
      }

      const post = segment(u, v, 0, PIVOT, 0, 0.78) - 0.036;
      const base = box(u, v - 0.84, 0.36, 0.055, 0.03);
      const pivot = len(u, v - PIVOT) - 0.07;
      const beam = segment(u, v, lx, ly, rx, ry) - 0.028;
      const frame = Math.min(post, base, pivot, beam, pans);
      if (strings < 0.013 && frame > 0) return set(out, 0.6);
      set(out, Math.max(solid(frame, lit(u, v, 1.8)), items > 0 ? 0.2 * Math.exp(-items * 11) : 0));
    },
  };
}

// ---- Paid: coins drop onto a stack, and each one sends out a ring of red ------------------------

const COIN = { rx: 0.36, ry: 0.105, thick: 0.085, bottom: 0.56 };

/**
 * A stack of `count` coins standing on the line `COIN.bottom`, at (u, v) from its middle: whether
 * the point is on it, with its light in `out`. The top coin shows its face; below it each coin is a
 * band of edge, lit like a cylinder, with a bright bevel on top and a dark seam under it.
 */
function coinStack(u: number, v: number, count: number, out: Shade): boolean {
  const { rx, ry, thick, bottom } = COIN;
  const top = bottom - thick * count;
  const face = ellipse(u, v - top, rx, ry);
  if (face < 0) {
    let l = 0.46 + 0.45 * lit(u, v - top, 0.6);
    const r = len(u / rx, (v - top) / ry);
    if (Math.abs(r - 0.7) < 0.08) l -= 0.32;
    if (face > -0.018) l += 0.25;
    set(out, clamp01(l));
    return true;
  }
  if (Math.abs(u) >= rx) return false;
  const arc = ry * Math.sqrt(1 - (u / rx) ** 2);
  if (v <= top + arc || v >= bottom + arc) return false;
  const into = (v - top - arc) / thick;
  const part = into - Math.floor(into);
  const round = Math.sqrt(1 - (u / rx) ** 2);
  let l = 0.22 + 0.45 * round * (u < 0 ? 1 : 0.72);
  if (part < 0.2) l += 0.28;
  if (part > 0.84) l -= 0.3;
  if ((((u * 36) % 1) + 1) % 1 < 0.3) l -= 0.08;
  set(out, clamp01(l));
  return true;
}

export function coinsScene(): Scene {
  const LEFT = -0.48;
  const RIGHT = 0.48;
  const STILL = 5;
  const EVERY = 1.5;
  const FIRST = 2;
  const MOST = 8;
  let count = FIRST;
  let fallY = 0;
  let falling = false;
  let spin = 1;
  let ring = -1;
  return {
    frame(t) {
      // A coin lands on the right stack every EVERY seconds, the first at 0.9 s.
      const landed = Math.max(0, Math.floor((t - 0.9) / EVERY) + 1);
      count = Math.min(MOST, FIRST + landed);
      const since = t - 0.9 - (landed - 1) * EVERY;
      ring = landed > 0 && since < 1 ? since : -1;
      falling = count < MOST;
      const top = COIN.bottom - COIN.thick * count;
      const k = clamp01((t - 0.9 - landed * EVERY + EVERY) / EVERY);
      fallY = -2.2 + (top - COIN.thick + 2.2) * k * k;
      spin = Math.abs(Math.cos(t * 5));
    },
    shade(u, v, out) {
      const top = COIN.bottom - COIN.thick * count;
      // Outside the stacks, the coin in the air and the ring, give or take a halo: nothing.
      if (Math.abs(u) > 1.2 || v > COIN.bottom + 0.45 || v < Math.min(fallY, top) - 0.45) {
        return set(out, 0);
      }
      // The ring a landing sends out, flat around the top of the stack.
      if (ring >= 0) {
        const r = len(u - RIGHT, (v - top) / 0.32);
        if (Math.abs(r - (0.4 + ring * 0.16)) < 0.026 * (1.3 - ring)) {
          return set(out, 0.95 * (1 - ring), 1);
        }
      }
      // The coin in the air, turning as it falls.
      if (falling) {
        const ry = 0.015 + COIN.ry * spin;
        const d = ellipse(u - RIGHT, v - fallY, COIN.rx, ry);
        if (d < 0) {
          const ringed = Math.abs(len((u - RIGHT) / COIN.rx, (v - fallY) / ry) - 0.7) < 0.08;
          return set(out, clamp01(0.5 + 0.4 * lit(u - RIGHT, v - fallY, 0.6) - (ringed ? 0.3 : 0)));
        }
      }
      if (coinStack(u - RIGHT, v, count, out)) return;
      if (coinStack(u - LEFT, v, STILL, out)) return;
      // A halo around both stacks.
      const tallest = COIN.bottom - COIN.thick * Math.max(count, STILL);
      const d = box(
        u,
        v - (tallest + COIN.bottom) / 2,
        0.85,
        (COIN.bottom - tallest) / 2 + 0.1,
        0.1,
      );
      set(out, 0.18 * Math.exp(-Math.max(d, 0) * 8));
    },
  };
}

// ---- Escrow: a vault door with a turning wheel -------------------------------------------------

export function vaultScene(): Scene {
  let cos = 1;
  let sin = 0;
  return {
    frame(t) {
      const a = t * 0.45 + 0.3 * Math.sin(t * 0.7);
      cos = Math.cos(a);
      sin = Math.sin(a);
    },
    shade(u, v, out) {
      const r = len(u, v);
      const door = r - 0.92;
      if (door >= 0) return set(out, door > 0.4 ? 0 : 0.2 * Math.exp(-door * 9));
      // The wheel: a rim, a hub and four spokes with a grip at each end, turning.
      const x = cos * u + sin * v;
      const y = -sin * u + cos * v;
      const spokes = Math.min(Math.abs(x), Math.abs(y)) - 0.035;
      const arms = Math.max(spokes, r - 0.5);
      const grips = Math.min(len(Math.abs(x) - 0.56, y), len(x, Math.abs(y) - 0.56)) - 0.075;
      const wheel = Math.min(arms, Math.abs(r - 0.42) - 0.03, r - 0.11, grips);
      let l = 0.26 + 0.36 * lit(u, v, 2);
      if (door > -0.045) l += 0.32;
      if (Math.abs(r - 0.76) < 0.025) l -= 0.18;
      // Bolts around the rim.
      const bolt = Math.round(Math.atan2(v, u) / (Math.PI / 6)) * (Math.PI / 6);
      if (len(u - Math.cos(bolt) * 0.84, v - Math.sin(bolt) * 0.84) < 0.035) l += 0.4;
      if (wheel < 0) l = 0.45 + 0.45 * lit(u, v, 1.2) + (wheel > -0.025 ? 0.2 : 0);
      else if (wheel < 0.04) l -= 0.2;
      set(out, clamp01(l));
    },
  };
}

// ---- Scorecard: a sheet whose checks are ticked one by one, and stamped -----------------------

export function scorecardScene(): Scene {
  const ROWS = 4;
  let ticked = 0;
  let stamp = 0;
  return {
    frame(t) {
      const at = t % 6;
      ticked = Math.min(ROWS, Math.floor(at / 0.9));
      stamp = easeOutBack((at - 4) / 0.4);
    },
    shade(u, v, out) {
      // The stamp, pressed on the corner once every check is done.
      if (stamp > 0) {
        const r = len(u - 0.4, v - 0.6);
        if (r < 0.25 * stamp && (Math.abs(r - 0.21 * stamp) < 0.03 || r < 0.12 * stamp)) {
          return set(out, 0.85, 1);
        }
      }
      const sheet = box(u, v, 0.62, 0.86, 0.04);
      if (sheet >= 0) return set(out, sheet > 0.4 ? 0 : 0.2 * Math.exp(-sheet * 10));
      let l = 0.36 + 0.4 * lit(u, v, 2);
      if (sheet > -0.035) l += 0.25;
      for (let i = 0; i < ROWS; i++) {
        const y = -0.52 + i * 0.34;
        if (i < ticked) {
          const tick = Math.min(
            segment(u, v, -0.46, y, -0.39, y + 0.07),
            segment(u, v, -0.39, y + 0.07, -0.26, y - 0.1),
          );
          if (tick < 0.032) return set(out, 0.9, 1);
        }
        const check = box(u + 0.38, v - y, 0.08, 0.08, 0.015);
        if (check < 0 && check > -0.025) l = 0.08;
        if (box(u - 0.14, v - y, 0.32 - (i % 2) * 0.1, 0.028, 0.028) < 0) l = 0.1;
      }
      set(out, clamp01(l));
    },
  };
}

// ---- Alerts and MCP: a node sends signals to the others, and rings go out ----------------------

export function signalScene(): Scene {
  const NODES: ReadonlyArray<readonly [number, number]> = [
    [-0.82, -0.5],
    [0.86, -0.36],
    [-0.62, 0.66],
    [0.74, 0.6],
  ];
  let t = 0;
  return {
    frame(time) {
      t = time;
    },
    shade(u, v, out) {
      const r = len(u, v);
      // Rings going out from the middle.
      const wave = (t * 0.45) % 1;
      if (Math.abs(r - 0.25 - wave * 1.1) < 0.02 && r < 1.4) return set(out, 0.7 * (1 - wave));
      const hub = r - 0.2;
      if (hub < 0)
        return set(out, clamp01(0.45 + 0.5 * lit(u, v, 0.4) + (hub > -0.03 ? 0.2 : 0)), 1);
      let l = 0.2 * Math.exp(-hub * 9);
      for (let i = 0; i < NODES.length; i++) {
        const [nx, ny] = NODES[i] ?? [0, 0];
        const node = len(u - nx, v - ny) - 0.12;
        if (node < 0) return set(out, solid(node, lit(u - nx, v - ny, 0.3), 0.025));
        if (segment(u, v, 0, 0, nx, ny) < 0.014) l = Math.max(l, 0.42);
        // A pulse travelling out along each line.
        const p = (t * 0.6 + i * 0.27) % 1;
        if (len(u - nx * p, v - ny * p) < 0.05) return set(out, 0.95);
        l = Math.max(l, 0.16 * Math.exp(-node * 10));
      }
      set(out, l);
    },
  };
}

// ---- Fleet: a provider's account and the agents it runs, each a sub-account with its bond ------

/**
 * Signals go from the provider down the line and along each branch in turn; where one lands, the
 * agent's bond (a dot of wax) flares and sends out a ring. The tree itself stands still.
 */
export function fleetScene(): Scene {
  const P = FLEET.provider;
  const A = FLEET.agents;
  const LINE = 0.022;
  const trunkTop = P.y + P.half;
  const trunkEnd = A.ys[A.ys.length - 1] ?? 0;
  const branchEnd = A.x - A.half;
  /** Art units a signal covers in a second, and the seconds between two signals to one agent. */
  const SPEED = 2.4;
  const EVERY = 3.6;
  const px = [0, 0, 0];
  const py = [0, 0, 0];
  const moving = [false, false, false];
  /** Seconds since the last signal landed on each agent. */
  const landed = [9, 9, 9];
  let glow = 0;
  return {
    frame(t) {
      glow = 0.5 + 0.5 * Math.sin(t * 1.6);
      A.ys.forEach((y, i) => {
        const down = y - trunkTop;
        const across = branchEnd - P.x;
        const since = t - 0.3 - i * (EVERY / 3);
        moving[i] = false;
        landed[i] = 9;
        if (since < 0) return;
        const d = (since % EVERY) * SPEED;
        if (d < down) {
          moving[i] = true;
          px[i] = P.x;
          py[i] = trunkTop + d;
        } else if (d < down + across) {
          moving[i] = true;
          px[i] = P.x + d - down;
          py[i] = y;
        } else {
          landed[i] = (d - down - across) / SPEED;
        }
        // The one before this, still ringing as the next sets out.
        if (moving[i] && since >= EVERY) landed[i] = (d + (EVERY * SPEED - down - across)) / SPEED;
      });
    },
    shade(u, v, out) {
      // Nothing but the fleet and its halo: the right of the box is for the names.
      if (
        u < P.x - P.half - 0.5 ||
        u > A.x + A.half + 0.7 ||
        v < P.y - P.half - 0.5 ||
        v > trunkEnd + A.half + 0.7
      ) {
        return set(out, 0);
      }
      for (let i = 0; i < 3; i++) {
        if (moving[i] && len(u - (px[i] ?? 0), v - (py[i] ?? 0)) < 0.06) return set(out, 0.97);
      }

      // The provider: an account with Tender's seal pressed in it.
      const pu = u - P.x;
      const pv = v - P.y;
      const pd = box(pu, pv, P.half, P.half, 0.08);
      if (pd < 0) {
        const r = len(pu, pv);
        if (r < 0.14) {
          let l = 0.52 + 0.42 * lit(pu, pv, 0.3) + (r > 0.115 ? 0.2 : 0);
          if (r < 0.05) l -= 0.25;
          return set(out, clamp01(l), 1);
        }
        let l = 0.25 + 0.46 * lit(pu, pv, 0.9);
        if (Math.abs(r - 0.205) < 0.017) l -= 0.26;
        if (pd > -0.035) l += 0.3;
        return set(out, clamp01(l));
      }
      let halo = pd;
      // The seal's glow on the ground around the provider.
      let l = pd < 0.16 ? 0.12 + 0.1 * glow * (1 - pd / 0.16) : 0;

      for (let i = 0; i < 3; i++) {
        const au = u - A.x;
        const av = v - (A.ys[i] ?? 0);
        const r = len(au, av);
        const since = landed[i] ?? 9;
        // The ring a landing sends out, in wax red.
        if (since < 0.9) {
          const ring = A.half * 1.25 + since * 0.42;
          if (Math.abs(r - ring) < 0.02 * (1.4 - since))
            return set(out, 0.92 * (1 - since / 0.9), 1);
        }
        const ad = box(au, av, A.half, A.half, 0.06);
        if (ad < 0) {
          // The agent's bond: a dot of wax, brighter for a moment when a signal lands.
          if (r < 0.075) {
            const flare = since < 0.6 ? 0.35 * (1 - since / 0.6) : 0;
            return set(out, clamp01(0.5 + 0.35 * lit(au, av, 0.15) + flare), 1);
          }
          let shade = 0.24 + 0.44 * lit(au, av, 0.6);
          if (Math.abs(r - 0.125) < 0.015) shade -= 0.22;
          if (ad > -0.03) shade += 0.3;
          return set(out, clamp01(shade));
        }
        halo = Math.min(halo, ad);
      }

      // The lines: down from the provider, and along to each agent.
      let line = segment(u, v, P.x, trunkTop, P.x, trunkEnd);
      for (const y of A.ys) line = Math.min(line, segment(u, v, P.x, y, branchEnd, y));
      if (line < LINE) return set(out, 0.46);
      l = Math.max(l, 0.2 * Math.exp(-Math.max(halo, 0) * 11), 0.1 * Math.exp(-line * 16));
      set(out, l);
    },
  };
}

/** The art the landing and the app show, by name: the hero's show and each scene alone. */
export const ARTS = {
  hero: () => [sealedScene(), scaleScene(), coinsScene()],
  escrow: () => [vaultScene()],
  sealed: () => [sealedScene({ settled: true })],
  scorecard: () => [scorecardScene()],
  signal: () => [signalScene()],
  // The hero's other two scenes, alone, for the heads of the app's pages (components/StillArt).
  coins: () => [coinsScene()],
  scale: () => [scaleScene()],
  // A provider and its agents: the landing's "Run a fleet", and the head of the providers' pages.
  fleet: () => [fleetScene()],
} satisfies Record<string, () => Scene[]>;

export type ArtName = keyof typeof ARTS;
