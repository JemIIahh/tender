import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library unmounts after each test by itself only when vitest runs with `globals: true`.
afterEach(cleanup);

// The tab's shared read of the platform's figures (lib/liveReads.ts) keeps its last value for a
// minute, and the tab's one event stream (lib/events.ts) lives while anything listens: each test
// starts without either. They are imported here only after the test, so that a test file's
// `vi.mock` of what they import still applies (a module this file imports at its top is loaded
// before the test file's mocks).
afterEach(async () => {
  const [{ liveReads }, { closeTabStream }] = await Promise.all([
    import("./lib/liveReads"),
    import("./lib/events"),
  ]);
  liveReads.clear();
  closeTabStream();
});
