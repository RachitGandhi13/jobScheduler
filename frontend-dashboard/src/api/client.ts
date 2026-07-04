import { loadSession, type AuthSession } from "../auth";
import type {
  ApiErrorBody,
  DeadLetterEntry,
  Job,
  JobLog,
  Metrics,
  Pagination,
  Project,
  Queue,
  QueueStats,
  Worker,
} from "../types";

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000/api";

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const session = loadSession();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiRequestError(
      res.status,
      body?.error.code ?? "unknown_error",
      body?.error.message ?? res.statusText,
      body?.error.details,
    );
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}

function projectPath(path: string): string {
  const session = loadSession();
  if (!session?.project) {
    throw new Error("No active project in session");
  }
  return `/projects/${session.project.id}${path}`;
}

export interface ListJobsParams {
  page?: number;
  pageSize?: number;
  queueId?: string;
  status?: string;
  from?: string;
  to?: string;
}

export type CreateJobSchedule =
  | { mode: "immediate" }
  | { mode: "delayed"; delayMs: number }
  | { mode: "scheduled"; runAt: string }
  | { mode: "recurring"; cronExpression: string };

export interface CreateJobBody {
  type: string;
  queueId: string;
  payload?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  schedule?: CreateJobSchedule;
  idempotencyKey?: string;
  parentJobId?: string;
}

export interface CreateQueueBody {
  name: string;
  priority?: number;
  concurrencyLimit?: number;
  retryPolicy?: { strategy?: string; maxRetries?: number; baseDelayMs?: number };
  shardCount?: number;
  rateLimitPerMinute?: number;
}

export interface UpdateQueueBody {
  name?: string;
  priority?: number;
  concurrencyLimit?: number;
  retryPolicy?: { strategy?: string; maxRetries?: number; baseDelayMs?: number };
  shardCount?: number;
  rateLimitPerMinute?: number | null;
}

export const api = {
  listQueues: () => request<{ data: Queue[] }>(projectPath("/queues")),
  createQueue: (body: CreateQueueBody) =>
    request<{ data: Queue }>(projectPath("/queues"), { method: "POST", body: JSON.stringify(body) }),
  updateQueue: (queueId: string, body: UpdateQueueBody) =>
    request<{ data: Queue }>(projectPath(`/queues/${queueId}`), { method: "PATCH", body: JSON.stringify(body) }),
  getQueueStats: (queueId: string) => request<{ data: QueueStats }>(projectPath(`/queues/${queueId}/stats`)),
  pauseQueue: (queueId: string) =>
    request<{ data: Queue }>(projectPath(`/queues/${queueId}/pause`), { method: "POST" }),
  resumeQueue: (queueId: string) =>
    request<{ data: Queue }>(projectPath(`/queues/${queueId}/resume`), { method: "POST" }),
  listWorkers: () => request<{ data: Worker[] }>("/workers"),
  getMetrics: () => request<{ data: Metrics }>(projectPath("/metrics")),
  listJobs: (params: ListJobsParams) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") qs.set(key, String(value));
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<{ data: Job[]; pagination: Pagination }>(projectPath(`/jobs${suffix}`));
  },
  getJobLogs: (jobId: string) => request<{ data: JobLog[] }>(projectPath(`/jobs/${jobId}/logs`)),
  getDeadLetterEntry: (jobId: string) =>
    request<{ data: DeadLetterEntry | null }>(projectPath(`/jobs/${jobId}/dead-letter`)),
  retryJob: (jobId: string) => request<{ data: Job }>(projectPath(`/jobs/${jobId}/retry`), { method: "POST" }),
  createJob: (body: CreateJobBody) =>
    request<{ data: Job; idempotent?: boolean }>(projectPath("/jobs"), { method: "POST", body: JSON.stringify(body) }),
};

export const projectsApi = {
  list: () => request<{ data: Project[] }>("/projects"),
  create: (name: string) => request<{ data: Project }>("/projects", { method: "POST", body: JSON.stringify({ name }) }),
  rename: (projectId: string, name: string) =>
    request<{ data: Project }>(`/projects/${projectId}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  remove: (projectId: string) => request<void>(`/projects/${projectId}`, { method: "DELETE" }),
};

export interface SignupBody {
  email: string;
  password: string;
  organizationName: string;
  name?: string;
}

export interface LoginBody {
  email: string;
  password: string;
}

export const authApi = {
  signup: (body: SignupBody) =>
    request<{ data: AuthSession }>("/auth/signup", { method: "POST", body: JSON.stringify(body) }),
  login: (body: LoginBody) =>
    request<{ data: AuthSession }>("/auth/login", { method: "POST", body: JSON.stringify(body) }),
  me: () => request<{ data: Omit<AuthSession, "token"> }>("/auth/me"),
  // `credential` is the ID token Google Identity Services hands back on a
  // successful "Sign in with Google" -- see components/AuthScreen.tsx.
  google: (credential: string) =>
    request<{ data: AuthSession }>("/auth/google", { method: "POST", body: JSON.stringify({ credential }) }),
};
