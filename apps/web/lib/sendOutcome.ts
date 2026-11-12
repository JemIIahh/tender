// A transaction that was signed and handed to the network, whose end the page does not know.
//
// Kept in a module of its own, with no imports, so that the login's wallet (lib/privyWallet.ts),
// which loads only when it signs, and the words for a person (lib/walletErrors.ts) can both use it
// without one pulling in the other.

/**
 * The wallet signed a transaction and sent it, and then the send failed in a way that does not say
 * whether the network took it: the connection dropped or timed out, or the node answered that the
 * nonce was already used, which is also what it says when an earlier copy of the same transaction
 * got in. It may still go through, so nothing is signed again: the person looks first.
 */
export class SendOutcomeUnknown extends Error {
  constructor(cause: unknown) {
    super("a transaction was sent and how it ended is not known", { cause });
    this.name = "SendOutcomeUnknown";
  }
}
