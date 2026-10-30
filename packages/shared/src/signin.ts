// What a sign-in to the Tender API is a signature of (NEP-413). The API puts these in every
// challenge it issues, and a client signs a challenge only if it carries exactly these: the key then
// signs a Tender sign-in meant for the API the client is talking to, and not whatever the server at
// its base URL asks for, nor a challenge that another API issued and that server passes on. A
// wallet shows both to its user before it signs.

/** What the wallet signs. */
export const SIGN_IN_MESSAGE = "Sign in to Tender";

/**
 * The one spelling of an API's base URL: where its routes are (`<base>/v1/...`) and whom a sign-in
 * is signed for. The API takes it from its `publicUrl` and a client from its `baseUrl`, and both
 * come here, so the base a client calls and the recipient it signs for are one string and cannot be
 * two readings of one text. A client, too, keeps its requests and the recipient it expects from this
 * one value, and strips nothing a second time.
 *
 * It is the scheme and the host in lower case, the port only when it is not the default of the
 * scheme, and the path (as the URL parser reads it, dot segments gone) without one trailing `/` and
 * then without one final `/v1`, which the routes sit under: `https://API.example:443/v1/` is
 * `https://api.example`, `http://127.0.0.1:8787` is itself, and `https://host.example/tender/v1` is
 * `https://host.example/tender`. The result is its own base: this gives it back unchanged.
 *
 * Text that would give two spellings of one base, or a base that is not where the routes are, is
 * refused: a URL that is not absolute or has no host, a user name or a password, a query, a
 * fragment (a bare `?` or `#` counts), an empty path segment (`//`), and a `/v1` that is still
 * there once the final one is off (`/v1/v1`, where it could not be said which is the version). Each
 * refusal names the problem and does not quote the URL, which can hold a password.
 *
 * A signature for one base is good at that base only. A name that every API shared would let a
 * server hand a client the challenge of another API and then use, there, what the client signed; a
 * host alone would not do for two APIs under paths of one host; and the scheme tells an API from the
 * same address over http.
 */
export function canonicalBase(url: string): string {
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL at all: refused below, as a URL with no host is.
  }
  if (parsed === undefined || parsed.host === "") {
    throw new Error("the API base URL must be an absolute URL with a host");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("the API base URL must not carry a user name or password");
  }
  // `search` and `hash` read empty for a bare `?` or `#`, which is another spelling all the same,
  // so the whole address is looked at. The fragment starts at the first `#`, and a `?` after that
  // belongs to it.
  const fragmentAt = parsed.href.indexOf("#");
  const beforeFragment = fragmentAt === -1 ? parsed.href : parsed.href.slice(0, fragmentAt);
  if (beforeFragment.includes("?")) throw new Error("the API base URL must not carry a query");
  if (fragmentAt !== -1) throw new Error("the API base URL must not carry a fragment");
  if (parsed.pathname.includes("//")) {
    throw new Error("the API base URL must not have an empty path segment (//)");
  }
  // One trailing slash, then one version. The path has no `//`, so what stays does not end in a
  // slash, and it does not end in `/v1` or it was refused: the result is its own base.
  let path = parsed.pathname;
  if (path.endsWith("/")) path = path.slice(0, -1);
  if (path.endsWith("/v1")) path = path.slice(0, -"/v1".length);
  if (path.endsWith("/v1")) throw new Error("the API base URL must not repeat /v1");
  return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}`;
}
