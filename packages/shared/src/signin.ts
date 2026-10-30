// What a sign-in to the Tender API is a signature of (NEP-413). The API puts these in every
// challenge it issues, and a client signs a challenge only if it carries exactly these: the key then
// signs a Tender sign-in meant for the API the client is talking to, and not whatever the server at
// its base URL asks for, nor a challenge that another API issued and that server passes on. A
// wallet shows both to its user before it signs.

/** What the wallet signs. */
export const SIGN_IN_MESSAGE = "Sign in to Tender";

/**
 * Whom the wallet signs it for: the API itself, named by its base URL. That is the scheme and the
 * host in lower case, the port only when it is not the default of the scheme, and the path with
 * its trailing slashes and a final `/v1` (which the routes sit under) taken off. The query, the
 * fragment and the user are no part of it. `https://API.example:443/v1/` is `https://api.example`,
 * `http://127.0.0.1:8787` is itself, and `https://host.example/tender/v1` is
 * `https://host.example/tender`.
 *
 * The API takes it from its own `publicUrl` and a client from its `baseUrl`, so the two have to
 * name the same base. A name that every API shared would let a server hand a client the challenge
 * of another API and then use, there, what the client signed. A host alone would not do for two
 * APIs under paths of one host, and the scheme tells an API from the same address over http. A
 * signature for one base is good at that base only.
 *
 * Throws for text that is not an absolute URL with a host. The error does not quote the URL, which
 * can hold a password.
 */
export function signInRecipientOf(url: string): string {
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL at all: refused below, as a URL with no host is.
  }
  const host = parsed?.host.toLowerCase() ?? "";
  if (parsed === undefined || host === "") {
    throw new Error("a sign-in recipient needs an absolute URL with a host");
  }
  // The path is the parser's: dot segments are gone, and a URL with no path has `/`.
  let path = parsed.pathname.replace(/\/+$/, "");
  if (path.endsWith("/v1")) path = path.slice(0, -"/v1".length).replace(/\/+$/, "");
  return `${parsed.protocol}//${host}${path}`;
}
