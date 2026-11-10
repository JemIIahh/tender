import Link from "next/link";
import { CopyButton } from "./CopyButton";
import { LiveStatus } from "./LiveStatus";

/** A pill of the app's top bar. */
export const BAR_PILL = "min-h-10 px-4 whitespace-nowrap";

/** The part of the account group after the status, divided from it by a hairline. */
const PART = "flex h-10 min-w-0 items-center border-l border-line";

/**
 * The top bar's account group, one joined pill: the status of the index and the network's name
 * (components/LiveStatus), then the connected account, cut short to fit and whole in its title,
 * with a button that copies it; or "Connect wallet" when no account is connected. Both lead to the
 * Wallet page. While the wallet store looks (`ready` false), the account's place is a placeholder
 * of its size, so that a page that is about to show the account never shows Connect first. On a
 * phone it is the dot and a short account.
 */
export function AccountGroup({ ready, accountId }: { ready: boolean; accountId: string | null }) {
  return (
    <div className="flex h-10 min-w-0 items-center rounded-full border border-line bg-panel">
      <LiveStatus />
      {!ready ? (
        <span className={PART}>
          <span
            role="status"
            aria-label="Checking your wallet"
            data-testid="wallet-pill-placeholder"
            className="mx-3 block h-3 w-16 animate-pulse rounded-full bg-raised motion-reduce:animate-none sm:mx-4 sm:w-28"
          >
            <span className="sr-only">Checking your wallet</span>
          </span>
        </span>
      ) : accountId === null ? (
        <span className={PART}>
          <Link
            href="/wallet"
            aria-label="Connect wallet"
            className="flex h-10 items-center rounded-r-full pr-4 pl-3.5 text-[13px] font-medium whitespace-nowrap text-bone transition-colors hover:bg-raised/60 motion-reduce:transition-none"
          >
            Connect<span className="max-sm:hidden">{"\u00a0"}wallet</span>
          </Link>
        </span>
      ) : (
        <span className={`${PART} gap-1 pr-1`}>
          <Link
            href="/wallet"
            title={accountId}
            className="flex h-10 min-w-0 items-center rounded-full pr-2.5 pl-3.5 font-mono sm:pr-0 text-[13px] text-bone transition-colors hover:text-white motion-reduce:transition-none"
          >
            <span className="max-w-[6.5rem] truncate sm:max-w-44">{accountId}</span>
          </Link>
          <CopyButton value={accountId} label="Copy account" className="max-sm:hidden" />
        </span>
      )}
    </div>
  );
}
