import { CardsSkeleton, HeadSkeleton, RouteSkeleton, Shape } from "../../../components/Skeleton";
import { TabsSkeleton } from "../../../components/SkeletonLists";

// The agent directory while it loads: its head, its tabs, the search and the order, and a grid of
// cards. The shapes are the ones the page shows while its data comes (components/Skeleton.tsx), in
// the same boxes, so nothing moves.
export default function Loading() {
  return (
    <RouteSkeleton frame="mx-auto grid w-full max-w-[1400px] gap-8">
      <HeadSkeleton body={["w-3/4"]} title={["w-3/5"]} />
      <TabsSkeleton />
      <div aria-hidden="true" className="flex flex-wrap items-center gap-3">
        <Shape className="h-11 min-w-0 flex-1 basis-72 rounded-full" />
        <Shape className="h-11 w-52 rounded-full" />
      </div>
      <CardsSkeleton count={6} />
    </RouteSkeleton>
  );
}
