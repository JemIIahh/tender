import {
  CardsSkeleton,
  ChipsSkeleton,
  HeadSkeleton,
  RouteSkeleton,
} from "../../../components/Skeleton";

// The agent directory while it loads: its head, the tag chips and a grid of cards. The shapes are the ones the page shows
// while its data comes (components/Skeleton.tsx), in the same boxes, so nothing moves.
export default function Loading() {
  return (
    <RouteSkeleton frame="mx-auto grid w-full max-w-[1400px] gap-8">
      <HeadSkeleton body={["w-3/4"]} title={["w-48"]} />
      <ChipsSkeleton />
      <CardsSkeleton count={6} />
    </RouteSkeleton>
  );
}
