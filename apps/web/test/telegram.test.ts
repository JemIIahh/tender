import { ApiError } from "@tender/shared";
import { expect, test } from "vitest";
import { TelegramLinkRefused, telegramLinkMessage, telegramStartUrl } from "../lib/telegram";
import { WALLET_CANNOT_SIGN_MESSAGE, WalletCannotSign } from "../lib/walletErrors";

// The address the Telegram page opens (lib/telegram.ts) comes from the API, which the page does not
// take on trust: it opens `https://t.me/<bot>?start=<code>` and nothing else. The API makes the
// code from 16 random bytes in base64url, 22 characters.

const CODE = "q3Zk_8-nP0aXw2YtLmB5Rg";
const LINK = `https://t.me/tender_bot?start=${CODE}`;

test("a_start_link_the_api_makes_is_opened_as_it_is", () => {
  expect(telegramStartUrl(LINK)).toBe(LINK);
});

test("a_start_link_is_opened_in_the_form_it_is_rebuilt_in", () => {
  // The scheme and the host are read as a browser reads them, and what is opened is written out
  // again from the parts that passed.
  expect(telegramStartUrl(`HTTPS://T.ME/tender_bot?start=${CODE}`)).toBe(LINK);
  expect(telegramStartUrl(`https://t.me:443/tender_bot?start=${CODE}`)).toBe(LINK);
  expect(telegramStartUrl(`  ${LINK}\n`)).toBe(LINK);
  // A fragment with nothing in it is not in what is opened.
  expect(telegramStartUrl(`${LINK}#`)).toBe(LINK);
});

test("an_address_that_is_not_a_t_me_start_link_is_refused", () => {
  for (const address of [
    // Not https, not Telegram's own host.
    `http://t.me/tender_bot?start=${CODE}`,
    `https://telegram.me/tender_bot?start=${CODE}`,
    `https://t.me.evil.test/tender_bot?start=${CODE}`,
    `https://evilt.me/tender_bot?start=${CODE}`,
    `https://t.me./tender_bot?start=${CODE}`,
    `https://evil.test/tender_bot?start=${CODE}`,
    // The host is not what comes first in the text.
    `https://t.me@evil.test/tender_bot?start=${CODE}`,
    `https://user:pass@t.me/tender_bot?start=${CODE}`,
    `https://t.me\\@evil.test/tender_bot?start=${CODE}`,
    `https://t.me:8443/tender_bot?start=${CODE}`,
    // Not a script, a file or an app.
    "javascript:alert(document.cookie)",
    `JaVaScRiPt:alert(1)//t.me/tender_bot?start=${CODE}`,
    "data:text/html,<script>alert(1)</script>",
    `tg://resolve?domain=tender_bot&start=${CODE}`,
    "file:///etc/passwd",
    // Not an absolute address.
    `//t.me/tender_bot?start=${CODE}`,
    `t.me/tender_bot?start=${CODE}`,
    "",
    "   ",
    "not a url",
  ]) {
    expect(telegramStartUrl(address), address).toBeNull();
  }
});

test("only_a_bot_s_start_link_with_nothing_added_is_opened", () => {
  for (const address of [
    // The path is the bot and nothing else.
    `https://t.me/tender_bot/?start=${CODE}`,
    `https://t.me/tender_bot/extra?start=${CODE}`,
    `https://t.me/s/tender_bot?start=${CODE}`,
    `https://t.me/?start=${CODE}`,
    `https://t.me?start=${CODE}`,
    // The query is `start` once and nothing else.
    "https://t.me/tender_bot",
    "https://t.me/tender_bot?",
    `https://t.me/tender_bot?start=${CODE}&start=${CODE}`,
    `https://t.me/tender_bot?start=${CODE}&startgroup=1`,
    `https://t.me/tender_bot?startgroup=${CODE}`,
    `https://t.me/tender_bot?START=${CODE}`,
    `https://t.me/tender_bot?x=1&start=${CODE}`,
    // No fragment.
    `https://t.me/tender_bot?start=${CODE}#frag`,
  ]) {
    expect(telegramStartUrl(address), address).toBeNull();
  }
});

test("a_start_code_is_one_to_sixty_four_url_safe_characters", () => {
  const at = (code: string) => telegramStartUrl(`https://t.me/tender_bot?start=${code}`);

  expect(at("a")).toBe("https://t.me/tender_bot?start=a");
  expect(at("A-z_0-9")).toBe("https://t.me/tender_bot?start=A-z_0-9");
  expect(at("a".repeat(64))).toBe(`https://t.me/tender_bot?start=${"a".repeat(64)}`);

  for (const code of [
    "",
    "a".repeat(65),
    "a b",
    "a%20b",
    "a.b",
    "a/b",
    "a+b",
    "a=b",
    "%3Cscript%3E",
    "%2e%2e",
    "é",
  ]) {
    expect(at(code), JSON.stringify(code)).toBeNull();
  }
});

test("a_bot_name_is_what_telegram_allows_a_bot", () => {
  const bot = (name: string) => telegramStartUrl(`https://t.me/${name}?start=${CODE}`);

  expect(bot("tender_bot")).toBe(LINK);
  expect(bot("Tender_Bot_01")).toBe(`https://t.me/Tender_Bot_01?start=${CODE}`);
  // 5 to 32 characters, the first a letter.
  expect(bot("abcde")).not.toBeNull();
  expect(bot(`a${"b".repeat(31)}`)).not.toBeNull();
  for (const name of [
    "abcd",
    `a${"b".repeat(32)}`,
    "1tender_bot",
    "_tender_bot",
    "tender-bot",
    "tender.bot",
    "tender%5Fbot",
  ]) {
    expect(bot(name), name).toBeNull();
  }
});

test("a_refused_link_says_nothing_of_the_address_it_refused", () => {
  const refused = new TelegramLinkRefused();

  expect(refused).toBeInstanceOf(Error);
  // It names the kind of link it refused, and quotes none: no scheme, no query, no code.
  expect(refused.message).not.toMatch(/:\/\/|start=|\?/);
});

test("the_words_for_a_link_that_was_not_made_or_not_opened", () => {
  expect(telegramLinkMessage(new TelegramLinkRefused())).toBe(
    "Tender sent a link that is not a Telegram link, so it was not opened.",
  );
  // The API has no bot to link to, and asking again changes nothing.
  expect(
    telegramLinkMessage(
      new ApiError(503, { error: "unavailable", message: "Telegram linking is not set up" }),
    ),
  ).toBe("Telegram linking isn't available on this server.");
  // The other failures are the ones every sign-in and API call has.
  expect(telegramLinkMessage(new WalletCannotSign())).toBe(WALLET_CANNOT_SIGN_MESSAGE);
  expect(
    telegramLinkMessage(
      new ApiError(429, { error: "rate_limited", message: "Too many links. Try again later." }),
    ),
  ).toBe("Too many links. Try again later.");
  expect(telegramLinkMessage(new TypeError("Failed to fetch"))).toBe(
    "Can't reach the server. Check your connection and try again.",
  );
});
