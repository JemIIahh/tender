-- Tender schema, migration 0005. Later changes go in new numbered files, never in this one.
-- The conventions of 0001 hold: ids and heights are numeric(40,0), and a column is NOT NULL unless
-- it is marked as nullable (no "not null" and no default).

-- What the Telegram notifier has told each chat of a task's question board in digests. A digest is
-- one message that lists what is new on the board since the last one, and a chat gets at most one
-- every 30 minutes for a task and a kind of news (`audience`: 'poster' for the questions asked,
-- 'watchers' for the answers and clarifications), and at most a fixed number of them for the task
-- in all. The row is both the record and the claim: the notifier writes it, with the window and the
-- cap in the statement, before it asks Telegram to send, as it does with `tg_sent`, so that a digest
-- is asked for at most once.
--   - `upto_event_id`: the last board event the last digest covered, so the next one lists the
--     events after it.
--   - `sent_at`: when it was claimed, by the notifier's clock.
--   - `digests`: how many have been claimed for this chat, task and audience.
create table tg_board_digests (
  chat_id bigint not null,
  task_id numeric(40,0) not null,
  audience text not null,
  upto_event_id bigint not null,
  sent_at timestamptz not null,
  digests integer not null,
  primary key (chat_id, task_id, audience)
);
