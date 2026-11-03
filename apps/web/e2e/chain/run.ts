import { readFileSync } from "node:fs";

// What the setup of the chain suite tells its specs. The setup writes it to a file in the run's own
// temp dir (never to the repository) and sets RUN_FILE_VARIABLE to the file's path; the workers
// that run the specs inherit the variable, and read the file here. No key is in it: the specs act
// through the page, and read the chain and the API, which need none.

/** The variable that holds the path of the run's file. */
export const RUN_FILE_VARIABLE = "TENDER_CHAIN_E2E_RUN_FILE";

/**
 * The port of the web server: `WEB_PORT`, as the fixture suite reads it, and 3000 if it is not set.
 * Each lane runs its own server on its own port.
 */
export function webPort(): number {
  const text = process.env.WEB_PORT || "3000";
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`WEB_PORT must be a port number, got ${JSON.stringify(text)}`);
  }
  return port;
}

export interface RunSeed {
  slug: string;
  /** The task's id on the chain, as a decimal string. */
  taskId: string;
  /** The title of the seed's brief, which the board and the task page show. */
  title: string;
}

export interface RunInfo {
  /** Where the web server listens, as the browser calls it: `http://localhost:<port>`. */
  webUrl: string;
  /** The API's base URL, in the spelling the sign-in is bound to. The web app is built for it. */
  apiUrl: string;
  /** The local chain's JSON-RPC endpoint. */
  rpcUrl: string;
  contractId: string;
  /** The test token. */
  tokenId: string;
  /** The Judge's account, which the post wizard offers as the verifier. */
  judge: string;
  /** The account that posted the seeds, and that the services count as the team's. */
  poster: string;
  /** The account the dev wallet signs as: new, and set up with nothing at Tender. */
  dev: string;
  /** An account registered as an agent, whose page the specs look at. */
  agent: string;
  /** The bot the Telegram links name. */
  botUsername: string;
  seeds: RunSeed[];
}

/** The run the setup made, for a spec. Throws, naming the variable, where there is none. */
export function loadRun(): RunInfo {
  const file = process.env[RUN_FILE_VARIABLE];
  if (file === undefined || file === "") {
    throw new Error(`${RUN_FILE_VARIABLE} is not set: the specs run only after the global setup`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as RunInfo;
}
