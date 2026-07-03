import { loadSettings } from "../settings";
import type { ApiErrorBody, Job, JobLog, Metrics, Pagination, Queue, Worker } from "../types";

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
  const settings = loadSettings();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-mock-user-id": settings.userId,
      "x-mock-organization-id": settings.organizationId,
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

  return res.json() as Promise<T>;
}

function projectPath(path: string): string {
  const { projectId } = loadSettings();
  return `/projects/${projectId}${path}`;
}

export interface ListJobsParams {
  page?: number;
  pageSize?: number;
  queueId?: string;
  status?: string;
  from?: string;
  to?: string;
}

export const api = {
  listQueues: () => request<{ data: Queue[] }>(projectPath("/queues")),
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
};
