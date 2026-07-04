import { useState } from "react";
import { api } from "../api/client";
import type { AuthSession } from "../auth";
import type { Queue, QueueStats, RetryStrategy } from "../types";
import { GlassCard } from "./GlassCard";

interface QueueMatrixProps {
  queues: Queue[] | null;
  loading: boolean;
  role: AuthSession["role"];
  onChanged: () => void;
}

const CAN_MANAGE: Record<AuthSession["role"], boolean> = { owner: true, admin: true, member: false };

interface QueueFormValues {
  name: string;
  priority: number;
  concurrencyLimit: number;
  strategy: RetryStrategy;
  maxRetries: number;
  baseDelayMs: number;
  shardCount: number;
  rateLimitPerMinute: string;
}

function emptyForm(): QueueFormValues {
  return {
    name: "",
    priority: 0,
    concurrencyLimit: 1,
    strategy: "exponential",
    maxRetries: 3,
    baseDelayMs: 1000,
    shardCount: 1,
    rateLimitPerMinute: "",
  };
}

function formFromQueue(queue: Queue): QueueFormValues {
  return {
    name: queue.name,
    priority: queue.priority,
    concurrencyLimit: queue.concurrencyLimit,
    strategy: queue.retryPolicy?.strategy ?? "exponential",
    maxRetries: queue.retryPolicy?.maxRetries ?? 3,
    baseDelayMs: queue.retryPolicy?.baseDelayMs ?? 1000,
    shardCount: queue.shardCount,
    rateLimitPerMinute: queue.rateLimitPerMinute != null ? String(queue.rateLimitPerMinute) : "",
  };
}

function QueueForm({
  values,
  onChange,
}: {
  values: QueueFormValues;
  onChange: (values: QueueFormValues) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 text-xs">
      <label className="col-span-2">
        <span className="mb-1 block text-olive-dark/60">Name</span>
        <input
          value={values.name}
          onChange={(e) => onChange({ ...values, name: e.target.value })}
          className="w-full rounded border border-olive-dark/20 bg-white/80 px-2 py-1"
        />
      </label>
      <label>
        <span className="mb-1 block text-olive-dark/60">Priority</span>
        <input
          type="number"
          value={values.priority}
          onChange={(e) => onChange({ ...values, priority: Number(e.target.value) })}
          className="w-full rounded border border-olive-dark/20 bg-white/80 px-2 py-1"
        />
      </label>
      <label>
        <span className="mb-1 block text-olive-dark/60">Concurrency</span>
        <input
          type="number"
          min={1}
          value={values.concurrencyLimit}
          onChange={(e) => onChange({ ...values, concurrencyLimit: Number(e.target.value) })}
          className="w-full rounded border border-olive-dark/20 bg-white/80 px-2 py-1"
        />
      </label>
      <label>
        <span className="mb-1 block text-olive-dark/60">Retry strategy</span>
        <select
          value={values.strategy}
          onChange={(e) => onChange({ ...values, strategy: e.target.value as RetryStrategy })}
          className="w-full rounded border border-olive-dark/20 bg-white/80 px-2 py-1"
        >
          <option value="fixed">fixed</option>
          <option value="linear">linear</option>
          <option value="exponential">exponential</option>
        </select>
      </label>
      <label>
        <span className="mb-1 block text-olive-dark/60">Max retries</span>
        <input
          type="number"
          min={0}
          value={values.maxRetries}
          onChange={(e) => onChange({ ...values, maxRetries: Number(e.target.value) })}
          className="w-full rounded border border-olive-dark/20 bg-white/80 px-2 py-1"
        />
      </label>
      <label>
        <span className="mb-1 block text-olive-dark/60">Retry base delay (ms)</span>
        <input
          type="number"
          min={0}
          value={values.baseDelayMs}
          onChange={(e) => onChange({ ...values, baseDelayMs: Number(e.target.value) })}
          className="w-full rounded border border-olive-dark/20 bg-white/80 px-2 py-1"
        />
      </label>
      <label>
        <span className="mb-1 block text-olive-dark/60" title="Splits this queue's jobs across N virtual shards so multiple worker groups can claim in parallel without contending on the same rows">
          Shard count
        </span>
        <input
          type="number"
          min={1}
          max={64}
          value={values.shardCount}
          onChange={(e) => onChange({ ...values, shardCount: Number(e.target.value) })}
          className="w-full rounded border border-olive-dark/20 bg-white/80 px-2 py-1"
        />
      </label>
      <label className="col-span-2">
        <span className="mb-1 block text-olive-dark/60">Rate limit (requests/min, blank = org default)</span>
        <input
          type="number"
          min={1}
          value={values.rateLimitPerMinute}
          onChange={(e) => onChange({ ...values, rateLimitPerMinute: e.target.value })}
          placeholder="org default"
          className="w-full rounded border border-olive-dark/20 bg-white/80 px-2 py-1"
        />
      </label>
    </div>
  );
}

function QueueCard({
  queue,
  canManage,
  onChanged,
}: {
  queue: Queue;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<QueueFormValues>(() => formFromQueue(queue));
  const [statsOpen, setStatsOpen] = useState(false);
  const [stats, setStats] = useState<QueueStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  async function toggle() {
    setPending(true);
    try {
      if (queue.isPaused) {
        await api.resumeQueue(queue.id);
      } else {
        await api.pauseQueue(queue.id);
      }
      onChanged();
    } finally {
      setPending(false);
    }
  }

  async function saveEdit() {
    setPending(true);
    try {
      await api.updateQueue(queue.id, {
        name: form.name,
        priority: form.priority,
        concurrencyLimit: form.concurrencyLimit,
        retryPolicy: { strategy: form.strategy, maxRetries: form.maxRetries, baseDelayMs: form.baseDelayMs },
        shardCount: form.shardCount,
        rateLimitPerMinute: form.rateLimitPerMinute.trim() ? Number(form.rateLimitPerMinute) : null,
      });
      setEditing(false);
      onChanged();
    } finally {
      setPending(false);
    }
  }

  async function toggleStats() {
    if (statsOpen) {
      setStatsOpen(false);
      return;
    }
    setStatsOpen(true);
    setStatsLoading(true);
    try {
      const res = await api.getQueueStats(queue.id);
      setStats(res.data);
    } finally {
      setStatsLoading(false);
    }
  }

  if (editing) {
    return (
      <GlassCard className="p-5">
        <h4 className="mb-3 font-semibold text-olive-dark">Edit "{queue.name}"</h4>
        <QueueForm values={form} onChange={setForm} />
        <div className="mt-3 flex gap-2">
          <button
            onClick={saveEdit}
            disabled={pending}
            className="flex-1 rounded-lg bg-olive px-3 py-1.5 text-sm font-medium text-white hover:bg-olive-dark disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save"}
          </button>
          <button
            onClick={() => setEditing(false)}
            className="flex-1 rounded-lg bg-white/60 px-3 py-1.5 text-sm font-medium text-olive-dark hover:bg-white/80"
          >
            Cancel
          </button>
        </div>
      </GlassCard>
    );
  }

  return (
    <GlassCard className="p-5">
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
        <dd className="text-right font-medium capitalize text-olive-dark">{queue.retryPolicy?.strategy ?? "—"}</dd>
        <dt className="text-olive-dark/60">Max retries</dt>
        <dd className="text-right font-medium text-olive-dark">{queue.retryPolicy?.maxRetries ?? "—"}</dd>
        <dt className="text-olive-dark/60">Retry base delay</dt>
        <dd className="text-right font-medium text-olive-dark">
          {queue.retryPolicy ? `${queue.retryPolicy.baseDelayMs}ms` : "—"}
        </dd>
        {queue.shardCount > 1 && (
          <>
            <dt className="text-olive-dark/60">Shards</dt>
            <dd className="text-right font-medium text-olive-dark">{queue.shardCount}</dd>
          </>
        )}
        {queue.rateLimitPerMinute != null && (
          <>
            <dt className="text-olive-dark/60">Rate limit</dt>
            <dd className="text-right font-medium text-olive-dark">{queue.rateLimitPerMinute}/min</dd>
          </>
        )}
      </dl>

      {statsOpen && (
        <div className="mb-4 rounded-lg bg-white/50 p-3 text-xs">
          {statsLoading || !stats ? (
            <p className="text-olive-dark/50">Loading stats…</p>
          ) : (
            <>
              <div className="mb-1.5 grid grid-cols-3 gap-y-1">
                {Object.entries(stats.jobCounts).map(([status, count]) => (
                  <div key={status} className="flex justify-between pr-2">
                    <span className="capitalize text-olive-dark/60">{status}</span>
                    <span className="font-medium text-olive-dark">{count}</span>
                  </div>
                ))}
              </div>
              <div className="flex justify-between border-t border-olive-dark/10 pt-1.5">
                <span className="text-olive-dark/60">Dead-lettered</span>
                <span className="font-medium text-terracotta">{stats.deadLetterCount}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-olive-dark/60">Avg. duration</span>
                <span className="font-medium text-olive-dark">
                  {stats.avgDurationMs != null ? `${stats.avgDurationMs}ms` : "—"}
                </span>
              </div>
            </>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={toggle}
          disabled={pending}
          className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition disabled:opacity-50 ${
            queue.isPaused
              ? "bg-olive text-white hover:bg-olive-dark"
              : "bg-terracotta-light text-olive-dark hover:bg-terracotta"
          }`}
        >
          {pending ? "Working…" : queue.isPaused ? "Resume" : "Pause"}
        </button>
        <button
          onClick={toggleStats}
          className="flex-1 rounded-lg bg-white/60 px-3 py-2 text-sm font-medium text-olive-dark hover:bg-white/80"
        >
          {statsOpen ? "Hide stats" : "Stats"}
        </button>
        {canManage && (
          <button
            onClick={() => setEditing(true)}
            className="flex-1 rounded-lg bg-white/60 px-3 py-2 text-sm font-medium text-olive-dark hover:bg-white/80"
          >
            Edit
          </button>
        )}
      </div>
    </GlassCard>
  );
}

function NewQueueCard({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<QueueFormValues>(emptyForm);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!form.name.trim()) return;
    setPending(true);
    setError(null);
    try {
      await api.createQueue({
        name: form.name.trim(),
        priority: form.priority,
        concurrencyLimit: form.concurrencyLimit,
        retryPolicy: { strategy: form.strategy, maxRetries: form.maxRetries, baseDelayMs: form.baseDelayMs },
        shardCount: form.shardCount,
        rateLimitPerMinute: form.rateLimitPerMinute.trim() ? Number(form.rateLimitPerMinute) : undefined,
      });
      setForm(emptyForm());
      setOpen(false);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex min-h-[220px] items-center justify-center rounded-2xl border-2 border-dashed border-olive-dark/20 text-sm font-medium text-olive-dark/50 transition hover:border-olive-dark/40 hover:text-olive-dark"
      >
        + New queue
      </button>
    );
  }

  return (
    <GlassCard className="p-5">
      <h4 className="mb-3 font-semibold text-olive-dark">New queue</h4>
      <QueueForm values={form} onChange={setForm} />
      {error && <p className="mt-2 text-xs text-terracotta">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button
          onClick={create}
          disabled={pending || !form.name.trim()}
          className="flex-1 rounded-lg bg-olive px-3 py-1.5 text-sm font-medium text-white hover:bg-olive-dark disabled:opacity-50"
        >
          {pending ? "Creating…" : "Create"}
        </button>
        <button
          onClick={() => setOpen(false)}
          className="flex-1 rounded-lg bg-white/60 px-3 py-1.5 text-sm font-medium text-olive-dark hover:bg-white/80"
        >
          Cancel
        </button>
      </div>
    </GlassCard>
  );
}

export function QueueMatrix({ queues, loading, role, onChanged }: QueueMatrixProps) {
  const canManage = CAN_MANAGE[role];

  if (loading && !queues) {
    return <GlassCard className="p-6 text-sm text-olive-dark/60">Loading queues…</GlassCard>;
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {(queues ?? []).map((queue) => (
        <QueueCard key={queue.id} queue={queue} canManage={canManage} onChanged={onChanged} />
      ))}
      {canManage && <NewQueueCard onCreated={onChanged} />}
      {(!queues || queues.length === 0) && !canManage && (
        <GlassCard className="col-span-full p-6 text-sm text-olive-dark/60">No queues in this project yet.</GlassCard>
      )}
    </div>
  );
}
