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
  onSwitchProject: (project: { id: string; name: string }) => void;
  children: ReactNode;
}

export function Layout({ active, onNavigate, title, session, onLogout, onSwitchProject, children }: LayoutProps) {
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
        session={session}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-olive-dark/[0.06] bg-sand/80 px-4 py-4 backdrop-blur-md md:px-8">
          <button
            className="rounded-lg p-1.5 text-olive-dark transition hover:bg-olive-dark/[0.06] md:hidden"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
          >
            <MenuIcon className="h-5 w-5" />
          </button>
          <h2 className="text-lg font-semibold tracking-tight text-olive-dark">{title}</h2>

          {session.project && (
            <span className="ml-auto hidden max-w-[240px] items-center gap-2 rounded-full border border-olive-dark/[0.07] bg-white/70 py-1.5 pr-3.5 pl-2.5 text-xs font-medium text-olive-dark/75 sm:flex">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sage" />
              <span className="truncate">{session.project.name}</span>
            </span>
          )}
        </header>

        <main className="flex-1 overflow-y-auto p-4 md:p-8">{children}</main>
      </div>

      {accountOpen && (
        <AccountPanel
          session={session}
          onLogout={onLogout}
          onClose={() => setAccountOpen(false)}
          onSwitchProject={onSwitchProject}
        />
      )}
    </div>
  );
}
