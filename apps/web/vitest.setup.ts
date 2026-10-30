import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library unmounts after each test by itself only when vitest runs with `globals: true`.
afterEach(cleanup);
