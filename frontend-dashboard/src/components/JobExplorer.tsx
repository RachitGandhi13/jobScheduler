import { useState } from "react";
import { api } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import type { Job, JobStatus, Queue } from "../types";
import { CreateJobModal } from "./CreateJobModal";
import { GlassCard } from "./GlassCard";
import { JobDetailPanel } from "./JobDetailPanel";
import { Toast } from "./Toast";

const STATUSES: JobStatus[] = ["queued", "scheduled", "claimed", "running", "completed", "failed"];

const STATUS_BADGE: Record<JobStatus, string> = {
  queued: "bg-sage/50 text-olive-dark",
  scheduled: "bg-sage/30 text-olive-dark",
  claimed: "bg-terracotta-light/70 text-olive-dark",
  running: "bg-terracotta-light text-olive-dark",
  completed: "bg-olive/20 text-olive-dark",
  failed: "bg-terracotta text-white",
};

interface JobExplorerProps {
  queues: Queue[] | null;
}

export function JobExplorer({ queues }: JobExplorerProps) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<JobStatus | "">("");
  const [queueId, setQueueId] = useState("");
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const pageSize = 10;

  const { data, loading, error, refetch } = usePolling(
    () => api.listJobs({ page, pageSize, status: status || undefined, queueId: queueId || undefined }),
    4000,
  );

  const jobs = data?.data ?? [];
  const pagination = data?.pagination;

  async function handleRetry(job: Job, e: React.MouseEvent) {
    e.stopPropagation(); // don't also open the detail panel for this row
    setRetryingId(job.id);
    try {
      await api.retryJob(job.id);
      setToast(`"${job.type}" requeued for retry`);
      refetch();
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <GlassCard className="flex flex-wrap items-center gap-3 p-4">
        <select
          className="rounded-lg border border-olive/20 bg-white/80 px-3 py-1.5 text-sm text-olive-dark outline-none"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as JobStatus | "");
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <select
          className="rounded-lg border border-olive/20 bg-white/80 px-3 py-1.5 text-sm text-olive-dark outline-none"
          value={queueId}
          onChange={(e) => {
            setQueueId(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All queues</option>
          {(queues ?? []).map((q) => (
            <option key={q.id} value={q.id}>
              {q.name}
            </option>
          ))}
        </select>

        <button
          onClick={() => setCreating(true)}
          className="ml-auto rounded-lg bg-olive px-3 py-1.5 text-sm font-medium text-white transition hover:bg-olive-dark"
        >
          + Create job
        </button>
        <button
          onClick={() => refetch()}
          className="rounded-lg bg-white/60 px-3 py-1.5 text-sm font-medium text-olive-dark transition hover:bg-white/80"
        >
          Refresh
        </button>
      </GlassCard>

      {error && (
        <p className="rounded-lg bg-terracotta-light/60 px-4 py-2 text-sm text-olive-dark">
          Couldn't refresh: {error.message}. Showing the last data loaded successfully.
        </p>
      )}

      <GlassCard className="overflow-x-auto p-0">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-olive/10 text-xs uppercase tracking-wide text-olive-dark/50">
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Attempts</th>
              <th className="px-4 py-3">Run at</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr
                key={job.id}
                onClick={() => setSelectedJob(job)}
                className="cursor-pointer border-b border-olive/5 transition hover:bg-sage/20"
              >
                <td className="px-4 py-3 font-medium text-olive-dark">{job.type}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[job.status]}`}>
                    {job.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-olive-dark/70">
                  {job.attempts}/{job.maxAttempts}
                </td>
                <td className="px-4 py-3 text-olive-dark/70">{new Date(job.runAt).toLocaleString()}</td>
                <td className="px-4 py-3 text-olive-dark/70">{new Date(job.createdAt).toLocaleString()}</td>
                <td className="px-4 py-3 text-right">
                  {job.status === "failed" && (
                    <button
                      onClick={(e) => handleRetry(job, e)}
                      disabled={retryingId === job.id}
                      className="rounded-full bg-terracotta-light px-3 py-1 text-xs font-medium text-olive-dark transition hover:bg-terracotta hover:text-white disabled:opacity-50"
                    >
                      {retryingId === job.id ? "Retrying…" : "Retry"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!loading && jobs.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-olive-dark/50">
                  No jobs match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </GlassCard>

      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-olive-dark/70">
          <span>
            Page {pagination.page} of {pagination.totalPages} ({pagination.total} jobs)
          </span>
          <div className="flex gap-2">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded-lg bg-white/60 px-3 py-1.5 font-medium text-olive-dark disabled:opacity-40"
            >
              Previous
            </button>
            <button
              disabled={page >= pagination.totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-lg bg-white/60 px-3 py-1.5 font-medium text-olive-dark disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}

      <JobDetailPanel job={selectedJob} onClose={() => setSelectedJob(null)} />
      {creating && (
        <CreateJobModal
          queues={queues ?? []}
          onClose={() => setCreating(false)}
          onCreated={(message) => {
            setCreating(false);
            setToast(message);
            setPage(1);
            refetch();
          }}
        />
      )}
      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}
