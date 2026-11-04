import { createServer } from "node:net";
import { ApiError } from "@tender/shared";
import { expect, test } from "vitest";
import { ApiClient, ApiTimeoutError, ApiUnreachableError, fetchNamingApi } from "../src/index";

// `fetchNamingApi`: an API client whose request gets no answer says which address it went to, in
// place of the bare "fetch failed" that `fetch` gives. Against a real closed port, and fakes.

/** A port on this machine that nothing listens on: one the system gave out a moment ago. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

test("a_request_nothing_answers_names_the_base_and_the_code", async () => {
  const base = `http://127.0.0.1:${await closedPort()}`;
  const api = new ApiClient({ baseUrl: `${base}/v1/`, fetchImpl: fetchNamingApi(`${base}/v1/`) });
  const failure = await api.listTasks().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ApiUnreachableError);
  expect((failure as ApiUnreachableError).message).toBe(
    `could not reach the Tender API at ${base} (fetch failed, ECONNREFUSED)`,
  );
  // The base as `canonicalBase` has it, and `fetch`'s own error under it.
  expect((failure as ApiUnreachableError).base).toBe(base);
  expect((failure as ApiUnreachableError).cause).toBeInstanceOf(TypeError);
});

test("without_it_the_error_is_fetchs_own", async () => {
  const base = `http://127.0.0.1:${await closedPort()}`;
  const failure = await new ApiClient({ baseUrl: base }).listTasks().catch((error) => error);
  expect(failure).toBeInstanceOf(TypeError);
  expect(failure).not.toBeInstanceOf(ApiUnreachableError);
});

test("an_answer_a_timeout_and_other_failures_are_left_as_they_are", async () => {
  const base = "https://api.test";
  // An answer, even a refusal, is the API's: an `ApiError`, as without the wrapper.
  const refused = new ApiClient({
    baseUrl: base,
    fetchImpl: fetchNamingApi(base, async () => new Response("{}", { status: 500 })),
  });
  await expect(refused.health()).rejects.toBeInstanceOf(ApiError);

  // A request cut by its timeout is the client's `ApiTimeoutError`, and the abort that `fetch`
  // throws for it is not taken for an address that did not answer.
  let seen: unknown;
  const waits: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new TypeError("aborted")));
    });
  const naming = fetchNamingApi(base, waits);
  const slow = new ApiClient({
    baseUrl: base,
    timeoutMs: 20,
    fetchImpl: (input, init) =>
      naming(input, init).catch((error: unknown) => {
        seen = error;
        throw error;
      }),
  });
  await expect(slow.health()).rejects.toBeInstanceOf(ApiTimeoutError);
  await expect.poll(() => seen).toBeInstanceOf(TypeError);
  expect(seen).not.toBeInstanceOf(ApiUnreachableError);

  // A failure that is not the network's is passed on.
  const odd = new Error("not the network");
  const broken = new ApiClient({
    baseUrl: base,
    fetchImpl: fetchNamingApi(base, async () => {
      throw odd;
    }),
  });
  await expect(broken.health()).rejects.toBe(odd);
});
