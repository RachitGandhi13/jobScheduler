import crypto from "node:crypto";
import { Router } from "express";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { projects } from "@scheduler/db";
import { db } from "../db.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireRole } from "../middleware/rbac.js";
import { validate } from "../middleware/validate.js";

/** Org-scoped: list/create. Mounted directly on apiRouter at "/projects" (no :projectId param yet). */
export const projectsRouter = Router();

/** GET /api/projects -- every project belonging to the caller's organization. */
projectsRouter.get(
  "/projects",
  asyncHandler(async (req, res) => {
    const organizationId = req.context.organizationId;
    const rows = await db
      .select()
      .from(projects)
      .where(eq(projects.organizationId, organizationId))
      .orderBy(asc(projects.createdAt));
    res.json({ data: rows });
  }),
);

const createProjectBodySchema = z.object({
  name: z.string().min(1).max(255),
});

/**
 * POST /api/projects
 *
 * Creates an additional project in the caller's organization. Unlike the one
 * auto-created at signup, this one starts with zero queues -- use
 * POST /projects/:projectId/queues to add its first one.
 */
projectsRouter.post(
  "/projects",
  requireRole("owner", "admin"),
  validate({ body: createProjectBodySchema }),
  asyncHandler(async (req, res) => {
    const { organizationId, userId } = req.context;
    const { name } = req.body as z.infer<typeof createProjectBodySchema>;

    const [project] = await db
      .insert(projects)
      .values({
        organizationId,
        name,
        ownerId: userId,
        apiKey: crypto.randomBytes(24).toString("hex"),
      })
      .returning();

    res.status(201).json({ data: project });
  }),
);

/** Project-scoped: get/rename/delete one project. Mounted inside the :projectId
 *  sub-router in routes/index.ts, after requireProjectAccess has already
 *  verified tenant ownership -- so every handler here can trust req.context.project. */
export const projectDetailRouter = Router({ mergeParams: true });

projectDetailRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json({ data: req.context.project });
  }),
);

const updateProjectBodySchema = z.object({
  name: z.string().min(1).max(255),
});

/** PATCH /api/projects/:projectId -- currently just renames; ownerId/apiKey are immutable via this route. */
projectDetailRouter.patch(
  "/",
  requireRole("owner", "admin"),
  validate({ body: updateProjectBodySchema }),
  asyncHandler(async (req, res) => {
    const projectId = req.context.projectId!;
    const { name } = req.body as z.infer<typeof updateProjectBodySchema>;

    const [updated] = await db
      .update(projects)
      .set({ name, updatedAt: new Date() })
      .where(eq(projects.id, projectId))
      .returning();

    res.json({ data: updated });
  }),
);

/**
 * DELETE /api/projects/:projectId
 *
 * Cascades through queues -> jobs -> {executions, logs, dead_letter_queue} and
 * scheduled_jobs/retry_policies (all ON DELETE CASCADE in schema.ts) -- this
 * is the one genuinely destructive endpoint in the API.
 */
projectDetailRouter.delete(
  "/",
  requireRole("owner", "admin"),
  asyncHandler(async (req, res) => {
    const projectId = req.context.projectId!;
    await db.delete(projects).where(eq(projects.id, projectId));
    res.status(204).send();
  }),
);
