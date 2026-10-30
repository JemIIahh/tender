import { ApiError } from "@tender/shared";
import { expect, test } from "vitest";
import { errorMessage } from "../lib/errors";
import { RpcError } from "../lib/rpc";

test("error_message_gives_the_apis_own_words_for_a_refusal", () => {
  const body = {
    error: "not_open",
    message: "only an open task can be started, and this one is judging",
  };

  expect(errorMessage(new ApiError(409, body))).toBe(body.message);
});

test("error_message_does_not_pass_on_a_server_fault_as_the_apis_words", () => {
  const message = errorMessage(
    new ApiError(503, { error: "unavailable", message: "db down at 10.0.3.7" }),
  );

  expect(message).toContain("503");
  expect(message).not.toContain("10.0.3.7");
});

test("error_message_names_a_status_when_the_body_is_not_the_apis", () => {
  // A proxy's page, or a text.
  expect(errorMessage(new ApiError(502, "<html>Bad Gateway</html>"))).toContain("502");
  expect(errorMessage(new ApiError(404, "not found"))).toContain("404");
});

test("error_message_says_so_when_the_apis_answer_is_unreadable", () => {
  const message = errorMessage(new ApiError(200, { tasks: "none" }, "does not fit its schema"));

  expect(message).toMatch(/can't read/i);
  expect(message).not.toContain("schema");
});

test("error_message_for_a_failed_request", () => {
  expect(errorMessage(new TypeError("Failed to fetch"))).toMatch(/can't reach/i);
  expect(errorMessage("a string")).toMatch(/can't reach/i);
  expect(errorMessage(undefined)).toMatch(/can't reach/i);
});

test("error_message_for_the_chain_is_about_its_answer_and_not_about_an_outage", () => {
  // Each of these is an answer: the node refused, the contract panicked, the result did not read.
  for (const reason of [
    "the RPC node answered with status 429",
    "wasm execution failed with error: FunctionCallError(HostError(GuestPanic",
    "get_task returned text that is not JSON",
  ]) {
    const message = errorMessage(new RpcError(reason));

    expect(message, reason).toMatch(/NEAR/);
    expect(message, reason).toMatch(/answer/i);
    expect(message, reason).not.toMatch(/did not answer|down|unavailable|reach/i);
    // The node's own words are for the console, not for a reader.
    expect(message, reason).not.toContain(reason);
  }
});

test("error_message_for_a_request_that_took_too_long", () => {
  const timeout = new DOMException("no answer", "TimeoutError");

  expect(errorMessage(timeout)).toMatch(/too long/i);
});
