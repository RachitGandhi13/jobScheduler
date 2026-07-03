import { Router } from "express";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { jobLogs, jobs, queues } from "@scheduler/db";
import { db } from "../db.js";
import { ApiError } from "../lib/apiError.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getNextCronRun } from "../lib/cron.js";
import { validate } from "../middleware/validate.js";

export const jobsRouter = Router({ mergeParams: true });

/**
 * Controls when a job first becomes eligible for claiming; independent of
 * `type`, which names the job *handler* (e.g. "send-welcome-email") a future
 * handler registry will dispatch on.
 */
const scheduleSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("immediate") }),
  z.object({ mode: z.literal("delayed"), runAt: z.coerce.date() }),
  z.object({ mode: z.literal("recurring"), cronExpression: z.string().min(1) }),
]);

const createJobBodySchema = z.object({
  type: z.string().min(1).max(255),
  queueId: z.string().uuid(),
  payload: z.record(z.unknown()).default({}),
  priority: z.number().int().default(0),
  // No default here: when omitted, falls back to the owning queue's configured
  // max_retries below, rather than silently overriding the queue's retry policy.
  maxAttempts: z.number().int().min(1).max(50).optional(),
  schedule: scheduleSchema.default({ mode: "immediate" }),
});

/**
 * POST /api/projects/:projectId/jobs
 *
 * Body: {
 *   type: string,               // job handler name
 *   queueId: string (uuid),     // must belong to :projectId
 *   payload?: Record<string, unknown>,
 *   priority?: number,          // default 0, higher claims first
 *   maxAttempts?: number,       // default: the owning queue's configured max_retries
 *   schedule?:
 *     | { mode: "immediate" }
 *     | { mode: "delayed", runAt: string (ISO date) }
 *     | { mode: "recurring", cronExpression: string }
 * }
 *
 * immediate  -> run_at = now(), status = 'queued' (claimable this instant).
 * delayed    -> run_at = schedule.runAt (must be future), status = 'scheduled'.
 * recurring  -> cronExpression persisted on the row as the baseline rule;
 *               run_at = its first computed occurrence, status = 'scheduled'.
 *               NOTE: only the first occurrence is scheduled here. Chaining
 *               subsequent occurrences after each run is worker-side work
 *               not yet wired up (see DEVELOPMENT.md).
 */
jobsRouter.post(
  "/jobs",
  validate({ body: createJobBodySchema }),
  asyncHandler(async (req, res) => {
    const projectId = req.context.projectId!;
    const { type, queueId, payload, priority, maxAttempts, schedule } = req.body as z.infer<
      typeof createJobBodySchema
    >;

    const [queue] = await db
      .select()
      .from(queues)
      .where(and(eq(queues.id, queueId), eq(queues.projectId, projectId)))
      .limit(1);

    if (!queue) {
      throw ApiError.notFound("queue_not_found", `Queue ${queueId} not found in this project`);
    }

    let runAt: Date;
    let status: "queued" | "scheduled";
    let cronExpression: string | null = null;

    if (schedule.mode === "immediate") {
      runAt = new Date();
      status = "queued";
    } else if (schedule.mode === "delayed") {
      if (schedule.runAt.getTime() <= Date.now()) {
        throw ApiError.badRequest("run_at_in_past", "schedule.runAt must be in the future");
      }
      runAt = schedule.runAt;
      status = "scheduled";
    } else {
      runAt = getNextCronRun(schedule.cronExpression);
      status = "scheduled";
      cronExpression = schedule.cronExpression;
    }

    const [job] = await db
      .insert(jobs)
      .values({
        queueId,
        type,
        payload,
        priority,
        maxAttempts: maxAttempts ?? queue.maxRetries,
        runAt,
        status,
        cronExpression,
      })
      .returning();

    res.status(201).json({ data: job });
  }),
);

const listJobsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  queueId: z.string().uuid().optional(),
  status: z.enum(["queued", "scheduled", "claimed", "running", "completed", "failed"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/**
 * GET /api/projects/:projectId/jobs
 *
 * Query: page, pageSize (<=100), queueId?, status?, from?/to? (createdAt range).
 * Response: { data: Job[], pagination: { page, pageSize, total, totalPages } }
 */
jobsRouter.get(
  "/jobs",
  validate({ query: listJobsQuerySchema }),
  asyncHandler(async (req, res) => {
    const projectId = req.context.projectId!;
    const { page, pageSize, queueId, status, from, to } = req.query as unknown as z.infer<
      typeof listJobsQuerySchema
    >;

    let scopeQueueIds: string[];
    if (queueId) {
      const [queue] = await db
        .select({ id: queues.id })
        .from(queues)
        .where(and(eq(queues.id, queueId), eq(queues.projectId, projectId)))
        .limit(1);
      if (!queue) {
        throw ApiError.notFound("queue_not_found", `Queue ${queueId} not found in this project`);
      }
      scopeQueueIds = [queue.id];
    } else {
      const projectQueues = await db.select({ id: queues.id }).from(queues).where(eq(queues.projectId, projectId));
      scopeQueueIds = projectQueues.map((q) => q.id);
    }

    if (scopeQueueIds.length === 0) {
      return res.json({ data: [], pagination: { page, pageSize, total: 0, totalPages: 0 } });
    }

    const filters = [inArray(jobs.queueId, scopeQueueIds)];
    if (status) filters.push(eq(jobs.status, status));
    if (from) filters.push(gte(jobs.createdAt, from));
    if (to) filters.push(lte(jobs.createdAt, to));
    const whereClause = and(...filters);

    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(jobs).where(whereClause);

    const rows = await db
      .select()
      .from(jobs)
      .where(whereClause)
      .orderBy(desc(jobs.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    res.json({
      data: rows,
      pagination: { page, pageSize, total: count, totalPages: Math.ceil(count / pageSize) },
    });
  }),
);

const jobLogsParamsSchema = z.object({
  projectId: z.string().uuid(),
  jobId: z.string().uuid(),
});

/**
 * GET /api/projects/:projectId/jobs/:jobId/logs
 *
 * Full log trace for one job (the Job Explorer's slide-out detail panel),
 * oldest first. 404s if the job isn't in this project rather than leaking
 * whether the id exists at all.
 */
jobsRouter.get(
  "/jobs/:jobId/logs",
  validate({ params: jobLogsParamsSchema }),
  asyncHandler(async (req, res) => {
    const { projectId, jobId } = req.params as unknown as z.infer<typeof jobLogsParamsSchema>;

    const [job] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .innerJoin(queues, eq(jobs.queueId, queues.id))
      .where(and(eq(jobs.id, jobId), eq(queues.projectId, projectId)))
      .limit(1);

    if (!job) {
      throw ApiError.notFound("job_not_found", `Job ${jobId} not found in this project`);
    }

    const rows = await db.select().from(jobLogs).where(eq(jobLogs.jobId, jobId)).orderBy(asc(jobLogs.createdAt));
    res.json({ data: rows });
  }),
);
