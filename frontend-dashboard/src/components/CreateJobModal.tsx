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

const FIELD_LABEL = "mb-1.5 block text-[13px] font-medium text-olive-dark";

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
  const [parentJobId, setParentJobId] = useState("");
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
        parentJobId: parentJobId.trim() || undefined,
      });
      onCreated(res.idempotent ? `"${res.data.type}" already existed for this key — reused it` : `"${res.data.type}" enqueued`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-espresso/25 p-4 backdrop-blur-sm">
      <GlassCard className="animate-scale-in max-h-[90vh] w-full max-w-lg overflow-y-auto p-6 sm:p-7">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-olive-dark">Create job</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-olive-dark/50 transition hover:bg-olive-dark/[0.06] hover:text-olive-dark"
            aria-label="Close"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>
        <p className="mb-5 text-[13px] text-olive-dark/55">Enqueue work onto one of this project's queues.</p>

        <div className="space-y-4 text-sm">
          <label className="block">
            <span className={FIELD_LABEL}>Type</span>
            <input
              value={type}
              onChange={(e) => setType(e.target.value)}
              placeholder="send-welcome-email"
              className="input"
            />
          </label>

          <label className="block">
            <span className={FIELD_LABEL}>Queue</span>
            <select value={queueId} onChange={(e) => setQueueId(e.target.value)} className="input">
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
              <span className={FIELD_LABEL}>Priority</span>
              <input
                type="number"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
                className="input"
              />
            </label>
            <label className="block">
              <span className={FIELD_LABEL}>Max attempts</span>
              <input
                type="number"
                min={1}
                value={maxAttempts}
                onChange={(e) => setMaxAttempts(e.target.value)}
                placeholder="queue default"
                className="input"
              />
            </label>
          </div>

          <label className="block">
            <span className={FIELD_LABEL}>Payload (JSON)</span>
            <textarea
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              rows={3}
              spellCheck={false}
              className="input font-mono text-xs leading-relaxed"
            />
          </label>

          <label className="block">
            <span className={FIELD_LABEL}>Schedule</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as ScheduleMode)} className="input">
              <option value="immediate">Immediate — run now</option>
              <option value="delayed">Delayed — run after a delay</option>
              <option value="scheduled">Scheduled — run at a specific time</option>
              <option value="recurring">Recurring — run on a cron schedule</option>
            </select>
          </label>

          {mode === "delayed" && (
            <label className="animate-fade-in block">
              <span className={FIELD_LABEL}>Delay (ms)</span>
              <input
                type="number"
                min={1}
                value={delayMs}
                onChange={(e) => setDelayMs(Number(e.target.value))}
                className="input"
              />
            </label>
          )}
          {mode === "scheduled" && (
            <label className="animate-fade-in block">
              <span className={FIELD_LABEL}>Run at</span>
              <input type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)} className="input" />
            </label>
          )}
          {mode === "recurring" && (
            <label className="animate-fade-in block">
              <span className={FIELD_LABEL}>Cron expression</span>
              <input
                value={cronExpression}
                onChange={(e) => setCronExpression(e.target.value)}
                placeholder="*/15 * * * *"
                className="input font-mono"
              />
            </label>
          )}

          <div className="grid grid-cols-1 gap-4 border-t border-olive-dark/[0.06] pt-4">
            <label className="block">
              <span className={FIELD_LABEL}>Idempotency key (optional)</span>
              <input
                value={idempotencyKey}
                onChange={(e) => setIdempotencyKey(e.target.value)}
                placeholder="order-123"
                className="input"
              />
            </label>

            <label className="block">
              <span className={FIELD_LABEL}>Waits on job (optional)</span>
              <input
                value={parentJobId}
                onChange={(e) => setParentJobId(e.target.value)}
                placeholder="Parent job id — this job won't claim until that one completes"
                className="input font-mono text-xs"
              />
            </label>
          </div>

          {error && (
            <div
              role="alert"
              className="animate-fade-in rounded-xl border border-terracotta/25 bg-terracotta-light/40 px-3.5 py-2.5 text-[13px] leading-snug text-olive-dark"
            >
              {error}
            </div>
          )}

          <button
            onClick={handleSubmit}
            disabled={submitting || queues.length === 0}
            className="btn btn-primary btn-press w-full py-2.5 text-sm"
          >
            {submitting && (
              <span
                aria-hidden="true"
                className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white motion-reduce:animate-none"
              />
            )}
            {submitting ? "Creating…" : "Create job"}
          </button>
        </div>
      </GlassCard>
    </div>
  );
}
