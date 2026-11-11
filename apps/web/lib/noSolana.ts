// What two Solana program clients would give Privy's kit, in this app: nothing that works.
//
// Privy's kit (`@privy-io/react-auth` 3.51.0, lib/privyKit.tsx) has screens that fund a Solana
// wallet, and they import `@solana-program/system` and `@solana-program/token`. The versions
// installed need `@solana/kit` 8, while the kit that Privy's peer resolves to here is 5.5.1, so the
// build fails on their imports (`@solana/kit/program-client-core` and five other names it lacks).
// Tender uses no Solana wallet, and the app turns Privy's Solana wallets off, so none of this is
// ever called. next.config.ts points both names at this module in every build, so that the build
// works without a change to the lockfile. It has the names that code bundled with the kit imports:
// Privy's own, each of which throws, and the token program's address, which the x402 client that
// the kit bundles reads as a constant (the SPL Token program's public address, as the package
// exports it).

function notInThisApp(): never {
  throw new Error("Solana is not part of this app");
}

// @solana-program/system
export const getTransferSolInstruction = notInThisApp;

// @solana-program/token
export const TOKEN_PROGRAM_ADDRESS = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const findAssociatedTokenPda = notInThisApp;
export const getCreateAssociatedTokenIdempotentInstruction = notInThisApp;
export const getApproveInstruction = notInThisApp;
export const fetchMaybeToken = notInThisApp;
export const getTransferInstruction = notInThisApp;
