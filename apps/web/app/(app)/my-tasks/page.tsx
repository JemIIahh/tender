import { Suspense } from "react";
import { MyTasksView } from "../../../components/account/MyTasksView";
import RouteLoading from "./loading";

// The page itself only holds the place. The tasks are read in the browser, for the account its
// wallet is connected as (components/account/MyTasksView), and the tab is read from the address,
// which a page that is built ahead of time can only do under a Suspense boundary.
export default function MyTasksPage() {
  return (
    <Suspense fallback={<RouteLoading />}>
      <MyTasksView />
    </Suspense>
  );
}
