import { expect, test } from "vitest";
import { runLocalX402Example } from "../example/local";

test("an agent discovers an ASP service and pays for its API response on a real local chain", async () => {
  const result = await runLocalX402Example(() => {});
  expect(result).toMatchObject({ passed: true, amount: "1000", settlements: 1, responses: 1 });
  expect(result.transaction).toBeTruthy();
});
