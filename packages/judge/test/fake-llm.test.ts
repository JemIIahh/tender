import OpenAI from "openai";
import { expect, test } from "vitest";
import { completion, gradeJson, startFakeLlm } from "./fake-llm";

// The fake model server that the rubric tests rely on has to be what it says: an OpenAI-compatible
// server that the real client can talk to, that keeps to the loopback, and that cannot hold a test
// up.

test("the_fake_answers_the_openai_client_and_records_what_it_was_sent", async () => {
  const llm = await startFakeLlm((_request, nth) => ({ json: completion(`answer ${nth}`) }));
  const client = new OpenAI({
    baseURL: llm.baseUrl,
    apiKey: "sk-fake-test-key",
    defaultHeaders: { "x-no-aliasing": "true" },
    maxRetries: 0,
  });

  const reply = await client.chat.completions.create({
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    temperature: 0,
  });

  expect(reply.choices[0]?.message.content).toBe("answer 1");
  expect(llm.requests).toHaveLength(1);
  const [request] = llm.requests;
  expect(request).toMatchObject({
    method: "POST",
    path: "/v1/chat/completions",
    user: "hello",
    body: { model: "test-model", temperature: 0 },
  });
  expect(request?.headers).toMatchObject({
    authorization: "Bearer sk-fake-test-key",
    "x-no-aliasing": "true",
  });
});

test("the_fake_listens_on_the_loopback_and_reads_a_rubric_from_a_request", async () => {
  const llm = await startFakeLlm((request) => ({
    json: completion(gradeJson(request, (criterion) => criterion.length)),
  }));
  expect(llm.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);

  const response = await fetch(`${llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [
        {
          role: "user",
          content: [
            "Rubric:",
            JSON.stringify({ criterion: "clear", weight: 2 }),
            JSON.stringify({ criterion: "short", weight: 1 }),
            "<entry>",
            "the text",
            "</entry>",
          ].join("\n"),
        },
      ],
    }),
  });

  const body = (await response.json()) as { choices: { message: { content: string } }[] };
  expect(JSON.parse(body.choices[0]?.message.content ?? "")).toEqual({
    scores: [
      { criterion: "clear", score: 5, reason: "clear earned 5" },
      { criterion: "short", score: 5, reason: "short earned 5" },
    ],
    addresses_grader: false,
  });
});

test("a_stalled_request_does_not_hold_the_fake_up_when_it_closes", async () => {
  const llm = await startFakeLlm(() => "stall");

  // The request is received and never answered; the client gives up on it.
  await expect(
    fetch(`${llm.baseUrl}/chat/completions`, {
      method: "POST",
      body: "{}",
      signal: AbortSignal.timeout(150),
    }),
  ).rejects.toMatchObject({ name: "TimeoutError" });
  expect(llm.requests).toHaveLength(1);

  // Closing ends every connection, so it settles, and a second close is the same close.
  await llm.close();
  await llm.close();
});
