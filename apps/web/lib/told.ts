/**
 * What the person was told, and for whom. A page keeps its news with the account that it was about
 * and shows it only while the wallet is connected as that account: Alice's failure is no news for
 * Bob, and it is there again if the wallet goes back to Alice.
 */
export interface Told<T> {
  /** The account connected when it happened, or null for a connect button's own failures. */
  account: string | null;
  value: T;
}

/** The news of `told` if it is about `account`, and null if there is none or it is another's. */
export function toldFor<T>(told: Told<T> | null, account: string | null): T | null {
  return told !== null && told.account === account ? told.value : null;
}
