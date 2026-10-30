import { Script } from "node:vm";
import { type Brief, MAX_RESULT_BYTES, type PublicCriteria } from "@tender/shared";

// What an answer must look like before the agent commits to it. A commit is a hash: the runner
// commits to the bytes a solver gives, as they are, and reveals them later. A model that wanders off
// the format would enter a task with work the Judge scores 0, at the cost of a commit and a reveal,
// so the LLM solver checks its answer first and gives none (null) when the check fails.
//
// The rules are the Judge's own for each format or stricter: `regex_json` is what `scoreRegexCases`
// reads, `json` what `scoreJsonSchema` parses, and `code_js` the script that `scoreTests` puts a call
// after. What the model wrote is data: nothing here runs it. The answer that passes is the model's
// own text, byte for byte, apart from the code fence and the space around it (a number written
// 71.70 stays 71.70), because the Judge scores the bytes that were committed. What a reasoning model
// thought is not part of that: its message opens with the thinking, `<think>...</think>`, and the
// answer follows, so the thinking is taken off first (`withoutThinking`).

/** The most characters a regex pattern may have, counted as the Judge counts them (`pattern.length`). */
const MAX_PATTERN_LENGTH = 2_000;
/**
 * The flags a regex answer may set. `g` and `y` are left out: they make `test` remember where it
 * stopped, so a case would be judged by the cases before it.
 */
const REGEX_FLAGS = /^[imsu]*$/;
/** A half of a surrogate pair with no other half: text that UTF-8 cannot write as it is. */
const LONE_SURROGATE = /\p{Surrogate}/u;
/**
 * The thinking that a reasoning model opens its message with: `<think>`, whatever it thought, and
 * the first `</think>`, with the space before the block and all the space after it.
 */
const THINK_BLOCK = /^\s*<think>[\s\S]*?<\/think>\s*/;
/** The start of such a block, whether it is closed or not. */
const THINK_OPEN = /^\s*<think>/;
/**
 * How many bytes a reply may have beyond the limit of the answer in it: room for the thinking that
 * a reasoning model sends first, which is not held to that limit. A reply with more is dropped
 * unread (`checkAnswer`), as a server can make a reply as large as it likes.
 */
const MAX_THINKING_BYTES = 1_048_576;
/** A function name that can be checked for: a plain identifier, in ASCII. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** A reply that is one fenced block and nothing else: the fence, its body, the closing fence. */
const FENCED = /^```[^\r\n]*\r?\n([\s\S]*)\r?\n```$/;

/** Whether `source` is a JavaScript script. It is compiled and never run. */
function compiles(source: string): boolean {
  try {
    new Script(source);
    return true;
  } catch {
    return false;
  }
}

/**
 * The name the answer's code must define, if the criteria give one: the `entry` of `tests`
 * criteria, the function the Judge calls (`scoreTests`). Any other criteria for a `code_js` answer
 * name no function, and the code only has to be JavaScript.
 */
export function entryOf(brief: Brief, criteria: PublicCriteria): string | undefined {
  return brief.output.format === "code_js" && criteria.kind === "tests"
    ? criteria.entry
    : undefined;
}

/**
 * Whether `name` is one that `definesName` can look for: a plain identifier that `let` accepts in a
 * script of either kind. An answer may open with `"use strict"`, and then a `let` of `eval`,
 * `arguments`, `public`, `yield` or `interface` (names that only strict code reserves) is an error
 * of its own, which `definesName` would take for the name being declared already, so that a script
 * that never defines it would pass.
 */
function checkable(name: string): boolean {
  return (
    IDENTIFIER.test(name) && compiles(`let ${name};`) && compiles(`"use strict"; let ${name};`)
  );
}

/**
 * Whether the script `source` declares `name` at its top level, as a function, a `var`, `let` or
 * `const`, a class or a destructuring, which is how the Judge's call `(name)(input)` finds it.
 *
 * It asks the parser and runs nothing: a `let name;` put after the script is a SyntaxError (an early
 * error, found when the script is compiled) exactly when the script has declared `name` already,
 * for a `name` that `checkable` has passed. So a mention in a comment or a string is no declaration,
 * and neither is a function of that name inside another function, or a method of an object. What it
 * cannot see is a definition made by assignment (`globalThis.name = ...`), which the prompt does not
 * ask for.
 */
function definesName(source: string, name: string): boolean {
  return !compiles(`${source}\n;let ${name};`);
}

/**
 * Whether the solver can answer a task at all. It cannot when the brief has attachments, which are
 * files it is not given and the instructions may depend on, or when the code it is asked for must
 * define a name that cannot be looked for (`definesName`). It says no before the model is asked, so
 * that no credits go on an answer that could not be sent.
 */
export function canAnswer(brief: Brief, criteria: PublicCriteria): boolean {
  if (brief.attachments !== undefined && brief.attachments.length > 0) return false;
  const entry = entryOf(brief, criteria);
  return entry === undefined || checkable(entry);
}

/** The most bytes the answer to `brief` may have: its own limit, and the result store's. */
export function answerLimit(brief: Brief): number {
  return Math.min(brief.output.max_bytes, MAX_RESULT_BYTES);
}

/**
 * `reply` without the one block of thinking that opens it, and the space round the block. Reasoning
 * models send their thinking in the message itself, and every answer of theirs would be null if the
 * check took it for part of the answer. Only a block that opens the message is taken off, and only
 * one: a block anywhere else is left in, and the format check judges it with the rest.
 *
 * Null when the message opens a block that it never closes. The model stopped while it was still
 * thinking and has no answer, which a `text` task would otherwise take for one.
 */
function withoutThinking(reply: string): string | null {
  const answer = reply.replace(THINK_BLOCK, "");
  return answer === reply && THINK_OPEN.test(reply) ? null : answer;
}

/**
 * `reply` without the code fence that wraps it, if it is wrapped by one: the whole reply (but for
 * the space round it) is one block, from an opening line of backticks and an optional language to
 * a closing line of backticks. Prose before or after the block, a block that is not closed, and
 * two blocks are not one surrounding fence, and the reply is returned as it is.
 */
function unwrapFence(reply: string): string {
  const body = FENCED.exec(reply.trim())?.[1];
  if (body === undefined) return reply;
  // The greedy match runs from the first fence to the last, so a fence line inside means two blocks.
  return /^```/m.test(body) ? reply : body;
}

/** Whether `text` is one JSON document. */
function isJson(text: string): boolean {
  if (text === "") return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** `text` if it is `{"pattern": string, "flags": string}` and no more, with a pattern the Judge accepts. */
function regexAnswer(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !keys.includes("pattern") || !keys.includes("flags")) return null;

  const { pattern, flags } = parsed as Record<string, unknown>;
  if (typeof pattern !== "string" || typeof flags !== "string") return null;
  if (pattern.length > MAX_PATTERN_LENGTH) return null;
  // Each flag at most once, as `new RegExp` insists.
  if (!REGEX_FLAGS.test(flags) || new Set(flags).size !== flags.length) return null;
  try {
    // Compiled to see that it is a regex, never run on anything.
    new RegExp(pattern, flags);
  } catch {
    return null;
  }
  return text;
}

/** `text` if it is JavaScript that defines `entry` (when there is one to look for). */
function codeAnswer(text: string, entry: string | undefined): string | null {
  if (text === "" || !compiles(text)) return null;
  if (entry !== undefined && !(checkable(entry) && definesName(text, entry))) return null;
  return text;
}

/**
 * The answer that `reply`, the model's whole message, makes for the task whose brief and criteria
 * are given, as the bytes to commit to, or null when it is not an answer in the format the brief
 * asks for. After the thinking that opens the message (`withoutThinking`) and then one surrounding
 * code fence are taken off:
 *
 * - `text`: any text that is not empty once trimmed, sent as the model wrote it, space and all;
 * - `json`: one JSON document, trimmed;
 * - `regex_json`: `{"pattern": ..., "flags": ...}` with those two keys and no other, a pattern of
 *   at most 2000 characters that compiles, and flags that are some of `i`, `m`, `s` and `u`, each
 *   once (so never `g` or `y`), trimmed;
 * - `code_js`: JavaScript that compiles as a script (no `import`, `export` or top-level `return`)
 *   and, for `tests` criteria, declares the function `entry` they name, trimmed. It is never run.
 *
 * And in every format the answer is at most `answerLimit(brief)` bytes of UTF-8. A reply of more
 * than that and 1 MiB, the room for the thinking, is no answer, and none of it is read.
 */
export function checkAnswer(
  reply: string,
  brief: Brief,
  criteria: PublicCriteria,
): Uint8Array | null {
  // The server decides how large the reply is. Past the answer's limit and the room for thinking,
  // the reply is dropped before any of the checks below reads it.
  if (Buffer.byteLength(reply) > answerLimit(brief) + MAX_THINKING_BYTES) return null;
  // The thinking is not the answer: it is not checked, and it does not count against the limit.
  const message = withoutThinking(reply);
  if (message === null) return null;
  // A lone surrogate would be written as U+FFFD, and the answer would not be what the model wrote.
  // With the `u` flag a surrogate pair is one character, so only a lone half is a match.
  if (LONE_SURROGATE.test(message)) return null;

  const text = unwrapFence(message);
  let answer: string | null;
  switch (brief.output.format) {
    case "text":
      answer = text.trim() === "" ? null : text;
      break;
    case "json":
      answer = isJson(text.trim()) ? text.trim() : null;
      break;
    case "regex_json":
      answer = regexAnswer(text.trim());
      break;
    case "code_js":
      answer = codeAnswer(text.trim(), entryOf(brief, criteria));
      break;
  }
  if (answer === null) return null;

  const bytes = new TextEncoder().encode(answer);
  return bytes.length <= answerLimit(brief) ? bytes : null;
}
