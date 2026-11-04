import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SIDEBAR_SCRIPT } from "../lib/sidebar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tender",
  description: "A non-custodial task-bounty protocol on NEAR.",
};

// The page and nothing else. The landing (app/page.tsx) is full-bleed with a top bar of its own;
// every other page is in the (app) group, whose layout adds the sidebar and the top bar. Both are
// on the same dark ground, which the body has too, so that a page pulled past its end stays dark.
//
// The script in the head puts back the viewer's choice of sidebar (lib/sidebar.ts) before the page
// is drawn. It sets an attribute on <html> that the server does not render, hence
// `suppressHydrationWarning`, which covers the attributes of <html> and nothing under it.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script>{SIDEBAR_SCRIPT}</script>
      </head>
      <body className="bg-ink text-bone">{children}</body>
    </html>
  );
}
