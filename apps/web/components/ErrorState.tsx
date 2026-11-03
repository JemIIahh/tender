import { PRIMARY } from "./ui";

/**
 * Why something could not be shown, in words for a person, and a button to try again. While a retry
 * is under way (`retrying`) the same button reads "Retrying…" and asks for nothing more.
 */
export function ErrorState({
  message,
  onRetry,
  retrying = false,
}: {
  message: string;
  onRetry: () => void;
  retrying?: boolean;
}) {
  return (
    <div
      role="alert"
      data-testid="error-state"
      className="grid gap-4 rounded-2xl border border-seal/45 bg-seal/[0.06] p-5 text-bone sm:flex sm:items-center sm:justify-between sm:gap-6"
    >
      <p className="flex min-w-0 gap-3 wrap-anywhere">
        <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-seal" />
        {message}
      </p>
      {/* `aria-disabled` and not `disabled`: a disabled button cannot hold focus, and a person on
          the keyboard would lose their place at the moment they asked to try again. */}
      <button
        type="button"
        aria-disabled={retrying}
        onClick={retrying ? undefined : onRetry}
        className={`${PRIMARY} shrink-0`}
      >
        {retrying ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}
