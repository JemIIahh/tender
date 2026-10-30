import { expect, test } from "vitest";
import { SIGN_IN_MESSAGE, signInRecipientOf } from "../src/index";

// Whom a sign-in to the API is signed for. The API takes it from its public URL and a client from
// its base URL; the two agree only if they spell one host one way, so the spelling is held here.

test("the_message_is_the_one_a_wallet_shows", () => {
  expect(SIGN_IN_MESSAGE).toBe("Sign in to Tender");
});

test("the_recipient_is_the_host_of_the_url", () => {
  const cases: Array<[string, string]> = [
    ["https://api.example", "api.example"],
    // Nothing but the host: not the path, the query, the fragment or the user.
    ["https://api.example/", "api.example"],
    ["https://api.example/v1/tasks?x=1#top", "api.example"],
    ["https://someone:secret@api.example/", "api.example"],
    // Lower case, whatever the URL says.
    ["https://API.Example", "api.example"],
    ["HTTPS://API.EXAMPLE:443", "api.example"],
    // The port only if it is not the default of the scheme.
    ["https://api.example:443", "api.example"],
    ["http://api.example:80", "api.example"],
    ["https://api.example:8443", "api.example:8443"],
    ["http://api.example:443", "api.example:443"],
    ["https://api.example:80", "api.example:80"],
    // A name with its root dot is another name.
    ["https://api.example./", "api.example."],
    ["http://localhost", "localhost"],
    ["http://localhost:8787", "localhost:8787"],
    ["http://127.0.0.1:3000/v1", "127.0.0.1:3000"],
    // An address of IPv6 in brackets, in its short form.
    ["http://[::1]:8787", "[::1]:8787"],
    ["http://[0:0:0:0:0:0:0:1]", "[::1]"],
    // A name in letters beyond ASCII, as it is on the wire.
    ["https://bücher.example", "xn--bcher-kva.example"],
    ["https://BÜCHER.example", "xn--bcher-kva.example"],
    // A scheme the URL parser does not know keeps the case of the host, and so the lower case is
    // this function's own.
    ["tender://API.Example:99/x", "api.example:99"],
  ];
  for (const [url, recipient] of cases) {
    expect(signInRecipientOf(url), url).toBe(recipient);
  }
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
      "a sign-in recipient is the host of an absolute URL",
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
