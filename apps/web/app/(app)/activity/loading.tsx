import { HeadSkeleton, RouteSkeleton } from "../../../components/Skeleton";
import { FeedSkeleton } from "../../../components/SkeletonLists";

// Activity while it loads: the head and the feed's filters and lines. The shapes are the ones the page shows
// while its data comes (components/Skeleton.tsx), in the same boxes, so nothing moves.
export default function Loading() {
  return (
    <RouteSkeleton frame="mx-auto grid w-full max-w-5xl gap-8">
      <HeadSkeleton title={["w-11/12", "w-3/5"]} phone={["w-1/2"]} />
      <FeedSkeleton />
    </RouteSkeleton>
  );
}
