import { HeadSkeleton, RouteSkeleton } from "../../../components/Skeleton";
import { FormsSkeleton } from "../../../components/SkeletonDetail";

// How it works while it loads: the head and its first parts. The shapes are the ones the page shows
// while its data comes (components/Skeleton.tsx), in the same boxes, so nothing moves.
export default function Loading() {
  return (
    <RouteSkeleton frame="mx-auto grid w-full max-w-[1400px] gap-10">
      <HeadSkeleton title={["w-11/12", "w-3/5"]} phone={["w-2/3"]} />
      <FormsSkeleton panels={2} />
    </RouteSkeleton>
  );
}
