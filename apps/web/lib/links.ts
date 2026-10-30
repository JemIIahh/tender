/**
 * `value` as an address a link may point to: an absolute `http` or `https` URL, in the form a
 * browser reads it. Anything else is undefined.
 *
 * Text that came from the chain (an entry's `uri` is any 1 to 256 bytes its author chose) is shown
 * as text. It becomes a link only through here, because `javascript:` and `data:` addresses in an
 * `href` run in this page's origin when clicked. The URL parser strips the tabs, newlines and spaces
 * that people hide a scheme behind, and lower-cases the scheme, so what is checked is the scheme
 * the browser would use.
 */
export function safeHref(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
}

/** The host (with the port, if there is one) a link from `safeHref` goes to, else undefined. */
export function linkHost(value: string): string | undefined {
  const href = safeHref(value);
  return href === undefined ? undefined : new URL(href).host;
}
