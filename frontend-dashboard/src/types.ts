export type JobStatus = "queued" | "scheduled" | "claimed" | "running" | "completed" | "failed";
export type RetryStrategy = "fixed" | "linear" | "exponential";
export type WorkerStatus = "idle" | "busy" | "offline";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type OrganizationRole = "owner" | "admin" | "member";

export interface Job {
  id: string;
  queueId: string;
  type: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  priority: number;
  runAt: string;
  scheduledJobId: string | null;
  batchId: string | null;
  maxAttempts: number;
  attempts: number;
  claimedBy: string | null;
  claimedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Queue {
  id: string;
  projectId: string;
  name: string;
  priority: number;
  concurrencyLimit: number;
  isPaused: boolean;
  createdAt: string;
  updatedAt: string;
  retryPolicy: { strategy: RetryStrategy; maxRetries: number; baseDelayMs: number } | null;
}

export interface Project {
  id: string;
  organizationId: string;
  name: string;
  ownerId: string;
  apiKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface QueueStats {
  queueId: string;
  jobCounts: Record<JobStatus, number>;
  deadLetterCount: number;
  avgDurationMs: number | null;
}

export interface Worker {
  id: string;
  hostname: string;
  pid: number | null;
  status: WorkerStatus;
  lastHeartbeatAt: string | null;
  startedAt: string;
  createdAt: string;
}

export interface JobLog {
  id: string;
  jobId: string;
  executionId: string | null;
  level: LogLevel;
  message: string;
  createdAt: string;
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface Metrics {
  queueCount: number;
  jobCounts: Record<JobStatus, number>;
  deadLetterCount: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
