import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { queues } from "@scheduler/db";
import { db } from "../db.js";
import { ApiError } from "../lib/apiError.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { validate } from "../middleware/validate.js";

export const queuesRouter = Router({ mergeParams: true });

const queueParamsSchema = z.object({
  projectId: z.string().uuid(),
  queueId: z.string().uuid(),
});

/** GET /api/projects/:projectId/queues -- list queues for the Queue Configuration Matrix. */
queuesRouter.get(
  "/queues",
  asyncHandler(async (req, res) => {
    const projectId = req.context.projectId!;
    const rows = await db.select().from(queues).where(eq(queues.projectId, projectId)).orderBy(desc(queues.priority));
    res.json({ data: rows });
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
  return queue;
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
