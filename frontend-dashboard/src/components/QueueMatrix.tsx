import { useState } from "react";
import { api } from "../api/client";
import type { Queue } from "../types";
import { GlassCard } from "./GlassCard";

interface QueueMatrixProps {
  queues: Queue[] | null;
  loading: boolean;
  onChanged: () => void;
}

export function QueueMatrix({ queues, loading, onChanged }: QueueMatrixProps) {
  const [pendingId, setPendingId] = useState<string | null>(null);

  async function toggle(queue: Queue) {
    setPendingId(queue.id);
    try {
      if (queue.isPaused) {
        await api.resumeQueue(queue.id);
      } else {
        await api.pauseQueue(queue.id);
      }
      onChanged();
    } finally {
      setPendingId(null);
    }
  }

  if (loading && !queues) {
    return <GlassCard className="p-6 text-sm text-olive-dark/60">Loading queues…</GlassCard>;
  }

  if (!queues || queues.length === 0) {
    return <GlassCard className="p-6 text-sm text-olive-dark/60">No queues in this project yet.</GlassCard>;
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {queues.map((queue) => (
        <GlassCard key={queue.id} className="p-5">
          <div className="mb-3 flex items-start justify-between">
            <div>
              <h4 className="font-semibold text-olive-dark">{queue.name}</h4>
              <p className="text-xs text-olive-dark/50">priority {queue.priority}</p>
            </div>
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                queue.isPaused ? "bg-terracotta-light text-olive-dark" : "bg-sage/50 text-olive-dark"
              }`}
            >
              {queue.isPaused ? "Paused" : "Active"}
            </span>
          </div>

          <dl className="mb-4 grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-olive-dark/60">Concurrency</dt>
            <dd className="text-right font-medium text-olive-dark">{queue.concurrencyLimit}</dd>
            <dt className="text-olive-dark/60">Retry strategy</dt>
            <dd className="text-right font-medium capitalize text-olive-dark">{queue.retryStrategy}</dd>
            <dt className="text-olive-dark/60">Max retries</dt>
            <dd className="text-right font-medium text-olive-dark">{queue.maxRetries}</dd>
            <dt className="text-olive-dark/60">Retry base delay</dt>
            <dd className="text-right font-medium text-olive-dark">{queue.retryBaseDelayMs}ms</dd>
          </dl>

          <button
            onClick={() => toggle(queue)}
            disabled={pendingId === queue.id}
            className={`w-full rounded-lg px-4 py-2 text-sm font-medium transition disabled:opacity-50 ${
              queue.isPaused
                ? "bg-olive text-white hover:bg-olive-dark"
                : "bg-terracotta-light text-olive-dark hover:bg-terracotta"
            }`}
          >
            {pendingId === queue.id ? "Working…" : queue.isPaused ? "Resume queue" : "Pause queue"}
          </button>
        </GlassCard>
      ))}
    </div>
  );
}
