import { useState, type ReactNode } from "react";
import type { DashboardSettings } from "../settings";
import { MenuIcon } from "./icons";
import { Sidebar, type TabKey } from "./Sidebar";
import { SettingsPanel } from "./SettingsPanel";

interface LayoutProps {
  active: TabKey;
  onNavigate: (tab: TabKey) => void;
  title: string;
  settings: DashboardSettings;
  onSaveSettings: (next: DashboardSettings) => void;
  children: ReactNode;
}

export function Layout({ active, onNavigate, title, settings, onSaveSettings, children }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-sand">
      <Sidebar
        active={active}
        onNavigate={onNavigate}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onOpenSettings={() => setSettingsOpen(true)}
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

      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          onSave={onSaveSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
