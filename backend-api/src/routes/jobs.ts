import crypto from "node:crypto";
import { Router } from "express";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { deadLetterQueue, jobLogs, jobs, queues, retryPolicies, scheduledJobs } from "@scheduler/db";
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
  // No default here: when omitted, falls back to the owning queue's retry
  // policy's max_retries below, rather than silently overriding it.
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
 *   maxAttempts?: number,       // default: the owning queue's retry_policies.max_retries
 *   schedule?:
 *     | { mode: "immediate" }
 *     | { mode: "delayed", runAt: string (ISO date) }
 *     | { mode: "recurring", cronExpression: string }
 * }
 *
 * immediate  -> run_at = now(), status = 'queued' (claimable this instant).
 * delayed    -> run_at = schedule.runAt (must be future), status = 'scheduled'.
 * recurring  -> creates a scheduled_jobs row (the baseline rule: queue, type,
 *               payload template, cron expression) and a jobs row for its
 *               first occurrence, linked via scheduled_job_id. Only the first
 *               occurrence is created here; worker-service chains every one
 *               after that (see DEVELOPMENT.md).
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

    const [retryPolicy] = await db.select().from(retryPolicies).where(eq(retryPolicies.queueId, queueId)).limit(1);
    const resolvedMaxAttempts = maxAttempts ?? retryPolicy?.maxRetries ?? 3;

    if (schedule.mode === "immediate") {
      const [job] = await db
        .insert(jobs)
        .values({ queueId, type, payload, priority, maxAttempts: resolvedMaxAttempts, runAt: new Date(), status: "queued" })
        .returning();
      return res.status(201).json({ data: job });
    }

    if (schedule.mode === "delayed") {
      if (schedule.runAt.getTime() <= Date.now()) {
        throw ApiError.badRequest("run_at_in_past", "schedule.runAt must be in the future");
      }
      const [job] = await db
        .insert(jobs)
        .values({
          queueId,
          type,
          payload,
          priority,
          maxAttempts: resolvedMaxAttempts,
          runAt: schedule.runAt,
          status: "scheduled",
        })
        .returning();
      return res.status(201).json({ data: job });
    }

    // recurring
    const firstRunAt = getNextCronRun(schedule.cronExpression);

    const [job] = await db.transaction(async (tx) => {
      const [rule] = await tx
        .insert(scheduledJobs)
        .values({
          queueId,
          type,
          payload,
          priority,
          maxAttempts: resolvedMaxAttempts,
          cronExpression: schedule.cronExpression,
        })
        .returning();

      return tx
        .insert(jobs)
        .values({
          queueId,
          type,
          payload,
          priority,
          maxAttempts: resolvedMaxAttempts,
          runAt: firstRunAt,
          status: "scheduled",
          scheduledJobId: rule.id,
        })
        .returning();
    });

    res.status(201).json({ data: job });
  }),
);

const createBatchBodySchema = z.object({
  queueId: z.string().uuid(),
  jobs: z
    .array(
      z.object({
        type: z.string().min(1).max(255),
        payload: z.record(z.unknown()).default({}),
        priority: z.number().int().default(0),
        maxAttempts: z.number().int().min(1).max(50).optional(),
      }),
    )
    .min(1)
    .max(500),
});

/**
 * POST /api/projects/:projectId/jobs/batch
 *
 * Enqueues many immediate jobs on one queue, sharing a generated `batchId`
 * (jobs.batch_id), in a single transaction -- either every job in the batch
 * lands or none do.
 */
jobsRouter.post(
  "/jobs/batch",
  validate({ body: createBatchBodySchema }),
  asyncHandler(async (req, res) => {
    const projectId = req.context.projectId!;
    const { queueId, jobs: jobSpecs } = req.body as z.infer<typeof createBatchBodySchema>;

    const [queue] = await db
      .select()
      .from(queues)
      .where(and(eq(queues.id, queueId), eq(queues.projectId, projectId)))
      .limit(1);
    if (!queue) {
      throw ApiError.notFound("queue_not_found", `Queue ${queueId} not found in this project`);
    }

    const [retryPolicy] = await db.select().from(retryPolicies).where(eq(retryPolicies.queueId, queueId)).limit(1);
    const defaultMaxAttempts = retryPolicy?.maxRetries ?? 3;
    const batchId = crypto.randomUUID();
    const runAt = new Date();

    const inserted = await db.transaction((tx) =>
      tx
        .insert(jobs)
        .values(
          jobSpecs.map((spec) => ({
            queueId,
            type: spec.type,
            payload: spec.payload,
            priority: spec.priority,
            maxAttempts: spec.maxAttempts ?? defaultMaxAttempts,
            runAt,
            status: "queued" as const,
            batchId,
          })),
        )
        .returning(),
    );

    res.status(201).json({ data: { batchId, count: inserted.length, jobs: inserted } });
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

const retryJobParamsSchema = z.object({
  projectId: z.string().uuid(),
  jobId: z.string().uuid(),
});

/**
 * POST /api/projects/:projectId/jobs/:jobId/retry
 *
 * Manually force a 'failed' (dead-lettered) job back to 'queued', attempts
 * reset to 0 and immediately claimable. Kept project-scoped -- not the bare
 * `/api/jobs/:jobId/retry` path -- so it goes through the same tenant-
 * ownership check every other job route requires; see DEVELOPMENT.md for why
 * that consistency mattered more than matching the literal path.
 */
jobsRouter.post(
  "/jobs/:jobId/retry",
  validate({ params: retryJobParamsSchema }),
  asyncHandler(async (req, res) => {
    const { projectId, jobId } = req.params as unknown as z.infer<typeof retryJobParamsSchema>;

    const [job] = await db
      .select({ id: jobs.id, status: jobs.status })
      .from(jobs)
      .innerJoin(queues, eq(jobs.queueId, queues.id))
      .where(and(eq(jobs.id, jobId), eq(queues.projectId, projectId)))
      .limit(1);

    if (!job) {
      throw ApiError.notFound("job_not_found", `Job ${jobId} not found in this project`);
    }
    if (job.status !== "failed") {
      throw ApiError.badRequest(
        "job_not_retryable",
        `Job is '${job.status}', not 'failed' -- only failed/dead-lettered jobs can be manually retried`,
      );
    }

    await db.transaction(async (tx) => {
      await tx
        .update(jobs)
        .set({ status: "queued", runAt: new Date(), attempts: 0, lastError: null, updatedAt: new Date() })
        .where(eq(jobs.id, jobId));

      // A retried job can dead-letter again later under a fresh set of
      // attempts; clear the old entry so that future INSERT doesn't collide
      // with dead_letter_queue's one-row-per-job unique constraint.
      await tx.delete(deadLetterQueue).where(eq(deadLetterQueue.jobId, jobId));

      await tx.insert(jobLogs).values({
        jobId,
        level: "info",
        message: "Manually retried by operator -- attempts reset, requeued for immediate claiming",
      });
    });

    const [updated] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    res.json({ data: updated });
  }),
);
