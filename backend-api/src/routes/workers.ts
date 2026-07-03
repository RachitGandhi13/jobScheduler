import { Router } from "express";
import { workers } from "@scheduler/db";
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
 */
workersRouter.get(
  "/workers",
  asyncHandler(async (_req, res) => {
    const rows = await db.select().from(workers);
    res.json({ data: rows });
  }),
);
