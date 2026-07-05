import { useState } from "react";
import { api } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import type { Job, JobStatus, Queue } from "../types";
import { CreateJobModal } from "./CreateJobModal";
import { GlassCard } from "./GlassCard";
import { JobsIcon } from "./icons";
import { JobDetailPanel } from "./JobDetailPanel";
import { Skeleton } from "./Skeleton";
import { StatusBadge } from "./StatusBadge";
import { Toast } from "./Toast";

const STATUSES: JobStatus[] = ["queued", "scheduled", "claimed", "running", "completed", "failed"];

interface JobExplorerProps {
  queues: Queue[] | null;
}

/** Placeholder rows shown only before the very first response lands. */
function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }, (_, i) => (
        <tr key={i} className="border-b border-olive-dark/[0.04]">
          <td className="px-4 py-3.5"><Skeleton className="h-4 w-32" /></td>
          <td className="px-4 py-3.5"><Skeleton className="h-5 w-20 rounded-full" /></td>
          <td className="px-4 py-3.5"><Skeleton className="h-4 w-10" /></td>
          <td className="px-4 py-3.5"><Skeleton className="h-4 w-36" /></td>
          <td className="px-4 py-3.5"><Skeleton className="h-4 w-36" /></td>
          <td className="px-4 py-3.5" />
        </tr>
      ))}
    </>
  );
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
  const filtered = status !== "" || queueId !== "";

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
          className="input input-sm w-auto !py-2"
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
          className="input input-sm w-auto !py-2"
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
          className="btn btn-primary btn-press ml-auto px-3.5 py-2 text-sm"
        >
          + Create job
        </button>
        <button onClick={() => refetch()} className="btn btn-secondary px-3.5 py-2 text-sm">
          Refresh
        </button>
      </GlassCard>

      {error && (
        <p className="animate-fade-in rounded-xl border border-terracotta/25 bg-terracotta-light/40 px-4 py-2.5 text-sm text-olive-dark">
          Couldn't refresh: {error.message}. Showing the last data loaded successfully.
        </p>
      )}

      <GlassCard className="overflow-x-auto p-0">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-olive-dark/[0.07] text-[11px] font-semibold tracking-wider text-olive-dark/45 uppercase">
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Attempts</th>
              <th className="px-4 py-3">Run at</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {loading && !data && <SkeletonRows />}
            {jobs.map((job) => (
              <tr
                key={job.id}
                onClick={() => setSelectedJob(job)}
                className="cursor-pointer border-b border-olive-dark/[0.04] transition hover:bg-olive/[0.04]"
              >
                <td className="px-4 py-3 font-medium text-olive-dark">{job.type}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={job.status} />
                </td>
                <td className="px-4 py-3 text-olive-dark/70 tabular-nums">
                  {job.attempts}/{job.maxAttempts}
                </td>
                <td className="px-4 py-3 text-olive-dark/70">{new Date(job.runAt).toLocaleString()}</td>
                <td className="px-4 py-3 text-olive-dark/70">{new Date(job.createdAt).toLocaleString()}</td>
                <td className="px-4 py-3 text-right">
                  {job.status === "failed" && (
                    <button
                      onClick={(e) => handleRetry(job, e)}
                      disabled={retryingId === job.id}
                      className="btn btn-press rounded-full bg-terracotta-light px-3 py-1 text-xs text-olive-dark hover:bg-terracotta hover:text-white"
                    >
                      {retryingId === job.id ? "Retrying…" : "Retry"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!loading && jobs.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-14">
                  <div className="flex flex-col items-center gap-3 text-center">
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-olive/[0.08]">
                      <JobsIcon className="h-5 w-5 text-olive/60" />
                    </span>
                    <div>
                      <p className="text-sm font-medium text-olive-dark/70">
                        {filtered ? "No jobs match these filters." : "Nothing scheduled yet."}
                      </p>
                      <p className="mt-1 text-xs text-olive-dark/45">
                        {filtered
                          ? "Try widening the status or queue filter."
                          : "Enqueue your first job and watch it move through the lifecycle."}
                      </p>
                    </div>
                    {!filtered && (
                      <button
                        onClick={() => setCreating(true)}
                        className="btn btn-secondary mt-1 px-3.5 py-2 text-sm"
                      >
                        Create your first job
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </GlassCard>

      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-olive-dark/70">
          <span className="tabular-nums">
            Page {pagination.page} of {pagination.totalPages} ({pagination.total} jobs)
          </span>
          <div className="flex gap-2">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="btn btn-secondary px-3.5 py-1.5 text-sm"
            >
              Previous
            </button>
            <button
              disabled={page >= pagination.totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="btn btn-secondary px-3.5 py-1.5 text-sm"
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
