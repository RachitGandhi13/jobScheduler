import { useState, type FormEvent } from "react";
import type { DashboardSettings } from "../settings";
import { GlassCard } from "./GlassCard";
import { CloseIcon } from "./icons";

interface SettingsPanelProps {
  settings: DashboardSettings;
  onSave: (next: DashboardSettings) => void;
  onClose: () => void;
}

export function SettingsPanel({ settings, onSave, onClose }: SettingsPanelProps) {
  const [form, setForm] = useState(settings);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSave(form);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-olive-dark/20 p-4 backdrop-blur-sm">
      <GlassCard className="w-full max-w-md p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-olive-dark">Connection settings</h2>
          <button onClick={onClose} className="text-olive-dark/60 hover:text-olive-dark" aria-label="Close">
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>
        <p className="mb-4 text-sm text-olive-dark/70">
          No login flow yet — this dashboard authenticates the same way backend-api's{" "}
          <code className="rounded bg-sage/30 px-1">MOCK_AUTH</code> mode does, via headers. Paste in an
          existing organization and project id.
        </p>
        <form className="space-y-3" onSubmit={handleSubmit}>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-olive-dark">Organization ID</span>
            <input
              className="w-full rounded-lg border border-olive/20 bg-white/80 px-3 py-2 text-sm outline-none focus:border-olive"
              value={form.organizationId}
              onChange={(e) => setForm((f) => ({ ...f, organizationId: e.target.value }))}
              placeholder="00000000-0000-0000-0000-000000000000"
              required
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-olive-dark">Project ID</span>
            <input
              className="w-full rounded-lg border border-olive/20 bg-white/80 px-3 py-2 text-sm outline-none focus:border-olive"
              value={form.projectId}
              onChange={(e) => setForm((f) => ({ ...f, projectId: e.target.value }))}
              placeholder="00000000-0000-0000-0000-000000000000"
              required
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-olive-dark">User ID</span>
            <input
              className="w-full rounded-lg border border-olive/20 bg-white/80 px-3 py-2 text-sm outline-none focus:border-olive"
              value={form.userId}
              onChange={(e) => setForm((f) => ({ ...f, userId: e.target.value }))}
            />
          </label>
          <button
            type="submit"
            className="w-full rounded-lg bg-olive px-4 py-2 text-sm font-medium text-white transition hover:bg-olive-dark"
          >
            Save
          </button>
        </form>
      </GlassCard>
    </div>
  );
}
