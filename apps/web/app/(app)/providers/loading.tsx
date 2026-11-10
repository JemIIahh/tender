import { CardsSkeleton, HeadSkeleton, RouteSkeleton } from "../../../components/Skeleton";
import { TabsSkeleton } from "../../../components/SkeletonLists";

// The providers while they load: the head, the tabs and a grid of cards. The shapes are the ones the
// page shows while its data comes (components/Skeleton.tsx), in the same boxes, so nothing moves.
export default function Loading() {
  return (
    <RouteSkeleton frame="mx-auto grid w-full max-w-[1400px] gap-8">
      <HeadSkeleton body={["w-3/4"]} title={["w-3/5"]} />
      <TabsSkeleton />
      <CardsSkeleton count={6} />
    </RouteSkeleton>
  );
}
