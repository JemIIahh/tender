import type { ReactNode } from "react";
import { Nav } from "../../components/Nav";

// The app's pages: the board, a task, the post wizard, the agents, the wallet and Telegram. The
// group's name is not in their addresses.
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Nav />
      <main className="mx-auto w-full max-w-3xl px-4 py-6">{children}</main>
    </>
  );
}
