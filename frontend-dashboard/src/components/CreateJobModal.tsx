import { useState } from "react";
import { api } from "../api/client";
import type { CreateJobSchedule } from "../api/client";
import type { Queue } from "../types";
import { GlassCard } from "./GlassCard";
import { CloseIcon } from "./icons";

interface CreateJobModalProps {
  queues: Queue[];
  onClose: () => void;
  onCreated: (message: string) => void;
}

type ScheduleMode = CreateJobSchedule["mode"];

export function CreateJobModal({ queues, onClose, onCreated }: CreateJobModalProps) {
  const [type, setType] = useState("");
  const [queueId, setQueueId] = useState(queues[0]?.id ?? "");
  const [priority, setPriority] = useState(0);
  const [maxAttempts, setMaxAttempts] = useState("");
  const [payload, setPayload] = useState("{}");
  const [mode, setMode] = useState<ScheduleMode>("immediate");
  const [delayMs, setDelayMs] = useState(60000);
  const [runAt, setRunAt] = useState("");
  const [cronExpression, setCronExpression] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    setError(null);

    if (!type.trim()) return setError("Job type is required.");
    if (!queueId) return setError("Pick a queue.");

    let parsedPayload: Record<string, unknown>;
    try {
      parsedPayload = payload.trim() ? JSON.parse(payload) : {};
    } catch {
      return setError("Payload must be valid JSON.");
    }

    let schedule: CreateJobSchedule;
    if (mode === "immediate") {
      schedule = { mode: "immediate" };
    } else if (mode === "delayed") {
      if (!(delayMs > 0)) return setError("Delay must be a positive number of milliseconds.");
      schedule = { mode: "delayed", delayMs };
    } else if (mode === "scheduled") {
      if (!runAt) return setError("Pick a date/time to run at.");
      schedule = { mode: "scheduled", runAt: new Date(runAt).toISOString() };
    } else {
      if (!cronExpression.trim()) return setError("Cron expression is required for a recurring job.");
      schedule = { mode: "recurring", cronExpression: cronExpression.trim() };
    }

    setSubmitting(true);
    try {
      const res = await api.createJob({
        type: type.trim(),
        queueId,
        payload: parsedPayload,
        priority,
        maxAttempts: maxAttempts ? Number(maxAttempts) : undefined,
        schedule,
        idempotencyKey: idempotencyKey.trim() || undefined,
      });
      onCreated(res.idempotent ? `"${res.data.type}" already existed for this key — reused it` : `"${res.data.type}" enqueued`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-olive-dark/20 p-4 backdrop-blur-sm">
      <GlassCard className="max-h-[90vh] w-full max-w-lg overflow-y-auto p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-olive-dark">Create job</h2>
          <button onClick={onClose} className="text-olive-dark/60 hover:text-olive-dark" aria-label="Close">
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-3 text-sm">
          <label className="block">
            <span className="mb-1 block font-medium text-olive-dark">Type</span>
            <input
              value={type}
              onChange={(e) => setType(e.target.value)}
              placeholder="send-welcome-email"
              className="w-full rounded-lg border border-olive/20 bg-white/80 px-3 py-2 outline-none focus:border-olive"
            />
          </label>

          <label className="block">
            <span className="mb-1 block font-medium text-olive-dark">Queue</span>
            <select
              value={queueId}
              onChange={(e) => setQueueId(e.target.value)}
              className="w-full rounded-lg border border-olive/20 bg-white/80 px-3 py-2 outline-none focus:border-olive"
            >
              {queues.length === 0 && <option value="">No queues in this project</option>}
              {queues.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.name}
                </option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block font-medium text-olive-dark">Priority</span>
              <input
                type="number"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
                className="w-full rounded-lg border border-olive/20 bg-white/80 px-3 py-2 outline-none focus:border-olive"
              />
            </label>
            <label className="block">
              <span className="mb-1 block font-medium text-olive-dark">Max attempts</span>
              <input
                type="number"
                min={1}
                value={maxAttempts}
                onChange={(e) => setMaxAttempts(e.target.value)}
                placeholder="queue default"
                className="w-full rounded-lg border border-olive/20 bg-white/80 px-3 py-2 outline-none focus:border-olive"
              />
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block font-medium text-olive-dark">Payload (JSON)</span>
            <textarea
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              rows={3}
              className="w-full rounded-lg border border-olive/20 bg-white/80 px-3 py-2 font-mono text-xs outline-none focus:border-olive"
            />
          </label>

          <label className="block">
            <span className="mb-1 block font-medium text-olive-dark">Schedule</span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as ScheduleMode)}
              className="w-full rounded-lg border border-olive/20 bg-white/80 px-3 py-2 outline-none focus:border-olive"
            >
              <option value="immediate">Immediate — run now</option>
              <option value="delayed">Delayed — run after a delay</option>
              <option value="scheduled">Scheduled — run at a specific time</option>
              <option value="recurring">Recurring — run on a cron schedule</option>
            </select>
          </label>

          {mode === "delayed" && (
            <label className="block">
              <span className="mb-1 block font-medium text-olive-dark">Delay (ms)</span>
              <input
                type="number"
                min={1}
                value={delayMs}
                onChange={(e) => setDelayMs(Number(e.target.value))}
                className="w-full rounded-lg border border-olive/20 bg-white/80 px-3 py-2 outline-none focus:border-olive"
              />
            </label>
          )}
          {mode === "scheduled" && (
            <label className="block">
              <span className="mb-1 block font-medium text-olive-dark">Run at</span>
              <input
                type="datetime-local"
                value={runAt}
                onChange={(e) => setRunAt(e.target.value)}
                className="w-full rounded-lg border border-olive/20 bg-white/80 px-3 py-2 outline-none focus:border-olive"
              />
            </label>
          )}
          {mode === "recurring" && (
            <label className="block">
              <span className="mb-1 block font-medium text-olive-dark">Cron expression</span>
              <input
                value={cronExpression}
                onChange={(e) => setCronExpression(e.target.value)}
                placeholder="*/15 * * * *"
                className="w-full rounded-lg border border-olive/20 bg-white/80 px-3 py-2 font-mono outline-none focus:border-olive"
              />
            </label>
          )}

          <label className="block">
            <span className="mb-1 block font-medium text-olive-dark">Idempotency key (optional)</span>
            <input
              value={idempotencyKey}
              onChange={(e) => setIdempotencyKey(e.target.value)}
              placeholder="order-123"
              className="w-full rounded-lg border border-olive/20 bg-white/80 px-3 py-2 outline-none focus:border-olive"
            />
          </label>

          {error && <p className="text-sm text-terracotta">{error}</p>}

          <button
            onClick={handleSubmit}
            disabled={submitting || queues.length === 0}
            className="w-full rounded-lg bg-olive px-4 py-2 font-medium text-white transition hover:bg-olive-dark disabled:opacity-50"
          >
            {submitting ? "Creating…" : "Create job"}
          </button>
        </div>
      </GlassCard>
    </div>
  );
}
