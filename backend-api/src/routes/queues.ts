import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { queues, retryPolicies } from "@scheduler/db";
import { db } from "../db.js";
import { ApiError } from "../lib/apiError.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { validate } from "../middleware/validate.js";

export const queuesRouter = Router({ mergeParams: true });

const queueParamsSchema = z.object({
  projectId: z.string().uuid(),
  queueId: z.string().uuid(),
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
