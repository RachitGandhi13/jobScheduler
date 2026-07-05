import type { AuthSession } from "../auth";
import { BrandMark, CloseIcon, JobsIcon, OverviewIcon, QueuesIcon } from "./icons";

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
  onOpenAccount: () => void;
  session: AuthSession;
}

/** "AL" from "Ada Lovelace", or the first letters of an email's local part. */
function initials(name: string | null, email: string): string {
  const source = name?.trim() || email;
  const parts = source.split(/[\s._@-]+/).filter(Boolean);
  const derived = `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  return derived || source.slice(0, 1).toUpperCase();
}

export function Sidebar({ active, onNavigate, open, onClose, onOpenAccount, session }: SidebarProps) {
  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-espresso/30 backdrop-blur-sm md:hidden" onClick={onClose} />}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[264px] flex-col border-r border-olive-dark/[0.06] bg-white/70 p-5 backdrop-blur-md transition-transform duration-200 md:static md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <BrandMark className="h-9 w-9" />
            <div>
              <h1 className="text-[15px] leading-tight font-semibold tracking-tight text-olive-dark">Scheduler</h1>
              <p className="text-[9px] font-semibold tracking-[0.22em] text-olive">CONTROL ROOM</p>
            </div>
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
                active === key
                  ? "bg-olive text-white shadow-[0_10px_22px_-10px_rgba(138,58,31,0.65)]"
                  : "text-olive-dark/65 hover:bg-olive-dark/[0.05] hover:text-olive-dark"
              }`}
            >
              <Icon className="h-[18px] w-[18px]" />
              {label}
            </button>
          ))}
        </nav>

        <button
          onClick={onOpenAccount}
          aria-label="Account"
          className="mt-4 flex w-full items-center gap-3 rounded-xl border border-olive-dark/[0.06] bg-white/60 p-2.5 text-left transition hover:border-olive-dark/15 hover:bg-white"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-olive text-[13px] font-semibold text-white">
            {initials(session.user.name, session.user.email)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold text-olive-dark">
              {session.user.name ?? session.user.email.split("@")[0]}
            </span>
            <span className="block truncate text-[11px] text-olive-dark/50">{session.user.email}</span>
          </span>
          <span className="shrink-0 rounded-full bg-sage/25 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-olive-dark/70 uppercase">
            {session.role}
          </span>
        </button>
      </aside>
    </>
  );
}
