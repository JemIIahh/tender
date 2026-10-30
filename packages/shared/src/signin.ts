// What a sign-in to the Tender API is a signature of (NEP-413). The API puts these in every
// challenge it issues, and a client signs a challenge only if it carries exactly these: the key then
// signs a Tender sign-in meant for the API the client is talking to, and not whatever the server at
// its base URL asks for, nor a challenge that another API issued and that server passes on. A
// wallet shows both to its user before it signs.

/** What the wallet signs. */
export const SIGN_IN_MESSAGE = "Sign in to Tender";

/**
 * Whom the wallet signs it for: the API itself, named by the host of its URL, in lower case, with
 * the port only when it is not the default of the scheme. `https://API.example:443/v1/` and
 * `https://api.example` are both `api.example`, and `http://127.0.0.1:8787` is `127.0.0.1:8787`.
 * The scheme, the user and the path are not part of it.
 *
 * The API takes it from its own `publicUrl` and a client from its `baseUrl`, so the two have to
 * name the same host. A name that every API shared would let a server hand a client the challenge
 * of another API and then use, there, what the client signed. A signature for this host is good at
 * this host only.
 *
 * Throws for text that is not an absolute URL with a host. The error does not quote the URL, which
 * can hold a password.
 */
export function signInRecipientOf(url: string): string {
  let host = "";
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    // Not a URL at all: refused below, as a URL with no host is.
  }
  if (host === "") throw new Error("a sign-in recipient is the host of an absolute URL");
  return host;
}
