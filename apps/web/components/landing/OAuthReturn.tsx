"use client";

import { useEffect } from "react";
import { returnAddress, takeReturnPage } from "../../lib/lastWay";

// Google sends a person who signed in with it back to the site's origin, which opens this root:
// the one address Privy's dashboard lists (lib/lastWay.ts `oauthRedirectUrl`). The landing has no wallet store and no
// Connect window, so this sends them straight on to the page they started on (kept in the tab), or
// to the wallet page, with Privy's three parameters; the login ends there, as it does for a
// sign-in that never left. It does nothing on any other visit.

/** Whether this page load has sent the person on: once only, as the kept page is read once. */
let sent = false;

/** Goes to `address` in place of this page, so that Back doesn't land on the return. */
const replaceWith = (address: string) => window.location.replace(address);

export function OAuthReturn({ go = replaceWith }: { go?: (address: string) => void } = {}) {
  useEffect(() => {
    // React runs an effect twice in development; a second run would find nothing kept and send
    // the person to the wallet page instead.
    // Any other visit leaves the kept page alone.
    if (sent || returnAddress(window.location.search, null) === null) return;
    const next = returnAddress(window.location.search, takeReturnPage());
    if (next === null) return;
    sent = true;
    go(next);
  }, [go]);
  return null;
}
