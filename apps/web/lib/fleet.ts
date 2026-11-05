// Where the fleet's parts are, apart from the scene that draws them (lib/scenes.ts): the landing puts
// the accounts' names beside these points (app/page.tsx, `FleetArt`) as soon as it is drawn, and the
// art itself comes with its own code, after the page (components/landing/DitherArt.tsx).

/**
 * Where the fleet's parts are, in art units: the provider's account at the top left, and its three
 * agents down a line from it, each joined to it by a branch.
 */
export const FLEET = {
  provider: { x: -1.55, y: -1.5, half: 0.3 },
  agents: { x: -0.7, ys: [-0.42, 0.43, 1.28], half: 0.2 },
} as const;
