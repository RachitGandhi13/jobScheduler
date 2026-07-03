import { CloseIcon, JobsIcon, OverviewIcon, QueuesIcon, SettingsIcon } from "./icons";

export type TabKey = "overview" | "queues" | "jobs";

const NAV_ITEMS: { key: TabKey; label: string; Icon: typeof OverviewIcon }[] = [
  { key: "overview", label: "Overview", Icon: OverviewIcon },
  { key: "queues", label: "Queues", Icon: QueuesIcon },
  { key: "jobs", label: "Jobs", Icon: JobsIcon },
];

interface SidebarProps {
  active: TabKey;
  onNavigate: (tab: TabKey) => void;
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
}

export function Sidebar({ active, onNavigate, open, onClose, onOpenSettings }: SidebarProps) {
  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-olive-dark/20 backdrop-blur-sm md:hidden" onClick={onClose} />}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-white/40 bg-white/70 p-5 backdrop-blur-md transition-transform duration-200 md:static md:translate-x-0 md:shadow-[0_8px_30px_rgb(0,0,0,0.02)] ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="mb-8 flex items-center justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-olive/70">Scheduler</p>
            <h1 className="text-lg font-semibold text-olive-dark">Control Room</h1>
          </div>
          <button className="text-olive-dark/60 hover:text-olive-dark md:hidden" onClick={onClose} aria-label="Close menu">
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-1">
          {NAV_ITEMS.map(({ key, label, Icon }) => (
            <button
              key={key}
              onClick={() => {
                onNavigate(key);
                onClose();
              }}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                active === key ? "bg-olive text-white shadow-[0_8px_30px_rgb(0,0,0,0.06)]" : "text-olive-dark/80 hover:bg-sage/40"
              }`}
            >
              <Icon className="h-5 w-5" />
              {label}
            </button>
          ))}
        </nav>

        <button
          onClick={onOpenSettings}
          className="mt-4 flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-olive-dark/70 transition hover:bg-sage/40"
        >
          <SettingsIcon className="h-5 w-5" />
          Connection settings
        </button>
      </aside>
    </>
  );
}
