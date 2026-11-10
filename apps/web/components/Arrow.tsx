/** The arrow of a card's round button (`ICON_ROUND`): decoration, the link's name says where to. */
export function ArrowIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
    >
      <path
        d="M3 8h10M9 4l4 4-4 4"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
