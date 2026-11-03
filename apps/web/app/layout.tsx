import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tender",
  description: "A non-custodial task-bounty protocol on NEAR.",
};

// The page and nothing else. The landing (app/page.tsx) is full-bleed with a top bar of its own;
// every other page is in the (app) group, whose layout adds the sidebar and the top bar. Both are
// on the same dark ground, which the body has too, so that a page pulled past its end stays dark.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-ink text-bone">{children}</body>
    </html>
  );
}
