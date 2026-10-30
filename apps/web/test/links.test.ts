import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useNowNs } from "../lib/clock";
import { linkHost, safeHref } from "../lib/links";

afterEach(() => {
  vi.useRealTimers();
});

// ---- Links ------------------------------------------------------------------------------------

test("safe_href_takes_http_and_https_addresses", () => {
  expect(safeHref("https://api.test/v1/blobs/abc")).toBe("https://api.test/v1/blobs/abc");
  expect(safeHref("http://localhost:3003/v1/blobs/abc?x=1#y")).toBe(
    "http://localhost:3003/v1/blobs/abc?x=1#y",
  );
});

test("safe_href_refuses_anything_that_can_run_script_or_leave_the_web", () => {
  // A `uri` is text any entrant writes. Put into an href, one of these would run in this page's
  // origin when clicked, or hand the browser something it renders itself.
  for (const uri of [
    "javascript:alert(document.cookie)",
    "JaVaScRiPt:alert(1)",
    "  javascript:alert(1)",
    "\tjavascript:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "blob:https://api.test/1234",
    "file:///etc/passwd",
    "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    "ftp://api.test/x",
  ]) {
    expect(safeHref(uri), uri).toBeUndefined();
  }
});

test("safe_href_refuses_text_that_is_no_absolute_address", () => {
  for (const uri of ["", "   ", "not a url", "/v1/blobs/abc", "//evil.test/x", "abc"]) {
    expect(safeHref(uri), JSON.stringify(uri)).toBeUndefined();
  }
});

test("safe_href_hands_back_the_address_as_a_browser_reads_it", () => {
  // Surrounding whitespace is dropped by the URL parser, and the result is what an href gets.
  expect(safeHref("  https://api.test/a b  ")).toBe("https://api.test/a%20b");
});

test("link_host_names_where_a_link_goes", () => {
  expect(linkHost("https://api.test/v1/blobs/abc")).toBe("api.test");
  expect(linkHost("http://localhost:3003/x")).toBe("localhost:3003");
  expect(linkHost("javascript:alert(1)")).toBeUndefined();
});

// ---- The clock --------------------------------------------------------------------------------

test("use_now_ns_reads_the_clock_in_nanoseconds_and_ticks_each_second", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-10-30T10:00:00.000Z"));
  const { result } = renderHook(() => useNowNs());
  const start = BigInt(Date.parse("2026-10-30T10:00:00.000Z")) * 1_000_000n;
  expect(result.current).toBe(start);
  // A nanosecond count is above 2^53: it has to be a bigint to be exact.
  expect(typeof result.current).toBe("bigint");

  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(result.current).toBe(start + 1_000_000_000n);
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(result.current).toBe(start + 3_000_000_000n);
});

test("use_now_ns_stops_ticking_when_the_page_goes", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const { unmount } = renderHook(() => useNowNs());

  unmount();

  expect(vi.getTimerCount()).toBe(0);
});
