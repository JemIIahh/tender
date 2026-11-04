import type { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { useCallback, useContext, useRef } from "react";

/**
 * The whole route, and not only as far as its loading.tsx (`next/link`'s own fetch ahead): the page
 * is then drawn at once on a press, with no skeleton between. React shows content that a skeleton
 * stood for no sooner than 300 ms after the skeleton came, so a skeleton that is not needed slows
 * the page down.
 */
const WHOLE = "full" as PrefetchKind;

/**
 * What a card that leads to `href` (a task's, an agent's, a provider's or a service's) spreads on
 * its box: the first time the pointer comes onto the card, or the focus comes into it, the whole
 * route is fetched ahead (`router.prefetch`), so a press shows it at once; never again for this
 * card. Its link fetches the route ahead when it comes into view (`next/link`), but only as far as
 * its loading.tsx; the person's interest is the surer sign, and worth the whole of it.
 *
 * The router is read from its context, as `useRouter` reads it, but without its demand that there
 * be one: a card drawn outside the app's router (a test) fetches nothing. Next fetches ahead only in
 * a production build.
 */
export function usePrefetchOnIntent(href: string): {
  onPointerEnter: () => void;
  onFocus: () => void;
} {
  const router = useContext(AppRouterContext);
  const fetched = useRef<string | null>(null);
  const prefetch = useCallback(() => {
    if (router === null || fetched.current === href) return;
    fetched.current = href;
    router.prefetch(href, { kind: WHOLE });
  }, [router, href]);
  return { onPointerEnter: prefetch, onFocus: prefetch };
}
