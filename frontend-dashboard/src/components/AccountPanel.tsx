import type { AuthSession } from "../auth";
import { GlassCard } from "./GlassCard";
import { CloseIcon } from "./icons";

interface AccountPanelProps {
  session: AuthSession;
  onLogout: () => void;
  onClose: () => void;
}

export function AccountPanel({ session, onLogout, onClose }: AccountPanelProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-olive-dark/20 p-4 backdrop-blur-sm">
      <GlassCard className="w-full max-w-md p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-olive-dark">Account</h2>
          <button onClick={onClose} className="text-olive-dark/60 hover:text-olive-dark" aria-label="Close">
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <dl className="mb-6 space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-olive-dark/60">Email</dt>
            <dd className="font-medium text-olive-dark">{session.user.email}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-olive-dark/60">Organization</dt>
            <dd className="font-medium text-olive-dark">{session.organization.name}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-olive-dark/60">Project</dt>
            <dd className="font-medium text-olive-dark">{session.project?.name ?? "—"}</dd>
          </div>
        </dl>

        <button
          onClick={onLogout}
          className="w-full rounded-lg bg-terracotta px-4 py-2 text-sm font-medium text-white transition hover:bg-terracotta-light hover:text-olive-dark"
        >
          Log out
        </button>
      </GlassCard>
    </div>
  );
}
