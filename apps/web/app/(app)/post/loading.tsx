import { HeadSkeleton, RouteSkeleton } from "../../../components/Skeleton";
import { FormsSkeleton } from "../../../components/SkeletonDetail";

// The post wizard while it loads: the head and its first steps. The shapes are the ones the page shows
// while its data comes (components/Skeleton.tsx), in the same boxes, so nothing moves.
export default function Loading() {
  return (
    <RouteSkeleton frame="mx-auto grid w-full max-w-4xl gap-6">
      <HeadSkeleton body={["w-3/4"]} title={["w-3/5"]} />
      <FormsSkeleton panels={2} />
    </RouteSkeleton>
  );
}
