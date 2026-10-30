import type { Page, Route } from "@playwright/test";
import {
  AgentDetailResponseSchema,
  canonicalJson,
  EventMessageSchema,
  ListTasksResponseSchema,
  sha256Hex,
  TaskDetailResponseSchema,
  TenderEventSchema,
} from "@tender/shared";
import { expect, test } from "vitest";
import {
  API_URL,
  type FixtureApi,
  HELDOUT,
  HELDOUT_COMMITMENT,
  pickedPage,
  routeApi,
  TASKS,
  WIDE_ACCOUNT,
} from "../e2e/fixtures";
import { detail, HASH_A } from "./tasks";

// The fixture API of the e2e specs, run without a browser: a spec that fails should have found a
// bug in the page, not in the fixture. A fake page hands the fixture's one route a fake route.

type Fulfill = Parameters<Route["fulfill"]>[0];

function fakePage() {
  let handler: ((route: Route) => Promise<void>) | undefined;
  const onClose: Array<() => void> = [];
  const page = {
    route: async (_url: string, run: (route: Route) => Promise<void>) => {
      handler = run;
    },
    on: (event: string, run: () => void) => {
      if (event === "close") onClose.push(run);
    },
  } as unknown as Page;

  /** Sends a GET to the fixture. `response` settles when the fixture answers. */
  function get(path: string, headers: Record<string, string> = {}) {
    const url = `${API_URL}${path}`;
    let answer: (options: Fulfill) => void = () => {};
    const response = new Promise<NonNullable<Fulfill>>((resolve) => {
      answer = (options) => resolve(options as NonNullable<Fulfill>);
    });
    const route = {
      request: () => ({ method: () => "GET", url: () => url, headers: () => headers }),
      fulfill: async (options: Fulfill) => answer(options),
    } as unknown as Route;
    if (!handler) throw new Error("routeApi has not been called");
    const done = handler(route);
    return { response, done };
  }

  function close() {
    for (const run of onClose) run();
  }

  return { page, get, close };
}

async function fixture() {
  const harness = fakePage();
  const api = await routeApi(harness.page);
  return { ...harness, api };
}

/** The page the fixture serves for task 2. */
function task2(api: FixtureApi) {
  const found = api.details.get("2");
  if (!found) throw new Error("no task 2");
  return found;
}

/** The messages of a stream body: `id`, `event`, `data` and `retry` lines, set apart by blank lines. */
function messages(body: string) {
  return body
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) =>
      Object.fromEntries(
        block.split("\n").map((line) => {
          const colon = line.indexOf(":");
          return [line.slice(0, colon), line.slice(colon + 1).trim()];
        }),
      ),
    );
}

/** Whether a stream request is still unanswered after a moment. */
async function stillHeld(request: { response: Promise<unknown> }) {
  let answered = false;
  void request.response.then(() => {
    answered = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return !answered;
}

// ---- Reads ------------------------------------------------------------------------------------

test("fixture_task_pages_fit_the_api_schema", async () => {
  const { get } = await fixture();

  for (const id of ["1", "2", "3"]) {
    const { response } = get(`/v1/tasks/${id}`);

    const answer = await response;
    expect(answer.status, id).toBe(200);
    const parsed = TaskDetailResponseSchema.safeParse(answer.json);
    expect(parsed.error?.message, id).toBeUndefined();
  }
});

test("fixture_board_fits_the_api_schema_and_narrows_by_phase_and_tag", async () => {
  const { get } = await fixture();

  const all = await get("/v1/tasks").response;
  expect(ListTasksResponseSchema.parse(all.json).tasks).toHaveLength(TASKS.length);
  const none = await get("/v1/tasks?phase=settled").response;
  expect(ListTasksResponseSchema.parse(none.json).tasks).toHaveLength(0);
  const tagged = await get("/v1/tasks?tag=regex").response;
  expect(ListTasksResponseSchema.parse(tagged.json).tasks.map((task) => task.tags)).toEqual([
    expect.arrayContaining(["regex"]),
  ]);
});

test("fixture_serves_the_judge_and_refuses_an_account_it_does_not_know", async () => {
  const { get } = await fixture();

  const judge = await get("/v1/agents/judge.tender-team.testnet").response;
  expect(AgentDetailResponseSchema.safeParse(judge.json).success).toBe(true);
  const nobody = await get("/v1/agents/nobody.testnet").response;
  expect(nobody.status).toBe(404);
});

test("fixture_answers_an_unknown_path_and_task_with_a_404", async () => {
  const { get } = await fixture();

  expect((await get("/v1/nothing").response).status).toBe(404);
  expect((await get("/v1/tasks/999").response).status).toBe(404);
});

test("fixture_commitment_is_the_hash_of_the_held_out_document", () => {
  expect(HELDOUT_COMMITMENT).toBe(sha256Hex(canonicalJson(HELDOUT)));
  expect(HELDOUT_COMMITMENT).toMatch(/^[0-9a-f]{64}$/);
});

test("fixture_wide_task_is_as_wide_as_the_data_can_be", async () => {
  const { api } = await fixture();

  const wide = api.details.get("3");

  expect(wide?.entries[0]?.account).toBe(WIDE_ACCOUNT);
  expect(wide?.task.outcome?.kind).toBe("picked");
  expect(wide?.scorecard?.heldout_commitment).toBe(HELDOUT_COMMITMENT);
});

// ---- What an agent does -----------------------------------------------------------------------

test("fixture_commit_adds_the_entry_and_tells_the_stream", async () => {
  const { api, get } = await fixture();

  api.commit("2", "carol.testnet");

  const page = (await get("/v1/tasks/2").response).json as { entries: Array<{ account: string }> };
  expect(page.entries.map((entry) => entry.account)).toEqual([
    "alice.testnet",
    "bob.testnet",
    "carol.testnet",
  ]);
  const stream = await get("/v1/events", { "last-event-id": "0" }).response;
  const [event] = messages(String(stream.body));
  expect(event?.event).toBe("committed");
});

test("fixture_reveal_gives_the_entry_a_hash_and_an_address", async () => {
  const { api, get } = await fixture();

  api.reveal("2", "alice.testnet", HASH_A);

  const page = TaskDetailResponseSchema.parse((await get("/v1/tasks/2").response).json);
  const alice = page.entries[0];
  expect(alice).toMatchObject({
    revealed: true,
    content_hash: HASH_A,
    uri: `${API_URL}/v1/blobs/${HASH_A}`,
  });
  expect(page.task.reveal_count).toBe(1);
});

test("fixture_settle_replaces_the_page_and_tells_the_stream", async () => {
  const { api, get } = await fixture();

  api.settle(pickedPage(task2(api)));

  const page = TaskDetailResponseSchema.parse((await get("/v1/tasks/2").response).json);
  expect(page.task.outcome?.kind).toBe("picked");
  const stream = await get("/v1/events", { "last-event-id": "0" }).response;
  expect(messages(String(stream.body))[0]?.event).toBe("picked");
});

test("fixture_events_fit_the_event_schemas_the_page_listens_with", async () => {
  const { api, get } = await fixture();
  api.commit("2", "carol.testnet");
  api.reveal("2", "alice.testnet", HASH_A);
  api.settle(pickedPage(task2(api)));
  const voidedPage = detail({
    id: "1",
    phase: "settled",
    outcome_kind: "voided",
    outcome: {
      kind: "voided",
      task_id: "1",
      reason: "expired",
      by: null,
      refunds: [{ account: "poster.tender-team.testnet", amount: "500000" }],
      scorecard_hash: null,
      scorecard_uri: null,
    },
  });
  api.settle(voidedPage);

  const stream = await get("/v1/events", { "last-event-id": "0" }).response;

  const sent = messages(String(stream.body)).filter((message) => message.event !== undefined);
  expect(sent.map((message) => message.event)).toEqual([
    "committed",
    "revealed",
    "picked",
    "voided",
  ]);
  for (const message of sent) {
    const envelope = EventMessageSchema.parse(JSON.parse(message.data ?? ""));
    const known = TenderEventSchema.safeParse({ event: envelope.event, data: envelope.data });
    expect(known.error?.message, message.event).toBeUndefined();
    expect(envelope.task_id).not.toBeNull();
  }
});

// ---- The stream -------------------------------------------------------------------------------

test("fixture_stream_opens_at_once_and_sends_nothing_from_before", async () => {
  const { api, get } = await fixture();
  api.commit("2", "carol.testnet");

  const answer = await get("/v1/events").response;

  expect(answer.status).toBe(200);
  expect((answer.headers as Record<string, string>)["content-type"]).toBe("text/event-stream");
  // Nothing from before: only that the stream is open, and when to ask again.
  expect(String(answer.body)).toBe(": open\nretry: 100\n\n");
});

test("fixture_stream_holds_until_an_event_after_the_id_it_is_given", async () => {
  const { api, get } = await fixture();
  const held = get("/v1/events", { "last-event-id": "0" });
  expect(await stillHeld(held)).toBe(true);

  api.commit("2", "carol.testnet");

  const answer = await held.response;
  const [event] = messages(String(answer.body));
  expect(event).toMatchObject({ id: "1", event: "committed" });
  expect(JSON.parse(event?.data ?? "").task_id).toBe("2");
  // Asked again from that id, it holds again.
  expect(await stillHeld(get("/v1/events", { "last-event-id": "1" }))).toBe(true);
});

test("fixture_stream_resumes_a_browser_whose_last_event_id_a_route_cannot_see", async () => {
  const { api, get } = await fixture();
  api.commit("2", "carol.testnet");
  await get("/v1/events").response;

  // The browser comes back after the stream's `retry:`, and the request shows no id.
  const reconnect = get("/v1/events");
  // It is told what it has not seen, and not what came before it first asked.
  expect(await stillHeld(reconnect)).toBe(true);
  api.commit("2", "dave.testnet");
  api.commit("2", "erin.testnet");
  const first = await reconnect.response;
  expect(
    messages(String(first.body))
      .filter((m) => m.event)
      .map((m) => m.id),
  ).toEqual(["2", "3"]);

  // And again, from where that response left it.
  const again = get("/v1/events");
  expect(await stillHeld(again)).toBe(true);
  api.commit("2", "frank.testnet");
  const next = await again.response;
  expect(
    messages(String(next.body))
      .filter((m) => m.event)
      .map((m) => m.id),
  ).toEqual(["4"]);
});

test("fixture_counts_the_streams_it_is_holding", async () => {
  const { api, get } = await fixture();
  expect(api.heldStreams()).toBe(0);

  const first = get("/v1/events", { "last-event-id": "0" });
  const second = get("/v1/events", { "last-event-id": "0" });
  expect(api.heldStreams()).toBe(2);
  api.commit("2", "carol.testnet");
  await Promise.all([first.response, second.response]);

  expect(api.heldStreams()).toBe(0);
});

test("fixture_stream_resumes_from_a_since_parameter_too", async () => {
  const { api, get } = await fixture();
  api.commit("2", "carol.testnet");
  api.commit("2", "dave.testnet");

  const answer = await get("/v1/events?since=1").response;

  expect(
    messages(String(answer.body))
      .filter((m) => m.event)
      .map((m) => m.id),
  ).toEqual(["2"]);
});

test("fixture_stream_can_be_refused_with_a_retry_after_and_served_again", async () => {
  const { api, get } = await fixture();
  api.refuseStreams(7);

  const refused = await get("/v1/events").response;

  expect(refused.status).toBe(503);
  const headers = refused.headers as Record<string, string>;
  expect(headers["retry-after"]).toBe("7");
  // The page's script can read it only if the response says so.
  expect(headers["access-control-expose-headers"]).toBe("Retry-After");

  api.acceptStreams();
  expect((await get("/v1/events").response).status).toBe(200);
});

test("fixture_lets_a_held_stream_go_when_the_page_closes", async () => {
  const { get, close } = await fixture();
  const held = get("/v1/events", { "last-event-id": "0" });

  close();

  // The route settles, and answers into the page that is gone, which does nothing.
  await expect(held.done).resolves.toBeUndefined();
});
