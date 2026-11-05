import { HeadSkeleton, RouteSkeleton } from "../../../components/Skeleton";
import { FormsSkeleton } from "../../../components/SkeletonDetail";

// The wallet while it loads: the head and its first panels. The shapes are the ones the page shows
// while its data comes (components/Skeleton.tsx), in the same boxes, so nothing moves.
export default function Loading() {
  return (
    <RouteSkeleton frame="mx-auto grid w-full max-w-6xl gap-5">
      <HeadSkeleton body={["w-3/4"]} title={["w-40"]} />
      <FormsSkeleton panels={2} />
    </RouteSkeleton>
  );
}
