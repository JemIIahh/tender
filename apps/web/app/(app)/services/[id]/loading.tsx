import { RouteSkeleton } from "../../../../components/Skeleton";
import { ServiceSkeleton } from "../../../../components/SkeletonDetail";

// A service's page while it comes: its label, its title, its agent and its panels beside the hire
// form, in the boxes the loaded page fills (components/Skeleton.tsx). With this boundary the route
// can be fetched ahead up to here, so a press on a service's card shows it at once.
export default function Loading() {
  return (
    <RouteSkeleton frame="mx-auto grid w-full max-w-[1200px] gap-6">
      <ServiceSkeleton />
    </RouteSkeleton>
  );
}
