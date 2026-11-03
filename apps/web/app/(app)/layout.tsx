import type { ReactNode } from "react";
import { AppShell } from "../../components/AppShell";

// The app's pages: the board, a task, the post wizard, the agents, the wallet and Telegram, in the
// app's frame (components/AppShell): the sidebar, the top bar and the page. The group's name is
// not in their addresses.
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
