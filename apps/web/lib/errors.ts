import { ApiError, ErrorBodySchema } from "@tender/shared";
import { RpcError } from "./rpc";

/** What to tell a person about a refused request: the API's own words, or else its status. */
function apiErrorMessage(error: ApiError): string {
  // A 2xx the client could not use: the body is not JSON, or not the shape the API promises.
  if (error.status < 300) return "The Tender API sent an answer this page can't read.";
  // A refusal says why in words for people (`ErrorBody.message`). A server fault may say more than
  // a reader should see, so it is only given a status.
  const body = ErrorBodySchema.safeParse(error.body);
  if (error.status < 500) {
    return body.success
      ? body.data.message
      : `The Tender API refused the request (status ${error.status}).`;
  }
  return `The Tender API had a problem (status ${error.status}). Try again in a moment.`;
}

/** Plain words for why a request failed, for an `ErrorState`. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return apiErrorMessage(error);
  if (error instanceof RpcError) return "The NEAR network did not answer. Try again in a moment.";
  if ((error as { name?: unknown } | null)?.name === "TimeoutError") {
    return "That took too long. Check your connection and try again.";
  }
  // `fetch` rejects with a TypeError when the network is down or the server refuses the connection.
  return "Can't reach the server. Check your connection and try again.";
}
