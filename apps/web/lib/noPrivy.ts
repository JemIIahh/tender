// What Privy's kit is in a build with no Privy app id: nothing.
//
// lib/privyKit.tsx, the one importer of `@privy-io/react-auth`, is loaded only when the build has
// an app id (`config.privy`), but a dynamic import is still compiled, and the kit is large: every
// page of `next dev` and every build would compile it for nothing. So when NEXT_PUBLIC_PRIVY_APP_ID
// is empty as the build starts, next.config.ts points the kit's two module names here. These are
// the names lib/privyKit.tsx imports; each throws, and none is ever reached, since `config.privy`
// is null in such a build.

function noLogin(): never {
  throw new Error("this build has no Privy app id");
}

// @privy-io/react-auth
export const PrivyProvider = noLogin;
export const usePrivy = noLogin;
export const useLoginWithEmail = noLogin;
export const useLoginWithOAuth = noLogin;
export const useLogout = noLogin;
export const getAccessToken = noLogin;

// @privy-io/react-auth/extended-chains
export const useCreateWallet = noLogin;
export const useExportWallet = noLogin;
export const useSignRawHash = noLogin;
