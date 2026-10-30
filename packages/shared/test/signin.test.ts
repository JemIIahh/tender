import { expect, test } from "vitest";
import { SIGN_IN_MESSAGE, signInRecipientOf } from "../src/index";

// Whom a sign-in to the API is signed for. The API takes it from its public URL and a client from
// its base URL; the two agree only if they spell one base one way, so the spelling is held here.

test("the_message_is_the_one_a_wallet_shows", () => {
  expect(SIGN_IN_MESSAGE).toBe("Sign in to Tender");
});

test("the_recipient_is_the_base_of_the_api", () => {
  const cases: Array<[string, string]> = [
    // The ruling's own three.
    ["https://API.example/v1/", "https://api.example"],
    ["http://127.0.0.1:8787", "http://127.0.0.1:8787"],
    ["https://host.example/tender/v1", "https://host.example/tender"],
    // A base as it is.
    ["https://api.example", "https://api.example"],
    ["https://host.example/tender", "https://host.example/tender"],
    // Scheme and host in lower case, whatever the URL says.
    ["HTTPS://API.Example", "https://api.example"],
    ["HTTPS://API.EXAMPLE:443", "https://api.example"],
    // The port only if it is not the default of the scheme.
    ["https://api.example:443", "https://api.example"],
    ["http://api.example:80", "http://api.example"],
    ["https://api.example:8443", "https://api.example:8443"],
    ["http://api.example:443", "http://api.example:443"],
    ["https://api.example:80", "https://api.example:80"],
    // Trailing slashes are not part of it.
    ["https://api.example/", "https://api.example"],
    ["https://api.example//", "https://api.example"],
    ["https://host.example/tender/", "https://host.example/tender"],
    ["https://host.example/tender//", "https://host.example/tender"],
    // A final /v1, which the routes sit under, is not part of it either, with or without a slash.
    ["https://api.example/v1", "https://api.example"],
    ["https://api.example/v1/", "https://api.example"],
    ["https://host.example/tender/v1/", "https://host.example/tender"],
    ["https://host.example/a/b/v1", "https://host.example/a/b"],
    ["https://host.example/tender//v1", "https://host.example/tender"],
    // Only a whole last segment is the version, and only one is taken off.
    ["https://host.example/v10", "https://host.example/v10"],
    ["https://host.example/xv1", "https://host.example/xv1"],
    ["https://host.example/v1/tender", "https://host.example/v1/tender"],
    ["https://host.example/v1/v1", "https://host.example/v1"],
    ["https://host.example/V1", "https://host.example/V1"],
    // A host named v1 is a host.
    ["https://v1", "https://v1"],
    ["https://v1/v1", "https://v1"],
    // The path keeps its case, and the parser's reading of dots and spaces.
    ["https://host.example/Tender", "https://host.example/Tender"],
    ["https://host.example/a/../tender/v1", "https://host.example/tender"],
    ["https://host.example/a/./tender", "https://host.example/a/tender"],
    ["https://host.example/ten der", "https://host.example/ten%20der"],
    // The path is what tells two APIs of one host apart.
    ["https://host.example/other", "https://host.example/other"],
    // Not the user, the query or the fragment.
    ["https://someone:secret@api.example/tender?x=1#top", "https://api.example/tender"],
    ["https://api.example/v1?x=1", "https://api.example"],
    ["https://api.example?x=1", "https://api.example"],
    // A name with its root dot is another name.
    ["https://api.example./", "https://api.example."],
    ["http://localhost", "http://localhost"],
    ["http://localhost:8787", "http://localhost:8787"],
    ["http://127.0.0.1:3000/v1", "http://127.0.0.1:3000"],
    // An address of IPv6 in brackets, in its short form.
    ["http://[::1]:8787", "http://[::1]:8787"],
    ["http://[0:0:0:0:0:0:0:1]", "http://[::1]"],
    // A name in letters beyond ASCII, as it is on the wire.
    ["https://bücher.example", "https://xn--bcher-kva.example"],
    ["https://BÜCHER.example/Tender", "https://xn--bcher-kva.example/Tender"],
    // A scheme the URL parser does not know keeps the case of the host, and so the lower case is
    // this function's own.
    ["tender://API.Example:99/x/v1", "tender://api.example:99/x"],
  ];
  for (const [url, recipient] of cases) {
    expect(signInRecipientOf(url), url).toBe(recipient);
  }
});

test("an_address_is_one_recipient_however_it_is_spelled_and_two_bases_are_two", () => {
  const same = [
    "https://host.example/tender",
    "https://HOST.example/tender/",
    "https://host.example:443/tender/v1",
    "https://host.example/tender/v1/?x=1#y",
    "https://someone@host.example/tender",
  ];
  const recipients = new Set(same.map(signInRecipientOf));
  expect([...recipients]).toEqual(["https://host.example/tender"]);

  const apart = [
    "https://host.example/tender",
    "https://host.example/other",
    "https://host.example",
    "https://host.example/Tender",
    "https://host.example/tender/sub",
    "http://host.example/tender",
    "https://host.example:8443/tender",
    "https://other.example/tender",
  ];
  expect(new Set(apart.map(signInRecipientOf)).size).toBe(apart.length);
});

test("text_that_is_no_url_with_a_host_has_no_recipient", () => {
  const refused = [
    "",
    "api.example",
    "/v1",
    "//api.example",
    "https://",
    "http://:8080",
    "file:///tmp/api",
    "data:text/plain,hi",
    "mailto:a@b.example",
  ];
  for (const url of refused) {
    expect(() => signInRecipientOf(url), url).toThrow(
      "a sign-in recipient needs an absolute URL with a host",
    );
  }

  // The error does not quote what it was given, which can hold a password.
  const error = (() => {
    try {
      return signInRecipientOf("https://someone:hunter2@");
    } catch (thrown) {
      return thrown as Error;
    }
  })();
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain("hunter2");
});
