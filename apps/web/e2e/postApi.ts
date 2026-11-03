import type { Page } from "@playwright/test";
import { SIGN_IN_MESSAGE, sha256Hex, type TaskDetailResponse } from "@tender/shared";
import type { FakeChain, FakeTask } from "../test/fakeChain";
import { detail } from "../test/tasks";
import { API_URL } from "./fixtures";

// The writes of the post wizard against the fixture API (e2e/fixtures.ts, whose routes answer
// reads only): the sign-in, the uploads, and the task page of a task the wizard has posted. It is
// registered after `routeApi`, so that it is asked first, and hands every request it has no
// answer for back to it (`route.fallback()`).
//
// The API keeps what it is sent and checks what the real one checks of it: that the token is one it
// issued, that the signed sign-in is the challenge it gave, and that a held-out document is the one
// its commitment names. A task page is built from the task on the model chain and the documents
// that were uploaded, so that the page the wizard opens is the task the person wrote.

const CORS = { "access-control-allow-origin": "*" };
/** `authorization` is not covered by a `*`, so the preflight names what the page sends. */
const PREFLIGHT = {
  ...CORS,
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

/** The 32 bytes of the nonce, in base64 as the API writes one. */
const NONCE = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString("base64");

interface Upload {
  /** The bearer token the request came with. */
  token: string | null;
  text: string;
  bytes: Uint8Array;
}

export interface PostApi {
  /** Every write the page made, as `POST /v1/blobs`. */
  requests: string[];
  blobs: Array<Upload & { kind: string; sha256: string }>;
  heldouts: Array<Upload & { commitment: string }>;
  /** The tokens issued, in order. */
  tokens: string[];
  challenges: number;
}

/**
 * Answers the writes of the wizard for `page`, and `GET /v1/tasks/:id` for the tasks that `chain`
 * holds whose brief and criteria were uploaded. A path it does not know goes to the fixture.
 */
export async function routePostApi(page: Page, chain: FakeChain): Promise<PostApi> {
  const api: PostApi = { requests: [], blobs: [], heldouts: [], tokens: [], challenges: 0 };

  /** A task of the chain as the API shows it: open, with no entries, and its documents. */
  function pageOf(task: FakeTask): TaskDetailResponse | null {
    const brief = api.blobs.find(({ sha256 }) => sha256 === task.briefHash);
    const criteria = api.blobs.find(({ sha256 }) => sha256 === task.criteriaHash);
    if (brief === undefined || criteria === undefined) return null;
    const parsedBrief = JSON.parse(brief.text) as NonNullable<TaskDetailResponse["brief"]>;
    return detail(
      {
        id: task.id.toString(),
        title: parsedBrief.title,
        category: parsedBrief.category,
        tags: parsedBrief.tags,
        token: task.token,
        reward: task.reward.toString(),
        phase: "open",
        poster: task.poster,
        verifier: task.verifier,
        created_at: task.createdAt.toString(),
        commit_deadline: task.commitDeadline.toString(),
        reveal_deadline: task.revealDeadline.toString(),
        pick_deadline: task.pickDeadline.toString(),
        fallback_deadline: task.fallbackDeadline.toString(),
        commit_count: 0,
        reveal_count: 0,
        working_count: 0,
        judge_status: null,
        judge_reason: null,
        is_team_poster: false,
        parent: null,
        outcome_kind: null,
        brief_uri: task.briefUri,
        brief_hash: task.briefHash,
        criteria_hash: task.criteriaHash,
        heldout_commitment: task.heldoutCommitment,
        max_entries: task.maxEntries,
        max_winners: task.maxWinners,
        invited: task.invited,
        fee_bps: task.feeBps,
        outcome: null,
      },
      {
        brief: parsedBrief,
        criteria: JSON.parse(criteria.text) as TaskDetailResponse["criteria"],
        entries: [],
        funders: [{ account: task.poster, amount: task.reward.toString() }],
      },
    );
  }

  await page.route(`${API_URL}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, json: body, headers: CORS });

    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: PREFLIGHT });
      return;
    }

    if (request.method() === "GET") {
      const wanted = /^\/v1\/tasks\/(\d+)$/.exec(url.pathname);
      const task = wanted === null ? undefined : chain.tasks.get(BigInt(wanted[1] ?? "0"));
      const found = task === undefined ? null : pageOf(task);
      if (found === null) await route.fallback();
      else await json(200, found);
      return;
    }

    api.requests.push(`${request.method()} ${url.pathname}`);
    const body = (request.postDataJSON() ?? {}) as Record<string, string>;
    const token = (await request.allHeaders()).authorization?.replace(/^Bearer /, "") ?? null;
    const unauthorized = () => json(401, { error: "unauthorized", message: "Sign in again." });

    switch (url.pathname) {
      case "/v1/auth/challenge":
        api.challenges++;
        return json(200, {
          nonce: NONCE,
          message: SIGN_IN_MESSAGE,
          recipient: API_URL,
          expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        });

      case "/v1/auth/verify": {
        // What the wallet was asked to sign is what the API issued, for the account that signed.
        const signedWhatWasIssued =
          body.nonce === NONCE &&
          body.message === SIGN_IN_MESSAGE &&
          body.recipient === API_URL &&
          typeof body.account_id === "string" &&
          typeof body.public_key === "string" &&
          typeof body.signature === "string" &&
          body.signature !== "";
        if (!signedWhatWasIssued)
          return json(400, { error: "bad_request", message: "Not signed." });
        const issued = `tok-${body.account_id}-${api.tokens.length + 1}`;
        api.tokens.push(issued);
        return json(200, {
          token: issued,
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          key_kind: "full_access",
        });
      }

      case "/v1/blobs":
      case "/v1/heldout": {
        if (token === null || !api.tokens.includes(token)) return unauthorized();
        const bytes = new Uint8Array(Buffer.from(body.content_base64 ?? "", "base64"));
        const upload = { token, bytes, text: new TextDecoder().decode(bytes) };
        const sha256 = sha256Hex(bytes);
        if (url.pathname === "/v1/blobs") {
          api.blobs.push({ ...upload, kind: body.kind ?? "", sha256 });
          return json(200, { sha256, uri: `${API_URL}/v1/blobs/${sha256}` });
        }
        // A held-out document is stored under the hash it commits to, or not at all.
        if (sha256 !== body.commitment) {
          return json(400, { error: "bad_request", message: "The hash does not match." });
        }
        api.heldouts.push({ ...upload, commitment: sha256 });
        return json(200, { ok: true });
      }

      default:
        return json(404, { error: "not_found", message: "no such route" });
    }
  });

  return api;
}
