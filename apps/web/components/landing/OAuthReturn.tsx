"use client";

import { useEffect } from "react";
import { returnAddress, takeReturnPage } from "../../lib/lastWay";

// Google sends a person who signed in with it back to the site's origin, which opens this root:
// the one address Privy's dashboard lists (lib/lastWay.ts `oauthRedirectUrl`). The landing has no wallet store and no
// Connect window, so this sends them straight on to the page they started on (kept in the tab), or
// to the wallet page, with Privy's three parameters; the login ends there, as it does for a
// sign-in that never left. It does nothing on any other visit.

export function OAuthReturn() {
  useEffect(() => {
    const next = returnAddress(window.location.search, takeReturnPage());
    if (next !== null) window.location.replace(next);
  }, []);
  return null;
}
