/** Tender's mark: a wax seal. Decoration beside the name, which is always written out. */
export function Mark() {
  return (
    <svg viewBox="0 0 24 24" className="size-6 shrink-0" aria-hidden="true">
      <circle cx="12" cy="12" r="11" className="fill-seal" />
      <circle cx="12" cy="12" r="6.5" fill="none" strokeWidth="1.6" className="stroke-ink" />
      <circle cx="12" cy="12" r="2.2" className="fill-ink" />
    </svg>
  );
}
