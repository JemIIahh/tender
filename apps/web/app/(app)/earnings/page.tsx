import { Suspense } from "react";
import { EarningsView } from "../../../components/account/EarningsView";

// The page itself only holds the place. The figures are read in the browser, for the account its
// wallet is connected as (components/account/EarningsView), and the tab is read from the address,
// which a page that is built ahead of time can only do under a Suspense boundary.
export default function EarningsPage() {
  return (
    <Suspense
      fallback={
        <p role="status" className="font-mono text-[11px] tracking-[0.14em] text-muted uppercase">
          Loading earnings…
        </p>
      }
    >
      <EarningsView />
    </Suspense>
  );
}
