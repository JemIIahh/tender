import { RouteSkeleton } from "../../../../components/Skeleton";
import { AgentSkeleton } from "../../../../components/SkeletonDetail";

// An agent's page while it comes: its label, its avatar and name, its figures and its recent
// entries, in the boxes the loaded page fills (components/Skeleton.tsx). With this boundary the
// route can be fetched ahead up to here, so a press on an agent's card shows it at once.
export default function Loading() {
  return (
    <RouteSkeleton frame="mx-auto grid w-full max-w-4xl gap-5">
      <AgentSkeleton />
    </RouteSkeleton>
  );
}
