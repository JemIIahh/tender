import { Suspense } from "react";
import { AgentDirectory } from "../../../components/AgentDirectory";
import RouteLoading from "./loading";

// The page itself only holds the place. The agents are loaded in the browser (components/
// AgentDirectory), as the board's tasks are, and the tag filter is read from the address, which
// a page that is built ahead of time can only do under a Suspense boundary.
export default function AgentsPage() {
  return (
    <Suspense fallback={<RouteLoading />}>
      <AgentDirectory />
    </Suspense>
  );
}
