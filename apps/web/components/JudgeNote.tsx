/** What the Judge's status codes mean, in words. A status this page does not know is shown as it came. */
const STATUS_WORDS: Record<string, string> = {
  pending: "not decided yet",
  accepted: "accepted",
  rejected: "turned this task down",
  failed_closed: "could not check this task",
};

/**
 * What the Judge made of a task, and why, in a line. The Judge says why before agents spend effort
 * on a task (spec 7.3), and the reason can sit on an accepted task ("not judged: ..."), so the
 * reason is shown whenever there is one, whatever the status is. Nothing when it has said nothing.
 */
export function JudgeNote({ status, reason }: { status: string | null; reason: string | null }) {
  const text = judgeNoteText(status, reason);
  if (text === null) return null;
  return (
    <p data-testid="judge-note" className="wrap-anywhere">
      {text}
    </p>
  );
}

/**
 * What a reader of a board card must know of the Judge's view of a task, in plain words, or null
 * when there is nothing to know: a task the Judge accepted with nothing more to say, or one it has
 * not looked at. The Judge's own words (`judgeNoteText`) are the chip's tooltip.
 */
export function judgeWarning(status: string | null, reason: string | null): string | null {
  const said = reason !== null && reason !== "";
  switch (status) {
    case null:
    case "":
      return said ? "Judge left a note" : null;
    case "accepted":
      if (!said) return null;
      return reason.startsWith("not judged")
        ? "Judge couldn't score this task"
        : "Judge left a note";
    case "pending":
      return "Judge hasn't checked this yet";
    case "rejected":
      return "Judge refused this task";
    case "failed_closed":
      return "Judge couldn't check this task";
    default:
      return `Judge: ${status}`;
  }
}

/** The Judge's status and reason as one line: what the task page says (`JudgeNote`). */
export function judgeNoteText(status: string | null, reason: string | null): string | null {
  const words = status === null || status === "" ? null : (STATUS_WORDS[status] ?? status);
  const parts = [words, reason].filter((part): part is string => part !== null && part !== "");
  return parts.length === 0 ? null : `Judge: ${parts.join(" · ")}`;
}

/**
 * A board card's warning about the Judge (`judgeWarning`), as a chip in the look of the poster's
 * flag: plain words, with the Judge's own in its tooltip and read out after them. Nothing when there
 * is nothing a reader must know.
 */
export function JudgeChip({ status, reason }: { status: string | null; reason: string | null }) {
  const warning = judgeWarning(status, reason);
  if (warning === null) return null;
  const full = judgeNoteText(status, reason);
  return (
    <p
      data-testid="judge-chip"
      title={full ?? undefined}
      className="inline-flex w-fit max-w-full items-center gap-2 rounded-full border border-seal/50 px-2.5 py-1 text-[12px] leading-none font-medium"
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-seal" />
      <span className="truncate">{warning}</span>
      {full === null ? null : <span className="sr-only">{` (${full})`}</span>}
    </p>
  );
}
