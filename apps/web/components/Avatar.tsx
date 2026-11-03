/** FNV-1a over the UTF-16 units of `text`, then mixed, so that close account ids look apart. */
function hash32(text: string, seed: number): number {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

/** The size of the grid: 5 x 5, mirrored about the middle column. */
const GRID = 5;
/** How strong a lit cell is: three steps, as the landing's dithered art has steps of light. */
const LEVELS = [1, 0.62, 0.34] as const;

export interface AvatarCell {
  x: number;
  y: number;
  /** Opacity of the cell's ink. */
  level: number;
  /** The one cell in the red of sealing wax, which not every avatar has. */
  accent: boolean;
}

/**
 * The cells of the avatar of `account`: the same account always gets the same picture, and the
 * picture says nothing but that. It is not a profile picture and nobody chose it.
 */
export function avatarCells(account: string): AvatarCell[] {
  const bits = hash32(account, 0);
  const shades = hash32(account, 1);
  const half = Math.ceil(GRID / 2);
  const cells: AvatarCell[] = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < half; x++) {
      const at = y * half + x;
      if (((bits >>> at) & 1) === 0) continue;
      const level = LEVELS[((shades >>> (2 * (at % 16))) & 3) % LEVELS.length] ?? 1;
      cells.push({ x, y, level, accent: false });
      if (x !== GRID - 1 - x) cells.push({ x: GRID - 1 - x, y, level, accent: false });
    }
  }
  // A picture with nothing lit would be a blank circle: the middle cell is lit then.
  if (cells.length === 0) cells.push({ x: 2, y: 2, level: 1, accent: false });
  // Half of the avatars carry one red cell, on the middle column, so the picture stays mirrored.
  if (((shades >>> 31) & 1) === 1) {
    const middle = cells.filter((cell) => cell.x === 2);
    const pick = middle[(bits >>> 16) % Math.max(1, middle.length)];
    if (pick !== undefined) pick.accent = true;
  }
  return cells;
}

/**
 * A small picture made from an account id, so that a reader can tell posters apart at a glance.
 * It is drawn in the colour of the text around it, which is bone on the dark ground and ink on a
 * light card. Decoration only: the account is always written out next to it.
 */
export function Avatar({ account, size = 32 }: { account: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      data-testid="avatar"
      className="grid shrink-0 place-items-center overflow-hidden rounded-full border border-current/20 bg-current/[0.04]"
      style={{ width: size, height: size }}
    >
      <svg
        viewBox={`0 0 ${GRID} ${GRID}`}
        aria-hidden="true"
        className="size-[58%]"
        shapeRendering="crispEdges"
      >
        {avatarCells(account).map((cell) => (
          <rect
            key={`${cell.x}:${cell.y}`}
            x={cell.x}
            y={cell.y}
            width={1}
            height={1}
            fill={cell.accent ? "var(--color-seal)" : "currentColor"}
            fillOpacity={cell.accent ? 1 : cell.level}
          />
        ))}
      </svg>
    </span>
  );
}
