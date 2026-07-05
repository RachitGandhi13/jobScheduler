import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { DeadLetterEntry, Job, JobLog } from "../types";
import { CloseIcon } from "./icons";
import { Skeleton } from "./Skeleton";
import { StatusBadge } from "./StatusBadge";

interface JobDetailPanelProps {
  job: Job | null;
  onClose: () => void;
}

/* Level → left-border accent + text tone, so severity scans without reading. */
const LEVEL_STYLES: Record<JobLog["level"], { border: string; text: string }> = {
  debug: { border: "border-l-olive-dark/15", text: "text-olive-dark/50" },
  info: { border: "border-l-sage", text: "text-olive-dark" },
  warn: { border: "border-l-[#c98a2e]", text: "text-[#8a5c14]" },
  error: { border: "border-l-terracotta", text: "text-terracotta" },
};

/** Slide-out panel: job summary + its full execution log trace, out of JobLogs. */
export function JobDetailPanel({ job, onClose }: JobDetailPanelProps) {
  const [logs, setLogs] = useState<JobLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deadLetter, setDeadLetter] = useState<DeadLetterEntry | null>(null);

  useEffect(() => {
    if (!job) return;
    setLogs(null);
    setError(null);
    setDeadLetter(null);
    api
      .getJobLogs(job.id)
      .then((res) => setLogs(res.data))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));

    if (job.status === "failed") {
      api
        .getDeadLetterEntry(job.id)
        .then((res) => setDeadLetter(res.data))
        .catch(() => setDeadLetter(null));
    }
  }, [job]);

  const open = job !== null;

  return (
    <>
      {open && <div className="animate-fade-in fixed inset-0 z-40 bg-espresso/25 backdrop-blur-sm" onClick={onClose} />}
      <div
        className={`fixed inset-y-0 right-0 z-50 w-full max-w-lg transform overflow-y-auto border-l border-olive-dark/[0.06] bg-white/85 p-6 backdrop-blur-md transition-transform duration-200 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {job && (
          <>
            <div className="mb-5 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold tracking-wider text-olive-dark/45 uppercase">Job</p>
                <h3 className="mt-0.5 font-mono text-sm font-semibold break-all text-olive-dark">{job.id}</h3>
                <div className="mt-2">
                  <StatusBadge status={job.status} />
                </div>
              </div>
              <button
                onClick={onClose}
                className="shrink-0 rounded-lg p-1 text-olive-dark/50 transition hover:bg-olive-dark/[0.06] hover:text-olive-dark"
                aria-label="Close"
              >
                <CloseIcon className="h-5 w-5" />
              </button>
            </div>

            <dl className="mb-6 divide-y divide-olive-dark/[0.05] rounded-xl border border-olive-dark/[0.06] bg-white/60 px-4 text-sm">
              {[
                ["Type", job.type],
                ["Attempts", `${job.attempts} / ${job.maxAttempts}`],
                ["Run at", new Date(job.runAt).toLocaleString()],
                ...(job.scheduledJobId ? [["Recurring", `rule ${job.scheduledJobId.slice(0, 8)}`] as const] : []),
                ...(job.parentJobId ? [["Waits on", `job ${job.parentJobId.slice(0, 8)}`] as const] : []),
              ].map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-4 py-2.5">
                  <dt className="text-olive-dark/55">{label}</dt>
                  <dd className="text-right font-medium text-olive-dark tabular-nums">{value}</dd>
                </div>
              ))}
              {job.lastError && (
                <div className="flex items-start justify-between gap-4 py-2.5">
                  <dt className="shrink-0 text-olive-dark/55">Last error</dt>
                  <dd className="text-right font-medium break-words text-terracotta">{job.lastError}</dd>
                </div>
              )}
            </dl>

            {job.status === "failed" && (
              <div className="animate-fade-in mb-6 rounded-xl border border-terracotta/25 bg-terracotta-light/30 p-4">
                <p className="mb-1.5 text-[11px] font-semibold tracking-wider text-terracotta uppercase">
                  Failure summary
                </p>
                {!deadLetter ? (
                  <div className="space-y-1.5">
                    <Skeleton className="h-3.5 w-full" />
                    <Skeleton className="h-3.5 w-4/5" />
                  </div>
                ) : (
                  <p className="text-sm leading-relaxed text-olive-dark">
                    {deadLetter.aiSummary ?? "No summary available."}
                  </p>
                )}
              </div>
            )}

            <h4 className="mb-2.5 text-sm font-semibold text-olive-dark">Execution trace</h4>
            {error && <p className="text-sm text-terracotta">{error}</p>}
            {!error && !logs && (
              <div className="space-y-2">
                <Skeleton className="h-16 rounded-xl" />
                <Skeleton className="h-16 rounded-xl" />
                <Skeleton className="h-16 rounded-xl" />
              </div>
            )}
            {!error && logs && logs.length === 0 && <p className="text-sm text-olive-dark/50">No log entries yet.</p>}
            {!error && logs && logs.length > 0 && (
              <ul className="space-y-2">
                {logs.map((entry) => (
                  <li
                    key={entry.id}
                    className={`rounded-xl border border-olive-dark/[0.05] border-l-[3px] bg-white/60 p-3 text-sm ${LEVEL_STYLES[entry.level].border}`}
                  >
                    <div className="mb-1 flex items-center justify-between text-[11px] font-medium tracking-wide text-olive-dark/45">
                      <span className="uppercase">{entry.level}</span>
                      <span className="tabular-nums">{new Date(entry.createdAt).toLocaleTimeString()}</span>
                    </div>
                    <p className={`leading-relaxed ${LEVEL_STYLES[entry.level].text}`}>{entry.message}</p>
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
