import type { Metadata } from "next";
import type { ReactNode } from "react";
import { preconnect } from "react-dom";
import { config } from "../lib/config";
import { SIDEBAR_SCRIPT } from "../lib/sidebar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tender",
  description: "A task-bounty market on NEAR: rewards in escrow in a contract.",
};

// The page and nothing else. The landing (app/page.tsx) is full-bleed with a top bar of its own;
// every other page is in the (app) group, whose layout adds the sidebar and the top bar. Both are
// on the same dark ground, which the body has too, so that a page pulled past its end stays dark.
//
// The script in the head puts back the viewer's choice of sidebar (lib/sidebar.ts) before the page
// is drawn. It sets an attribute on <html> that the server does not render, hence
// `suppressHydrationWarning`, which covers the attributes of <html> and nothing under it.
//
// Every page reads the API from the browser, once its code has run. The connection to the API's
// origin is opened while that code loads (`preconnect`, which React puts in the head), so the first
// read does not wait for it. The page asks without credentials (CORS), hence `anonymous`.
export default function RootLayout({ children }: { children: ReactNode }) {
  preconnect(config.apiUrl, { crossOrigin: "anonymous" });
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script>{SIDEBAR_SCRIPT}</script>
      </head>
      <body className="bg-ink text-bone">{children}</body>
    </html>
  );
}
