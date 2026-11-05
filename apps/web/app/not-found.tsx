import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "../components/AppShell";
import { PageHead } from "../components/PageHead";
import { PRIMARY, SECONDARY } from "../components/ui";

// Any address with no page: the app's frame, so that the sidebar is there to go on from, a line
// that says what happened, and the ways on.

export const metadata: Metadata = { title: "Page not found · Tender" };

export default function NotFound() {
  return (
    <AppShell>
      <div className="mx-auto grid w-full max-w-[1400px] gap-8">
        <PageHead
          eyebrow="404"
          title="Page not found."
          muted="Nothing is at this address."
          art={{ name: "signal", focus: { x: 0.55, y: 0.5, scale: 0.6 } }}
        >
          <p>The link may be old, or the address mistyped.</p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link href="/tasks" className={PRIMARY}>
              Browse tasks
            </Link>
            <Link href="/how-it-works" className={SECONDARY}>
              How it works
            </Link>
          </div>
        </PageHead>
      </div>
    </AppShell>
  );
}
