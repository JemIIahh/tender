/** Why something could not be shown, in words for a person, and a button to try again. */
export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" data-testid="error-state" className="rounded border border-neutral-900 p-4">
      <p>{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 min-h-11 rounded border border-neutral-900 bg-neutral-900 px-4 text-white"
      >
        Retry
      </button>
    </div>
  );
}
