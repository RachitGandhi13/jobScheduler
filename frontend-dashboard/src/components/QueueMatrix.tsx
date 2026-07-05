import { useState } from "react";
import { api } from "../api/client";
import type { AuthSession } from "../auth";
import type { Queue, QueueStats, RetryStrategy } from "../types";
import { GlassCard } from "./GlassCard";
import { PlusIcon } from "./icons";
import { Skeleton } from "./Skeleton";

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

const FIELD_LABEL = "mb-1 block text-[11px] font-medium text-olive-dark/55";

function QueueForm({
  values,
  onChange,
}: {
  values: QueueFormValues;
  onChange: (values: QueueFormValues) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2.5">
      <label className="col-span-2">
        <span className={FIELD_LABEL}>Name</span>
        <input
          value={values.name}
          onChange={(e) => onChange({ ...values, name: e.target.value })}
          placeholder="emails"
          className="input input-sm"
        />
      </label>
      <label>
        <span className={FIELD_LABEL}>Priority</span>
        <input
          type="number"
          value={values.priority}
          onChange={(e) => onChange({ ...values, priority: Number(e.target.value) })}
          className="input input-sm"
        />
      </label>
      <label>
        <span className={FIELD_LABEL}>Concurrency</span>
        <input
          type="number"
          min={1}
          value={values.concurrencyLimit}
          onChange={(e) => onChange({ ...values, concurrencyLimit: Number(e.target.value) })}
          className="input input-sm"
        />
      </label>
      <label>
        <span className={FIELD_LABEL}>Retry strategy</span>
        <select
          value={values.strategy}
          onChange={(e) => onChange({ ...values, strategy: e.target.value as RetryStrategy })}
          className="input input-sm"
        >
          <option value="fixed">fixed</option>
          <option value="linear">linear</option>
          <option value="exponential">exponential</option>
        </select>
      </label>
      <label>
        <span className={FIELD_LABEL}>Max retries</span>
        <input
          type="number"
          min={0}
          value={values.maxRetries}
          onChange={(e) => onChange({ ...values, maxRetries: Number(e.target.value) })}
          className="input input-sm"
        />
      </label>
      <label>
        <span className={FIELD_LABEL}>Retry base delay (ms)</span>
        <input
          type="number"
          min={0}
          value={values.baseDelayMs}
          onChange={(e) => onChange({ ...values, baseDelayMs: Number(e.target.value) })}
          className="input input-sm"
        />
      </label>
      <label>
        <span
          className={FIELD_LABEL}
          title="Splits this queue's jobs across N virtual shards so multiple worker groups can claim in parallel without contending on the same rows"
        >
          Shard count
        </span>
        <input
          type="number"
          min={1}
          max={64}
          value={values.shardCount}
          onChange={(e) => onChange({ ...values, shardCount: Number(e.target.value) })}
          className="input input-sm"
        />
      </label>
      <label className="col-span-2">
        <span className={FIELD_LABEL}>Rate limit (requests/min, blank = org default)</span>
        <input
          type="number"
          min={1}
          value={values.rateLimitPerMinute}
          onChange={(e) => onChange({ ...values, rateLimitPerMinute: e.target.value })}
          placeholder="org default"
          className="input input-sm"
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
        <h4 className="mb-3.5 font-semibold text-olive-dark">Edit "{queue.name}"</h4>
        <QueueForm values={form} onChange={setForm} />
        <div className="mt-4 flex gap-2">
          <button
            onClick={saveEdit}
            disabled={pending}
            className="btn btn-primary btn-press flex-1 px-3 py-2 text-sm"
          >
            {pending ? "Saving…" : "Save"}
          </button>
          <button onClick={() => setEditing(false)} className="btn btn-ghost flex-1 px-3 py-2 text-sm">
            Cancel
          </button>
        </div>
      </GlassCard>
    );
  }

  return (
    <GlassCard className="flex flex-col p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="truncate font-semibold text-olive-dark">{queue.name}</h4>
          <p className="mt-0.5 text-xs text-olive-dark/50">priority {queue.priority}</p>
        </div>
        <span
          className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
            queue.isPaused ? "bg-terracotta-light/70 text-olive-dark" : "bg-sage/25 text-olive-dark"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${queue.isPaused ? "bg-terracotta" : "animate-pulse bg-olive"}`} />
          {queue.isPaused ? "Paused" : "Active"}
        </span>
      </div>

      <dl className="mb-4 flex-1 divide-y divide-olive-dark/[0.05] text-sm">
        {[
          ["Concurrency", String(queue.concurrencyLimit)],
          ["Retry strategy", queue.retryPolicy?.strategy ?? "—"],
          ["Max retries", queue.retryPolicy != null ? String(queue.retryPolicy.maxRetries) : "—"],
          ["Retry base delay", queue.retryPolicy ? `${queue.retryPolicy.baseDelayMs}ms` : "—"],
          ...(queue.shardCount > 1 ? [["Shards", String(queue.shardCount)] as const] : []),
          ...(queue.rateLimitPerMinute != null ? [["Rate limit", `${queue.rateLimitPerMinute}/min`] as const] : []),
        ].map(([label, value]) => (
          <div key={label} className="flex items-center justify-between py-1.5 first:pt-0 last:pb-0">
            <dt className="text-olive-dark/55">{label}</dt>
            <dd className="font-medium text-olive-dark capitalize tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      {statsOpen && (
        <div className="animate-fade-in mb-4 rounded-xl border border-olive-dark/[0.06] bg-white/60 p-3 text-xs">
          {statsLoading || !stats ? (
            <div className="space-y-2">
              <Skeleton className="h-3.5 w-2/3" />
              <Skeleton className="h-3.5 w-1/2" />
              <Skeleton className="h-3.5 w-3/5" />
            </div>
          ) : (
            <>
              <div className="mb-1.5 grid grid-cols-3 gap-x-3 gap-y-1">
                {Object.entries(stats.jobCounts).map(([status, count]) => (
                  <div key={status} className="flex justify-between">
                    <span className="text-olive-dark/55 capitalize">{status}</span>
                    <span className="font-medium text-olive-dark tabular-nums">{count}</span>
                  </div>
                ))}
              </div>
              <div className="flex justify-between border-t border-olive-dark/[0.07] pt-1.5">
                <span className="text-olive-dark/55">Dead-lettered</span>
                <span className={`font-medium tabular-nums ${stats.deadLetterCount > 0 ? "text-terracotta" : "text-olive-dark"}`}>
                  {stats.deadLetterCount}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-olive-dark/55">Avg. duration</span>
                <span className="font-medium text-olive-dark tabular-nums">
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
          className={`btn btn-press flex-1 px-3 py-2 text-sm ${
            queue.isPaused ? "btn-primary" : "bg-terracotta-light/70 text-olive-dark hover:bg-terracotta-light"
          }`}
        >
          {pending ? "Working…" : queue.isPaused ? "Resume" : "Pause"}
        </button>
        <button onClick={toggleStats} className="btn btn-secondary flex-1 px-3 py-2 text-sm">
          {statsOpen ? "Hide stats" : "Stats"}
        </button>
        {canManage && (
          <button onClick={() => setEditing(true)} className="btn btn-secondary flex-1 px-3 py-2 text-sm">
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
        className="animate-fade-in-up group flex min-h-[240px] flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-olive-dark/15 text-sm font-medium text-olive-dark/50 transition hover:border-olive/40 hover:bg-white/40 hover:text-olive-dark"
      >
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-olive/[0.08] transition group-hover:bg-olive/15">
          <PlusIcon className="h-4.5 w-4.5 text-olive" />
        </span>
        + New queue
      </button>
    );
  }

  return (
    <GlassCard className="p-5">
      <h4 className="mb-3.5 font-semibold text-olive-dark">New queue</h4>
      <QueueForm values={form} onChange={setForm} />
      {error && (
        <p className="animate-fade-in mt-2.5 rounded-lg border border-terracotta/25 bg-terracotta-light/40 px-2.5 py-1.5 text-xs text-olive-dark">
          {error}
        </p>
      )}
      <div className="mt-4 flex gap-2">
        <button
          onClick={create}
          disabled={pending || !form.name.trim()}
          className="btn btn-primary btn-press flex-1 px-3 py-2 text-sm"
        >
          {pending ? "Creating…" : "Create"}
        </button>
        <button onClick={() => setOpen(false)} className="btn btn-ghost flex-1 px-3 py-2 text-sm">
          Cancel
        </button>
      </div>
    </GlassCard>
  );
}

export function QueueMatrix({ queues, loading, role, onChanged }: QueueMatrixProps) {
  const canManage = CAN_MANAGE[role];

  if (loading && !queues) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Skeleton className="h-[248px] rounded-2xl" />
        <Skeleton className="h-[248px] rounded-2xl" />
        <Skeleton className="h-[248px] rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="stagger grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
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
