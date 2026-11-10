import { CardsSkeleton, HeadSkeleton, RouteSkeleton, Shape } from "../../../components/Skeleton";

// The services while they load: the head, the search and a grid of cards. The shapes are the ones
// the page shows while its data comes (components/Skeleton.tsx), in the same boxes, so nothing moves.
export default function Loading() {
  return (
    <RouteSkeleton frame="mx-auto grid w-full max-w-[1400px] gap-8">
      <HeadSkeleton body={["w-3/4"]} title={["w-11/12", "w-1/4"]} phone={["w-1/2"]} />
      <Shape className="h-11 w-full max-w-2xl rounded-full" />
      <CardsSkeleton count={6} />
    </RouteSkeleton>
  );
}
