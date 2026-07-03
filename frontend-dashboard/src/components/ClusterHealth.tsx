import type { Metrics, Worker } from "../types";
import { GlassCard } from "./GlassCard";

interface ClusterHealthProps {
  workers: Worker[] | null;
  metrics: Metrics | null;
}

function StatTile({ label, value, danger = false }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className="rounded-xl bg-white/50 px-4 py-3">
      <p className="text-xs font-medium text-olive-dark/60">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${danger ? "text-terracotta" : "text-olive-dark"}`}>
        {value.toLocaleString()}
      </p>
    </div>
  );
}

/** Dot always ships with a numeric + text label -- color is never the only signal. */
function WorkerBadge({ count, label, pulse = false, muted = false }: { count: number; label: string; pulse?: boolean; muted?: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-full bg-white/60 px-3 py-1.5 text-sm">
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
      <span className="font-medium text-olive-dark">{count}</span>
      <span className="text-olive-dark/60">{label}</span>
    </div>
  );
}

export function ClusterHealth({ workers, metrics }: ClusterHealthProps) {
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
      <h3 className="mb-1 text-sm font-semibold text-olive-dark">Cluster health</h3>
      <p className="mb-4 text-xs text-olive-dark/60">Worker fleet + job throughput, live</p>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <WorkerBadge count={busy} label="busy" pulse />
        <WorkerBadge count={idle} label="idle" />
        <WorkerBadge count={offline} label="offline" muted />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Enqueued" value={enqueued} />
        <StatTile label="Running" value={running} />
        <StatTile label="Completed" value={completed} />
        <StatTile label="Dead-lettered" value={deadLettered} danger />
      </div>
    </GlassCard>
  );
}
