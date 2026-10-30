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
    <div role="alert" data-testid="error-state" className="rounded border border-neutral-900 p-4">
      <p>{message}</p>
      {/* `aria-disabled` and not `disabled`: a disabled button cannot hold focus, and a person on
          the keyboard would lose their place at the moment they asked to try again. */}
      <button
        type="button"
        aria-disabled={retrying}
        onClick={retrying ? undefined : onRetry}
        className="mt-3 min-h-11 rounded border border-neutral-900 bg-neutral-900 px-4 text-white aria-disabled:opacity-60"
      >
        {retrying ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}
