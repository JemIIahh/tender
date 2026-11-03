import { ApiError } from "@tender/shared";
import { walletErrorMessage } from "./walletErrors";

// The link to the Tender bot. The API makes it (`POST /v1/telegram/link`) and the Telegram page
// opens it, so it is an address from a server that the page does not take on trust: it is opened
// only if it is exactly `https://t.me/<bot>?start=<code>`, and what is opened is rebuilt from the
// parts that were checked and not the text that came. The code in it is a secret until it is spent
// (the bot spends it), so nothing here puts it in a message.

/** A bot's username: 5 to 32 letters, digits and underscores, the first a letter (Telegram's rule). */
const BOT = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

/** What follows `?start=` in a deep link: 1 to 64 characters from `A-Za-z0-9_-` (Telegram's rule). */
const START = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The address to open for `value`, or null if `value` is not `https://t.me/<bot>?start=<code>`: the
 * scheme, the host and the path are exactly those, with no port, user name, password or fragment, and
 * the query is `start` and nothing else.
 */
export function telegramStartUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "t.me") return null;
  if (url.port !== "" || url.username !== "" || url.password !== "" || url.hash !== "") return null;

  const bot = url.pathname.slice(1);
  if (!BOT.test(bot)) return null;

  const query = [...url.searchParams];
  const [name, code] = query[0] ?? [];
  if (query.length !== 1 || name !== "start" || code === undefined || !START.test(code)) {
    return null;
  }
  return `https://t.me/${bot}?start=${code}`;
}

/** The API made a link that is not a Telegram start link. It says nothing of the address. */
export class TelegramLinkRefused extends Error {
  constructor() {
    super("the API's Telegram link is not a t.me start link");
    this.name = "TelegramLinkRefused";
  }
}

/** Plain words for why a Telegram link was not made or not opened. */
export function telegramLinkMessage(error: unknown): string {
  if (error instanceof TelegramLinkRefused) {
    return "Tender sent a link that is not a Telegram link, so it was not opened.";
  }
  // The API answers 503 when it has no bot to link to; asking again changes nothing.
  if (error instanceof ApiError && error.status === 503) {
    return "Telegram linking isn't available on this server.";
  }
  return walletErrorMessage(error);
}
