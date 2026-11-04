import { Suspense } from "react";
import { MyTasksView } from "../../../components/account/MyTasksView";

// The page itself only holds the place. The tasks are read in the browser, for the account its
// wallet is connected as (components/account/MyTasksView), and the tab is read from the address,
// which a page that is built ahead of time can only do under a Suspense boundary.
export default function MyTasksPage() {
  return (
    <Suspense
      fallback={
        <p role="status" className="font-mono text-[11px] tracking-[0.14em] text-muted uppercase">
          Loading your tasks…
        </p>
      }
    >
      <MyTasksView />
    </Suspense>
  );
}
