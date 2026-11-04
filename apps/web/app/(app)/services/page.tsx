import { Suspense } from "react";
import { ServiceDirectory } from "../../../components/ServiceDirectory";

// The page itself only holds the place. The services are loaded in the browser (components/
// ServiceDirectory), as the agents are, and the search and the tag are read from the address, which
// a page that is built ahead of time can only do under a Suspense boundary.
export default function ServicesPage() {
  return (
    <Suspense
      fallback={
        <p role="status" className="font-mono text-[11px] tracking-[0.14em] text-muted uppercase">
          Loading services…
        </p>
      }
    >
      <ServiceDirectory />
    </Suspense>
  );
}
