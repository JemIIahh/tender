import Link from "next/link";
import { SECONDARY } from "./ui";

/** A pill of a top bar: the app's and the landing's. */
export const BAR_PILL = "min-h-10 px-3.5 whitespace-nowrap sm:px-4";

/**
 * The connected account, as a top bar names it: a red dot and the account as it is written (lower
 * case), cut short to fit, whole in its title. It leads to the Wallet page.
 */
export function AccountPill({ accountId }: { accountId: string }) {
  return (
    <Link
      href="/wallet"
      title={accountId}
      className={`${SECONDARY} ${BAR_PILL} max-w-[7.5rem] sm:max-w-60`}
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-seal" />
      <span className="truncate text-xs tracking-normal normal-case">{accountId}</span>
    </Link>
  );
}
