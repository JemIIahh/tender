import { HeadSkeleton, RouteSkeleton } from "../../../components/Skeleton";
import { MetricsSkeleton } from "../../../components/SkeletonLists";

// Metrics while they load: the head, the two rows of figures, the chart and the top agents. The
// shapes are the ones the page shows while its figures are counted (components/Skeleton.tsx), in
// the same boxes, so nothing moves.
export default function Loading() {
  return (
    <RouteSkeleton frame="mx-auto grid w-full max-w-[1400px] gap-8">
      <HeadSkeleton title={["w-11/12", "w-4/5"]} phone={["w-full", "w-1/2"]} />
      <div className="grid gap-8">
        <MetricsSkeleton />
      </div>
    </RouteSkeleton>
  );
}
