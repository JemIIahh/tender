import { expect, test } from "vitest";
import { canonicalBase, SIGN_IN_MESSAGE } from "../src/index";

// The base of the API, in the one spelling. A client calls `<base>/v1/...` and signs in for the base
// itself, and the API names its own base from its public URL: if two functions read the text, one
// spelling could call one base and be signed for as another. There is one, and it is held here:
// what it makes of a URL, and the URLs it will not make anything of.

/** What `canonicalBase` says when it refuses a URL: the problem, and nothing of the URL. */
const REFUSED = {
  noHost: "the API base URL must be an absolute URL with a host",
  user: "the API base URL must not carry a user name or password",
  query: "the API base URL must not carry a query",
  fragment: "the API base URL must not carry a fragment",
  emptySegment: "the API base URL must not have an empty path segment (//)",
  repeated: "the API base URL must not repeat /v1",
};

/** What `canonicalBase` threw for `url`: the test fails if it gave a base. */
function refusalOf(url: string): Error {
  try {
    canonicalBase(url);
  } catch (error) {
    expect(error, url).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error(`expected ${url} to be refused, and it gave a base`);
}

/** URLs and the base each one is. */
const BASES: Array<[string, string]> = [
  // The ruling's own three.
  ["https://API.example/v1/", "https://api.example"],
  ["http://127.0.0.1:8787", "http://127.0.0.1:8787"],
  ["https://host.example/tender/v1", "https://host.example/tender"],
  // The same two spellings of one base, as the review had them.
  ["https://H/x/v1/", "https://h/x"],
  ["https://h/x", "https://h/x"],
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
  // One trailing slash is not part of it.
  ["https://api.example/", "https://api.example"],
  ["https://host.example/tender/", "https://host.example/tender"],
  // A final /v1, which the routes sit under, is not part of it either, with or without a slash.
  ["https://api.example/v1", "https://api.example"],
  ["https://api.example/v1/", "https://api.example"],
  ["https://host.example/tender/v1/", "https://host.example/tender"],
  ["https://host.example/a/b/v1", "https://host.example/a/b"],
  // Only a whole last segment is the version.
  ["https://host.example/v10", "https://host.example/v10"],
  ["https://host.example/xv1", "https://host.example/xv1"],
  ["https://host.example/v1/tender", "https://host.example/v1/tender"],
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
  // A `@` with no user or password in front of it is no user, and the parser drops it.
  ["https://@api.example/tender", "https://api.example/tender"],
];

test("the_message_is_the_one_a_wallet_shows", () => {
  expect(SIGN_IN_MESSAGE).toBe("Sign in to Tender");
});

test("the_base_is_the_scheme_host_and_path_of_the_api", () => {
  for (const [url, base] of BASES) {
    expect(canonicalBase(url), url).toBe(base);
  }
});

test("a_base_is_its_own_base_and_has_nothing_that_reads_two_ways", () => {
  for (const [url, base] of BASES) {
    // Asked again, it is not changed: nothing is left that a second reading would take off.
    expect(canonicalBase(base), url).toBe(base);
    // After the scheme: no user, query, fragment or empty segment, and no slash or version at the
    // end, where a client would add its own.
    const afterScheme = base.slice(base.indexOf("//") + 2);
    expect(afterScheme, url).not.toMatch(/[?#@]|\/\//);
    expect(afterScheme, url).not.toMatch(/\/$|\/v1$/);
  }
});

test("an_address_is_one_base_however_it_is_spelled_and_two_bases_are_two", () => {
  const same = [
    "https://host.example/tender",
    "https://HOST.example/tender/",
    "https://host.example:443/tender/v1",
    "HTTPS://host.EXAMPLE/tender/v1/",
    "https://@host.example/tender",
  ];
  expect([...new Set(same.map(canonicalBase))]).toEqual(["https://host.example/tender"]);

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
  expect(new Set(apart.map(canonicalBase)).size).toBe(apart.length);
});

test("spellings_that_differ_in_case_port_slash_or_version_are_one_base", () => {
  const bases = [
    "https://api.example",
    "https://host.example/tender",
    "https://host.example:8443/x",
    "http://127.0.0.1:8787",
    "http://[::1]:3000/a/b",
    "http://localhost",
  ];
  for (const base of bases) {
    const parsed = new URL(base);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    const origin = `${parsed.protocol}//${parsed.host}`;
    const origins = [origin, origin.toUpperCase()];
    // The default port, written out.
    if (parsed.port === "")
      origins.push(`${origin}${parsed.protocol === "https:" ? ":443" : ":80"}`);
    for (const written of origins) {
      for (const tail of ["", "/", "/v1", "/v1/"]) {
        const spelling = `${written}${path}${tail}`;
        expect(canonicalBase(spelling), spelling).toBe(base);
      }
    }
  }
});

test("a_url_that_would_be_read_two_ways_is_refused_and_the_problem_is_named", () => {
  const refused: Array<[string, string]> = [
    // A version twice: which of the two is the one the routes sit under?
    ["https://host.example/tender/v1/v1", REFUSED.repeated],
    ["https://host.example/v1/v1", REFUSED.repeated],
    ["https://host.example/v1/v1/", REFUSED.repeated],
    ["https://host.example/v1/tender/v1/v1", REFUSED.repeated],
    // The parser has done its dots before this looks: a repeat they make is a repeat.
    ["https://host.example/v1/x/../v1", REFUSED.repeated],
    ["https://host.example/v1/./v1", REFUSED.repeated],
    // An empty segment, in front of the version, behind it or on its own.
    ["https://host.example//", REFUSED.emptySegment],
    ["https://host.example//v1", REFUSED.emptySegment],
    ["https://host.example/tender//v1", REFUSED.emptySegment],
    ["https://host.example/tender/v1//", REFUSED.emptySegment],
    ["https://host.example/tender//", REFUSED.emptySegment],
    ["https://host.example//tender", REFUSED.emptySegment],
    ["https://host.example/a//b", REFUSED.emptySegment],
    ["https://host.example/..//x", REFUSED.emptySegment],
    ["tender://host.example//x", REFUSED.emptySegment],
    // A query, even an empty one.
    ["https://host.example/tender?x=1", REFUSED.query],
    ["https://host.example?x=1", REFUSED.query],
    ["https://host.example/v1?x=1", REFUSED.query],
    ["https://host.example/tender/v1/?x=1", REFUSED.query],
    ["https://host.example/tender?", REFUSED.query],
    ["https://host.example?", REFUSED.query],
    // A fragment, even an empty one, and a `?` that belongs to it is no query.
    ["https://host.example/tender#top", REFUSED.fragment],
    ["https://host.example#top", REFUSED.fragment],
    ["https://host.example/v1/#top", REFUSED.fragment],
    ["https://host.example/tender#", REFUSED.fragment],
    ["https://host.example#", REFUSED.fragment],
    ["https://host.example/tender#a?b", REFUSED.fragment],
    // A user name or a password, or both, or a host that is another host's user.
    ["https://someone@host.example/tender", REFUSED.user],
    ["https://someone:secret@host.example/tender", REFUSED.user],
    ["https://:secret@host.example/tender", REFUSED.user],
    ["https://someone:@host.example/tender", REFUSED.user],
    ["https://host.example:443@other.example/tender", REFUSED.user],
    ["https://host.example:secret@other.example", REFUSED.user],
    // More than one problem: the user is named first, then the query, then the fragment, then an
    // empty segment, and the repeat last.
    ["https://someone@host.example/x?y#z", REFUSED.user],
    ["https://host.example/x?y#z", REFUSED.query],
    ["https://host.example//x#z", REFUSED.fragment],
    ["https://host.example//x?y", REFUSED.query],
    ["https://host.example/v1/v1?y", REFUSED.query],
    ["https://host.example/v1/v1#z", REFUSED.fragment],
    ["https://host.example//v1/v1", REFUSED.emptySegment],
    ["https://someone@host.example//v1/v1", REFUSED.user],
  ];
  for (const [url, message] of refused) {
    expect(refusalOf(url).message, url).toBe(message);
  }
});

test("whatever_makes_a_base_read_two_ways_is_refused_whichever_base_it_is_added_to", () => {
  const bases = [
    "https://api.example",
    "https://host.example/tender",
    "http://127.0.0.1:8787",
    "http://[::1]:3000/a/b",
  ];
  const additions: Array<[string, string]> = [
    ["/v1/v1", REFUSED.repeated],
    ["/v1/v1/", REFUSED.repeated],
    ["//", REFUSED.emptySegment],
    ["//v1", REFUSED.emptySegment],
    ["/v1//", REFUSED.emptySegment],
    ["/x//y", REFUSED.emptySegment],
    ["?x=1", REFUSED.query],
    ["/?x=1", REFUSED.query],
    ["/v1?x=1", REFUSED.query],
    ["?", REFUSED.query],
    ["/?", REFUSED.query],
    ["#top", REFUSED.fragment],
    ["/#top", REFUSED.fragment],
    ["/v1/#top", REFUSED.fragment],
    ["#", REFUSED.fragment],
    ["/#", REFUSED.fragment],
    ["?x=1#top", REFUSED.query],
  ];
  for (const base of bases) {
    for (const [addition, message] of additions) {
      expect(refusalOf(`${base}${addition}`).message, `${base}${addition}`).toBe(message);
    }
    // A user in front of the host.
    const [scheme, rest] = base.split("//") as [string, string];
    for (const user of ["someone@", "someone:secret@", ":secret@"]) {
      const url = `${scheme}//${user}${rest}`;
      expect(refusalOf(url).message, url).toBe(REFUSED.user);
    }
  }
});

test("text_that_is_no_url_with_a_host_has_no_base", () => {
  const refused = [
    "",
    " ",
    "api.example",
    "/v1",
    "//api.example",
    "https://",
    "http://:8080",
    "https://exa mple.com",
    "file:///tmp/api",
    "data:text/plain,hi",
    "mailto:a@b.example",
    "localhost:8787",
    "tender:///x",
  ];
  for (const url of refused) {
    expect(refusalOf(url).message, url).toBe(REFUSED.noHost);
  }
});

/** A seeded stream of numbers in [0, 1), so that every run tries the same cases. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("any_spelling_is_refused_or_is_one_base_that_is_called_and_signed_for", () => {
  // Spellings made of the pieces a base is spelled with: the case of the scheme and of the host, a
  // user, a port, dot segments (some of them percent-encoded), versions, empty segments, a query, a
  // fragment. Five thousand of them, from a fixed seed. Each is refused with one of the sentences,
  // or it is a base that reads one way: it is its own base, it holds nothing that could be read two
  // ways, and a request to `<base>/v1/...` is made at exactly that address, so that the base that
  // is called and the base that is signed for are the same string.
  const next = seeded(20261030);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const schemes = ["https", "HTTPS", "http", "Http", "tender"];
  const users = ["", "", "", "u@", "u:p@", ":p@", "@"];
  const hosts = [
    "api.test",
    "API.Test",
    "host.example",
    "H",
    "v1",
    "127.0.0.1",
    "[::1]",
    "[0:0:0:0:0:0:0:1]",
    "bücher.example",
    "a.b.",
    "",
    "ex ample",
  ];
  const ports = ["", "", "", ":443", ":80", ":8787", ":", ":0443"];
  const segments = [
    "",
    "v1",
    "V1",
    "v10",
    "xv1",
    "a",
    "A",
    "tender",
    ".",
    "..",
    "%2e",
    "%2E%2e",
    ".%2e",
    "%76%31",
    "x%2Fv1",
    "a b",
    "ü",
    "v1?",
    "%3F",
    "%23",
    "\\",
    "\t",
  ];
  const tails = [
    "",
    "",
    "",
    "",
    "/",
    "//",
    "/v1",
    "/v1/",
    "?",
    "?x=1",
    "#",
    "#t",
    "?x#y",
    "#a?b",
    " ",
  ];
  const spelling = () => {
    const path = Array.from({ length: Math.floor(next() * 5) }, () => `/${pick(segments)}`);
    return `${pick(schemes)}://${pick(users)}${pick(hosts)}${pick(ports)}${path.join("")}${pick(tails)}`;
  };

  const known = Object.values(REFUSED);
  const refusals = new Set<string>();
  let accepted = 0;
  for (let i = 0; i < 5000; i++) {
    const url = spelling();
    let base: string;
    try {
      base = canonicalBase(url);
    } catch (error) {
      const { message } = error as Error;
      expect(known, url).toContain(message);
      refusals.add(message);
      continue;
    }
    accepted++;
    expect(canonicalBase(base), url).toBe(base);
    const afterScheme = base.slice(base.indexOf("//") + 2);
    expect(afterScheme, url).not.toMatch(/[?#@\s]/);
    expect(afterScheme, url).not.toContain("//");
    expect(afterScheme, url).not.toMatch(/\/$|\/v1$/);
    // The parser moves nothing of `<base>/v1/x`: it is called at that address and no other.
    expect(new URL(`${base}/v1/x`).href, url).toBe(`${base}/v1/x`);
    // The scheme and the host in capitals are the same base.
    const capitals = base.replace(/^[a-z]+:\/\/[^/]*/, (head) => head.toUpperCase());
    expect(canonicalBase(capitals), url).toBe(base);
  }
  // The pieces make a fair share of both, and every sentence is met: no kind is tried by a handful.
  expect(accepted).toBeGreaterThan(300);
  expect(accepted).toBeLessThan(4000);
  expect([...refusals].sort()).toEqual([...known].sort());
});

test("a_refusal_names_the_problem_and_does_not_quote_the_url", () => {
  // The URL can hold a password, and the message is read by people and by agents.
  const secret = [
    "https://someone:hunter2@secret.example/x",
    "https://secret.example/x?token=hunter2",
    "https://secret.example/x#hunter2",
    "https://secret.example/hunter2//x",
    "https://secret.example/v1/hunter2/v1/v1",
    "https://someone:hunter2@",
    "hunter2.secret.example",
  ];
  const known = Object.values(REFUSED);
  for (const url of secret) {
    const { message } = refusalOf(url);
    expect(known, url).toContain(message);
    expect(message, url).not.toContain("hunter2");
    expect(message, url).not.toContain("secret.example");
  }
});
