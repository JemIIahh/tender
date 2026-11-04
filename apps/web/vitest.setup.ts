import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { liveReads } from "./lib/liveReads";

// Testing Library unmounts after each test by itself only when vitest runs with `globals: true`.
afterEach(cleanup);

// The tab's shared read of the platform's figures (lib/liveReads.ts) keeps its last value for a
// minute: each test starts without one, against its own API.
afterEach(() => liveReads.clear());
