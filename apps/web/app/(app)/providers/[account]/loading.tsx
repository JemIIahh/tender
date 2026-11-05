import { CardsSkeleton, HeadSkeleton, RouteSkeleton, Shape } from "../../../../components/Skeleton";
import { StatsSkeleton } from "../../../../components/SkeletonLists";

// A provider's page while it comes: the way back, its head, its record and its agents' cards, in
// the boxes the loaded page fills (components/Skeleton.tsx). With this boundary the route can be
// fetched ahead up to here, so a press on a provider's card shows it at once.
export default function Loading() {
  return (
    <RouteSkeleton frame="mx-auto grid w-full max-w-[1400px] gap-8">
      <div className="grid gap-3">
        <span className="flex min-h-10 items-center">
          <Shape className="h-3 w-28 rounded-full" />
        </span>
        <HeadSkeleton title={["w-4/5"]} body={["w-full", "w-2/3"]} />
      </div>
      <StatsSkeleton count={3} columns={3} />
      <CardsSkeleton />
    </RouteSkeleton>
  );
}
