import { Router } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { deadLetterQueue, jobExecutions, jobs, queues, retryPolicies } from "@scheduler/db";
import { db } from "../db.js";
import { ApiError } from "../lib/apiError.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireRole } from "../middleware/rbac.js";
import { validate } from "../middleware/validate.js";

export const queuesRouter = Router({ mergeParams: true });

const queueParamsSchema = z.object({
  projectId: z.string().uuid(),
  queueId: z.string().uuid(),
});

const retryPolicyInputSchema = z.object({
  strategy: z.enum(["fixed", "linear", "exponential"]).default("exponential"),
  maxRetries: z.number().int().min(0).max(50).default(3),
  baseDelayMs: z.number().int().min(0).default(1000),
});

/** Flattens the queue + its 1:1 retry_policies row into one wire shape, so the API's
 *  response doesn't force clients to know retry config lives in a separate table. */
function shapeQueue(row: { queues: typeof queues.$inferSelect; retry_policies: typeof retryPolicies.$inferSelect | null }) {
  return {
    ...row.queues,
    retryPolicy: row.retry_policies
      ? {
          strategy: row.retry_policies.strategy,
          maxRetries: row.retry_policies.maxRetries,
          baseDelayMs: row.retry_policies.baseDelayMs,
        }
      : null,
  };
}

/** GET /api/projects/:projectId/queues -- list queues for the Queue Configuration Matrix. */
queuesRouter.get(
  "/queues",
  asyncHandler(async (req, res) => {
    const projectId = req.context.projectId!;
    const rows = await db
      .select()
      .from(queues)
      .leftJoin(retryPolicies, eq(retryPolicies.queueId, queues.id))
      .where(eq(queues.projectId, projectId))
      .orderBy(desc(queues.priority));
    res.json({ data: rows.map(shapeQueue) });
  }),
);

const createQueueBodySchema = z.object({
  name: z.string().min(1).max(255),
  priority: z.number().int().default(0),
  concurrencyLimit: z.number().int().min(1).default(1),
  retryPolicy: retryPolicyInputSchema.default({}),
  shardCount: z.number().int().min(1).max(64).default(1),
  rateLimitPerMinute: z.number().int().min(1).optional(),
});

/**
 * POST /api/projects/:projectId/queues
 *
 * Adds a queue to an existing project -- the piece missing before this
 * sprint, when a project's only queue was the one made automatically at
 * signup. Queue + its 1:1 retry policy are created in one transaction.
 */
queuesRouter.post(
  "/queues",
  requireRole("owner", "admin"),
  validate({ body: createQueueBodySchema }),
  asyncHandler(async (req, res) => {
    const projectId = req.context.projectId!;
    const { name, priority, concurrencyLimit, retryPolicy, shardCount, rateLimitPerMinute } = req.body as z.infer<
      typeof createQueueBodySchema
    >;

    const result = await db.transaction(async (tx) => {
      const [queue] = await tx
        .insert(queues)
        .values({ projectId, name, priority, concurrencyLimit, shardCount, rateLimitPerMinute })
        .returning();

      const [policy] = await tx
        .insert(retryPolicies)
        .values({ queueId: queue.id, ...retryPolicy })
        .returning();

      return { queue, policy };
    });

    res.status(201).json({ data: shapeQueue({ queues: result.queue, retry_policies: result.policy }) });
  }),
);

const updateQueueBodySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  priority: z.number().int().optional(),
  concurrencyLimit: z.number().int().min(1).optional(),
  retryPolicy: retryPolicyInputSchema.partial().optional(),
  // Sharding: how many virtual sub-shards this queue's jobs are split across
  // (see packages/db/src/shard.ts + worker-service/src/claim.ts). 1 = unsharded.
  shardCount: z.number().int().min(1).max(64).optional(),
  // Rate limiting: overrides the organization's default for this queue only.
  // null explicitly clears the override (falls back to org/code default);
  // omitted leaves it unchanged.
  rateLimitPerMinute: z.number().int().min(1).nullable().optional(),
});

/**
 * PATCH /api/projects/:projectId/queues/:queueId
 *
 * Updates the config fields that were previously frozen after creation --
 * priority, concurrency limit, and the linked retry policy (strategy, max
 * retries, base delay). Pause/resume stay their own dedicated endpoints below
 * since they're a distinct, high-frequency operational toggle rather than a
 * config edit.
 */
queuesRouter.patch(
  "/queues/:queueId",
  requireRole("owner", "admin"),
  validate({ params: queueParamsSchema, body: updateQueueBodySchema }),
  asyncHandler(async (req, res) => {
    const { projectId, queueId } = req.params as unknown as z.infer<typeof queueParamsSchema>;
    const { name, priority, concurrencyLimit, retryPolicy, shardCount, rateLimitPerMinute } = req.body as z.infer<
      typeof updateQueueBodySchema
    >;

    const [existing] = await db
      .select()
      .from(queues)
      .where(and(eq(queues.id, queueId), eq(queues.projectId, projectId)))
      .limit(1);
    if (!existing) {
      throw ApiError.notFound("queue_not_found", `Queue ${queueId} not found in this project`);
    }

    const queuePatch: Partial<typeof queues.$inferInsert> = { updatedAt: new Date() };
    if (name !== undefined) queuePatch.name = name;
    if (priority !== undefined) queuePatch.priority = priority;
    if (concurrencyLimit !== undefined) queuePatch.concurrencyLimit = concurrencyLimit;
    if (shardCount !== undefined) queuePatch.shardCount = shardCount;
    if (rateLimitPerMinute !== undefined) queuePatch.rateLimitPerMinute = rateLimitPerMinute;

    const [updatedQueue] = await db.update(queues).set(queuePatch).where(eq(queues.id, queueId)).returning();

    let updatedPolicy = null;
    if (retryPolicy && Object.keys(retryPolicy).length > 0) {
      [updatedPolicy] = await db
        .update(retryPolicies)
        .set({ ...retryPolicy, updatedAt: new Date() })
        .where(eq(retryPolicies.queueId, queueId))
        .returning();
    } else {
      [updatedPolicy] = await db.select().from(retryPolicies).where(eq(retryPolicies.queueId, queueId)).limit(1);
    }

    res.json({ data: shapeQueue({ queues: updatedQueue, retry_policies: updatedPolicy ?? null }) });
  }),
);

const JOB_STATUSES = ["queued", "scheduled", "claimed", "running", "completed", "failed"] as const;

/**
 * GET /api/projects/:projectId/queues/:queueId/stats
 *
 * Per-queue breakdown -- job counts by status, dead-letter total, and average
 * duration of successful executions -- as opposed to GET /metrics, which only
 * ever aggregates across every queue in the project.
 */
queuesRouter.get(
  "/queues/:queueId/stats",
  validate({ params: queueParamsSchema }),
  asyncHandler(async (req, res) => {
    const { projectId, queueId } = req.params as unknown as z.infer<typeof queueParamsSchema>;

    const [queue] = await db
      .select({ id: queues.id })
      .from(queues)
      .where(and(eq(queues.id, queueId), eq(queues.projectId, projectId)))
      .limit(1);
    if (!queue) {
      throw ApiError.notFound("queue_not_found", `Queue ${queueId} not found in this project`);
    }

    const jobCounts = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<
      (typeof JOB_STATUSES)[number],
      number
    >;
    const counts = await db
      .select({ status: jobs.status, count: sql<number>`count(*)::int` })
      .from(jobs)
      .where(eq(jobs.queueId, queueId))
      .groupBy(jobs.status);
    for (const row of counts) jobCounts[row.status] = row.count;

    const [dlq] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(deadLetterQueue)
      .where(eq(deadLetterQueue.queueId, queueId));

    const [durations] = await db
      .select({ avgDurationMs: sql<number | null>`avg(${jobExecutions.durationMs})::int` })
      .from(jobExecutions)
      .innerJoin(jobs, eq(jobExecutions.jobId, jobs.id))
      .where(and(eq(jobs.queueId, queueId), eq(jobExecutions.status, "success")));

    res.json({
      data: {
        queueId,
        jobCounts,
        deadLetterCount: dlq?.count ?? 0,
        avgDurationMs: durations?.avgDurationMs ?? null,
      },
    });
  }),
);

async function setQueuePaused(projectId: string, queueId: string, isPaused: boolean) {
  const [queue] = await db
    .update(queues)
    .set({ isPaused, updatedAt: new Date() })
    .where(and(eq(queues.id, queueId), eq(queues.projectId, projectId)))
    .returning();

  if (!queue) {
    throw ApiError.notFound("queue_not_found", `Queue ${queueId} not found in this project`);
  }

  const [retryPolicy] = await db.select().from(retryPolicies).where(eq(retryPolicies.queueId, queue.id)).limit(1);
  return shapeQueue({ queues: queue, retry_policies: retryPolicy ?? null });
}

/**
 * POST /api/projects/:projectId/queues/:queueId/pause
 *
 * Sets queues.is_paused = true. worker-service's claim query (see
 * worker-service/src/claim.ts) joins queues and requires is_paused = false
 * before locking a row, so this takes effect on the very next poll cycle.
 * Jobs already claimed/running are unaffected — pause only stops new claims.
 */
queuesRouter.post(
  "/queues/:queueId/pause",
  validate({ params: queueParamsSchema }),
  asyncHandler(async (req, res) => {
    const { projectId, queueId } = req.params as unknown as z.infer<typeof queueParamsSchema>;
    const queue = await setQueuePaused(projectId, queueId, true);
    res.json({ data: queue });
  }),
);

/** POST /api/projects/:projectId/queues/:queueId/resume -- clears is_paused, allowing new claims again. */
queuesRouter.post(
  "/queues/:queueId/resume",
  validate({ params: queueParamsSchema }),
  asyncHandler(async (req, res) => {
    const { projectId, queueId } = req.params as unknown as z.infer<typeof queueParamsSchema>;
    const queue = await setQueuePaused(projectId, queueId, false);
    res.json({ data: queue });
  }),
);
