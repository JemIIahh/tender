import { HeadSkeleton, RouteSkeleton } from "../../../components/Skeleton";
import { StatsSkeleton, TableSkeleton } from "../../../components/SkeletonLists";

// Earnings while it loads: the head, the figures and the panel of tabs and rows. The shapes are the ones the page shows
// while its data comes (components/Skeleton.tsx), in the same boxes, so nothing moves.
export default function Loading() {
  return (
    <RouteSkeleton frame="mx-auto grid w-full max-w-[1400px] gap-8">
      <HeadSkeleton title={["w-11/12", "w-3/5"]} phone={["w-full", "w-1/3"]} />
      <StatsSkeleton count={4} columns={4} />
      <TableSkeleton tabs={2} />
    </RouteSkeleton>
  );
}
