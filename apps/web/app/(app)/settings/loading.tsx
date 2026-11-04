import { HeadSkeleton, RouteSkeleton } from "../../../components/Skeleton";
import { FormsSkeleton } from "../../../components/SkeletonDetail";

// Settings while they load: the head and the first panels. The shapes are the ones the page shows
// while its data comes (components/Skeleton.tsx), in the same boxes, so nothing moves.
export default function Loading() {
  return (
    <RouteSkeleton frame="mx-auto grid w-full max-w-4xl gap-6">
      <HeadSkeleton art={false} title={["w-4/5"]} />
      <FormsSkeleton panels={3} />
    </RouteSkeleton>
  );
}
