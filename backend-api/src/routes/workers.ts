import { Router } from "express";
import { eq, sql } from "drizzle-orm";
import { workerHeartbeats, workers } from "@scheduler/db";
import { db } from "../db.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const workersRouter = Router();

/**
 * GET /api/workers
 *
 * Fleet-wide worker roster for Cluster Health Telemetry. Not scoped to
 * :projectId: the `workers` table has no tenant column (see DEVELOPMENT.md)
 * -- a single worker process polls and claims across any org/project's
 * queues, so "this project's workers" isn't a concept the schema supports.
 *
 * lastHeartbeatAt is computed from worker_heartbeats (an insert-only history
 * log, see schema.ts) rather than read off a column, so the response shape
 * stays the same one the dashboard already expects.
 */
workersRouter.get(
  "/workers",
  asyncHandler(async (_req, res) => {
    const latestHeartbeats = db
      .select({
        workerId: workerHeartbeats.workerId,
        latestAt: sql<Date>`max(${workerHeartbeats.heartbeatAt})`.as("latest_at"),
      })
      .from(workerHeartbeats)
      .groupBy(workerHeartbeats.workerId)
      .as("latest_heartbeats");

    const rows = await db
      .select({
        id: workers.id,
        hostname: workers.hostname,
        pid: workers.pid,
        status: workers.status,
        startedAt: workers.startedAt,
        createdAt: workers.createdAt,
        lastHeartbeatAt: latestHeartbeats.latestAt,
      })
      .from(workers)
      .leftJoin(latestHeartbeats, eq(latestHeartbeats.workerId, workers.id));

    res.json({ data: rows });
  }),
);
