import { Router } from "express";
import { eq, inArray, sql } from "drizzle-orm";
import { deadLetterQueue, jobs, queues } from "@scheduler/db";
import { db } from "../db.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const metricsRouter = Router({ mergeParams: true });

const JOB_STATUSES = ["queued", "scheduled", "claimed", "running", "completed", "failed"] as const;

/**
 * GET /api/projects/:projectId/metrics
 *
 * One aggregate read for the dashboard's summary tiles and throughput chart:
 * job counts by status plus the dead-letter total, instead of the frontend
 * firing one paginated GET /jobs call per status tile.
 */
metricsRouter.get(
  "/metrics",
  asyncHandler(async (req, res) => {
    const projectId = req.context.projectId!;

    const projectQueues = await db.select({ id: queues.id }).from(queues).where(eq(queues.projectId, projectId));
    const queueIds = projectQueues.map((q) => q.id);

    const jobCounts = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<
      (typeof JOB_STATUSES)[number],
      number
    >;
    let deadLetterCount = 0;

    if (queueIds.length > 0) {
      const counts = await db
        .select({ status: jobs.status, count: sql<number>`count(*)::int` })
        .from(jobs)
        .where(inArray(jobs.queueId, queueIds))
        .groupBy(jobs.status);

      for (const row of counts) {
        jobCounts[row.status] = row.count;
      }

      const [dlq] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(deadLetterQueue)
        .where(inArray(deadLetterQueue.queueId, queueIds));
      deadLetterCount = dlq?.count ?? 0;
    }

    res.json({ data: { queueCount: queueIds.length, jobCounts, deadLetterCount } });
  }),
);
