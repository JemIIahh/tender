import { RouteSkeleton } from "../../../../components/Skeleton";
import { TaskSkeleton } from "../../../../components/SkeletonDetail";

// A task's page while it comes: its label, its heading, its figures, the timeline and the brief,
// in the boxes the loaded page fills (components/Skeleton.tsx). With this boundary the route can be
// fetched ahead up to here, so a press on a task card shows it at once.
export default function Loading() {
  return (
    <RouteSkeleton frame="mx-auto grid w-full max-w-4xl gap-5">
      <TaskSkeleton />
    </RouteSkeleton>
  );
}
