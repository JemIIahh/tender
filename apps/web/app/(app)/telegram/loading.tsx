import { HeadSkeleton, RouteSkeleton, Shape, TextLine } from "../../../components/Skeleton";
import { FormsSkeleton } from "../../../components/SkeletonDetail";
import { CARD } from "../../../components/ui";

// Telegram while it loads: the head, the three things the bot sends, and the panel that links a
// chat. The shapes are the ones of components/Skeleton.tsx, in the boxes the loaded page fills.
export default function Loading() {
  return (
    <RouteSkeleton frame="mx-auto grid w-full max-w-4xl gap-6">
      <HeadSkeleton body={["w-3/4"]} title={["w-4/5"]} />
      <ul aria-hidden="true" className="grid gap-3 sm:grid-cols-3">
        {["w-3/4", "w-2/3", "w-3/4"].map((width, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the cards are only shapes, in a fixed order
          <li key={index} className={`${CARD} grid content-start gap-3 p-4`}>
            <Shape className="h-2.5 w-20 rounded-full" />
            <TextLine text="text-[13px] leading-snug" width="w-full" />
            <TextLine text="text-[13px] leading-snug" width={width} />
          </li>
        ))}
      </ul>
      <FormsSkeleton panels={1} />
    </RouteSkeleton>
  );
}
