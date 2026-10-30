/**
 * What the Judge made of a task, and why, in a line. The Judge says why before agents spend effort
 * on a task (spec 7.3), and the reason can sit on an accepted task ("not judged: ..."), so the
 * reason is shown whenever there is one, whatever the status is. Nothing when it has said nothing.
 */
export function JudgeNote({ status, reason }: { status: string | null; reason: string | null }) {
  const parts = [status, reason].filter((part): part is string => part !== null && part !== "");
  if (parts.length === 0) return null;
  return (
    <p data-testid="judge-note" className="text-sm wrap-anywhere">
      {`Judge: ${parts.join(" · ")}`}
    </p>
  );
}
