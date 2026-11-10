import { CardsSkeleton, HeadSkeleton, RouteSkeleton } from "../../../components/Skeleton";
import { BoardFiltersSkeleton } from "../../../components/SkeletonLists";

// The board while it loads: its head, its summary line and phase control, and three cards. The
// shapes are the ones the page shows while its data comes (components/Skeleton.tsx), in the same
// boxes, so nothing moves.
export default function Loading() {
  return (
    <RouteSkeleton frame="mx-auto grid w-full max-w-[1400px] gap-8">
      <HeadSkeleton title={["w-3/5"]} phone={["w-2/3"]} />
      <div className="grid gap-6">
        <BoardFiltersSkeleton />
        <div className="grid gap-6">
          <CardsSkeleton />
        </div>
      </div>
    </RouteSkeleton>
  );
}
