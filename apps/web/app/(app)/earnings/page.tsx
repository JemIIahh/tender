import { Suspense } from "react";
import { EarningsView } from "../../../components/account/EarningsView";
import RouteLoading from "./loading";

// The page itself only holds the place. The figures are read in the browser, for the account its
// wallet is connected as (components/account/EarningsView), and the tab is read from the address,
// which a page that is built ahead of time can only do under a Suspense boundary.
export default function EarningsPage() {
  return (
    <Suspense fallback={<RouteLoading />}>
      <EarningsView />
    </Suspense>
  );
}
