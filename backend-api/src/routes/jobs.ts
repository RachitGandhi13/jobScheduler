import crypto from "node:crypto";
import { Router } from "express";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { computeShardKey, deadLetterQueue, jobLogs, jobs, queues, retryPolicies, scheduledJobs } from "@scheduler/db";
import { db } from "../db.js";
import { ApiError } from "../lib/apiError.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getNextCronRun } from "../lib/cron.js";
import { notifyJobAvailable } from "../lib/notify.js";
import { rateLimitJobIngestion } from "../middleware/rateLimiter.js";
import { validate } from "../middleware/validate.js";

export const jobsRouter = Router({ mergeParams: true });

/**
 * Controls when a job first becomes eligible for claiming; independent of
 * `type`, which names the job *handler* (e.g. "send-welcome-email") a future
 * handler registry will dispatch on.
 *
 * "delayed" and "scheduled" are deliberately distinct: delayed takes a
 * relative offset from now ("run in 10 minutes" -- the caller doesn't need to
 * compute a timestamp), scheduled takes an absolute point in time ("run at
 * 2026-08-01T10:00:00Z"). Both land the job in status='scheduled' with a
 * concrete run_at; only how that run_at is expressed differs.
 */
const scheduleSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("immediate") }),
  z.object({ mode: z.literal("delayed"), delayMs: z.number().int().positive() }),
  z.object({ mode: z.literal("scheduled"), runAt: z.coerce.date() }),
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
  // Optional client-supplied dedupe key (also accepted via the
  // Idempotency-Key header; the body field wins if both are sent). Scoped to
  // this queue -- see schema.ts's jobs_queue_id_idempotency_key_idx.
  idempotencyKey: z.string().min(1).max(255).optional(),
  // Workflow dependency: this job stays out of claim.ts's candidate set until
  // the referenced job's status is strictly 'completed'. Must belong to the
  // same project (checked below), but may be on a different queue.
  parentJobId: z.string().uuid().optional(),
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
 *     | { mode: "delayed", delayMs: number }
 *     | { mode: "scheduled", runAt: string (ISO date) }
 *     | { mode: "recurring", cronExpression: string }
 *   idempotencyKey?: string,    // also accepted as an Idempotency-Key header
 *   parentJobId?: string (uuid) // this job waits until that job is 'completed'
 * }
 *
 * immediate  -> run_at = now(), status = 'queued' (claimable this instant).
 * delayed    -> run_at = now() + schedule.delayMs, status = 'scheduled'.
 * scheduled  -> run_at = schedule.runAt (must be future), status = 'scheduled'.
 * recurring  -> creates a scheduled_jobs row (the baseline rule: queue, type,
 *               payload template, cron expression) and a jobs row for its
 *               first occurrence, linked via scheduled_job_id. Only the first
 *               occurrence is created here; worker-service chains every one
 *               after that (see DEVELOPMENT.md).
 *
 * If idempotencyKey is supplied and a job already exists on this queue with
 * the same key, that existing job is returned as-is (200, not 201) instead of
 * inserting a duplicate -- makes retrying a POST /jobs call after a client
 * timeout safe. Jobs created without a key are never deduped against each
 * other or anything else (see schema.ts).
 */
jobsRouter.post(
  "/jobs",
  validate({ body: createJobBodySchema }),
  rateLimitJobIngestion,
  asyncHandler(async (req, res) => {
    const projectId = req.context.projectId!;
    const {
      type,
      queueId,
      payload,
      priority,
      maxAttempts,
      schedule,
      idempotencyKey: bodyKey,
      parentJobId,
    } = req.body as z.infer<typeof createJobBodySchema>;
    const idempotencyKey = bodyKey ?? req.header("idempotency-key");

    const [queue] = await db
      .select()
      .from(queues)
      .where(and(eq(queues.id, queueId), eq(queues.projectId, projectId)))
      .limit(1);

    if (!queue) {
      throw ApiError.notFound("queue_not_found", `Queue ${queueId} not found in this project`);
    }

    if (parentJobId) {
      const [parentJob] = await db
        .select({ id: jobs.id })
        .from(jobs)
        .innerJoin(queues, eq(jobs.queueId, queues.id))
        .where(and(eq(jobs.id, parentJobId), eq(queues.projectId, projectId)))
        .limit(1);
      if (!parentJob) {
        throw ApiError.notFound("parent_job_not_found", `Job ${parentJobId} not found in this project`);
      }
    }

    if (idempotencyKey) {
      const [existing] = await db
        .select()
        .from(jobs)
        .where(and(eq(jobs.queueId, queueId), eq(jobs.idempotencyKey, idempotencyKey)))
        .limit(1);
      if (existing) {
        return res.status(200).json({ data: existing, idempotent: true });
      }
    }

    const [retryPolicy] = await db.select().from(retryPolicies).where(eq(retryPolicies.queueId, queueId)).limit(1);
    const resolvedMaxAttempts = maxAttempts ?? retryPolicy?.maxRetries ?? 3;

    try {
      if (schedule.mode === "immediate") {
        const id = crypto.randomUUID();
        const [job] = await db
          .insert(jobs)
          .values({
            id,
            queueId,
            type,
            payload,
            priority,
            maxAttempts: resolvedMaxAttempts,
            runAt: new Date(),
            status: "queued",
            idempotencyKey,
            parentJobId,
            shardKey: computeShardKey(id),
          })
          .returning();
        // Only immediate jobs benefit from waking a worker early -- delayed/
        // scheduled/recurring jobs have a future run_at, so there's nothing
        // for a worker to claim yet regardless of how fast it wakes up.
        void notifyJobAvailable(queueId);
        return res.status(201).json({ data: job });
      }

      if (schedule.mode === "delayed" || schedule.mode === "scheduled") {
        const runAt = schedule.mode === "delayed" ? new Date(Date.now() + schedule.delayMs) : schedule.runAt;
        if (runAt.getTime() <= Date.now()) {
          throw ApiError.badRequest("run_at_in_past", "The resolved run time must be in the future");
        }
        const id = crypto.randomUUID();
        const [job] = await db
          .insert(jobs)
          .values({
            id,
            queueId,
            type,
            payload,
            priority,
            maxAttempts: resolvedMaxAttempts,
            runAt,
            status: "scheduled",
            idempotencyKey,
            parentJobId,
            shardKey: computeShardKey(id),
          })
          .returning();
        return res.status(201).json({ data: job });
      }

      // recurring
      const firstRunAt = getNextCronRun(schedule.cronExpression);
      const id = crypto.randomUUID();

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
            id,
            queueId,
            type,
            payload,
            priority,
            maxAttempts: resolvedMaxAttempts,
            runAt: firstRunAt,
            status: "scheduled",
            scheduledJobId: rule.id,
            idempotencyKey,
            parentJobId,
            shardKey: computeShardKey(id),
          })
          .returning();
      });

      res.status(201).json({ data: job });
    } catch (err) {
      // Unique violation on (queue_id, idempotency_key): a concurrent request
      // with the same key won the race between our pre-check and this insert.
      // Return the row it created rather than a 500/409.
      if (idempotencyKey && (err as { code?: string }).code === "23505") {
        const [existing] = await db
          .select()
          .from(jobs)
          .where(and(eq(jobs.queueId, queueId), eq(jobs.idempotencyKey, idempotencyKey)))
          .limit(1);
        if (existing) {
          return res.status(200).json({ data: existing, idempotent: true });
        }
      }
      throw err;
    }
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
  rateLimitJobIngestion,
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
          jobSpecs.map((spec) => {
            const id = crypto.randomUUID();
            return {
              id,
              queueId,
              type: spec.type,
              payload: spec.payload,
              priority: spec.priority,
              maxAttempts: spec.maxAttempts ?? defaultMaxAttempts,
              runAt,
              status: "queued" as const,
              batchId,
              shardKey: computeShardKey(id),
            };
          }),
        )
        .returning(),
    );

    void notifyJobAvailable(queueId);
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

/**
 * GET /api/projects/:projectId/jobs/:jobId/dead-letter
 *
 * The job's dead_letter_queue row (payload snapshot, fail reason, and its
 * aiSummary -- see worker-service/src/failureSummary.ts), or null if this job
 * never dead-lettered. Kept as its own endpoint rather than folding onto the
 * job row itself, matching how retryPolicy is nested onto queues: the data
 * lives in its own table, and only jobs that actually failed pay for the
 * extra query.
 */
jobsRouter.get(
  "/jobs/:jobId/dead-letter",
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

    const [entry] = await db.select().from(deadLetterQueue).where(eq(deadLetterQueue.jobId, jobId)).limit(1);
    res.json({ data: entry ?? null });
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
