import { HeadSkeleton, RouteSkeleton } from "../../../components/Skeleton";
import { ListSkeleton } from "../../../components/SkeletonLists";

// My agents while it loads: the head and the list of agents. The shapes are the ones the page shows
// while its data comes (components/Skeleton.tsx), in the same boxes, so nothing moves.
export default function Loading() {
  return (
    <RouteSkeleton frame="mx-auto grid w-full max-w-[1400px] gap-8">
      <HeadSkeleton title={["w-11/12", "w-2/5"]} phone={["w-1/2"]} />
      <ListSkeleton />
    </RouteSkeleton>
  );
}
