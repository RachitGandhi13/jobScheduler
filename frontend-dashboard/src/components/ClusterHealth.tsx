import type { Metrics, Worker } from "../types";
import { GlassCard } from "./GlassCard";
import { Skeleton } from "./Skeleton";

interface ClusterHealthProps {
  workers: Worker[] | null;
  metrics: Metrics | null;
  live?: boolean;
}

function StatTile({ label, value, danger = false }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className="rounded-xl border border-olive-dark/[0.05] bg-white/60 px-4 py-3">
      <p className="text-[11px] font-semibold tracking-wide text-olive-dark/50 uppercase">{label}</p>
      <p
        className={`mt-1 text-[26px] font-semibold tracking-tight tabular-nums ${
          danger ? "text-terracotta" : "text-olive-dark"
        }`}
      >
        {value.toLocaleString()}
      </p>
    </div>
  );
}

/** Dot always ships with a numeric + text label -- color is never the only signal. */
function WorkerBadge({ count, label, pulse = false, muted = false }: { count: number; label: string; pulse?: boolean; muted?: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-full border border-olive-dark/[0.05] bg-white/60 px-3 py-1.5 text-sm">
      <span className="relative flex h-2.5 w-2.5">
        {pulse && count > 0 && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sage opacity-75" />
        )}
        <span
          className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
            muted ? "bg-olive-dark/30" : pulse ? "bg-sage" : "bg-olive/60"
          }`}
        />
      </span>
      <span className="font-medium text-olive-dark tabular-nums">{count}</span>
      <span className="text-olive-dark/60">{label}</span>
    </div>
  );
}

export function ClusterHealth({ workers, metrics, live = false }: ClusterHealthProps) {
  const loading = workers === null && metrics === null;

  const idle = workers?.filter((w) => w.status === "idle").length ?? 0;
  const busy = workers?.filter((w) => w.status === "busy").length ?? 0;
  const offline = workers?.filter((w) => w.status === "offline").length ?? 0;

  const enqueued =
    (metrics?.jobCounts.queued ?? 0) + (metrics?.jobCounts.scheduled ?? 0) + (metrics?.jobCounts.claimed ?? 0);
  const running = metrics?.jobCounts.running ?? 0;
  const completed = metrics?.jobCounts.completed ?? 0;
  const deadLettered = metrics?.deadLetterCount ?? 0;

  return (
    <GlassCard className="p-5 md:p-6">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-olive-dark">Cluster health</h3>
        <span
          className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${
            live ? "bg-sage/25 text-olive-dark" : "bg-olive-dark/[0.05] text-olive-dark/50"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${live ? "animate-pulse bg-sage" : "bg-olive-dark/30"}`} />
          {live ? "Live" : "Polling"}
        </span>
      </div>
      <p className="mb-4 text-xs text-olive-dark/60">Worker fleet + job throughput, live</p>

      {loading ? (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <Skeleton className="h-8 w-24 rounded-full" />
            <Skeleton className="h-8 w-24 rounded-full" />
            <Skeleton className="h-8 w-28 rounded-full" />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Skeleton className="h-[78px] rounded-xl" />
            <Skeleton className="h-[78px] rounded-xl" />
            <Skeleton className="h-[78px] rounded-xl" />
            <Skeleton className="h-[78px] rounded-xl" />
          </div>
        </>
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <WorkerBadge count={busy} label="busy" pulse />
            <WorkerBadge count={idle} label="idle" />
            <WorkerBadge count={offline} label="offline" muted />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Enqueued" value={enqueued} />
            <StatTile label="Running" value={running} />
            <StatTile label="Completed" value={completed} />
            <StatTile label="Dead-lettered" value={deadLettered} danger={deadLettered > 0} />
          </div>
        </>
      )}
    </GlassCard>
  );
}
