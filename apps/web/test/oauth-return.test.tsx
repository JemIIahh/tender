import { render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { RETURN_PAGE_KEY } from "../lib/lastWay";

// The landing's part that sends a person back from Google on to the page they started on
// (components/landing/OAuthReturn.tsx). Google comes back to the site's root with Privy's three
// parameters; the page kept in the tab is where the login ends.

afterEach(() => {
  window.history.replaceState({}, "", "/");
  sessionStorage.clear();
  vi.resetModules();
});

/** The part, fresh: it sends a person on once per page load. */
async function freshPart() {
  vi.resetModules();
  return (await import("../components/landing/OAuthReturn")).OAuthReturn;
}

test("back_from_google_the_landing_sends_the_person_on_to_their_page_once", async () => {
  const OAuthReturn = await freshPart();
  sessionStorage.setItem(RETURN_PAGE_KEY, "/wallet?from=x");
  window.history.replaceState(
    {},
    "",
    "/?privy_oauth_code=c&privy_oauth_state=s&privy_oauth_provider=google",
  );
  const went: string[] = [];
  // In development React runs the effect twice: the person is sent on once, to their page.
  render(
    <StrictMode>
      <OAuthReturn go={(address) => went.push(address)} />
    </StrictMode>,
  );
  expect(went).toEqual([
    "/wallet?from=x&privy_oauth_code=c&privy_oauth_state=s&privy_oauth_provider=google",
  ]);
  expect(sessionStorage.getItem(RETURN_PAGE_KEY)).toBeNull();
});

test("any_other_visit_to_the_landing_goes_nowhere_and_leaves_the_kept_page", async () => {
  const OAuthReturn = await freshPart();
  sessionStorage.setItem(RETURN_PAGE_KEY, "/wallet");
  window.history.replaceState({}, "", "/?tag=x");
  const went: string[] = [];
  render(<OAuthReturn go={(address) => went.push(address)} />);
  expect(went).toEqual([]);
  expect(sessionStorage.getItem(RETURN_PAGE_KEY)).toBe("/wallet");
});
