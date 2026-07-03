import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Job, JobLog } from "../types";
import { CloseIcon } from "./icons";

interface JobDetailPanelProps {
  job: Job | null;
  onClose: () => void;
}

const LEVEL_STYLES: Record<JobLog["level"], string> = {
  debug: "text-olive-dark/50",
  info: "text-olive-dark",
  warn: "text-terracotta",
  error: "text-terracotta font-medium",
};

/** Slide-out panel: job summary + its full execution log trace, out of JobLogs. */
export function JobDetailPanel({ job, onClose }: JobDetailPanelProps) {
  const [logs, setLogs] = useState<JobLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!job) return;
    setLogs(null);
    setError(null);
    api
      .getJobLogs(job.id)
      .then((res) => setLogs(res.data))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [job]);

  const open = job !== null;

  return (
    <>
      {open && <div className="fixed inset-0 z-40 bg-olive-dark/20 backdrop-blur-sm" onClick={onClose} />}
      <div
        className={`fixed inset-y-0 right-0 z-50 w-full max-w-lg transform overflow-y-auto border-l border-white/40 bg-white/80 p-6 backdrop-blur-md transition-transform duration-200 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {job && (
          <>
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-olive-dark/50">Job</p>
                <h3 className="break-all font-mono text-sm font-semibold text-olive-dark">{job.id}</h3>
              </div>
              <button onClick={onClose} className="shrink-0 text-olive-dark/60 hover:text-olive-dark" aria-label="Close">
                <CloseIcon className="h-5 w-5" />
              </button>
            </div>

            <dl className="mb-6 grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-olive-dark/60">Type</dt>
              <dd className="text-right font-medium text-olive-dark">{job.type}</dd>
              <dt className="text-olive-dark/60">Status</dt>
              <dd className="text-right font-medium text-olive-dark">{job.status}</dd>
              <dt className="text-olive-dark/60">Attempts</dt>
              <dd className="text-right font-medium text-olive-dark">
                {job.attempts} / {job.maxAttempts}
              </dd>
              <dt className="text-olive-dark/60">Run at</dt>
              <dd className="text-right font-medium text-olive-dark">{new Date(job.runAt).toLocaleString()}</dd>
              {job.cronExpression && (
                <>
                  <dt className="text-olive-dark/60">Cron</dt>
                  <dd className="text-right font-mono text-xs font-medium text-olive-dark">{job.cronExpression}</dd>
                </>
              )}
              {job.lastError && (
                <>
                  <dt className="text-olive-dark/60">Last error</dt>
                  <dd className="text-right font-medium text-terracotta">{job.lastError}</dd>
                </>
              )}
            </dl>

            <h4 className="mb-2 text-sm font-semibold text-olive-dark">Execution trace</h4>
            {error && <p className="text-sm text-terracotta">{error}</p>}
            {!error && !logs && <p className="text-sm text-olive-dark/50">Loading logs…</p>}
            {!error && logs && logs.length === 0 && <p className="text-sm text-olive-dark/50">No log entries yet.</p>}
            {!error && logs && logs.length > 0 && (
              <ul className="space-y-2">
                {logs.map((entry) => (
                  <li key={entry.id} className="rounded-lg bg-white/60 p-3 text-sm">
                    <div className="mb-1 flex items-center justify-between text-xs text-olive-dark/50">
                      <span className="uppercase">{entry.level}</span>
                      <span>{new Date(entry.createdAt).toLocaleTimeString()}</span>
                    </div>
                    <p className={LEVEL_STYLES[entry.level]}>{entry.message}</p>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </>
  );
}
