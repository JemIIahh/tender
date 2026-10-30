// What a sign-in to the Tender API is a signature of (NEP-413). The API puts these in every
// challenge it issues, and a client signs a challenge only if it carries exactly these: the key then
// signs a Tender sign-in, and not whatever the server at its base URL asks for. A wallet shows both
// to its user before it signs.

/** What the wallet signs. */
export const SIGN_IN_MESSAGE = "Sign in to Tender";

/** Whom the wallet signs it for. */
export const SIGN_IN_RECIPIENT = "tender";
