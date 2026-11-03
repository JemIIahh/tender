import type { Db } from "@tender/db";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type Alert, resolveRecipients } from "../src/index";
import {
  type ChatId,
  linkChat,
  openTestDb,
  seedAgent,
  seedEntry,
  seedFunder,
  seedTask,
  watchTag,
} from "./helpers";

// The world these tests share: two tasks, the accounts around them and the chats of those
// accounts. One database is seeded once, because opening a PGlite takes close to a second. A test
// that changes a row puts it back.
//
// A chat is named after whose it is, and a test says who must hear an alert in those names, so a
// wrong answer reads "expected acme, got lab" and not a pair of numbers. Every chat that must NOT
// hear an alert is in the world on purpose: the ASP of the poster and of a funder (the table gives
// those two roles their own chats, not their owners'), a bystander, the watchers of other tags, a
// watcher of pieces of a tag, and everyone around the other task.

const TASK = "7";
const OTHER_TASK = "8";
/** Task 7's tags and people, but only three invitees may enter it. */
const INVITE_ONLY_TASK = "15";
const TITLE = "Summarise the Q3 report";

// Task 7's accounts. An account has an ASP only if it is a registered agent whose row names one.
const POSTER = "lead.lab.near"; // agent of lab.near
const VERIFIER = "judge.court.near"; // agent of court.near
const BACKER_1 = "backer1.fund.near"; // agent of fund.near
const BACKER_2 = "backer2.near"; // not registered
const BOT_1 = "bot1.acme.near"; // agent of acme.near: committed and revealed
const BOT_2 = "bot2.acme.near"; // agent of acme.near, no chat of its own: committed, not revealed
const BOT_3 = "bot3.acme.near"; // agent of acme.near with a chat of its own, in no task at all
const SOLO = "solo.near"; // not registered: committed and revealed on task 7, not on task 8
const LONE = "lone.near"; // agent without an ASP: committed, not revealed on task 7, revealed on 8
// Task 8's accounts.
const OTHER_POSTER = "other.near";
const OTHER_VERIFIER = "judge8.near";
const OTHER_BACKER = "backer8.near";
const BOT_9 = "bot9.beta.near"; // agent of beta.near: committed and revealed on task 8

/** Every chat of the world, with the account it is linked to. */
const CHATS = {
  poster: { id: 101, account: POSTER },
  lab: { id: 110, account: "lab.near" }, // the poster's ASP
  verifier: { id: 102, account: VERIFIER },
  court: { id: 120, account: "court.near" }, // the verifier's ASP
  backer1: { id: 103, account: BACKER_1 },
  fund: { id: 130, account: "fund.near" }, // backer1's ASP
  backer2: { id: 104, account: BACKER_2 },
  bot1: { id: 201, account: BOT_1 },
  acme: { id: 202, account: "acme.near" }, // the ASP of bot1, bot2 and bot3
  bot3: { id: 205, account: BOT_3 }, // a sibling of bot1 and bot2: not their owner
  solo: { id: 203, account: SOLO },
  lone: { id: 204, account: LONE },
  bystander: { id: 301, account: "bystander.near" }, // has nothing to do with any task
  watchesResearch: { id: 501, account: "watcher-a.near" },
  watchesBoth: { id: 502, account: "watcher-b.near" }, // research and summary
  watchesCoding: { id: 503, account: "watcher-c.near" },
  watchesNear: { id: 504, account: "watcher-d.near" }, // res and search: pieces of "research", not tags
  otherPoster: { id: 401, account: OTHER_POSTER },
  otherVerifier: { id: 402, account: OTHER_VERIFIER },
  otherBacker: { id: 405, account: OTHER_BACKER },
  bot9: { id: 403, account: BOT_9 },
  beta: { id: 404, account: "beta.near" }, // the ASP of bot9
} as const;
type ChatName = keyof typeof CHATS;

const WATCHES: readonly (readonly [ChatName, string])[] = [
  ["watchesResearch", "research"],
  ["watchesBoth", "research"],
  ["watchesBoth", "summary"],
  ["watchesCoding", "coding"],
  ["watchesNear", "res"],
  ["watchesNear", "search"],
];

async function seedWorld(db: Db): Promise<void> {
  await seedAgent(db, POSTER, { asp: "lab.near" });
  await seedAgent(db, VERIFIER, { asp: "court.near" });
  await seedAgent(db, BACKER_1, { asp: "fund.near" });
  await seedAgent(db, BOT_1, { asp: "acme.near" });
  await seedAgent(db, BOT_2, { asp: "acme.near" });
  await seedAgent(db, BOT_3, { asp: "acme.near" });
  await seedAgent(db, LONE);
  await seedAgent(db, BOT_9, { asp: "beta.near" });

  // Task 7. As the indexer does, the poster is one of the funders.
  await seedTask(db, {
    id: TASK,
    poster: POSTER,
    verifier: VERIFIER,
    title: TITLE,
    tags: ["research", "summary"],
  });
  await seedFunder(db, TASK, POSTER);
  await seedFunder(db, TASK, BACKER_1);
  await seedFunder(db, TASK, BACKER_2);
  await seedEntry(db, TASK, BOT_1, { revealed: true });
  await seedEntry(db, TASK, BOT_2);
  await seedEntry(db, TASK, SOLO, { revealed: true });
  await seedEntry(db, TASK, LONE);

  // Task 8: the same people turn up in other roles, so a mix-up of tasks shows.
  await seedTask(db, {
    id: OTHER_TASK,
    poster: OTHER_POSTER,
    verifier: OTHER_VERIFIER,
    title: "Extract the invoice lines",
    tags: ["coding"],
  });
  await seedFunder(db, OTHER_TASK, OTHER_POSTER);
  await seedFunder(db, OTHER_TASK, OTHER_BACKER);
  await seedEntry(db, OTHER_TASK, BOT_9, { revealed: true });
  await seedEntry(db, OTHER_TASK, SOLO);
  await seedEntry(db, OTHER_TASK, LONE, { revealed: true });

  // Task 15, invite-only. It has no entries: only its announcements are tested.
  await seedTask(db, {
    id: INVITE_ONLY_TASK,
    poster: POSTER,
    verifier: VERIFIER,
    title: "Review the vendor contract",
    tags: ["research", "summary"],
    invited: [BOT_1, BOT_2, SOLO],
  });
  await seedFunder(db, INVITE_ONLY_TASK, POSTER);
  await seedFunder(db, INVITE_ONLY_TASK, BACKER_2);

  for (const chat of Object.values(CHATS)) await linkChat(db, chat.id, chat.account);
  for (const [name, tag] of WATCHES) await watchTag(db, CHATS[name].id, tag);
}

let db: Db;

beforeAll(async () => {
  db = await openTestDb();
  await seedWorld(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

type ByKind = { [K in Alert["kind"]]: Extract<Alert, { kind: K }> };

/**
 * One alert of every kind, all on task 7. The fields that name people (`winners`, `agent`) are
 * deliberately not the whole story: the table sends `winner_paid` to every revealer, and `bot1`
 * is the only winner here.
 */
const ALERT: ByKind = {
  new_task: {
    kind: "new_task",
    taskId: TASK,
    title: TITLE,
    reward: "5000000",
    token: "usdc.test",
    tags: ["research", "summary"],
    commitDeadline: "1793235600000000000",
  },
  agent_started: { kind: "agent_started", taskId: TASK, title: TITLE, agent: BOT_1 },
  entry_committed: { kind: "entry_committed", taskId: TASK, title: TITLE, count: 4 },
  reveal_open: {
    kind: "reveal_open",
    taskId: TASK,
    title: TITLE,
    revealDeadline: "1793239200000000000",
  },
  reveal_closing: {
    kind: "reveal_closing",
    taskId: TASK,
    title: TITLE,
    revealDeadline: "1793239200000000000",
  },
  winner_paid: {
    kind: "winner_paid",
    taskId: TASK,
    title: TITLE,
    token: "usdc.test",
    winners: [{ account: BOT_1, amount: "4750000" }],
    scorecardUri: "https://api.tender.example/v1/blobs/ab12",
  },
  task_voided: { kind: "task_voided", taskId: TASK, title: TITLE, reason: "no_award" },
  deadline_reminder: { kind: "deadline_reminder", taskId: TASK, title: TITLE, hoursLeft: 1 },
  pool_grew: {
    kind: "pool_grew",
    taskId: TASK,
    title: TITLE,
    token: "usdc.test",
    reward: "12500000",
    funders: 3,
  },
};

const NAME_OF = new Map(Object.entries(CHATS).map(([name, chat]) => [String(chat.id), name]));

/** The names of the chats that hear `alert`, in alphabetical order. A chat nobody named shows its id. */
async function who(alert: Alert): Promise<string[]> {
  const ids = await resolveRecipients(db, alert);
  return ids.map((id) => NAME_OF.get(id) ?? `unknown chat ${id}`).sort();
}

/** `list`, in the order `who` gives. */
function names(...list: ChatName[]): string[] {
  return [...list].sort();
}

async function setMuted(chat: string, muted: boolean): Promise<void> {
  await db.query("update tg_links set muted = $2 where chat_id = $1::bigint", [chat, muted]);
}

// One test per row of the table.

test("new_task_reaches_tag_watchers_and_the_posters_owner_chats", async () => {
  // The poster's chat and its ASP's, and each chat watching research or summary, once. Nobody
  // else: not the watcher of coding, not the verifier, not a funder.
  expect(await who(ALERT.new_task)).toEqual(
    names("poster", "lab", "watchesResearch", "watchesBoth"),
  );
});

test("agent_started_reaches_the_poster_and_the_agents_owner_chats", async () => {
  // The poster's own chat, not its ASP's; and bot1's chat and the chat of its ASP.
  expect(await who(ALERT.agent_started)).toEqual(names("poster", "bot1", "acme"));
});

test("a_later_starter_reaches_its_owners_and_not_the_poster", async () => {
  // The notifier sets `posterHears` to false after a task's first few starters. Not set means that
  // the poster hears, as above.
  expect(await who({ ...ALERT.agent_started, posterHears: false })).toEqual(names("acme", "bot1"));
  expect(await who({ ...ALERT.agent_started, posterHears: true })).toEqual(
    names("poster", "bot1", "acme"),
  );
});

test("entry_committed_reaches_the_poster_only", async () => {
  expect(await who(ALERT.entry_committed)).toEqual(names("poster"));
});

test("reveal_open_reaches_every_committers_owners_and_the_verifiers_owners", async () => {
  // bot1 and bot2 share acme's chat, which hears once. solo is not an agent and lone has no ASP,
  // so each has only its own chat. The verifier is an agent of court.near: its own chat and the
  // chat of its ASP both hear.
  expect(await who(ALERT.reveal_open)).toEqual(
    names("acme", "bot1", "court", "lone", "solo", "verifier"),
  );
});

test("reveal_closing_reaches_the_owners_of_committers_who_have_not_revealed", async () => {
  // bot2 (no chat of its own: its ASP's) and lone have not revealed. bot1 and solo have, so their
  // own chats stay quiet, though acme's chat hears for bot2.
  expect(await who(ALERT.reveal_closing)).toEqual(names("acme", "lone"));
});

test("winner_paid_reaches_the_poster_every_revealers_owners_and_the_verifiers_owners", async () => {
  // Every revealer, not only the winner: solo revealed and did not win. lone never revealed. The
  // poster's own chat, not its ASP's; the verifier's own chat and its ASP's.
  expect(await who(ALERT.winner_paid)).toEqual(
    names("poster", "bot1", "acme", "solo", "verifier", "court"),
  );
});

test("task_voided_reaches_the_poster_and_every_funder", async () => {
  // The poster is also a funder and hears once. A funder's chat, not its ASP's.
  expect(await who(ALERT.task_voided)).toEqual(names("poster", "backer1", "backer2"));
});

test("deadline_reminder_reaches_the_poster_and_every_committers_owners", async () => {
  // Every committer, revealed or not; not the verifier or its ASP.
  expect(await who(ALERT.deadline_reminder)).toEqual(
    names("poster", "bot1", "acme", "solo", "lone"),
  );
});

test("pool_grew_reaches_the_poster_every_funder_and_tag_watchers", async () => {
  expect(await who(ALERT.pool_grew)).toEqual(
    names("poster", "backer1", "backer2", "watchesResearch", "watchesBoth"),
  );
});

// Two refinements of the rows above.

test("verifier_owner_chats_hear_reveal_open_and_winner_paid", async () => {
  // The Judge is a sub-account of its owner, and nobody links a chat to it. Its row in `agents`
  // names the owner's account as its ASP, and that chat is the only one on task 16.
  await seedAgent(db, "judge.bench.near", { asp: "bench.near" });
  await linkChat(db, 611, "bench.near");
  await seedTask(db, { id: "16", poster: "nobody.near", verifier: "judge.bench.near" });
  const open16 = { ...ALERT.reveal_open, taskId: "16" };
  const paid16 = { ...ALERT.winner_paid, taskId: "16" };
  expect(await resolveRecipients(db, open16)).toEqual(["611"]);
  expect(await resolveRecipients(db, paid16)).toEqual(["611"]);

  // The ASP is what the verifier's row says. A verifier that never registered has none, so the
  // chat of its parent account hears nothing.
  await linkChat(db, 612, "unlisted.near");
  await seedTask(db, { id: "17", poster: "nobody.near", verifier: "judge.unlisted.near" });
  expect(await resolveRecipients(db, { ...open16, taskId: "17" })).toEqual([]);
  expect(await resolveRecipients(db, { ...paid16, taskId: "17" })).toEqual([]);
});

test("new_task_for_an_invite_only_task_reaches_the_poster_and_the_invitees_owners", async () => {
  // Task 15 has task 7's tags and invites bot1, bot2 and solo. The owner chats of each invitee
  // hear: bot1's own chat, the chat of acme.near (the ASP of bot1 and of bot2), and solo's, which
  // is an account with no agent row and so has no ASP. The poster's owner chats still hear too.
  //
  // Nobody else does. Not lone, an agent nobody invited. Not bot3, an agent of acme.near that was
  // not invited: its own chat is not an owner chat of bot1. Not the chats watching research and
  // summary, since watchers cannot enter the task.
  const alert = { ...ALERT.new_task, taskId: INVITE_ONLY_TASK };
  expect(await who(alert)).toEqual(names("poster", "lab", "bot1", "acme", "solo"));
});

test("pool_grew_for_an_invite_only_task_skips_tag_watchers", async () => {
  // The poster and the funders have money in the task, so they still hear; the watchers do not.
  const alert = { ...ALERT.pool_grew, taskId: INVITE_ONLY_TASK };
  expect(await who(alert)).toEqual(names("poster", "backer2"));
});

// The rules that hold for every row.

test("muted_chats_excluded", async () => {
  // Mute each chat that hears an alert, one at a time: it drops out and nobody else does, so the
  // account arm, the ASP arm and the tag arm of every kind all respect the mute. The invite-only
  // new_task is in the list for the chats of its invitees.
  const inviteOnly = { ...ALERT.new_task, taskId: INVITE_ONLY_TASK };
  for (const alert of [...Object.values(ALERT), inviteOnly]) {
    const which = `${alert.kind} on task ${alert.taskId}`;
    const everyone = await resolveRecipients(db, alert);
    expect(everyone.length, `${which} has recipients`).toBeGreaterThan(0);
    for (const chat of everyone) {
      await setMuted(chat, true);
      try {
        expect(await resolveRecipients(db, alert), `${which} with chat ${chat} muted`).toEqual(
          everyone.filter((other) => other !== chat),
        );
      } finally {
        await setMuted(chat, false);
      }
    }
  }

  // An account with three chats: muting one of them leaves the other two.
  await postedFromChats("13", [21, 22, 23]);
  const committed = { kind: "entry_committed", taskId: "13", title: TITLE, count: 1 } as const;
  await setMuted("22", true);
  try {
    expect(await resolveRecipients(db, committed)).toEqual(["21", "23"]);
  } finally {
    await setMuted("22", false);
  }
});

test("asp_owner_receives_agent_alerts", async () => {
  // Task 9 names only agents of the ASP guild.near, and the one chat is the guild's: no agent has
  // a chat of its own, and the poster and the verifier have none.
  await seedAgent(db, "boss.guild.near", { asp: "guild.near" });
  await seedAgent(db, "worker.guild.near", { asp: "guild.near" });
  await seedAgent(db, "finisher.guild.near", { asp: "guild.near" });
  await linkChat(db, 601, "guild.near");
  await seedTask(db, { id: "9", poster: "boss.guild.near", verifier: "judge.nowhere.near" });
  await seedEntry(db, "9", "worker.guild.near");
  await seedEntry(db, "9", "finisher.guild.near", { revealed: true });
  const task = { taskId: "9", title: TITLE };
  const deadline = "1793239200000000000";
  const guild = ["601"];

  // The agent that started, a committer, one that has not revealed, a revealer, and a poster
  // that is itself an agent.
  expect(
    await resolveRecipients(db, { ...task, kind: "agent_started", agent: "worker.guild.near" }),
  ).toEqual(guild);
  expect(
    await resolveRecipients(db, { ...task, kind: "reveal_open", revealDeadline: deadline }),
  ).toEqual(guild);
  expect(
    await resolveRecipients(db, { ...task, kind: "reveal_closing", revealDeadline: deadline }),
  ).toEqual(guild);
  expect(
    await resolveRecipients(db, { ...task, kind: "deadline_reminder", hoursLeft: 24 }),
  ).toEqual(guild);
  expect(
    await resolveRecipients(db, {
      ...task,
      kind: "winner_paid",
      token: "usdc.test",
      winners: [{ account: "finisher.guild.near", amount: "1" }],
      scorecardUri: "https://api.tender.example/v1/blobs/ab12",
    }),
  ).toEqual(guild);
  expect(
    await resolveRecipients(db, {
      ...task,
      kind: "new_task",
      reward: "1",
      token: "usdc.test",
      tags: [],
      commitDeadline: deadline,
    }),
  ).toEqual(guild);

  // The ASP is what the agent's row says, not what its name suggests: a sub-account of guild.near
  // that never registered has no ASP, so the guild's chat hears nothing about it.
  await seedTask(db, { id: "10", poster: "stranger.near", verifier: "judge.nowhere.near" });
  await seedEntry(db, "10", "ghost.guild.near");
  expect(
    await resolveRecipients(db, {
      ...task,
      taskId: "10",
      kind: "reveal_open",
      revealDeadline: deadline,
    }),
  ).toEqual([]);
  expect(
    await resolveRecipients(db, { ...task, taskId: "10", kind: "deadline_reminder", hoursLeft: 1 }),
  ).toEqual([]);
});

test("alerts_are_scoped_to_their_task", async () => {
  const closing8 = { ...ALERT.reveal_closing, taskId: OTHER_TASK };
  const paid8 = { ...ALERT.winner_paid, taskId: OTHER_TASK };
  const new8 = { ...ALERT.new_task, taskId: OTHER_TASK, tags: ["coding"] };
  const voided8 = { ...ALERT.task_voided, taskId: OTHER_TASK };

  // solo has not revealed on task 8 (but did on task 7), and lone has (but did not on task 7).
  expect(await who(closing8)).toEqual(names("solo"));
  expect(await who(paid8)).toEqual(names("otherPoster", "otherVerifier", "bot9", "beta", "lone"));
  expect(await who(new8)).toEqual(names("otherPoster", "watchesCoding"));
  expect(await who(voided8)).toEqual(names("otherPoster", "otherBacker"));
});

test("a_task_the_database_does_not_know_reaches_nobody", async () => {
  // Task 99 is not indexed, so it has no poster, verifier, committers, funders or tags, and the
  // tags that new_task carries are not read. Only agent_started names someone of its own.
  for (const alert of Object.values(ALERT)) {
    expect(await who({ ...alert, taskId: "99" }), alert.kind).toEqual(
      alert.kind === "agent_started" ? names("bot1", "acme") : [],
    );
  }
});

test("a_chat_with_several_reasons_to_hear_an_alert_hears_it_once", async () => {
  // acme.near is a person. It posts task 14, backs it, watches its tag and enters itself and both
  // of its agents. Its one chat (202) is then the poster's chat, a funder's, a committer's, the
  // ASP of two agents and a tag watcher all at once, and each alert reaches it once.
  await seedTask(db, { id: "14", poster: "acme.near", verifier: VERIFIER, tags: ["ops"] });
  await seedFunder(db, "14", "acme.near");
  await seedEntry(db, "14", "acme.near");
  await seedEntry(db, "14", BOT_1);
  await seedEntry(db, "14", BOT_2);
  await watchTag(db, CHATS.acme.id, "ops");
  const task = { taskId: "14", title: TITLE };

  expect(await who({ ...task, kind: "agent_started", agent: BOT_1 })).toEqual(
    names("acme", "bot1"),
  );
  expect(await who({ ...task, kind: "agent_started", agent: "acme.near" })).toEqual(names("acme"));
  expect(await who({ ...task, kind: "deadline_reminder", hoursLeft: 24 })).toEqual(
    names("acme", "bot1"),
  );
  expect(
    await who({
      ...task,
      kind: "new_task",
      reward: "1",
      token: "usdc.test",
      tags: ["ops"],
      commitDeadline: "1793235600000000000",
    }),
  ).toEqual(names("acme"));
  expect(
    await who({ ...task, kind: "pool_grew", token: "usdc.test", reward: "2", funders: 1 }),
  ).toEqual(names("acme"));
});

test("a_watching_chat_that_is_not_linked_still_hears_its_tags", async () => {
  // The table sends tag alerts to the chats in tg_watches. A chat can only be muted through its
  // link, so a watcher without a link is a chat that has not muted.
  await seedTask(db, { id: "12", poster: "nobody.near", tags: ["niche"] });
  await watchTag(db, 701, "niche");
  const alert = { ...ALERT.new_task, taskId: "12", tags: ["niche"] };
  expect(await resolveRecipients(db, alert)).toEqual(["701"]);
  expect(await resolveRecipients(db, { ...ALERT.pool_grew, taskId: "12" })).toEqual(["701"]);
});

test("chat_ids_come_back_as_exact_decimal_strings_in_ascending_order", async () => {
  // A negative id, two that differ in length (text order would put 10 before 9), and one past
  // 2^53, which a JS number would round to ...992.
  await postedFromChats("11", [9007199254740993n, 10, -1001234567890, 9]);
  const alert = { kind: "entry_committed", taskId: "11", title: TITLE, count: 1 } as const;
  expect(await resolveRecipients(db, alert)).toEqual([
    "-1001234567890",
    "9",
    "10",
    "9007199254740993",
  ]);
});

test("each_alert_is_resolved_with_one_query", async () => {
  for (const alert of Object.values(ALERT)) {
    const statements: string[] = [];
    const counting: Db = {
      query: <T>(sql: string, params?: unknown[]) => {
        statements.push(sql);
        return db.query<T>(sql, params);
      },
      exec: (sql) => {
        statements.push(sql);
        return db.exec(sql);
      },
      tx: (fn) => {
        statements.push("transaction");
        return db.tx(fn);
      },
      close: () => db.close(),
    };
    await resolveRecipients(counting, alert);
    expect(statements, alert.kind).toHaveLength(1);
  }
});

test("an_alert_of_an_unknown_kind_is_refused", async () => {
  const unknown = { kind: "task_exploded", taskId: TASK } as unknown as Alert;
  await expect(resolveRecipients(db, unknown)).rejects.toThrow("unknown alert");
});

/** Task `id`, posted by an account that has one chat for each of `chats`. */
async function postedFromChats(id: string, chats: ChatId[]): Promise<void> {
  const poster = `poster-of-${id}.near`;
  await seedTask(db, { id, poster });
  for (const chat of chats) await linkChat(db, chat, poster);
}
