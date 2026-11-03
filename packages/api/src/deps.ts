import type { KeyPermission } from "@tender/client";
import type { Db } from "@tender/db";
import type { NetworkId } from "@tender/shared";
import type { RateLimits } from "./limits";

/**
 * The two chain reads the API makes: the height of the last final block (`/v1/health`) and the
 * permission of an access key (sign-in, and the check that the key of a token is still there).
 * `TenderClient` has both and satisfies this interface; tests pass a fake, so the API
 * type-checks and runs without a chain.
 */
export interface ChainReader {
  /** The height of the last final block. */
  finalHeight(): Promise<bigint>;
  /** The permission of the key `publicKey` on `accountId`, or null when the account has no such key. */
  viewAccessKey(
    accountId: string,
    publicKey: string,
  ): Promise<{ permission: KeyPermission } | null>;
}

/** Everything `createApp` needs. No route reads the environment: the caller resolves it into this. */
export interface ApiDeps {
  db: Db;
  client: ChainReader;
  network: NetworkId;
  /** The Tender contract the indexer follows. */
  contractId: string;
  /**
   * The base URL the API is served at, with no trailing slash. Blob URIs are built from it as it
   * is written, and it is whom every sign-in is signed for (`canonicalBase`: its scheme, host and
   * path, without a trailing `/v1`): a client signs in only if its own base URL names the same, so
   * it has to be the address the clients use, spelled as `canonicalBase` spells it. One that
   * `canonicalBase` refuses (a query, a fragment, a user, `//`, a repeated `/v1` or a dot at the
   * end of the host) cannot be signed for: every challenge fails as a fault.
   */
  publicUrl: string;
  /** Accounts the team runs. Posters and entrants among them are labelled as ours. */
  teamAccounts: string[];
  /**
   * The account the team's Judge signs in as (`JUDGE_ACCOUNT`). Only it may upload a scorecard that
   * carries the Judge's name in `judge.software` (`isJudgeBranded`). When it is not set, every such
   * scorecard is refused.
   */
  judgeAccount?: string;
  /**
   * Origins of the web app, which the browser may call the API from (`PUBLIC_WEB_URL`, split at
   * commas). A trailing slash or a path is dropped. On the sandbox network every origin is
   * allowed whatever this holds; elsewhere an empty list allows none.
   */
  webOrigins: string[];
  /** The Telegram bot's username as in `t.me/<username>`. Without it, linking answers 503. */
  telegramBotUsername?: string;
  /** The current time in nanoseconds since the epoch. Default: the wall clock. */
  now?: () => bigint;
  /**
   * The most event streams (`GET /v1/events`) this process keeps open at once, a whole number from
   * 0. Each one polls the database, so this bounds that load. Past it the answer is a 503 with
   * `Retry-After`, and so it is for a value that is not a number. Default: 200.
   */
  maxSseStreams?: number;
  /**
   * The most event streams one client keeps open at once, a whole number from 0, the client being
   * its address as the rate limits count it (`clientKey`). So one client cannot take the places of
   * all the others. Past it the answer is a 503 with `Retry-After`, and so it is for a value that
   * is not a number. Default: 4.
   */
  maxSseStreamsPerClient?: number;
  /**
   * How many proxies in front of the API add the address they saw to `X-Forwarded-For`
   * (`TRUSTED_PROXY_HOPS`). The rate limits count requests by client address: the socket's when
   * this is 0, the default, and otherwise the header's entry that many places from its end (see
   * `clientKey`).
   */
  trustedProxyHops?: number;
  /** The rate limits, where they differ from `DEFAULT_RATE_LIMITS`. Tests use small ones. */
  rateLimits?: Partial<RateLimits>;
  /**
   * Whether the services are waiting for the chain right now: the indexer, the keeper and the Judge
   * have not started because the node cannot be asked, or is behind the index, and the API serves
   * the index as it is. `GET /v1/health` says so as `waiting_for_chain`, so that a monitor can
   * alert on it. Called on each health request. Default: not waiting.
   */
  waitingForChain?: () => boolean;
}

/** The time, in nanoseconds, that `deps` says it is. */
export function nowNs(deps: Pick<ApiDeps, "now">): bigint {
  return deps.now ? deps.now() : BigInt(Date.now()) * 1_000_000n;
}
