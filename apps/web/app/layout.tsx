import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tender",
  description: "A non-custodial task-bounty protocol on NEAR.",
};

// The page and nothing else. The landing (app/page.tsx) is full-bleed with a top bar of its own;
// every other page is in the (app) group, whose layout adds the Nav and the column.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="text-neutral-900">{children}</body>
    </html>
  );
}
