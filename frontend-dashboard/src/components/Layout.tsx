import { useState, type ReactNode } from "react";
import type { AuthSession } from "../auth";
import { AccountPanel } from "./AccountPanel";
import { MenuIcon } from "./icons";
import { Sidebar, type TabKey } from "./Sidebar";

interface LayoutProps {
  active: TabKey;
  onNavigate: (tab: TabKey) => void;
  title: string;
  session: AuthSession;
  onLogout: () => void;
  children: ReactNode;
}

export function Layout({ active, onNavigate, title, session, onLogout, children }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-sand">
      <Sidebar
        active={active}
        onNavigate={onNavigate}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onOpenAccount={() => setAccountOpen(true)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-white/40 bg-white/50 px-4 py-4 backdrop-blur-md md:px-8">
          <button
            className="rounded-lg p-1.5 text-olive-dark hover:bg-sage/40 md:hidden"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
          >
            <MenuIcon className="h-5 w-5" />
          </button>
          <h2 className="text-lg font-semibold text-olive-dark">{title}</h2>
        </header>

        <main className="flex-1 overflow-y-auto p-4 md:p-8">{children}</main>
      </div>

      {accountOpen && (
        <AccountPanel session={session} onLogout={onLogout} onClose={() => setAccountOpen(false)} />
      )}
    </div>
  );
}
