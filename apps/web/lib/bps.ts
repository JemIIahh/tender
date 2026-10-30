/** A share in basis points as a percentage, with no more digits than it needs: 3333 is `33.33%`. */
export function formatBps(bps: number): string {
  return `${bps / 100}%`;
}
